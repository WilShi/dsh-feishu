import assert from 'node:assert/strict';
import test from 'node:test';
import { InteractionCardController } from '../lib/cards/InteractionCardController.js';
import { buildQuestionCard } from '../lib/cards/render.js';

function cardActions(card) {
    const found = [];
    const visit = (value) => {
        if (Array.isArray(value)) return value.forEach(visit);
        if (value === null || typeof value !== 'object') return;
        if (value.value && typeof value.value === 'object' && typeof value.value.kind === 'string') {
            found.push(value.value);
        }
        Object.values(value).forEach(visit);
    };
    visit(card);
    return found;
}

function harness({ interactionTimeoutMs = 2000, requesterOpenId } = {}) {
    const cards = [];
    const updates = [];
    const transport = {
        async sendCard(chatId, card) {
            const messageId = `message-${cards.length + 1}`;
            cards.push({ chatId, card, messageId });
            return { messageId };
        },
        async updateCard(messageId, card) { updates.push({ messageId, card }); },
    };
    const host = {
        transport,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        sessionMap: { chatFor: (id) => id === 'session-1' ? 'chat-1' : undefined },
        interactionTimeoutMs,
        cardMentionFor: () => '',
        requesterOpenIdFor: () => requesterOpenId,
        syncCard() {},
    };
    return { controller: new InteractionCardController(host), cards, updates };
}

