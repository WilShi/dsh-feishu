import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAgentPresetPickerCard } from '../lib/cards/render.js';
import { parseQuickAction } from '../lib/commands.js';
import { AgentPresetPageAction } from '../lib/panel/actions/NavigatorActions.js';
import { AgentPresetPickAction } from '../lib/panel/actions/PickActions.js';

function actionKinds(value, found = []) {
    if (Array.isArray(value)) {
        for (const entry of value) actionKinds(entry, found);
    }
    else if (value !== null && typeof value === 'object') {
        if (typeof value.kind === 'string') found.push(value.kind);
        for (const child of Object.values(value)) actionKinds(child, found);
    }
    return found;
}

test('Agent mode card shows current and broken presets and paginates healthy choices', () => {
    const presets = Array.from({ length: 10 }, (_, index) => ({
        id: `mode-${index}`,
        label: `Mode ${index}`,
        description: `Description ${index}`,
        current: index === 0,
        broken: index === 1 ? 'missing dependency' : undefined,
    }));
    const first = buildAgentPresetPickerCard(presets, 0);
    const firstKinds = actionKinds(first);
    assert.equal(firstKinds.filter((kind) => kind === 'agent-preset-pick').length, 6);
    assert.ok(firstKinds.includes('agent-preset-page'));
    assert.match(JSON.stringify(first), /missing dependency/);
    assert.match(JSON.stringify(first), /Mode 0/);

    const second = buildAgentPresetPickerCard(presets, 1);
    assert.equal(actionKinds(second).filter((kind) => kind === 'agent-preset-pick').length, 2);
    assert.ok(actionKinds(second).includes('agent-preset-page'));
});

test('Agent mode pick and page actions delegate through the panel state machine', async () => {
    const calls = [];
    const ctx = {
        selectAgentPreset: async (chatId, preset) => {
            calls.push(['select', chatId, preset]);
            return { kind: 'success', text: 'ok' };
        },
        canReturn: () => false,
        panelViewFor: () => ({ kind: 'picker', picker: 'agent-preset', page: 0 }),
        replacePanel: async (chatId, view) => calls.push(['replace', chatId, view]),
    };
    const picked = await new AgentPresetPickAction().work(ctx, {
        chatId: 'chat-1',
        messageId: 'card-1',
        operatorOpenId: 'user-1',
        value: { kind: 'agent-preset-pick', preset: 'claude-code' },
    });
    assert.deepEqual(picked, { kind: 'success', text: 'ok' });

    await new AgentPresetPageAction().transition(ctx, {
        chatId: 'chat-1',
        messageId: 'card-1',
        operatorOpenId: 'user-1',
        value: { kind: 'agent-preset-page', page: '2' },
    });
    assert.deepEqual(calls, [
        ['select', 'chat-1', 'claude-code'],
        ['replace', 'chat-1', { kind: 'picker', picker: 'agent-preset', page: 2 }],
    ]);
});

test('Chinese and English natural-language mode shortcuts are exact', () => {
    assert.deepEqual(parseQuickAction('模式'), { name: 'mode', rawInput: '' });
    assert.deepEqual(parseQuickAction('切换模式'), { name: 'mode', rawInput: '' });
    assert.deepEqual(parseQuickAction('mode'), { name: 'mode', rawInput: '' });
    assert.equal(parseQuickAction('帮我切换模式并继续工作'), undefined);
});
