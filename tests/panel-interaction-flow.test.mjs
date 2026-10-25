import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSessionsCard } from '../lib/cards/session-list.js';
import { setActiveLocale } from '../lib/i18n/index.js';
import { PanelInputSubmitAction } from '../lib/panel/actions/CommandActions.js';
import { SessionScopeAction, WorkspaceFindAction } from '../lib/panel/actions/NavigatorActions.js';
import { PanelController } from '../lib/panel/PanelController.js';
import { WorkspacePickerViewState } from '../lib/panel/views/PanelViewStates.js';

function createControllerHarness() {
    const sent = [];
    const updated = [];
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const workspaceState = new WorkspacePickerViewState();
    const workspaces = [
        { name: 'alpha', path: 'D:/work/alpha', root: 'D:/work' },
        { name: 'beta', path: 'D:/work/beta', root: 'D:/work' },
    ];
    const viewContext = {
        repoRoots: ['D:/work'],
        listWorkspaces: async () => workspaces,
        workspaceCwd: () => 'D:/work/alpha',
        recentWorkspaces: () => ['D:/work/beta'],
        favoriteWorkspaces: () => ['D:/work/alpha'],
    };
    const host = {
        logger,
        transport: {
            async sendCard(chatId, card) {
                const messageId = `card-${sent.length + 1}`;
                sent.push({ chatId, messageId, card });
                return { messageId };
            },
            async updateCard(messageId, card) { updated.push({ messageId, card }); },
        },
        isAsyncView: (view) => view.kind === 'sessions' || view.kind === 'picker',
        async renderPanelView(_chatId, view) {
            if (view.kind === 'sessions') {
                return buildSessionsCard([], view.archived, view.query, {
                    scope: view.scope ?? 'all',
                    availableScopes: ['all', 'workspace', 'chat'],
                });
            }
            if (view.kind === 'picker' && view.picker === 'workspace') {
                return workspaceState.render(viewContext, 'chat-1', view);
            }
            if (view.kind === 'input') {
                return {
                    config: { wide_screen_mode: true },
                    header: { title: { tag: 'plain_text', content: view.command }, template: 'wathet' },
                    elements: [],
                };
            }
            return host.buildMenuCard();
        },
        buildMenuCard: () => ({
            config: { wide_screen_mode: true },
            header: { title: { tag: 'plain_text', content: 'menu' }, template: 'wathet' },
            elements: [],
        }),
        syncCard() {},
        async resultCard() {},
        async text() {},
    };
    return { controller: new PanelController(host), logger, sent, updated };
}

function contextFor(controller, logger, messageId) {
    return {
        services: { sessionVisibility: 'all', logger },
        panelViewFor: (chatId) => controller.panelViewFor(chatId, messageId),
        panelStack: (chatId) => controller.panelStack(chatId, messageId),
        pushPanel: (chatId, view) => controller.pushPanel(chatId, messageId, view),
        replacePanel: (chatId, view) => controller.replacePanel(chatId, messageId, view),
    };
}

test('a session-scope card click updates the same card and preserves filters', async () => {
    setActiveLocale('zh-CN');
    const { controller, logger, sent, updated } = createControllerHarness();
    const messageId = await controller.openPanelView('chat-1', {
        kind: 'sessions', archived: true, query: '旧', scope: 'all',
    });
    updated.length = 0;

    await new SessionScopeAction().run(contextFor(controller, logger, messageId), {
        chatId: 'chat-1', messageId, operatorOpenId: 'user',
        value: { kind: 'session-scope', scope: 'chat' },
    });

    assert.equal(sent.length, 1);
    assert.equal(updated.at(-1).messageId, messageId);
    assert.deepEqual(controller.panelViewFor('chat-1', messageId), {
        kind: 'sessions', archived: true, query: '旧', scope: 'chat',
    });
    assert.match(JSON.stringify(updated.at(-1).card), /当前飞书聊天/);
});

test('workspace search click opens input and submit redraws a filtered picker in place', async () => {
    setActiveLocale('zh-CN');
    const { controller, logger, sent, updated } = createControllerHarness();
    const messageId = await controller.openPanelView('chat-1', {
        kind: 'picker', picker: 'workspace', page: 0,
    });
    const ctx = contextFor(controller, logger, messageId);

    await new WorkspaceFindAction().run(ctx, {
        chatId: 'chat-1', messageId, operatorOpenId: 'user', value: { kind: 'workspace-find' },
    });
    assert.deepEqual(controller.panelViewFor('chat-1', messageId), { kind: 'input', command: 'find-workspace' });

    await new PanelInputSubmitAction().run(ctx, {
        chatId: 'chat-1', messageId, operatorOpenId: 'user',
        formValue: { query: 'beta' },
        value: { kind: 'panel-input-submit', command: 'find-workspace' },
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(controller.panelViewFor('chat-1', messageId), {
        kind: 'picker', picker: 'workspace', page: 0, query: 'beta',
    });
    const json = JSON.stringify(updated.at(-1).card);
    assert.match(json, /D:\/work\/beta/);
    const options = updated.at(-1).card.elements
        .flatMap((element) => element.actions ?? [])
        .filter((action) => action.tag === 'select_static')
        .flatMap((action) => action.options ?? []);
    assert.deepEqual(options.map((option) => option.value), ['D:/work/beta']);
});

test('workspace detail views use a valid localized loading title', async () => {
    setActiveLocale('zh-CN');
    const sent = [];
    const updated = [];
    const host = {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        transport: {
            async sendCard(chatId, card) {
                sent.push({ chatId, card });
                return { messageId: 'workspace-card' };
            },
            async updateCard(messageId, card) { updated.push({ messageId, card }); },
        },
        isAsyncView: () => true,
        async renderPanelView() {
            return {
                header: { title: { tag: 'plain_text', content: 'detail' }, template: 'wathet' },
                elements: [],
            };
        },
        buildMenuCard: () => ({ elements: [] }),
        syncCard() {},
        async resultCard() {},
        async text() {},
    };
    const controller = new PanelController(host);

    await controller.openPanelView('chat-1', { kind: 'workspace-detail', workspaceId: 'workspace-one' });
    assert.equal(typeof sent[0].card.header.title.content, 'string');
    assert.notEqual(sent[0].card.header.title.content, '');

    await controller.openPanelView('chat-1', { kind: 'workspace-remove-confirm', workspaceId: 'workspace-one' });
    assert.equal(typeof sent[1].card.header.title.content, 'string');
    assert.notEqual(sent[1].card.header.title.content, '');
    assert.equal(updated.length, 2);
});
