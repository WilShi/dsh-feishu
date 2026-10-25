import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionMap } from '../lib/session-map.js';

function withTempFile(run) {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-feishu-session-map-'));
    const file = join(directory, 'sessions.json');
    try {
        return run(file);
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('v1 and v2 maps migrate in memory without losing bindings or cwd', () => {
    withTempFile((file) => {
        writeFileSync(file, JSON.stringify({ version: 1, entries: { chat1: 'session1' } }));
        const v1 = new SessionMap(file);
        v1.load();
        assert.equal(v1.get('chat1'), 'session1');
        assert.deepEqual(v1.sessionsFor('chat1'), ['session1']);
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 3);
        assert.equal(JSON.parse(readFileSync(`${file}.v1.backup`, 'utf8')).version, 1);
    });

    withTempFile((file) => {
        writeFileSync(file, JSON.stringify({
            version: 2,
            entries: { chat2: 'session2' },
            cwds: { chat2: 'D:/workspace/two' },
        }));
        const v2 = new SessionMap(file);
        v2.load();
        assert.equal(v2.get('chat2'), 'session2');
        assert.equal(v2.cwdFor('chat2'), 'D:/workspace/two');
        assert.deepEqual(v2.sessionsFor('chat2'), ['session2']);
        assert.deepEqual(v2.recentWorkspaces(), ['D:/workspace/two']);
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 3);
        assert.equal(JSON.parse(readFileSync(`${file}.v2.backup`, 'utf8')).version, 2);
    });
});

test('v3 persists session history plus recent and favorite workspaces', () => {
    withTempFile((file) => {
        let next = 1;
        const map = new SessionMap(file, () => `session-${next++}`);
        assert.equal(map.ensure('chat'), 'session-1');
        map.setCwd('chat', 'D:/workspace/one');
        assert.equal(map.remint('chat'), 'session-2');
        map.setCwd('chat', 'D:/workspace/two');
        map.setAgentPreset('chat', 'codex-code');
        assert.equal(map.toggleFavoriteWorkspace('D:/workspace/one'), true);

        const saved = JSON.parse(readFileSync(file, 'utf8'));
        assert.equal(saved.version, 3);
        assert.deepEqual(saved.sessionHistory.chat, ['session-1', 'session-2']);
        assert.deepEqual(saved.recentWorkspaces, ['D:/workspace/one', 'D:/workspace/two']);
        assert.deepEqual(saved.favoriteWorkspaces, ['D:/workspace/one']);
        assert.deepEqual(saved.agentPresets, { chat: 'codex-code' });

        const restored = new SessionMap(file);
        restored.load();
        assert.deepEqual(restored.sessionsFor('chat'), ['session-1', 'session-2']);
        assert.deepEqual(restored.recentWorkspaces(), ['D:/workspace/one', 'D:/workspace/two']);
        assert.deepEqual(restored.favoriteWorkspaces(), ['D:/workspace/one']);
        assert.equal(restored.agentPresetFor('chat'), 'codex-code');
        assert.equal(restored.toggleFavoriteWorkspace('D:/workspace/one'), false);
        assert.deepEqual(restored.favoriteWorkspaces(), []);
    });
});

test('default session ids stay unique even when created in the same millisecond', () => {
    withTempFile((file) => {
        const map = new SessionMap(file);
        const first = map.ensure('chat-1');
        const second = map.ensure('chat-2');
        assert.match(first, /^feishu-[0-9a-f-]{36}$/);
        assert.match(second, /^feishu-[0-9a-f-]{36}$/);
        assert.notEqual(first, second);
    });
});

test('a malformed session map is reported and never overwritten with empty state', () => {
    withTempFile((file) => {
        const original = '{not valid json';
        writeFileSync(file, original, 'utf8');
        const errors = [];
        const warnings = [];
        const map = new SessionMap(file, undefined, {
            debug() {}, error: (message) => errors.push(message), warn: (message) => warnings.push(message),
        });
        map.load();
        map.ensure('chat-new');
        assert.equal(readFileSync(file, 'utf8'), original);
        assert.equal(errors.length, 1);
        assert.equal(warnings.length, 1);
    });
});

test('a malformed record cannot leave a partially loaded map in memory', () => {
    withTempFile((file) => {
        const original = JSON.stringify({
            version: 3,
            entries: {
                'chat-valid': 'session-valid',
                'chat-broken': '',
            },
        });
        writeFileSync(file, original, 'utf8');
        const errors = [];
        const map = new SessionMap(file, undefined, {
            debug() {}, error: (message) => errors.push(message), warn() {},
        });

        map.load();

        assert.equal(map.size, 0);
        assert.equal(map.get('chat-valid'), undefined);
        assert.equal(map.chatFor('session-valid'), undefined);
        assert.equal(readFileSync(file, 'utf8'), original);
        assert.equal(errors.length, 1);
    });
});
