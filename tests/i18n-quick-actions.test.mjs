import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parseQuickAction } from '../lib/commands.js';
import { enMessages } from '../lib/i18n/en-US.js';
import { createTranslator, placeholderNames, setActiveLocale, t } from '../lib/i18n/index.js';
import { zhMessages } from '../lib/i18n/zh-CN.js';
import { resolveLocale } from '../lib/locale.js';

test('English and Chinese catalogs contain the same keys and placeholders', () => {
    assert.deepEqual(Object.keys(zhMessages).sort(), Object.keys(enMessages).sort());
    for (const [key, value] of Object.entries(enMessages)) {
        assert.deepEqual(
            placeholderNames(zhMessages[key]).sort(),
            placeholderNames(value).sort(),
            `placeholder mismatch for ${key}`,
        );
    }
    assert.equal(createTranslator('zh-CN')('sessions.scope.all'), '全部会话');
});

test('every literal translation call and public message-key declaration exists', () => {
    const sourceFiles = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
            if (entry.isDirectory()) visit(path);
            else if (entry.name.endsWith('.js')) sourceFiles.push(path);
        }
    };
    visit(new URL('../lib/', import.meta.url));
    const called = new Set();
    for (const file of sourceFiles) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/\bt\('([^']+)'/g)) called.add(match[1]);
    }
    assert.deepEqual([...called].filter((key) => !(key in enMessages)), []);

    const declarations = readFileSync(new URL('../lib/i18n/en-US.d.ts', import.meta.url), 'utf8');
    for (const key of Object.keys(enMessages)) {
        assert.match(declarations, new RegExp(`readonly '${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    }
});

test('Chinese is the default while an explicit locale or environment remains supported', () => {
    const previous = process.env.FEISHU_LOCALE;
    try {
        delete process.env.FEISHU_LOCALE;
        assert.equal(resolveLocale({}), 'zh-CN');
        process.env.FEISHU_LOCALE = 'en-US';
        assert.equal(resolveLocale({}), 'en-US');
        assert.equal(resolveLocale({ locale: 'zh-CN' }), 'zh-CN');
    }
    finally {
        if (previous === undefined) delete process.env.FEISHU_LOCALE;
        else process.env.FEISHU_LOCALE = previous;
    }
});

test('natural-language shortcuts open cards without intercepting ordinary prompts', () => {
    assert.deepEqual(parseQuickAction('切换工作区'), { name: 'workspaces', rawInput: '' });
    assert.deepEqual(parseQuickAction(' 会话管理 '), { name: 'sessions', rawInput: '' });
    assert.deepEqual(parseQuickAction('添加工作区'), { name: 'workspaces', rawInput: '' });
    assert.deepEqual(parseQuickAction('模型'), { name: 'model', rawInput: '' });
    assert.deepEqual(parseQuickAction('权限设置'), { name: 'permission', rawInput: '' });
    assert.deepEqual(parseQuickAction('New Chat'), { name: 'new', rawInput: '' });
    assert.deepEqual(parseQuickAction('新对话'), { name: 'new', rawInput: '' });
    assert.equal(parseQuickAction('帮我检查一下当前工作区里的代码'), undefined);
    assert.equal(parseQuickAction('help me refactor this module'), undefined);
});

test('new card copy is available in both locales', () => {
    setActiveLocale('zh-CN');
    assert.equal(t('card.workspace.find'), '🔎 查找工作区');
    assert.equal(t('sessions.scope.chat'), '当前飞书聊天');
    setActiveLocale('en-US');
    assert.equal(t('card.workspace.find'), '🔎 Find workspace');
});