async function waitFor(predicate) {
    for (let index = 0; index < 100; index += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('condition was not reached');
}

test('same caller question id gets unique callback ids across requests', async () => {
    const { controller, cards } = harness();
    const question = { id: 'confirm', question: 'Continue?', options: [{ label: 'Yes' }] };
    const first = controller.askQuestions({ agent: { session: { id: 'session-1' } }, questions: [question] });
    const second = controller.askQuestions({ agent: { session: { id: 'session-1' } }, questions: [question] });
    await waitFor(() => cards.length === 2);
    const firstAction = cardActions(cards[0].card).find((action) => action.kind === 'question');
    const secondAction = cardActions(cards[1].card).find((action) => action.kind === 'question');
    assert.notEqual(firstAction.id, secondAction.id);
    await controller.handleCardAction({ chatId: 'chat-1', messageId: cards[0].messageId, operatorOpenId: 'user', value: firstAction });
    await controller.handleCardAction({ chatId: 'chat-1', messageId: cards[1].messageId, operatorOpenId: 'user', value: secondAction });
    assert.deepEqual(await first, { answers: [{ id: 'confirm', selected: ['Yes'] }] });
    assert.deepEqual(await second, { answers: [{ id: 'confirm', selected: ['Yes'] }] });
    controller.dispose();
});

test('multiple free-text questions in one chat are answered FIFO', async () => {
    const { controller, cards } = harness();
    const pending = controller.askQuestions({
        agent: { session: { id: 'session-1' } },
        questions: [{ id: 'one', question: 'First?' }, { id: 'two', question: 'Second?' }],
    });
    await waitFor(() => cards.length === 2);
    assert.equal(controller.answerFreeText('chat-1', 'alpha'), true);
    assert.equal(controller.answerFreeText('chat-1', 'beta'), true);
    assert.equal(controller.answerFreeText('chat-1', 'unused'), false);
    assert.deepEqual(await pending, { answers: [
        { id: 'one', selected: [], custom: 'alpha' },
        { id: 'two', selected: [], custom: 'beta' },
    ] });
    controller.dispose();
});

test('cancelling a multi-select discards already toggled choices', async () => {
    const { controller, cards } = harness();
    const pending = controller.askQuestions({
        agent: { session: { id: 'session-1' } },
        questions: [{ id: 'many', question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
    });
    await waitFor(() => cards.length === 1);
    const toggle = cardActions(cards[0].card).find((action) => action.kind === 'question-toggle');
    await controller.handleCardAction({ chatId: 'chat-1', messageId: cards[0].messageId, operatorOpenId: 'user', value: toggle });
    await waitFor(() => cards.length === 2);
    const cancel = cardActions(cards[1].card).find((action) => action.kind === 'question-cancel');
    await controller.handleCardAction({ chatId: 'chat-1', messageId: cards[1].messageId, operatorOpenId: 'user', value: cancel });
    assert.deepEqual(await pending, { answers: [{ id: 'many', selected: [] }] });
    controller.dispose();
});

test('approval callbacks allow or reject exactly once and ignore stale clicks', async () => {
    for (const [decision, expected] of [['allow', 'allowed-once'], ['reject', 'rejected']]) {
        const { controller, cards, updates } = harness();
        const pending = controller.handleApprovalRequest({
            agent: { session: { id: 'session-1' } },
            toolName: 'shell',
            reason: 'Run a verified command',
        });
        await waitFor(() => cards.length === 1);
        const action = cardActions(cards[0].card).find((value) => value.kind === 'approval' && value.decision === decision);
        assert.ok(action);

        // A forged callback from another chat or card must not settle it.
        await controller.handleCardAction({ chatId: 'chat-2', messageId: cards[0].messageId, operatorOpenId: 'user', value: action });
        await controller.handleCardAction({ chatId: 'chat-1', messageId: 'stale-card', operatorOpenId: 'user', value: action });

        // Rapid repeated clicks still settle only once.
        await Promise.all([
            controller.handleCardAction({ chatId: 'chat-1', messageId: cards[0].messageId, operatorOpenId: 'user', value: action }),
            controller.handleCardAction({ chatId: 'chat-1', messageId: cards[0].messageId, operatorOpenId: 'user', value: action }),
        ]);
        assert.equal(await pending, expected);
        await waitFor(() => updates.length === 1);
        assert.equal(updates[0].messageId, cards[0].messageId);
        controller.dispose();
    }
});

test('approval and question cards only accept the user who initiated the turn', async () => {
    const { controller, cards } = harness({ requesterOpenId: 'owner' });
    const pending = controller.handleApprovalRequest({
        agent: { session: { id: 'session-1' } }, toolName: 'shell', reason: 'Run command',
    });
    await waitFor(() => cards.length === 1);
    const action = cardActions(cards[0].card).find((value) => value.kind === 'approval' && value.decision === 'allow');

    await controller.handleCardAction({
        chatId: 'chat-1', messageId: cards[0].messageId, operatorOpenId: 'other-user', value: action,
    });
    const stateAfterOtherUser = await Promise.race([
        pending.then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 10)),
    ]);
    assert.equal(stateAfterOtherUser, 'pending');

    await controller.handleCardAction({
        chatId: 'chat-1', messageId: cards[0].messageId, operatorOpenId: 'owner', value: action,
    });
    assert.equal(await pending, 'allowed-once');
    controller.dispose();
});

test('approval timeout and abort both fail closed as cancelled', async () => {
    const timed = harness({ interactionTimeoutMs: 5 });
    const timedResult = timed.controller.handleApprovalRequest({
        agent: { session: { id: 'session-1' } }, toolName: 'shell', reason: 'timeout',
    });
    assert.equal(await timedResult, 'cancelled');
    await waitFor(() => timed.updates.length === 1);
    timed.controller.dispose();

    const aborted = harness();
    const abortController = new AbortController();
    const abortedResult = aborted.controller.handleApprovalRequest({
        agent: { session: { id: 'session-1' } }, toolName: 'shell', reason: 'abort', signal: abortController.signal,
    });
    await waitFor(() => aborted.cards.length === 1);
    abortController.abort();
    assert.equal(await abortedResult, 'cancelled');
    await waitFor(() => aborted.updates.length === 1);
    aborted.controller.dispose();
});

test('question timeout, abort, and duplicate callbacks produce one safe answer', async () => {
    const timed = harness({ interactionTimeoutMs: 5 });
    assert.deepEqual(await timed.controller.askQuestions({
        agent: { session: { id: 'session-1' } },
        questions: [{ id: 'timeout', question: 'Continue?', options: [{ label: 'Yes' }] }],
    }), { answers: [{ id: 'timeout', selected: [] }] });
    await waitFor(() => timed.updates.length === 1);
    timed.controller.dispose();

    const aborted = harness();
    const abortController = new AbortController();
    const pending = aborted.controller.askQuestions({
        agent: { session: { id: 'session-1' } },
        signal: abortController.signal,
        questions: [{ id: 'abort', question: 'Continue?', options: [{ label: 'Yes' }] }],
    });
    await waitFor(() => aborted.cards.length === 1);
    const action = cardActions(aborted.cards[0].card).find((value) => value.kind === 'question');
    abortController.abort();
    await Promise.all([
        aborted.controller.handleCardAction({ chatId: 'chat-1', messageId: aborted.cards[0].messageId, operatorOpenId: 'user', value: action }),
        aborted.controller.handleCardAction({ chatId: 'chat-1', messageId: aborted.cards[0].messageId, operatorOpenId: 'user', value: action }),
    ]);
    assert.deepEqual(await pending, { answers: [{ id: 'abort', selected: [] }] });
    await waitFor(() => aborted.updates.length === 1);
    aborted.controller.dispose();
});

test('RC2 header, descriptions, plan-review styling and button chunking render', () => {
    const card = buildQuestionCard({
        id: 'question-9',
        header: 'Deployment gate',
        question: 'Approve this plan?',
        detail: '# Plan\nShip safely',
        multiSelect: false,
        intent: { kind: 'plan-review', approve: 'Approve' },
        options: [
            { label: 'Approve', description: 'Proceed with deployment' },
            { label: 'Revise', description: 'Return to planning' },
        ],
    });
    assert.equal(card.header.title.content, 'Deployment gate');
    assert.equal(card.header.template, 'orange');
    assert.match(JSON.stringify(card), /Proceed with deployment/);
    const actions = cardActions(card);
    assert.deepEqual(actions.map((action) => action.id), ['question-9', 'question-9']);

    const many = buildQuestionCard({
        id: 'question-10', question: 'Pick', detail: undefined, multiSelect: false,
        options: Array.from({ length: 7 }, (_, index) => ({ label: `Option ${index}` })),
    });
    assert.deepEqual(many.elements.filter((element) => element.tag === 'action').map((element) => element.actions.length), [5, 2]);
});
