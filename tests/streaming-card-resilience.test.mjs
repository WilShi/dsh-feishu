import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamingCardController } from '../lib/cards/StreamingCardController.js';
import { buildCard, buildRowDetailsCard, MAX_CARD_BYTES } from '../lib/cards/render.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function controllerHarness() {
    const texts = [];
    const files = [];
    const cards = [];
    const followups = [];
    const cancelled = [];
    let liveMessageId = 'card-current';
    const agent = {
        status: 'idle',
        followup: (message) => followups.push(message),
        cancel: (...args) => cancelled.push(args),
    };
    const host = {
        transport: {
            sendText: async (_chatId, text) => texts.push(text),
            sendFile: async (_chatId, name, content) => files.push({ name, content }),
            sendCard: async (_chatId, card) => { cards.push(card); return { messageId: `detail-${cards.length}` }; },
            updateCard: async () => {},
            addReaction: async () => undefined,
            removeReaction: async () => {},
        },
        cards: {
            lastMessageId: () => liveMessageId,
            open: async () => {}, patch() {}, finalize: async () => {},
        },
        logger,
        sessionMap: {
            get: () => 'session-1', ensure: () => 'session-1', cwdFor: () => process.cwd(), remint: () => 'session-2',
        },
        agentStore: { get: () => agent },
        defaultCwd: process.cwd(),
        resolveAgent: async () => agent,
        textMentionFor: () => '',
        sendLogFile: async () => {},
    };
    return {
        controller: new StreamingCardController(host), texts, files, cards, followups, cancelled, agent,
        setLiveMessageId: (id) => { liveMessageId = id; },
    };
}

test('historical card actions use the exact card snapshot and cannot stop the current turn', async () => {
    const harness = controllerHarness();
    const oldRow = { kind: 'tool', id: 'old-row', name: 'read', summary: 'old row', status: 'done', args: '{}', result: 'old result' };
    harness.controller.finishedRenders.set('chat-1', new Map([['card-old', {
        title: 'Old', content: 'old output', rows: [oldRow], status: 'done', collapsed: true,
        producedPaths: ['D:/workspace/old.txt'], prompt: 'old prompt',
    }]]));
    harness.controller.cardStates.set('chat-1', {
        title: 'Current', content: 'current output', rows: [], status: 'working', collapsed: true,
        stopRequested: false, producedPaths: [],
    });
    harness.agent.status = 'running';

    await harness.controller.handleStreamingAction({
        chatId: 'chat-1', messageId: 'card-old', operatorOpenId: 'user', value: { kind: 'copy' },
    });
    assert.equal(harness.texts[0], 'old output');

    await harness.controller.handleStreamingAction({
        chatId: 'chat-1', messageId: 'card-old', operatorOpenId: 'user', value: { kind: 'row-details', id: 'old-row' },
    });
    assert.match(JSON.stringify(harness.cards[0]), /old result/);

    await harness.controller.handleStreamingAction({
        chatId: 'chat-1', messageId: 'card-old', operatorOpenId: 'user', value: { kind: 'stop' },
    });
    assert.equal(harness.cancelled.length, 0);

    await harness.controller.handleStreamingAction({
        chatId: 'chat-1', messageId: 'card-old', operatorOpenId: 'user', value: { kind: 'retry' },
    });
    assert.equal(harness.followups.length, 0);
});

test('long copy output becomes a file and forged produced-file actions are rejected', async () => {
    const harness = controllerHarness();
    harness.controller.finishedRenders.set('chat-1', new Map([['card-old', {
        title: 'Old', content: 'x'.repeat(25_000), rows: [], status: 'done', collapsed: true,
        producedPaths: ['inside.txt'], prompt: 'old prompt',
    }]]));
    await harness.controller.handleStreamingAction({
        chatId: 'chat-1', messageId: 'card-old', operatorOpenId: 'user', value: { kind: 'copy' },
    });
    assert.equal(harness.files[0].name, 'dsh-answer.txt');
    assert.equal(harness.files[0].content.byteLength, 25_000);

    await harness.controller.handleStreamingAction({
        chatId: 'chat-1', messageId: 'card-old', operatorOpenId: 'user',
        value: { kind: 'send-produced', path: '../secret.txt' },
    });
    assert.equal(harness.files.length, 1);
    assert.equal(harness.texts.length, 1);
});

test('large tool traces and produced-file lists always stay within the card budget', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({
        kind: 'tool', id: `row-${index}`, name: `tool-${index}`, summary: 's'.repeat(5_000),
        status: 'done', args: 'a'.repeat(30_000), result: 'r'.repeat(30_000),
    }));
    const card = buildCard({
        title: 't'.repeat(1_000), content: 'body'.repeat(30_000), rows, status: 'done', collapsed: false,
        producedPaths: Array.from({ length: 50 }, (_, index) => `D:/workspace/result-${index}.txt`),
    });
    assert.ok(new TextEncoder().encode(JSON.stringify(card)).byteLength <= MAX_CARD_BYTES);
    for (const element of card.elements) {
        if (element.tag === 'action') assert.ok(element.actions.length <= 5);
    }
    const details = buildRowDetailsCard(rows[0]);
    assert.ok(new TextEncoder().encode(JSON.stringify(details)).byteLength <= MAX_CARD_BYTES);
});
