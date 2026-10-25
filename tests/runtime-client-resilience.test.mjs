import assert from 'node:assert/strict';
import test from 'node:test';
import { Bridge } from '../lib/bridge.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function bridgeHarness(overrides = {}) {
    const patches = [];
    const texts = [];
    const transport = {
        onMessage() {},
        onCardAction() {},
        getBotOpenId: () => undefined,
        updateCard: async (messageId, card) => patches.push({ messageId, card }),
        sendCard: async () => ({ messageId: 'new-card' }),
        sendText: async (_chatId, text) => texts.push(text),
        ...overrides.transport,
    };
    const sessionMap = {
        get: () => 'session-1',
        ...overrides.sessionMap,
    };
    const options = {
        transport,
        sessionMap,
        agentStore: { get: () => undefined, resume: async () => ({}), create: async () => ({}) },
        onSessionEvent: () => () => {},
        onAssistantStream: () => () => {},
        cards: {},
        defaultCwd: process.cwd(),
        dataDir: process.cwd(),
        logger,
        ...overrides.options,
    };
    return { bridge: new Bridge(options), patches, texts };
}

function memorySurfaceState() {
    let document;
    return {
        load: () => document,
        persist: (state) => { document = { version: 1, ...structuredClone(state) }; },
        snapshot: () => document,
    };
}

test('message text removes only the real bot mention and preserves normal @ content', async () => {
    const received = [];
    const { bridge } = bridgeHarness({
        transport: { getBotOpenId: () => 'ou_bot' },
    });
    bridge.deliverTurn = async (message) => received.push(message.text);

    await bridge.handleMessage({
        messageId: 'message-mentions',
        chatId: 'chat-1',
        chatType: 'p2p',
        senderOpenId: 'user-1',
        text: '@_user_1 contact alice@company.com about @scope/package',
        attachments: [],
        mentions: ['ou_bot'],
        mentionTokens: [{ key: '@_user_1', openId: 'ou_bot', name: 'DSH' }],
        createdAt: Date.now(),
    });

    assert.deepEqual(received, ['contact alice@company.com about @scope/package']);
    bridge.dispose();
});

