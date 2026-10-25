import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSessionsCard } from '../lib/cards/session-list.js';
import { buildWorkspacePickerCard } from '../lib/cards/render.js';
import { setActiveLocale } from '../lib/i18n/index.js';
import { CommandAction } from '../lib/panel/actions/CommandActions.js';
import { SessionScopeAction, WorkspaceFindAction } from '../lib/panel/actions/NavigatorActions.js';
import { SessionsViewState, WorkspacePickerViewState } from '../lib/panel/views/PanelViewStates.js';
import { effectiveSessionScope, filterArchivedSessionRows, filterSessionRowsByScope } from '../lib/session-visibility.js';
import { listWorkspaceDirectories } from '../lib/workspaces.js';

function actionsIn(card) {
    const actions = [];
    const visit = (value) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value === null || typeof value !== 'object') return;
        if (value.value?.kind) actions.push({ value: value.value, text: value.text?.content, type: value.type });
        Object.values(value).forEach(visit);
    };
    visit(card);
    return actions;
}

function selectOptions(card) {
    return card.elements
        .flatMap((element) => element.actions ?? [])
        .filter((action) => action.tag === 'select_static')
        .flatMap((action) => action.options ?? []);
}

test('workspace card supports current, favorites, recent, search, and custom path', () => {
    setActiveLocale('zh-CN');
    const rows = [
        { name: 'alpha', path: 'D:/work/alpha', root: 'D:/work' },
        { name: 'beta', path: 'D:/work/beta', root: 'D:/work' },
        { name: 'outside', path: 'E:/outside', root: 'E:/' },
    ];
    const full = buildWorkspacePickerCard(rows, 'D:/work/alpha', ['D:/work'], 0, {
        favoritePaths: ['D:/work/alpha'],
        recentPaths: ['D:/work/beta'],
    });
    const json = JSON.stringify(full);
    assert.match(json, /当前工作区/);
    assert.match(json, /收藏的工作区/);
    assert.match(json, /最近使用/);
    assert.deepEqual(
        new Set(actionsIn(full).map((entry) => entry.value.kind)),
        new Set(['workspace-pick', 'workspace-find', 'workspace-add', 'command', 'workspace-favorite-toggle']),
    );

    const filtered = buildWorkspacePickerCard(rows, undefined, ['D:/work'], 0, {
        query: 'beta',
        favoritePaths: ['D:/work/alpha'],
        recentPaths: ['E:/outside'],
    });
    assert.deepEqual(selectOptions(filtered).map((option) => option.value), ['D:/work/beta']);
    assert.doesNotMatch(JSON.stringify(filtered), /收藏的工作区|最近使用/);
});

