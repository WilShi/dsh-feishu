import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { serializePost } from '../lib/rich-text.js';
import { LarkTransport, normalizeMessageEvent } from '../lib/transport.js';

function event(messageType, content, overrides = {}) {
    return {
        sender: { sender_id: { open_id: 'ou_sender' } },
        message: {
            message_id: `message-${messageType}`,
            chat_id: 'chat-1',
            chat_type: 'p2p',
            message_type: messageType,
            content: JSON.stringify(content),
            create_time: '1700000000000',
            ...overrides,
        },
    };
}

test('normalizes every conversational Feishu message type used by the client', () => {
    const text = normalizeMessageEvent(event('text', { text: 'hello' }));
    assert.equal(text.text, 'hello');
    assert.deepEqual(text.attachments, []);

    const image = normalizeMessageEvent(event('image', { image_key: 'img-key' }));
    assert.deepEqual(image.attachments, [{ kind: 'image', key: 'img-key' }]);

    for (const type of ['file', 'audio', 'media', 'video']) {
        const normalized = normalizeMessageEvent(event(type, {
            file_key: `${type}-key`,
            file_name: `${type}.bin`,
        }));
        assert.equal(normalized.unsupportedType, undefined, `${type} must be handled`);
        assert.deepEqual(normalized.attachments, [{
            kind: 'file',
            key: `${type}-key`,
            name: `${type}.bin`,
        }]);
    }
});

test('preserves exact mention metadata for safe bot-token removal', () => {
    const normalized = normalizeMessageEvent(event('text', { text: '@_user_1 inspect alice@company.com and @scope/package' }, {
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'DSH' }],
    }));
    assert.deepEqual(normalized.mentions, ['ou_bot']);
    assert.deepEqual(normalized.mentionTokens, [{ key: '@_user_1', openId: 'ou_bot', name: 'DSH' }]);
    assert.equal(normalized.text, '@_user_1 inspect alice@company.com and @scope/package');
});

test('normalizes topic identifiers and sends topic output through message.reply', async () => {
    const normalized = normalizeMessageEvent(event('text', { text: 'reply' }, {
        root_id: 'root-1', parent_id: 'parent-1', thread_id: 'thread-1',
    }));
    assert.equal(normalized.rootId, 'root-1');
    assert.equal(normalized.replyToMessageId, 'parent-1');
    assert.equal(normalized.threadId, 'thread-1');

    const calls = [];
    const transport = Object.create(LarkTransport.prototype);
    transport.replyTargets = new Map();
    transport.client = { im: { v1: { message: {
        reply: async (payload) => { calls.push(['reply', payload]); return { code: 0, data: { message_id: 'reply-1' } }; },
        create: async (payload) => { calls.push(['create', payload]); return { code: 0, data: { message_id: 'create-1' } }; },
    } } } };
    transport.setReplyTarget('chat-1', { messageId: 'incoming-1', replyInThread: true });
    await transport.sendText('chat-1', 'hello');
    assert.equal(calls[0][0], 'reply');
    assert.deepEqual(calls[0][1].path, { message_id: 'incoming-1' });
    assert.equal(calls[0][1].data.reply_in_thread, true);
});

test('file download returns after the sniffing head instead of buffering until EOF', async () => {
    const source = new PassThrough();
    const transport = Object.create(LarkTransport.prototype);
    transport.client = { request: async () => ({ data: source, headers: { 'content-type': 'application/octet-stream' } }) };
    const pending = transport.downloadFile('message-1', 'file-1');
    source.write(Buffer.alloc(16, 1));
    const downloaded = await Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error('download waited for EOF')), 100)),
    ]);
    assert.equal(downloaded.head.byteLength, 16);
    source.end(Buffer.alloc(1024, 2));
    const chunks = [];
    for await (const chunk of downloaded.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).byteLength, 1040);
});

test('official media video messages are handled while unsupported objects fail loudly', () => {
    const media = normalizeMessageEvent(event('media', { file_key: 'video-key', file_name: 'demo.mp4' }));
    assert.deepEqual(media.attachments, [{ kind: 'file', key: 'video-key', name: 'demo.mp4' }]);

    const folder = normalizeMessageEvent(event('folder', { folder_key: 'folder-key' }));
    assert.equal(folder.unsupportedType, 'folder');
    assert.deepEqual(folder.attachments, []);

    const card = normalizeMessageEvent(event('card', {}));
    assert.equal(card.unsupportedType, 'card');
});

test('rich posts preserve localized title, inline order, and attachment kinds', () => {
    const content = {
        zh_cn: {
            title: '发布说明',
            content: [[
                { tag: 'text', text: '先看图：' },
                { tag: 'img', image_key: 'img-1' },
                { tag: 'text', text: '，再看视频：' },
                { tag: 'media', file_key: 'video-1', file_name: 'demo.mp4' },
                { tag: 'text', text: '，最后是文件：' },
                { tag: 'file', file_key: 'file-1', file_name: 'report.docx' },
            ]],
        },
    };
    const serialized = serializePost(JSON.stringify(content));
    assert.equal(
        serialized.text,
        '发布说明\n先看图：<image 1>，再看视频：<video 2>，最后是文件：<file 3>',
    );
    assert.deepEqual(serialized.attachments, [
        { kind: 'image', key: 'img-1' },
        { kind: 'file', key: 'video-1', name: 'demo.mp4' },
        { kind: 'file', key: 'file-1', name: 'report.docx' },
    ]);

    const normalized = normalizeMessageEvent(event('post', content));
    assert.equal(normalized.text, serialized.text);
    assert.deepEqual(normalized.attachments, serialized.attachments);
});

test('markdown-rich posts keep file and video placeholders distinct', () => {
    const serialized = serializePost(JSON.stringify({
        title: 'Assets',
        md: '![video](video-key) then ![file](file-key)',
        content: [[
            { tag: 'media', file_key: 'video-key' },
            { tag: 'file', file_key: 'file-key' },
        ]],
    }));
    assert.equal(serialized.text, 'Assets\n<video 1> then <file 2>');
    assert.deepEqual(serialized.attachments, [
        { kind: 'file', key: 'video-key' },
        { kind: 'file', key: 'file-key' },
    ]);
});
