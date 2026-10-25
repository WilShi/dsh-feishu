import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionDetailCard } from '../lib/cards/session-list.js';
import { buildWorkspaceDetailCard, buildWorkspacePickerCard } from '../lib/cards/render.js';
import { setActiveLocale } from '../lib/i18n/index.js';
import { PanelInputSubmitAction } from '../lib/panel/actions/CommandActions.js';
import {
    WorkspaceAddAction,
    WorkspaceInspectAction,
    WorkspaceRemoveAction,
    WorkspaceRenameAction,
} from '../lib/panel/actions/NavigatorActions.js';
import { SessionForkAction } from '../lib/panel/actions/SessionActions.js';
import { WorkspaceRemoveConfirmAction } from '../lib/panel/actions/WorkspaceActions.js';
import { listRegisteredWorkspaces } from '../lib/workspaces.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function actionKinds(card) {
    const kinds = [];
    const visit = (value) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value === null || typeof value !== 'object') return;
        if (typeof value.value?.kind === 'string') kinds.push(value.value.kind);
        Object.values(value).forEach(visit);
    };
    visit(card);
    return kinds;
}

function selectOptions(card, kind) {
    const options = [];
    const visit = (value) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value === null || typeof value !== 'object') return;
        if (value.tag === 'select_static' && value.value?.kind === kind) {
            options.push(...(value.options ?? []));
        }
        Object.values(value).forEach(visit);
    };
    visit(card);
    return options;
}

function panelAction(kind, value = {}, formValue) {
    return {
        chatId: 'chat-1',
        messageId: 'card-1',
        operatorOpenId: 'user-1',
        value: { kind, ...value },
        ...(formValue === undefined ? {} : { formValue }),
    };
}

test('registered workspaces preserve DSH title, order, status, and session count', async () => {
    const rows = await listRegisteredWorkspaces({
        list: () => [
            {
                id: 'workspace-two',
                title: '产品工作区',
                path: 'D:/source/folder-two',
                sessionIds: ['s1', 's2'],
                status: async () => 'ok',
            },
            {
                id: 'workspace-one',
                title: '归档项目',
                path: 'D:/source/folder-one',
                sessionIds: [],
                status: async () => 'missing-dir',
            },
        ],
    });

    assert.deepEqual(rows.map((row) => row.workspaceId), ['workspace-two', 'workspace-one']);
    assert.deepEqual(rows.map((row) => row.name), ['产品工作区', '归档项目']);
    assert.deepEqual(rows.map((row) => row.sessionCount), [2, 0]);
    assert.deepEqual(rows.map((row) => row.status), ['ok', 'missing-dir']);
});

test('registered workspace picker shows DSH names and exposes switching plus management', () => {
    setActiveLocale('zh-CN');
    const rows = [
        {
            workspaceId: 'workspace-one',
            name: '客户项目 A',
            path: 'D:/source/unrelated-folder-name',
            root: 'D:/source',
            registered: true,
            sessionCount: 3,
            status: 'ok',
        },
    ];
    const card = buildWorkspacePickerCard(rows, undefined, [], 0);

    assert.match(JSON.stringify(card), /客户项目 A/);
    assert.deepEqual(selectOptions(card, 'workspace-pick').map((option) => option.value), [rows[0].path]);
    assert.deepEqual(selectOptions(card, 'workspace-inspect').map((option) => option.value), ['workspace-one']);
    assert.ok(actionKinds(card).includes('workspace-add'));
    assert.ok(actionKinds(card).includes('workspace-find'));
    assert.ok(actionKinds(card).includes('workspace-inspect'));
});

test('workspace detail supports switch, rename, and safe removal', () => {
    setActiveLocale('zh-CN');
    const workspace = {
        workspaceId: 'workspace-one',
        name: '客户项目 A',
        path: 'D:/source/project-a',
        root: 'D:/source',
        registered: true,
        sessionCount: 4,
        status: 'ok',
    };
    const card = buildWorkspaceDetailCard(workspace, 'D:/other');
    const kinds = actionKinds(card);
    assert.ok(kinds.includes('workspace-pick'));
    assert.ok(kinds.includes('workspace-rename'));
    assert.ok(kinds.includes('workspace-remove'));
    assert.match(JSON.stringify(card), /4/);

    const missing = buildWorkspaceDetailCard({ ...workspace, status: 'missing-dir' }, 'D:/other');
    assert.ok(!actionKinds(missing).includes('workspace-pick'));
});

test('workspace navigation actions open the expected card views', async () => {
    const pushed = [];
    const ctx = {
        services: { logger },
        pushPanel: async (_chatId, view) => pushed.push(view),
    };

    await new WorkspaceAddAction().run(ctx, panelAction('workspace-add'));
    await new WorkspaceInspectAction().run(ctx, {
        ...panelAction('workspace-inspect'),
        option: 'workspace-one',
    });
    await new WorkspaceRenameAction().run(ctx, panelAction('workspace-rename', { workspaceId: 'workspace-one' }));
    await new WorkspaceRemoveAction().run(ctx, panelAction('workspace-remove', { workspaceId: 'workspace-one' }));

    assert.deepEqual(pushed, [
        { kind: 'input', command: 'add-workspace' },
        { kind: 'workspace-detail', workspaceId: 'workspace-one' },
        { kind: 'input', command: 'rename-workspace', workspaceId: 'workspace-one' },
        { kind: 'workspace-remove-confirm', workspaceId: 'workspace-one' },
    ]);
});

