import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { Bridge } from '../lib/bridge.js';
import { PanelController } from '../lib/panel/PanelController.js';
import { LarkTransport } from '../lib/transport.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function bridgeHarness() {
    const transport = {
        onMessage() {},
        onCardAction() {},
        setReplyTarget() {},
        sendText: async () => {},
        sendCard: async () => ({ messageId: 'card' }),
        updateCard: async () => {},
    };
    const bridge = new Bridge({
        transport,
        sessionMap: { get: () => undefined },
        agentStore: { get: () => undefined },
        onSessionEvent: () => () => {},
        onAssistantStream: () => () => {},
        cards: {},
        defaultCwd: process.cwd(),
        dataDir: process.cwd(),
        logger,
    });
    return bridge;
}

test('panel callback state is LRU-bounded and disposable', () => {
    const controller = new PanelController({
        transport: {},
        logger,
        renderPanelView: async () => ({ config: {}, elements: [] }),
        isAsyncView: () => false,
        buildMenuCard: () => ({ config: {}, elements: [] }),
        syncCard() {},
        resultCard: async () => {},
        text: async () => {},
    });

    for (let index = 0; index < 45; index++)
        controller.panelStack('chat-main', `card-${index}`);
    assert.equal(controller.panelViews.get('chat-main').size, 40);
    assert.equal(controller.panelViews.get('chat-main').has('card-0'), false);

    for (let index = 0; index < 505; index++)
        controller.panelStack(`chat-${index}`, 'card');
    assert.equal(controller.panelViews.size, 500);
    assert.equal(controller.panelViews.has('chat-0'), false);

    controller.dispose();
    assert.equal(controller.panelViews.size, 0);
    assert.equal(controller.panelMessageIds.size, 0);
    assert.equal(controller.panelMessageRoots.size, 0);
});

test('bridge retains recoverable work while bounding stale chat and queue-card state', async () => {
    const bridge = bridgeHarness();
    bridge.pendingInbound.set('protected-chat', [{ name: 'pending.txt' }]);
    bridge.touchChatState('protected-chat', 1);
    for (let index = 0; index < 505; index++)
        bridge.touchChatState(`idle-${index}`, index + 2);

    assert.equal(bridge.chatActivity.size, 500);
    assert.equal(bridge.chatActivity.has('protected-chat'), true);
    assert.equal(bridge.chatActivity.has('idle-0'), false);

    const entries = bridge.queueCardEntries('queue-chat');
    entries.set('still-waiting', { status: 'queued' });
    for (let index = 0; index < 45; index++)
        entries.set(`done-${index}`, { status: 'sent' });
    bridge.pruneQueueCards('queue-chat');
    assert.equal(entries.has('still-waiting'), true);
    assert.equal(entries.has('done-0'), false);
    assert.equal(entries.size, 41);

    for (let index = 0; index < 105; index++) {
        bridge.rememberTopic({
            chatId: 'topic-chat',
            messageId: `thread-${index}`,
        });
    }
    assert.equal(bridge.ownedThreads.get('topic-chat').size, 100);
    assert.equal(bridge.ownedThreads.get('topic-chat').has('thread-0'), false);

    await bridge.handleQueueCardAction({
        chatId: 'stale-card-chat',
        messageId: 'old-card',
        operatorOpenId: 'user-1',
        value: { kind: 'queue-remove', id: 'evicted-item' },
    });
    assert.equal(bridge.queueCards.has('stale-card-chat'), false);
    bridge.dispose();
});

test('transport stop wins a startup race, force-closes once, and releases callbacks', async () => {
    const transport = new LarkTransport({
        credentials: { appId: 'cli_0123456789abcdef', appSecret: 'test-secret' },
        logger,
        proxyUrl: 'http://127.0.0.1:1',
    });
    // The real SDK client owns a cache timer even before start; close it before
    // replacing the seam with a deterministic lifecycle probe.
    transport.ws.close({ force: true });
    const calls = [];
    transport.ws = {
        start: async () => calls.push(['start']),
        close: (options) => calls.push(['close', options]),
    };
    let releaseIdentity;
    transport.resolveBotOpenId = () => new Promise((resolve) => { releaseIdentity = resolve; });
    transport.onMessage(() => {});
    transport.onCardAction(() => {});
    transport.setReplyTarget('chat-1', { messageId: 'message-1', replyInThread: true });
    transport.statsCache.set('chat-1', { stats: { userCount: 1, botCount: 1 }, at: Date.now() });

    const starting = transport.start();
    await new Promise((resolve) => setImmediate(resolve));
    await transport.stop();
    releaseIdentity();
    await starting;

    assert.deepEqual(calls, [['close', { force: true }]]);
    assert.equal(transport.handler, undefined);
    assert.equal(transport.actionHandler, undefined);
    assert.equal(transport.replyTargets.size, 0);
    assert.equal(transport.statsCache.size, 0);
    await transport.stop();
    assert.equal(calls.length, 1);
});

test('attachment reservations stay unique under real parallel contention', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-feishu-reserve-'));
    try {
        const moduleUrl = new URL('../lib/attachment-naming.js', import.meta.url).href;
        const workerCode = `
            const { parentPort, workerData } = require('node:worker_threads');
            import(workerData.moduleUrl)
                .then(({ reserveAttachmentFile }) => {
                    parentPort.postMessage(reserveAttachmentFile(
                        workerData.dir, 'report.pdf', workerData.key, 'pdf'
                    ));
                })
                .catch((error) => { throw error; });
        `;
        const reservations = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
            const worker = new Worker(workerCode, {
                eval: true,
                workerData: { moduleUrl, dir: root, key: `key-${index}` },
            });
            worker.once('message', resolve);
            worker.once('error', reject);
            worker.once('exit', (code) => {
                if (code !== 0)
                    reject(new Error(`reservation worker exited with ${code}`));
            });
        })));
        const names = reservations.map(({ fileName }) => fileName);
        assert.equal(new Set(names).size, 8);
        assert.equal(names.includes('report.pdf'), true);
        assert.equal(reservations.every(({ path }) => existsSync(path)), true);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
