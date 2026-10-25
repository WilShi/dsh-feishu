import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../lib/bridge.js', import.meta.url), 'utf8');

test('package targets DSH 0.1.5 RC2 without stale RC1 contracts', () => {
    assert.equal(pkg.version, '0.3.3');
    assert.equal(JSON.stringify(pkg.peerDependencies).includes('0.1.5-rc.1'), false);
    assert.equal(JSON.stringify(pkg.devDependencies).includes('0.1.5-rc.1'), false);
});

test('waterfall listeners delegate foreign requests and claim Feishu requests first', () => {
    assert.match(source, /\(request, next\) =>/);
    assert.match(source, /return next\(\)/);
    assert.equal((source.match(/\{ prepend: true \}/g) ?? []).length, 2);
});

test('package metadata contains no embedded credentials', () => {
    const text = JSON.stringify(pkg);
    assert.doesNotMatch(text, /\bcli_[A-Za-z0-9]{16,}\b/);
    assert.doesNotMatch(text, /(?:appSecret|accessToken|apiKey)\s*[=:]\s*[A-Za-z0-9_+/=-]{12,}/i);
});

test('workspace, session, and Agent-mode card actions reach the panel dispatcher', () => {
    for (const kind of [
        'workspace-add',
        'workspace-inspect',
        'workspace-rename',
        'workspace-remove',
        'workspace-remove-confirm',
        'session-fork',
        'agent-preset-pick',
        'agent-preset-page',
    ]) {
        assert.match(bridgeSource, new RegExp(`case '${kind}':`));
    }
});
