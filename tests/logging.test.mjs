import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { consoleExporter } from '../lib/console-exporter.js';

function message(name, text) {
    return { ts: Date.now(), name, type: 'info', args: [text] };
}

test('persistent logging keeps Feishu records and excludes global logs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-log-'));
    const path = join(dir, 'dsh-feishu.log');
    const exporter = consoleExporter(path, { loggerName: 'feishu', maxBytes: 4096, maxFiles: 2 });
    const original = console.log;
    console.log = () => {};
    try {
        exporter.export(message('skill-registry', 'private global record'));
        exporter.export(message('feishu', 'owned record'));
    }
    finally {
        console.log = original;
    }
    const content = readFileSync(path, 'utf8');
    assert.match(content, /owned record/);
    assert.doesNotMatch(content, /private global record/);
});

test('persistent logging rotates bounded files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-feishu-rotate-'));
    const path = join(dir, 'dsh-feishu.log');
    const exporter = consoleExporter(path, { maxBytes: 120, maxFiles: 2 });
    const original = console.log;
    console.log = () => {};
    try {
        for (let index = 0; index < 8; index += 1) {
            exporter.export(message('feishu', `record-${index}-${'x'.repeat(45)}`));
        }
    }
    finally {
        console.log = original;
    }
    assert.match(readFileSync(path, 'utf8'), /record-7/);
    assert.match(readFileSync(`${path}.1`, 'utf8'), /record-6/);
});