test('add workspace creates only when needed, then switches and remints the chat', async () => {
    const calls = [];
    const created = { id: 'workspace-new', title: '新工作区', path: 'D:/source/new' };
    const registry = {
        resolveByPath: async (path) => { calls.push(['resolve', path]); return undefined; },
        create: async (path) => { calls.push(['create', path]); return created; },
    };
    const ctx = {
        services: {
            logger,
            getWorkspaceRegistry: () => registry,
            sessionMap: {
                setCwd: (chatId, path) => calls.push(['cwd', chatId, path]),
                remint: (chatId) => calls.push(['remint', chatId]),
            },
        },
        resolveDirectory: () => ({ ok: true, path: 'D:/source/new' }),
        resetChat: (chatId) => calls.push(['reset', chatId]),
    };
    const result = await new PanelInputSubmitAction().work(
        ctx,
        panelAction('panel-input-submit', { command: 'add-workspace' }, { path: 'D:/source/new' }),
    );

    assert.equal(result.kind, 'success');
    assert.deepEqual(calls, [
        ['resolve', 'D:/source/new'],
        ['create', 'D:/source/new'],
        ['cwd', 'chat-1', 'D:/source/new'],
        ['remint', 'chat-1'],
        ['reset', 'chat-1'],
    ]);

    calls.length = 0;
    registry.resolveByPath = async (path) => { calls.push(['resolve', path]); return created; };
    await new PanelInputSubmitAction().work(
        ctx,
        panelAction('panel-input-submit', { command: 'add-workspace' }, { path: 'D:/source/new' }),
    );
    assert.ok(!calls.some(([kind]) => kind === 'create'));
});

test('workspace rename validates conflicts and writes through the DSH entity', async () => {
    const renamed = [];
    const workspace = {
        id: 'workspace-one',
        title: '旧名称',
        setTitle: async (title) => renamed.push(title),
    };
    const registry = {
        get: () => workspace,
        list: () => [workspace, { id: 'workspace-two', title: '已存在' }],
    };
    const ctx = { services: { logger, getWorkspaceRegistry: () => registry } };
    const action = (title) => panelAction(
        'panel-input-submit',
        { command: 'rename-workspace', workspaceId: 'workspace-one' },
        { title },
    );

    assert.equal((await new PanelInputSubmitAction().work(ctx, action(''))).kind, 'error');
    assert.equal((await new PanelInputSubmitAction().work(ctx, action('已存在'))).kind, 'error');
    assert.equal((await new PanelInputSubmitAction().work(ctx, action('新名称'))).kind, 'success');
    assert.deepEqual(renamed, ['新名称']);
});

test('workspace removal deletes only the registration and clears a matching pinned cwd', async () => {
    const calls = [];
    const workspace = { id: 'workspace-one', title: '项目 A', path: 'D:/source/project-a' };
    const ctx = {
        services: {
            logger,
            getWorkspaceRegistry: () => ({
                get: () => workspace,
                delete: async (id) => { calls.push(['delete', id]); return true; },
            }),
            sessionMap: {
                cwdFor: () => 'd:/SOURCE/project-a',
                clearCwd: (chatId) => calls.push(['clear-cwd', chatId]),
            },
        },
        resetChat: (chatId) => calls.push(['reset', chatId]),
    };
    const result = await new WorkspaceRemoveConfirmAction().work(
        ctx,
        panelAction('workspace-remove-confirm', { workspaceId: 'workspace-one' }),
    );

    assert.equal(result.kind, 'success');
    assert.deepEqual(calls, [
        ['delete', 'workspace-one'],
        ['clear-cwd', 'chat-1'],
        ['reset', 'chat-1'],
    ]);
});

test('archived session detail exposes no unsupported mutations', () => {
    setActiveLocale('zh-CN');
    const archived = {
        sessionId: 'session-old',
        title: '旧会话',
        cwd: 'D:/source/project-a',
        createdAt: Date.now(),
        messageCount: 3,
        live: false,
        current: false,
        archived: true,
    };
    const card = buildSessionDetailCard(archived, true, true);
    const kinds = actionKinds(card);
    assert.ok(kinds.includes('session-export'));
    assert.ok(!kinds.includes('resume-session'));
    assert.ok(!kinds.includes('session-rename'));
    assert.ok(!kinds.includes('session-archive'));
    assert.ok(!kinds.includes('session-fork'));

});

test('session fork delegates to DSH and binds the chat to the returned child', async () => {
    const calls = [];
    const ctx = {
        services: { logger },
        panelViewFor: () => ({ kind: 'session-detail', sessionId: 'session-parent' }),
        forkSession: async (chatId, sessionId, cwd) => {
            calls.push([chatId, sessionId, cwd]);
            return { kind: 'success', text: 'ok' };
        },
    };
    const result = await new SessionForkAction().work(
        ctx,
        panelAction('session-fork', { sessionId: 'session-parent', cwd: 'D:/source/project-a' }),
    );
    assert.equal(result.kind, 'success');
    assert.deepEqual(calls, [['chat-1', 'session-parent', 'D:/source/project-a']]);
});
