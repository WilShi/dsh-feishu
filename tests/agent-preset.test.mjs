import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAgentComposition, storedAgentPreset } from '../lib/agent-preset.js';

test('resolves and mounts an RC2 Agent preset during setup', async () => {
    const calls = [];
    const presets = {
        resolve: async (id) => ({ id: id ?? 'standard' }),
        mount: async (agentCtx, id) => calls.push({ agentCtx, id }),
    };
    const composition = await resolveAgentComposition({ get: (name) => name === 'agentPresets' ? presets : undefined }, 'code');
    assert.equal(composition.agentPreset, 'code');
    const agentCtx = { scope: 'unpublished' };
    await composition.setup(agentCtx, {});
    assert.deepEqual(calls, [{ agentCtx, id: 'code' }]);
});

test('degrades cleanly when the deployment has no Agent preset service', async () => {
    assert.deepEqual(await resolveAgentComposition({ get: () => undefined }), {});
});

test('reads and releases the persisted preset, with legacy fallback', async () => {
    let disposed = 0;
    const observation = {
        projections: { values: { agentPreset: 'legacy-code' } },
        [Symbol.dispose]() { disposed += 1; },
    };
    const ctx = { get: () => ({ observeSession: async () => observation }) };
    assert.equal(await storedAgentPreset(ctx, 'session-1'), 'legacy-code');
    assert.equal(disposed, 1);

    const legacy = { get: () => ({ observeSession: async () => ({ projections: { values: { agentPreset: null } } }) }) };
    assert.equal(await storedAgentPreset(legacy, 'session-old'), undefined);
});