test('same-chat messages serialize before the running-turn queue gate', async () => {
    let releaseReaction;
    const reactionGate = new Promise((resolve) => { releaseReaction = resolve; });
    const followups = [];
    const agent = {
        status: 'running',
        inbox: {},
        followup: (message) => followups.push(message),
    };
    const cards = [];
    const { bridge } = bridgeHarness({
        transport: {
            addReaction: async () => {
                await reactionGate;
                return 'reaction-1';
            },
            sendCard: async (_chatId, card) => {
                cards.push(card);
                return { messageId: `card-${cards.length}` };
            },
        },
        sessionMap: {
            get: () => 'session-1',
            ensure: () => 'session-1',
            cwdFor: () => process.cwd(),
        },
        options: {
            requireWorkingDir: true,
            agentStore: { get: () => agent, resume: async () => agent, create: async () => agent },
            cards: { open: async () => {} },
        },
    });
    const message = (id, text) => ({
        messageId: id,
        chatId: 'chat-1',
        chatType: 'p2p',
        senderOpenId: 'user-1',
        text,
        attachments: [],
        mentions: [],
        createdAt: Date.now(),
    });

    const first = bridge.handleMessage(message('message-first', 'first'));
    const second = bridge.handleMessage(message('message-second', 'second'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(followups.length, 0);

    releaseReaction();
    await Promise.all([first, second]);
    assert.equal(followups.length, 1);
    assert.equal(bridge.queued.get('chat-1').length, 1);
    assert.equal(bridge.queued.get('chat-1')[0].text, 'second');
    bridge.dispose();
});

test('an instruction sent immediately after a file waits for the completed save', async () => {
    let releaseSave;
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    const followups = [];
    const agent = { followup: (message) => followups.push(message) };
    const { bridge } = bridgeHarness({
        transport: {
            downloadFile: async () => ({ stream: {}, head: new Uint8Array([0x25, 0x50, 0x44, 0x46]) }),
            addReaction: async () => 'reaction-1',
        },
        sessionMap: {
            get: () => 'session-1',
            ensure: () => 'session-1',
            cwdFor: () => process.cwd(),
        },
        options: {
            requireWorkingDir: true,
            saveInboundFile: async () => {
                await saveGate;
                return { path: 'D:/workspace/.dsh_feishu/report.pdf' };
            },
            agentStore: { get: () => agent, resume: async () => agent, create: async () => agent },
            cards: { open: async () => {} },
        },
    });
    const file = bridge.handleMessage({
        messageId: 'message-file', chatId: 'chat-1', chatType: 'p2p', senderOpenId: 'user-1',
        text: '', attachments: [{ kind: 'file', key: 'file-1', name: 'report.pdf' }], mentions: [], createdAt: Date.now(),
    });
    const instruction = bridge.handleMessage({
        messageId: 'message-instruction', chatId: 'chat-1', chatType: 'p2p', senderOpenId: 'user-1',
        text: 'summarize it', attachments: [], mentions: [], createdAt: Date.now(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(followups.length, 0);

    releaseSave();
    await Promise.all([file, instruction]);
    assert.equal(followups.length, 1);
    const texts = followups[0].content.filter((block) => block.type === 'text').map((block) => block.text);
    assert.match(texts[0], /^\[user sent a file: report\.pdf .*D:\/workspace\/\.dsh_feishu\/report\.pdf\./);
    assert.equal(texts[1], 'summarize it');
    bridge.dispose();
});

test('durable dedup ignores completed redelivery but releases failed claims', async () => {
    const surfaceState = memorySurfaceState();
    const message = {
        messageId: 'message-durable', chatId: 'chat-1', chatType: 'p2p', senderOpenId: 'user-1',
        text: 'hello', attachments: [], mentions: [], createdAt: Date.now(),
    };
    const first = bridgeHarness({ options: { surfaceState } });
    const delivered = [];
    first.bridge.deliverTurn = async (received) => delivered.push(received.messageId);
    await first.bridge.handleMessage(message);
    first.bridge.dispose();

    const restored = bridgeHarness({ options: { surfaceState } });
    restored.bridge.deliverTurn = async (received) => delivered.push(received.messageId);
    await restored.bridge.handleMessage(message);
    assert.deepEqual(delivered, ['message-durable']);

    let attempts = 0;
    restored.bridge.deliverTurn = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
    };
    const retry = { ...message, messageId: 'message-retry' };
    await assert.rejects(restored.bridge.handleMessage(retry), /transient/);
    await restored.bridge.handleMessage(retry);
    assert.equal(attempts, 2);
    restored.bridge.dispose();
});

test('pending attachments and queued turns survive a bridge restart', async () => {
    const surfaceState = memorySurfaceState();
    const first = bridgeHarness({
        options: { surfaceState },
    });
    first.bridge.pendingInbound.set('chat-1', [{
        attachment: { kind: 'file', key: 'file-1', name: 'report.pdf' },
        name: 'report.pdf',
        savedPath: 'D:/workspace/report.pdf',
    }]);
    const queued = {
        cardMessageId: 'queue-card-1',
        status: 'editing',
        text: 'queued task',
        message: { id: 'queued-message-1', content: [{ type: 'text', text: 'queued task' }], source: { kind: 'user' } },
        feishu: {
            messageId: 'feishu-queued-1', chatId: 'chat-2', chatType: 'p2p', senderOpenId: 'user-2',
            text: 'queued task', attachments: [], mentions: [], createdAt: Date.now(),
        },
    };
    first.bridge.queued.set('chat-2', [queued]);
    first.bridge.queueCards.set('chat-2', new Map([[queued.message.id, queued]]));
    first.bridge.persistSurfaceState();
    first.bridge.dispose();

    const followups = [];
    const agent = { followup: (message) => followups.push(message) };
    const restored = bridgeHarness({
        transport: { addReaction: async () => 'reaction', sendCard: async () => ({ messageId: 'restored-card' }) },
        sessionMap: {
            get: () => 'session-1', ensure: () => 'session-1', cwdFor: () => process.cwd(),
        },
        options: {
            surfaceState,
            agentStore: { get: () => agent, resume: async () => agent, create: async () => agent },
            cards: { open: async () => {} },
        },
    });
    assert.equal(restored.bridge.pendingInbound.get('chat-1')[0].savedPath, 'D:/workspace/report.pdf');
    assert.equal(restored.bridge.queued.get('chat-2')[0].status, 'queued');
    await restored.bridge.recoverPendingState();
    assert.equal(followups.length, 1);
    assert.equal(followups[0].id, 'queued-message-1');
    assert.equal(restored.bridge.queued.get('chat-2')?.length ?? 0, 0);
    restored.bridge.dispose();
});

test('topic mode accepts owned-thread replies without a second mention and keeps replies threaded', async () => {
    const surfaceState = memorySurfaceState();
    const replyTargets = [];
    const make = () => bridgeHarness({
        transport: {
            getBotOpenId: () => 'ou_bot',
            chatStats: async () => ({ userCount: 3, botCount: 1 }),
            setReplyTarget: (chatId, target) => replyTargets.push({ chatId, target }),
        },
        options: { groupMentionMode: 'topic', surfaceState },
    }).bridge;
    const first = make();
    const accepted = [];
    first.deliverTurn = async (message) => accepted.push(message.messageId);
    await first.handleMessage({
        messageId: 'topic-root', chatId: 'group-1', chatType: 'group', senderOpenId: 'user-1',
        text: '@_user_1 start', attachments: [], mentions: ['ou_bot'],
        mentionTokens: [{ key: '@_user_1', openId: 'ou_bot' }], createdAt: Date.now(),
    });
    first.dispose();

    const restored = make();
    restored.deliverTurn = async (message) => accepted.push(message.messageId);
    await restored.handleMessage({
        messageId: 'topic-reply', rootId: 'topic-root', threadId: 'thread-1', replyToMessageId: 'topic-root',
        chatId: 'group-1', chatType: 'group', senderOpenId: 'user-1', text: 'continue',
        attachments: [], mentions: [], createdAt: Date.now(),
    });
    await restored.handleMessage({
        messageId: 'unrelated-root', chatId: 'group-1', chatType: 'group', senderOpenId: 'user-2',
        text: 'unrelated', attachments: [], mentions: [], createdAt: Date.now(),
    });
    assert.deepEqual(accepted, ['topic-root', 'topic-reply']);
    assert.deepEqual(replyTargets.at(-1), {
        chatId: 'group-1', target: { messageId: 'topic-reply', replyInThread: true },
    });
    restored.dispose();
});

test('late-mounted DSH services become available without restarting Feishu', async () => {
    let defaultModel;
    let llm;
    const saves = [];
    const { bridge } = bridgeHarness({
        options: {
            getAgentDefaultModel: () => defaultModel,
            getLlm: () => llm,
        },
    });

    assert.equal(bridge.currentModelSelection('chat-1'), undefined);
    assert.equal(await bridge.loadModelOptions(), undefined);

    defaultModel = {
        currentSelection: () => ({ provider: 'gateway', model: 'model-a' }),
        saveSelection: async (selection) => saves.push(selection),
    };
    llm = {
        listProviders: () => [{ id: 'gateway', name: 'Gateway' }],
        listModels: async () => [{ provider: 'gateway', id: 'model-a', name: 'Model A' }],
    };

    assert.equal(bridge.currentModelSelection('chat-1'), 'gateway/model-a');
    assert.deepEqual(await bridge.loadModelOptions(), [{
        value: 'gateway/model-a',
        label: 'gateway · Model A',
        current: false,
    }]);

    const model = bridge.commandsList().find((command) => command.name === 'model');
    const result = await model.handler({ chatId: 'chat-1', senderOpenId: 'user-1', rawInput: 'gateway/model-a' });
    assert.equal(result.kind, 'success');
    assert.deepEqual(saves, [{ provider: 'gateway', model: 'model-a' }]);
    bridge.dispose();
});

test('direct workspace commands use the real late-bound DSH registry', async () => {
    const calls = [];
    const workspace = { id: 'workspace-1', path: process.cwd(), title: 'Current project' };
    let registry;
    const { bridge } = bridgeHarness({
        sessionMap: {
            setCwd: (chatId, path) => calls.push(['cwd', chatId, path]),
            remint: (chatId) => { calls.push(['remint', chatId]); return 'session-new'; },
        },
        options: {
            getWorkspaceRegistry: () => registry,
        },
    });
    registry = {
        resolveByPath: async (path) => { calls.push(['resolve', path]); return undefined; },
        create: async (path, title) => { calls.push(['create', path, title]); return workspace; },
    };

    const command = bridge.commandsList().find((entry) => entry.name === 'workspaces');
    const result = await command.handler({
        chatId: 'chat-1',
        senderOpenId: 'user-1',
        rawInput: process.cwd(),
    });
    assert.equal(result.kind, 'success');
    assert.deepEqual(calls.map(([kind]) => kind), ['resolve', 'create', 'cwd', 'remint']);
    bridge.dispose();
});

test('Agent mode discovery is late-bound and switching preserves the old session', async () => {
    let agentPresets;
    let currentSession = 'session-old';
    const remembered = [];
    const created = [];
    const sessionMap = {
        get: () => currentSession,
        ensure: () => currentSession,
        agentPresetFor: () => remembered.at(-1)?.preset,
        setAgentPreset: (chatId, preset) => remembered.push({ chatId, preset }),
        remint: () => { currentSession = 'session-new'; return currentSession; },
        cwdFor: () => 'D:/workspace',
    };
    const { bridge } = bridgeHarness({
        sessionMap,
        options: {
            getAgentPresets: () => agentPresets,
            agentStore: {
                get: () => undefined,
                presetFor: async () => 'standard',
                resume: async () => { throw new Error('not persisted'); },
                create: async (sessionId, cwd, preset) => {
                    created.push({ sessionId, cwd, preset });
                    return { session: {}, ctx: {} };
                },
            },
        },
    });

    assert.equal(await bridge.loadAgentPresetOptions('chat-1'), undefined);
    agentPresets = {
        defaultId: 'standard',
        list: async () => [
            { id: 'standard', name: 'Standard' },
            { id: 'codex-code', name: 'Codex', description: 'Codex kernel' },
            { id: 'broken', broken: 'missing package' },
        ],
        resolve: async (id) => {
            const found = (await agentPresets.list()).find((preset) => preset.id === id);
            if (found === undefined) throw new Error('not found');
            return found;
        },
        composedPreset: () => undefined,
    };

    const listed = await bridge.loadAgentPresetOptions('chat-1');
    assert.equal(listed.find((preset) => preset.id === 'standard').current, true);
    assert.equal(listed.find((preset) => preset.id === 'broken').broken, 'missing package');

    bridge.pendingInbound.set('chat-1', [{ name: 'old-workspace.txt' }]);
    bridge.queued.set('chat-1', [{ message: { id: 'queued-old' } }]);
    bridge.queueCards.set('chat-1', new Map([['queued-old', {}]]));

    const switched = await bridge.selectAgentPreset('chat-1', 'codex-code');
    assert.equal(switched.kind, 'success');
    assert.equal(currentSession, 'session-new');
    assert.deepEqual(remembered.at(-1), { chatId: 'chat-1', preset: 'codex-code' });
    assert.equal(bridge.pendingInbound.has('chat-1'), false);
    assert.equal(bridge.queued.has('chat-1'), false);
    assert.equal(bridge.queueCards.has('chat-1'), false);

    await bridge.ensureAgent('chat-1');
    assert.deepEqual(created, [{ sessionId: 'session-new', cwd: 'D:/workspace', preset: 'codex-code' }]);

    const refused = await bridge.selectAgentPreset('chat-1', 'broken');
    assert.equal(refused.kind, 'error');
    assert.equal(currentSession, 'session-new');
    bridge.dispose();
});

test('plugin slash commands lazily restore a persisted session before execution', async () => {
    const executed = [];
    let resumed = 0;
    const agent = { status: 'idle', ctx: {}, options: {} };
    const { bridge, texts } = bridgeHarness({
        sessionMap: {
            get: () => 'session-persisted',
            ensure: () => 'session-persisted',
            cwdFor: () => 'D:/workspace',
            agentPresetFor: () => 'standard',
        },
        options: {
            agentStore: {
                get: () => undefined,
                resume: async (sessionId) => {
                    resumed += 1;
                    assert.equal(sessionId, 'session-persisted');
                    return agent;
                },
                create: async () => { throw new Error('must resume'); },
            },
            executeCommand: async (received, line) => {
                executed.push({ received, line });
                return { kind: 'success', text: 'plugin command ok' };
            },
        },
    });

    await bridge.handleMessage({
        messageId: 'message-plugin-command',
        chatId: 'chat-1',
        chatType: 'p2p',
        senderOpenId: 'user-1',
        text: '/oc doctor',
        attachments: [],
        mentions: [],
        createdAt: Date.now(),
    });

    assert.equal(resumed, 1);
    assert.deepEqual(executed, [{ received: agent, line: '/oc doctor' }]);
    assert.deepEqual(texts, ['plugin command ok']);
    bridge.dispose();
});

test('plugin slash commands cannot mutate a session during a running turn', async () => {
    let executed = 0;
    const { bridge, texts } = bridgeHarness({
        sessionMap: {
            get: () => 'session-running',
            ensure: () => 'session-running',
            cwdFor: () => 'D:/workspace',
        },
        options: {
            executeCommand: async () => {
                executed += 1;
                return { kind: 'success', text: 'must not run' };
            },
        },
    });
    bridge.streaming.cardStates.set('chat-1', {
        title: 'Running',
        content: '',
        rows: [],
        status: 'working',
        collapsed: true,
        stopRequested: false,
        producedPaths: [],
    });

    await bridge.handleMessage({
        messageId: 'message-plugin-command-running',
        chatId: 'chat-1',
        chatType: 'p2p',
        senderOpenId: 'user-1',
        text: '/oc doctor',
        attachments: [],
        mentions: [],
        createdAt: Date.now(),
    });

    assert.equal(executed, 0);
    assert.equal(texts.length, 1);
    assert.doesNotMatch(texts[0], /must not run/);
    bridge.dispose();
});

test('inbound Feishu images reach DSH as native image blocks and keep the workspace fallback', async () => {
    const imageRef = {
        attachmentId: 'sha256:image',
        mediaType: 'image/png',
        bytes: 8,
        width: 1,
        height: 1,
        name: 'image-key',
    };
    const saved = [];
    const { bridge } = bridgeHarness({
        transport: {
            downloadImage: async () => ({ data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }),
        },
        options: {
            appId: 'cli-test',
            saveInboundImage: async (input) => {
                saved.push(input);
                return imageRef;
            },
            saveInboundFile: async () => ({ path: 'D:/workspace/.dsh_feishu/image.png' }),
        },
    });
    const content = await bridge.inboundContent({
        messageId: 'message-1',
        chatId: 'chat-1',
        chatType: 'p2p',
        senderOpenId: 'user-1',
        text: 'describe this image',
        attachments: [{ kind: 'image', key: 'image-key' }],
        mentions: [],
        createdAt: Date.now(),
    });
    assert.equal(saved[0].mediaType, 'image/png');
    assert.deepEqual(content, [
        { type: 'text', text: 'describe this image' },
        { type: 'image', attachment: imageRef },
        { type: 'text', text: '[user sent a file: image-key — saved at D:/workspace/.dsh_feishu/image.png. You can read it with your file tools.]' },
    ]);
    bridge.dispose();
});

test('inbound Feishu files keep a durable DSH file reference plus the readable workspace path', async () => {
    const fileRef = { attachmentId: 'sha256:file', name: 'report.xlsx', bytes: 42 };
    const { bridge } = bridgeHarness({
        transport: {
            downloadFile: async () => ({
                stream: {},
                head: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
            }),
        },
        options: {
            appId: 'cli-test',
            saveInboundFile: async () => ({
                path: 'D:/workspace/.dsh_feishu/report.xlsx',
                fileAttachment: fileRef,
            }),
        },
    });
    const content = await bridge.inboundContent({
        messageId: 'message-2',
        chatId: 'chat-1',
        chatType: 'p2p',
        senderOpenId: 'user-1',
        text: 'summarize this workbook',
        attachments: [{ kind: 'file', key: 'file-key', name: 'report.xlsx' }],
        mentions: [],
        createdAt: Date.now(),
    });
    assert.deepEqual(content, [
        { type: 'text', text: 'summarize this workbook' },
        { type: 'file', attachment: fileRef },
        { type: 'text', text: '[user sent a file: report.xlsx — saved at D:/workspace/.dsh_feishu/report.xlsx. You can read it with your file tools.]' },
    ]);
    bridge.dispose();
});

test('queued message edit keeps attachment notes and edit/remove work without a live agent', async () => {
    const { bridge, patches } = bridgeHarness();
    const entry = {
        cardMessageId: 'queue-card',
        status: 'queued',
        text: 'old instruction',
        message: {
            id: 'queued-1',
            content: [
                { type: 'text', text: 'old instruction' },
                { type: 'text', text: '[user sent a file: report.xlsx — saved at D:/work/report.xlsx]' },
            ],
            source: { kind: 'user' },
        },
        feishu: { messageId: 'feishu-1', senderOpenId: 'user-1', chatType: 'p2p' },
    };
    bridge.queueCards.set('chat-1', new Map([['queued-1', entry]]));
    bridge.queued.set('chat-1', [entry]);

    await bridge.handleCardAction({
        chatId: 'chat-1',
        messageId: 'queue-card',
        operatorOpenId: 'user-1',
        value: { kind: 'queue-edit-submit', id: 'queued-1' },
        formValue: { text: 'summarize this workbook' },
    });
    assert.equal(entry.status, 'queued');
    assert.deepEqual(entry.message.content, [
        { type: 'text', text: 'summarize this workbook' },
        { type: 'text', text: '[user sent a file: report.xlsx — saved at D:/work/report.xlsx]' },
    ]);

    await bridge.handleCardAction({
        chatId: 'chat-1',
        messageId: 'queue-card',
        operatorOpenId: 'user-1',
        value: { kind: 'queue-remove', id: 'queued-1' },
    });
    assert.equal(entry.status, 'removed');
    assert.equal(bridge.queued.get('chat-1')?.length ?? 0, 0);
    assert.equal(patches.length, 2);
    bridge.dispose();
});

test('per-chat queue and pending-attachment limits refuse excess work without downloading it', async () => {
    const agent = { status: 'running', inbox: {}, followup() {} };
    const { bridge, texts } = bridgeHarness({
        sessionMap: {
            get: () => 'session-1',
            ensure: () => 'session-1',
            cwdFor: () => process.cwd(),
        },
        options: {
            maxQueuedTurns: 1,
            maxPendingAttachments: 1,
            agentStore: { get: () => agent, resume: async () => agent, create: async () => agent },
        },
    });
    bridge.streaming.cardStates.set('chat-1', {
        title: 'Running', content: '', rows: [], status: 'working', collapsed: true,
        stopRequested: false, producedPaths: [],
    });
    const message = (id, text) => ({
        messageId: id, chatId: 'chat-1', chatType: 'p2p', senderOpenId: 'user-1',
        text, attachments: [], mentions: [], createdAt: Date.now(),
    });

    await bridge.handleMessage(message('queued-1', 'first queued'));
    await bridge.handleMessage(message('queued-2', 'must be refused'));
    assert.equal(bridge.queued.get('chat-1').length, 1);
    assert.match(texts.at(-1), /1/);

    const saved = [];
    bridge.saveInboundFileAttachment = async (_message, attachment) => {
        saved.push(attachment.key);
        return { attachment, name: attachment.name ?? attachment.key, savedPath: `D:/${attachment.key}` };
    };
    await bridge.registerPending({
        messageId: 'files-1', chatId: 'chat-files', chatType: 'p2p', senderOpenId: 'user-1',
        text: '', mentions: [], createdAt: Date.now(),
        attachments: [
            { kind: 'file', key: 'file-1', name: 'one.txt' },
            { kind: 'file', key: 'file-2', name: 'two.txt' },
        ],
    });
    assert.deepEqual(saved, ['file-1']);
    assert.equal(bridge.pendingInbound.get('chat-files').length, 1);
    assert.match(texts.find((text) => text.includes('文件') || text.includes('file')), /1/);
    bridge.dispose();
});
