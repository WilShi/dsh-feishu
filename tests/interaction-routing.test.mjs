import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { feishuChatForRequest } from '../lib/interaction-routing.js';

const sessionMap = { chatFor: (id) => id === 'feishu-session' ? 'chat-1' : undefined };

test('claims only requests belonging to a mapped Feishu session', () => {
    assert.equal(feishuChatForRequest(sessionMap, { agent: { session: { id: 'feishu-session' } } }), 'chat-1');
    assert.equal(feishuChatForRequest(sessionMap, { agent: { session: { id: 'web-session' } } }), undefined);
    assert.equal(feishuChatForRequest(sessionMap, {}), undefined);
});

test('Cordis waterfall keeps foreign surfaces reachable and Feishu requests exclusive', async () => {
    const ctx = new Context();
    const calls = [];
    const feishuFiber = ctx.plugin((child) => {
        child.on('test/approval-request', (request, next) => {
            if (feishuChatForRequest(sessionMap, request) === undefined) return next();
            calls.push('feishu');
            return 'allowed-once';
        }, { prepend: true });
    });
    const webFiber = ctx.plugin((child) => {
        child.on('test/approval-request', () => {
            calls.push('web');
            return 'web-answer';
        });
    });
    await Promise.all([feishuFiber, webFiber]);

    const foreign = await ctx.waterfall(
        'test/approval-request',
        { agent: { session: { id: 'web-session' } } },
        () => 'unhandled',
    );
    assert.equal(foreign, 'web-answer');
    assert.deepEqual(calls, ['web']);

    calls.length = 0;
    const owned = await ctx.waterfall(
        'test/approval-request',
        { agent: { session: { id: 'feishu-session' } } },
        () => 'unhandled',
    );
    assert.equal(owned, 'allowed-once');
    assert.deepEqual(calls, ['feishu']);

    await webFiber.dispose();
    await feishuFiber.dispose();
});