test('workspace discovery includes valid recent paths outside configured roots', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-feishu-workspaces-'));
    try {
        const root = join(directory, 'root');
        const inside = join(root, 'inside');
        const outside = join(directory, 'outside');
        mkdirSync(inside, { recursive: true });
        mkdirSync(outside, { recursive: true });
        const rows = await listWorkspaceDirectories([root], {
            extraPaths: [outside, inside, join(directory, 'missing')],
        });
        assert.deepEqual(new Set(rows.map((row) => row.path)), new Set([inside, outside]));
    }
    finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('session card provides scope buttons and searches ids, titles, and cwd', () => {
    setActiveLocale('zh-CN');
    const sessions = [
        { sessionId: 'one', title: 'Alpha', cwd: 'D:/workspace/alpha', createdAt: 0, live: false, persisted: true, current: false },
        { sessionId: 'two', title: 'Beta', cwd: 'D:/workspace/beta', createdAt: 0, live: true, persisted: true, current: true },
    ];
    const card = buildSessionsCard(sessions, false, 'workspace/beta', {
        scope: 'workspace',
        availableScopes: ['all', 'workspace', 'chat'],
        workspacePath: 'D:/workspace/beta',
    });
    const scopeActions = actionsIn(card).filter((entry) => entry.value.kind === 'session-scope');
    assert.deepEqual(scopeActions.map((entry) => entry.value.scope), ['all', 'workspace', 'chat']);
    assert.equal(scopeActions.find((entry) => entry.value.scope === 'workspace').type, 'primary');
    assert.deepEqual(selectOptions(card).map((option) => option.value), ['two']);
    assert.match(JSON.stringify(card), /当前工作区/);
});

test('session and workspace view states forward scope and picker state', async () => {
    setActiveLocale('en-US');
    const calls = [];
    const sessionCtx = {
        sessionVisibility: 'workspace',
        workspaceCwd: () => 'D:/workspace',
        loadSessions: async (...args) => { calls.push(args); return []; },
    };
    await new SessionsViewState().render(sessionCtx, 'chat-1', {
        kind: 'sessions', archived: true, scope: 'all', query: 'old',
    });
    assert.deepEqual(calls, [['chat-1', true, 'workspace']]);

    const workspaceCtx = {
        repoRoots: ['D:/roots'],
        listWorkspaces: async (roots) => {
            assert.deepEqual(roots, ['D:/custom']);
            return [{ name: 'demo', path: 'D:/custom/demo', root: 'D:/custom' }];
        },
        workspaceCwd: () => 'D:/custom/demo',
        recentWorkspaces: () => ['D:/custom/demo'],
        favoriteWorkspaces: () => ['D:/custom/demo'],
    };
    const workspaceCard = await new WorkspacePickerViewState().render(workspaceCtx, 'chat-1', {
        kind: 'picker', picker: 'workspace', page: 0, roots: ['D:/custom'], query: 'demo',
    });
    assert.deepEqual(selectOptions(workspaceCard).map((option) => option.value), ['D:/custom/demo']);
});

test('scope and workspace-search actions preserve the parent card state', async () => {
    const replaced = [];
    const pushed = [];
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const sessionCtx = {
        services: { sessionVisibility: 'all', logger },
        panelViewFor: () => ({ kind: 'sessions', archived: true, query: 'old', scope: 'all' }),
        replacePanel: async (_chatId, view) => replaced.push(view),
    };
    await new SessionScopeAction().run(sessionCtx, {
        chatId: 'chat-1', messageId: 'card-1', operatorOpenId: 'user', value: { kind: 'session-scope', scope: 'chat' },
    });
    assert.deepEqual(replaced, [{ kind: 'sessions', archived: true, scope: 'chat', query: 'old' }]);

    const workspaceCtx = {
        services: { logger },
        pushPanel: async (_chatId, view) => pushed.push(view),
    };
    await new WorkspaceFindAction().run(workspaceCtx, {
        chatId: 'chat-1', messageId: 'card-1', operatorOpenId: 'user', value: { kind: 'workspace-find' },
    });
    assert.deepEqual(pushed, [{ kind: 'input', command: 'find-workspace' }]);
});

test('control-panel workspace and session buttons route to card subviews', async () => {
    const pushed = [];
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const ctx = {
        services: { logger },
        allowedWhileWorking: () => true,
        pushPanel: async (_chatId, view) => pushed.push(view),
    };
    const command = new CommandAction();
    await command.run(ctx, {
        chatId: 'chat-1', messageId: 'card-1', operatorOpenId: 'user',
        value: { kind: 'command', name: 'workspaces' },
    });
    await command.run(ctx, {
        chatId: 'chat-1', messageId: 'card-1', operatorOpenId: 'user',
        value: { kind: 'command', name: 'sessions' },
    });
    assert.deepEqual(pushed, [
        { kind: 'picker', picker: 'workspace', page: 0 },
        { kind: 'sessions', archived: false },
    ]);
});

test('session visibility filters all, workspace, chat, and archived rows', () => {
    const rows = [
        { sessionId: 'one', title: 'One', cwd: 'D:/a', createdAt: 3, live: false, persisted: true },
        { sessionId: 'two', title: 'Two', cwd: 'D:/b/', createdAt: 2, live: false, persisted: true },
        { sessionId: 'three', title: 'Three', cwd: 'D:/b', createdAt: 1, live: false, persisted: true },
    ];
    const options = { chatSessionIds: ['one', 'two'], currentCwd: 'D:/b' };
    assert.equal(effectiveSessionScope('all', 'all'), 'all');
    assert.equal(effectiveSessionScope('workspace', 'all'), 'workspace');
    assert.equal(effectiveSessionScope('chat', 'all'), 'chat');
    assert.deepEqual(filterSessionRowsByScope(rows, 'all', options).map((row) => row.sessionId), ['one', 'two', 'three']);
    assert.deepEqual(filterSessionRowsByScope(rows, 'workspace', options).map((row) => row.sessionId), ['two', 'three']);
    assert.deepEqual(filterSessionRowsByScope(rows, 'chat', options).map((row) => row.sessionId), ['one', 'two']);
    assert.deepEqual(filterSessionRowsByScope(rows, 'workspace', { chatSessionIds: ['one'], currentCwd: undefined }).map((row) => row.sessionId), ['one']);
    assert.deepEqual(filterArchivedSessionRows(rows, new Set(), true), []);
    assert.deepEqual(filterArchivedSessionRows(rows, new Set(['two']), true).map((row) => row.sessionId), ['two']);
});
