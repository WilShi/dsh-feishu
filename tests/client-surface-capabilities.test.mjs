import assert from 'node:assert/strict';
import test from 'node:test';
import { CommandRegistry } from '../lib/commands.js';
import { registerSurfaceCommands } from '../lib/commands/surface.js';
import { setActiveLocale } from '../lib/i18n/index.js';
import { ModelPickAction, RepoPickAction, WorkspacePickAction } from '../lib/panel/actions/PickActions.js';

const EXPECTED_COMMANDS = [
    'help',
    'panel',
    'log',
    'group',
    'cancel',
    'cd',
    'repo',
    'workspaces',
    'status',
    'feishu-status',
    'schedule',
    'model',
    'mode',
    'export',
    'sessions',
    'resume',
    'clear',
    'new',
    'goal',
    'compact',
    'feedback',
    'permission',
    'plan',
];

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function commandHost(overrides = {}) {
    return {
        transport: {},
        sessionMap: {},
        agentStore: {},
        logger,
        groupMentionMode: 'always',
        transportMode: 'memory',
        appId: 'cli_test',
        openPanel: async () => 'card',
        pushPanel: async () => {},
        sendLog: async () => ({ kind: 'success', text: '' }),
        lastOutput: () => undefined,
        liveAgent: () => undefined,
        isWorking: () => false,
        resetChat: () => {},
        ensureAgent: async () => ({}),
        resumeSession: async () => ({ kind: 'success', text: '' }),
        selectAgentPreset: async () => ({ kind: 'success', text: '' }),
        ...overrides,
    };
}

test('the Feishu client exposes the complete operational command surface with localized buttons', () => {
    setActiveLocale('zh-CN');
    const commands = new CommandRegistry();
    registerSurfaceCommands(commands, commandHost());

    assert.deepEqual(commands.list().map((command) => command.name), EXPECTED_COMMANDS);
    for (const command of commands.list().filter((entry) => entry.hiddenFromPanel !== true)) {
        assert.equal(typeof command.buttonLabel, 'string', `missing button label for ${command.name}`);
        assert.notEqual(command.buttonLabel.trim(), '', `empty button label for ${command.name}`);
    }
});

test('/mode opens the Agent picker and direct mode selection uses the safe switch flow', async () => {
    const pushed = [];
    const selected = [];
    const commands = new CommandRegistry();
    registerSurfaceCommands(commands, commandHost({
        agentPresets: { defaultId: 'standard' },
        pushPanel: async (_chatId, view) => pushed.push(view),
        selectAgentPreset: async (chatId, preset) => {
            selected.push({ chatId, preset });
            return { kind: 'success', text: `selected ${preset}` };
        },
    }));

    const mode = commands.find('mode');
    const opened = await mode.handler({ chatId: 'chat-1', senderOpenId: 'user-1', rawInput: '' });
    assert.equal(opened.kind, 'success');
    assert.deepEqual(pushed, [{ kind: 'picker', picker: 'agent-preset', page: 0 }]);

    const switched = await mode.handler({ chatId: 'chat-1', senderOpenId: 'user-1', rawInput: 'codex-code' });
    assert.deepEqual(switched, { kind: 'success', text: 'selected codex-code' });
    assert.deepEqual(selected, [{ chatId: 'chat-1', preset: 'codex-code' }]);
});

