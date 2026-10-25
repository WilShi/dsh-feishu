import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { buildPanelActionRegistry } from '../lib/panel/actions/registry.js';

const lib = new URL('../lib/', import.meta.url);

function captures(source, pattern) {
    return [...source.matchAll(pattern)].map((match) => match[1]);
}

test('every card action rendered to users has a live dispatcher', async () => {
    const cardDir = new URL('cards/', lib);
    const cardFiles = (await readdir(cardDir)).filter((name) => name.endsWith('.js'));
    const rendered = new Set();
    for (const name of cardFiles) {
        const source = await readFile(new URL(name, cardDir), 'utf8');
        for (const kind of captures(source, /value:\s*(?:actionValue\()?\{\s*kind:\s*'([^']+)'/g)) {
            rendered.add(kind);
        }
    }

    const handlerSources = [await readFile(new URL('bridge.js', lib), 'utf8')];
    const actionDir = new URL('panel/actions/', lib);
    for (const name of (await readdir(actionDir)).filter((entry) => entry.endsWith('.js'))) {
        handlerSources.push(await readFile(new URL(name, actionDir), 'utf8'));
    }
    const handled = new Set();
    for (const source of handlerSources) {
        for (const kind of captures(source, /(?:case\s+|kind\s*=\s*)'([^']+)'/g)) handled.add(kind);
    }

    assert.deepEqual([...rendered].filter((kind) => !handled.has(kind)).sort(), []);
    assert.ok(rendered.has('workspace-pick'));
    assert.ok(rendered.has('session-select'));
    assert.ok(rendered.has('agent-preset-pick'));
    assert.ok(rendered.has('approval'));

    const nonPanel = new Set([
        'stop', 'copy', 'retry', 'row-details', 'toggle-rows', 'send-produced', 'send-log',
        'approval', 'question', 'question-toggle', 'question-submit', 'question-cancel',
        'queue-steer', 'queue-edit', 'queue-edit-submit', 'queue-edit-cancel', 'queue-remove',
    ]);
    const registered = new Set(buildPanelActionRegistry().kinds());
    assert.deepEqual(
        [...rendered].filter((kind) => !nonPanel.has(kind) && !registered.has(kind)).sort(),
        [],
    );
});
