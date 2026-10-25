import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { load } from 'js-yaml';
import { cardActionDeniedBy } from '../lib/interaction-routing.js';
import {
    upsertFeishuConfig,
    writeProfileCredentials,
} from '../lib/setup/profile-writer.js';
import { resolveWorkspaceFile } from '../lib/workspace-path.js';
import { SurfaceStateStore } from '../lib/surface-state.js';
import { sendFileFromPath } from '../lib/outbound.js';
import { Bridge } from '../lib/bridge.js';
import { SessionMap } from '../lib/session-map.js';

test('outbound file paths cannot escape the active workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-path-'));
    try {
        const workspace = join(root, 'workspace');
        const outside = join(root, 'outside');
        mkdirSync(workspace);
        mkdirSync(outside);
        const insideFile = join(workspace, 'inside.txt');
        const outsideFile = join(outside, 'secret.txt');
        writeFileSync(insideFile, 'inside');
        writeFileSync(outsideFile, 'secret');

        assert.equal(await resolveWorkspaceFile(workspace, 'inside.txt'), insideFile);
        assert.equal(await resolveWorkspaceFile(workspace, insideFile), insideFile);
        await assert.rejects(resolveWorkspaceFile(workspace, outsideFile), /outside the active workspace/);
        await assert.rejects(resolveWorkspaceFile(workspace, '../outside/secret.txt'), /outside the active workspace/);

        const link = join(workspace, 'outside-link');
        symlinkSync(outside, link, 'junction');
        await assert.rejects(resolveWorkspaceFile(workspace, join('outside-link', 'secret.txt')), /outside the active workspace/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('large outbound files use path streaming and enforce Feishu limits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-upload-'));
    try {
        const image = join(root, 'large.png');
        const tooLarge = join(root, 'too-large.bin');
        writeFileSync(image, '');
        writeFileSync(tooLarge, '');
        truncateSync(image, 11 * 1024 * 1024);
        truncateSync(tooLarge, 31 * 1024 * 1024);
        const calls = [];
        const transport = {
            sendFilePath: async (...args) => calls.push(['file-path', ...args]),
            sendImagePath: async (...args) => calls.push(['image-path', ...args]),
            sendFile: async () => { throw new Error('buffer fallback must not run'); },
            sendImage: async () => { throw new Error('buffer fallback must not run'); },
        };
        const sent = await sendFileFromPath(transport, 'chat-1', image, true);
        assert.equal(sent.kind, 'file');
        assert.equal(calls[0][0], 'file-path');
        await assert.rejects(sendFileFromPath(transport, 'chat-1', tooLarge), /30 MB upload limit/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('an image-looking suffix cannot route non-image bytes to the image API', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-image-magic-'));
    try {
        const fake = join(root, 'fake.png');
        const real = join(root, 'real.png');
        writeFileSync(fake, 'not an image');
        writeFileSync(real, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const calls = [];
        const transport = {
            sendFilePath: async (...args) => calls.push(['file', ...args]),
            sendImagePath: async (...args) => calls.push(['image', ...args]),
        };

        assert.equal((await sendFileFromPath(transport, 'chat-1', fake, true)).kind, 'file');
        assert.equal((await sendFileFromPath(transport, 'chat-1', real, true)).kind, 'image');
        assert.deepEqual(calls.map(([kind]) => kind), ['file', 'image']);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('the distributed profile defaults session visibility to the current Feishu chat', () => {
    const patch = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
    const rows = patch.flatMap((operation) => operation.insert ?? []);
    assert.equal(rows.find((row) => row.id === 'feishu').config.sessionVisibility, 'chat');
});

test('malformed durable surface state is preserved instead of overwritten', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-state-'));
    try {
        const file = join(root, 'surface-state.json');
        writeFileSync(file, '{broken', 'utf8');
        const errors = [];
        const state = new SurfaceStateStore(file, { error: (message) => errors.push(message) });
        assert.equal(state.load(), undefined);
        state.persist({ dedupIds: ['message-1'] });
        assert.equal(readFileSync(file, 'utf8'), '{broken');
        assert.equal(errors.length, 1);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('card callbacks obey both chat and user allowlists before routing commands', async () => {
    const action = (chatId, operatorOpenId) => ({
        chatId,
        operatorOpenId,
    });
    const allowedChats = ['chat-allowed'];
    const allowedUsers = ['user-allowed'];

    assert.equal(cardActionDeniedBy(action('chat-allowed', 'user-blocked'), allowedChats, allowedUsers), 'user');
    assert.equal(cardActionDeniedBy(action('chat-blocked', 'user-allowed'), allowedChats, allowedUsers), 'chat');
    assert.equal(cardActionDeniedBy(action('chat-allowed', 'user-allowed'), allowedChats, allowedUsers), undefined);
    assert.equal(cardActionDeniedBy(action('any-chat', 'any-user')), undefined);
});

test('session visibility gates direct resume and an active Feishu chat cannot be silently displaced', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-session-access-'));
    try {
        const sessionMap = new SessionMap(join(root, 'session-map.json'));
        sessionMap.set('chat-a', 'session-a');
        sessionMap.set('chat-b', 'session-b');
        const resumed = [];
        const transport = {
            onMessage() {}, onCardAction() {}, sendText: async () => {},
            sendCard: async () => ({ messageId: 'card' }), updateCard: async () => {},
        };
        const bridge = new Bridge({
            transport,
            sessionMap,
            agentStore: {
                get: () => undefined,
                resume: async (sessionId) => { resumed.push(sessionId); return {}; },
                create: async () => ({}),
            },
            onSessionEvent: () => () => {},
            onAssistantStream: () => () => {},
            cards: {},
            defaultCwd: process.cwd(),
            dataDir: root,
            sessionVisibility: 'chat',
            logger: { debug() {}, info() {}, warn() {}, error() {} },
        });

        const hidden = await bridge.resumeSession('chat-a', 'session-b');
        assert.equal(hidden.kind, 'error');
        assert.equal(resumed.length, 0);

        bridge.options.sessionVisibility = 'all';
        const alreadyOwned = await bridge.resumeSession('chat-a', 'session-b');
        assert.equal(alreadyOwned.kind, 'error');
        assert.equal(sessionMap.get('chat-b'), 'session-b');
        assert.equal(resumed.length, 0);
        bridge.dispose();
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('a forged session action cannot substitute another session for the open detail card', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-card-session-'));
    try {
        const sessionMap = new SessionMap(join(root, 'session-map.json'));
        sessionMap.set('chat-a', 'session-a');
        const reads = [];
        const transport = {
            onMessage() {}, onCardAction() {}, sendText: async () => {}, sendFile: async () => {},
            sendCard: async () => ({ messageId: 'card-a' }), updateCard: async () => {},
        };
        const bridge = new Bridge({
            transport,
            sessionMap,
            agentStore: { get: () => undefined, resume: async () => ({}), create: async () => ({}) },
            onSessionEvent: () => () => {},
            onAssistantStream: () => () => {},
            cards: {},
            defaultCwd: process.cwd(),
            dataDir: root,
            sessionVisibility: 'all',
            readSession: async (sessionId) => {
                reads.push(sessionId);
                return { session: { id: sessionId }, events: [] };
            },
            logger: { debug() {}, info() {}, warn() {}, error() {} },
        });
        const stack = bridge.panel.panelStack('chat-a', 'card-a');
        stack.splice(0, stack.length, { kind: 'session-detail', sessionId: 'session-a' });

        await bridge.handleCardAction({
            chatId: 'chat-a',
            messageId: 'card-a',
            operatorOpenId: 'user-a',
            value: { kind: 'session-export', sessionId: 'session-b' },
        });

        // The completion path re-renders the legitimate open detail, but the
        // substituted session is never read or exported.
        assert.deepEqual(reads, ['session-a']);
        bridge.dispose();
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('upgrading a Feishu row preserves legacy settings while refreshing credentials', () => {
    const rows = [{
        id: 'feishu',
        name: '@dsh-feishu/dsh-feishu',
        config: {
            appId: 'cli_old',
            appSecret: 'old-secret',
            allowedChats: ['oc_team'],
            allowedUsers: ['ou_owner'],
            proxyUrl: 'http://proxy.internal:80',
            groupMentionMode: 'ambient',
            customFutureOption: { enabled: true },
        },
    }];

    const updated = upsertFeishuConfig(rows, {
        appId: 'cli_new',
        appSecret: 'new-secret',
    }, { locale: 'zh-CN', sessionVisibility: 'all' });

    assert.notEqual(updated, rows);
    assert.deepEqual(updated[0].config, {
        appId: 'cli_new',
        appSecret: 'new-secret',
        allowedChats: ['oc_team'],
        allowedUsers: ['ou_owner'],
        proxyUrl: 'http://proxy.internal:80',
        groupMentionMode: 'ambient',
        customFutureOption: { enabled: true },
        locale: 'zh-CN',
        sessionVisibility: 'all',
    });
});

test('profile updates are backed up and preserve unrelated rows and Feishu options', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-profile-'));
    try {
        const profileDir = join(root, 'profiles', 'desktop');
        const patchPath = join(profileDir, 'cordis.patch.yml');
        mkdirSync(profileDir, { recursive: true });
        const original = [
            '- id: unrelated',
            '  name: example-plugin',
            '- id: feishu',
            "  name: '@dsh-feishu/dsh-feishu'",
            '  config:',
            '    appId: cli_existing',
            '    appSecret: existing-secret',
            '    allowedChats:',
            '      - oc_team',
            '    proxyUrl: http://proxy.internal:80',
            '',
        ].join('\n');
        writeFileSync(patchPath, original, 'utf8');

        const result = writeProfileCredentials(root, 'desktop', {
            appId: 'cli_existing',
            appSecret: 'existing-secret',
        }, { locale: 'zh-CN', sessionVisibility: 'all' });

        assert.equal(result.changed, true);
        assert.equal(result.backupPath, `${patchPath}.bak`);
        assert.equal(readFileSync(result.backupPath, 'utf8'), original);
        const rows = load(readFileSync(patchPath, 'utf8'));
        assert.equal(rows[0].id, 'unrelated');
        assert.deepEqual(rows[1].config, {
            appId: 'cli_existing',
            appSecret: 'existing-secret',
            allowedChats: ['oc_team'],
            proxyUrl: 'http://proxy.internal:80',
            locale: 'zh-CN',
            sessionVisibility: 'all',
        });
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