test('/workspaces opens the registered-workspace manager and a path registers plus switches', async () => {
    const pushed = [];
    const calls = [];
    const registry = {
        resolveByPath: async (path) => { calls.push(['resolve', path]); return undefined; },
        create: async (path) => {
            calls.push(['create', path]);
            return { id: 'workspace-one', title: '项目一', path };
        },
    };
    const sessionMap = {
        setCwd: (chatId, path) => calls.push(['cwd', chatId, path]),
        remint: (chatId) => calls.push(['remint', chatId]),
    };
    const commands = new CommandRegistry();
    registerSurfaceCommands(commands, commandHost({
        sessionMap,
        getWorkspaceRegistry: () => registry,
        pushPanel: async (_chatId, view) => pushed.push(view),
    }));

    const invocation = { chatId: 'chat-1', senderOpenId: 'user-1', rawInput: '' };
    assert.equal((await commands.find('workspaces').handler(invocation)).kind, 'success');
    assert.deepEqual(pushed, [{ kind: 'picker', picker: 'workspace', page: 0 }]);

    const direct = await commands.find('workspaces').handler({
        ...invocation,
        rawInput: process.cwd(),
    });
    assert.equal(direct.kind, 'success');
    assert.deepEqual(calls.map(([kind]) => kind), ['resolve', 'create', 'cwd', 'remint']);
});

test('model picker waits for durable default-model persistence before reporting success', async () => {
    const expected = { provider: 'gateway', model: 'model-a' };
    const failure = new Error('settings write failed');
    const ctx = {
        services: {
            logger,
            agentDefaultModel: { saveSelection: async () => { throw failure; } },
        },
        parseModelArg: () => ({ ok: true, selection: expected }),
        liveAgent: () => undefined,
    };

    await assert.rejects(
        new ModelPickAction().work(ctx, {
            chatId: 'chat-1',
            messageId: 'card-1',
            operatorOpenId: 'user-1',
            option: 'gateway/model-a',
            value: { kind: 'model-pick' },
        }),
        failure,
    );
});

test('typed model switches are refused during a running turn', async () => {
    const saves = [];
    const commands = new CommandRegistry();
    registerSurfaceCommands(commands, commandHost({
        isWorking: () => true,
        agentDefaultModel: { saveSelection: async (selection) => saves.push(selection) },
    }));
    const result = await commands.find('model').handler({
        chatId: 'chat-1', senderOpenId: 'user-1', rawInput: 'gateway/model-a',
    });
    assert.equal(result.kind, 'error');
    assert.deepEqual(saves, []);
});

test('/status reports the active workspace, model, and Agent mode', async () => {
    setActiveLocale('en-US');
    const sessionMap = {
        get: () => 'session-1',
        cwdFor: () => 'D:/workspace-one',
    };
    const commands = new CommandRegistry();
    registerSurfaceCommands(commands, commandHost({
        sessionMap,
        agentStore: { get: () => ({ status: 'idle' }) },
        getWorkspaceRegistry: () => ({
            resolveByPath: async () => ({
                id: 'workspace-one',
                title: 'Workspace One',
                path: 'D:/workspace-one',
            }),
        }),
        currentModelSelection: () => 'gateway/model-a',
        currentAgentPreset: async () => 'codex-code',
        lastOutput: () => 'done',
    }));

    const result = await commands.find('status').handler({
        chatId: 'chat-1', senderOpenId: 'user-1', rawInput: '',
    });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /workspace: Workspace One \(D:\/workspace-one\)/);
    assert.match(result.text, /model: gateway\/model-a/);
    assert.match(result.text, /Agent mode: codex-code/);
});

test('project and workspace picks clear stale retry state after reminting', () => {
    for (const Action of [RepoPickAction, WorkspacePickAction]) {
        const calls = [];
        const ctx = {
            services: {
                sessionMap: {
                    setCwd: (chatId, path) => calls.push(['cwd', chatId, path]),
                    remint: (chatId) => calls.push(['remint', chatId]),
                },
            },
            resolveDirectory: (path) => ({ ok: true, path }),
            resetChat: (chatId) => calls.push(['reset', chatId]),
        };
        const result = new Action().work(ctx, {
            chatId: 'chat-1',
            messageId: 'card-1',
            operatorOpenId: 'user-1',
            option: 'D:/workspace',
            value: { kind: 'pick' },
        });
        assert.equal(result.kind, 'success');
        assert.deepEqual(calls.map(([kind]) => kind), ['cwd', 'remint', 'reset']);
    }
});
