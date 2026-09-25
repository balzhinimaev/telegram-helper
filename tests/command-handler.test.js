import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHandler } from '../command-handler.js';
import { DeliveryState } from '../private-state.js';
import { ANALYSIS_MARKER } from '../telegram-commands.js';

const record = (id, text = `Текст ${id}`, extra = {}) => ({ id, message: text, date: 1_700_000_000 + id, senderId: id % 2 ? 1n : 2n, ...extra });
const event = (id = 10, text = 'суперанализ', extra = {}) => ({ message: { id, message: text, out: true, senderId: 1n, peerId: { userId: 2n }, ...extra } });
const analysisResult = overrides => ({ content: 'Основанный на тексте разбор.', model: 'unit-test-model', usage: { totalTokens: 123 }, cost: 0.001, ...overrides });

function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-helper-handler-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'delivery.json');
  const state = new DeliveryState(stateFile);
  const client = {
    sent: [], edits: [], historyCalls: [], counter: 1000,
    items: options.items ?? [record(3), record(2), record(1)],
    async sendMessage(peer, args) {
      const sent = { id: this.counter++, peer, ...args };
      this.sent.push(sent);
      return sent;
    },
    async editMessage(peer, args) { this.edits.push({ peer, ...args }); },
    iterMessages(peer, args) {
      this.historyCalls.push({ peer, args });
      const { items, historyError } = this;
      return (async function* () { for (const item of items) yield item; if (historyError) throw historyError; })();
    },
  };
  const calls = [];
  const analyzer = {
    async analyze(args) { calls.push(args); return options.analyze ? options.analyze(args) : analysisResult(); },
  };
  const statuses = [];
  const handler = createCommandHandler({ client, state, analyzer: options.withoutAI ? null : analyzer, meId: '1',
    targetIds: options.targetIds ?? new Set(), defaultLimit: options.defaultLimit ?? 50,
    maxMessages: options.maxMessages ?? 100000, status: info => statuses.push(info),
  });
  return { handler, client, state, stateFile, calls, statuses };
}

test('incoming messages, spoofed sender IDs, groups, and natural-language triggers do nothing', async t => {
  const env = setup(t);
  for (const sample of [
    event(10, 'суперанализ', { out: false }),
    event(11, 'суперанализ', { senderId: 99n }),
    event(12, 'суперанализ', { peerId: { chatId: 2n } }),
    event(13, 'суперанализ', { peerId: { channelId: 2n } }),
    event(14, 'хз'), event(15, 'даже не знаю'), event(16, 'не уверен'),
    event(17, `${ANALYSIS_MARKER}\nсуперанализ`),
  ]) await env.handler(sample);
  assert.equal(env.calls.length, 0);
  assert.equal(env.client.historyCalls.length, 0);
  assert.equal(env.client.sent.length, 0);
  assert.equal(env.state.has('2', 10), false);
});

test('a selected target restricts outgoing owner commands and valid target is accepted', async t => {
  const env = setup(t, { targetIds: new Set(['2']) });
  await env.handler(event(10, 'суперанализ', { peerId: { userId: 3n } }));
  assert.equal(env.calls.length, 0);
  await env.handler(event(10));
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].chatId, '2');
});

test('Telegram outgoing private messages without fromId are attributed to the authenticated owner', async t => {
  const env = setup(t, { items: [
    record(3, 'Мой ответ', { senderId: undefined, out: true, peerId: { userId: 2n } }),
    record(2, 'Вопрос собеседника', { senderId: undefined, out: false, peerId: { userId: 2n } }),
  ] });
  await env.handler(event(10, 'суперанализ', { senderId: undefined }));
  assert.equal(env.calls.length, 1);
  assert.deepEqual(env.calls[0].messages.map(m => m.sender), ['2', '1']);
  assert.equal(env.calls[0].ownerId, '1');
});

test('super command snapshots before command ID and uses all available history with stable owner label', async t => {
  const env = setup(t, { items: [record(12), record(10, 'суперанализ'), record(9), record(8), record(1)] });
  await env.handler(event(10, 'суперанализ: стоит ли продолжать?'));
  assert.deepEqual(env.client.historyCalls[0].args, { maxId: 10, limit: undefined, reverse: false });
  assert.deepEqual(env.calls[0].messages.map(item => item.id), [1, 8, 9]);
  assert.equal(env.calls[0].question, 'стоит ли продолжать?');
  assert.match(env.calls[0].messages[0].name, /автор команды/u);
  assert.match(env.client.sent.map(item => item.message).join(''), /Вся доступная/u);
});

test('ordinary analysis is bounded and question command retains requested scope', async t => {
  const env = setup(t, { items: [record(9), record(8), record(7), record(6)] });
  await env.handler(event(10, 'анализ 2'));
  assert.deepEqual(env.calls[0].messages.map(item => item.id), [8, 9]);
  assert.match(env.calls[0].question, /Не делай вывод о всей истории/u);
  assert.match(env.client.sent.map(item => item.message).join(''), /лимит 2/u);
  await env.handler(event(11, '/question Какие договорённости? number:all'));
  assert.equal(env.calls[1].question, 'Какие договорённости?');
  assert.equal(env.calls[1].messages.length, 4);
});

test('duplicate updates are persisted and never retry API automatically, even after failure', async t => {
  t.mock.method(console, 'error', () => {});
  const env = setup(t, { analyze: async () => { throw Object.assign(new Error('private-content'), { status: 429 }); } });
  await env.handler(event());
  await env.handler(event());
  assert.equal(env.calls.length, 1);
  const persisted = new DeliveryState(env.stateFile);
  assert.equal(persisted.has('2', 10), true);
  const restoredHandler = createCommandHandler({ client: env.client, meId: '1', state: persisted,
    analyzer: { analyze: () => { throw new Error('should not run after restart'); } },
  });
  await restoredHandler(event());
  assert.equal(env.client.historyCalls.length, 1);
  assert.match(env.client.edits.at(-1).text, /квота|ограничил/u);
  assert.ok(!env.client.edits.some(item => item.text.includes('private-content')));
  await env.handler(event(11));
  assert.equal(env.calls.length, 2, 'only a new user command permits another attempt');
});

test('global busy guard rejects a second chat analysis without a second paid call', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const env = setup(t, { analyze: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  const first = env.handler(event());
  await started;
  await env.handler(event(11, 'суперанализ', { peerId: { userId: 3n } }));
  assert.equal(env.calls.length, 1);
  assert.equal(env.client.historyCalls.length, 1);
  assert.ok(env.client.sent.some(item => /Уже выполняется/u.test(item.message)));
  assert.equal(env.state.has('3', 11), true);
  release(analysisResult());
  await first;
  assert.equal(env.statuses.at(-1).stage, 'ready');
});

test('empty and attachment-only histories never invoke paid analysis', async t => {
  for (const items of [[], [record(1, '', { media: { className: 'MessageMediaPhoto' } })], [record(1, '', {
    media: { className: 'MessageMediaDocument', document: { attributes: [{ className: 'DocumentAttributeAudio', voice: true }] } },
  })]]) {
    const env = setup(t, { items });
    await env.handler(event());
    assert.equal(env.calls.length, 0, 'unread media placeholders must not be sent to AI');
    assert.match(env.client.edits.at(-1).text, /Не найдено текстовых/u);
    assert.equal(env.statuses.at(-1).stage, 'ready');
  }
});

test('real captions, including bracket-prefixed captions, are usable text', async t => {
  const env = setup(t, { items: [record(1, '[Важно] Завтра встречаемся в пять', { media: { className: 'MessageMediaPhoto' } })] });
  await env.handler(event());
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0].messages[0].text, '[Важно] Завтра встречаемся в пять');
});

test('split reports and progress remain marked plain text under Telegram limits', async t => {
  const content = `Наблюдения <b>это не HTML</b>\n${'🙂 Взвешенный вывод. '.repeat(700)}`;
  const env = setup(t, { analyze: async ({ onProgress }) => {
    await onProgress({ stage: 'summarize', completed: 1, total: 2 });
    return analysisResult({ content });
  } });
  await env.handler(event());
  assert.ok(env.client.sent.length > 3);
  const joined = env.client.sent.slice(1).map(item => item.message.replace(`${ANALYSIS_MARKER}\n`, '').replace(/^Часть \d+\/\d+\n/u, '')).join('');
  assert.ok(joined.includes(content), 'all original output must survive exact splitting');
  for (const item of env.client.sent) {
    assert.ok(item.message.startsWith(`${ANALYSIS_MARKER}\n`));
    assert.equal(item.parseMode, false);
    assert.equal(item.linkPreview, false);
    assert.ok(item.message.length < 4096);
    assert.ok(env.state.excluded('2').has(item.id));
  }
  for (const item of env.client.edits) {
    assert.ok(item.text.startsWith(`${ANALYSIS_MARKER}\n`));
    assert.equal(item.parseMode, false);
  }
});

test('previous reports are removed by persisted IDs and marker on the next command', async t => {
  const env = setup(t);
  env.state.remember('sent', '2', 5);
  env.client.items = [record(9, `${ANALYSIS_MARKER}\nOld report`, { out: true }), record(8, 'анализ 2'), record(5, 'Legacy report without marker'), record(4, 'Real conversation')];
  await env.handler(event());
  assert.deepEqual(env.calls[0].messages.map(item => item.id), [4]);
});

test('newly generated report parts and status do not become dialogue on the next command', async t => {
  const env = setup(t);
  await env.handler(event());
  const sent = env.client.sent.map(item => record(item.id, item.message));
  env.client.items = [...sent.reverse(), record(10, 'суперанализ'), record(3), record(2), record(1)];
  await env.handler(event(2000));
  assert.equal(env.calls.length, 2);
  assert.deepEqual(env.calls[1].messages.map(item => item.id), [1, 2, 3]);
});

test('history timeout cancels before paid work and reports safely', async t => {
  t.mock.method(console, 'error', () => {});
  let timeout;
  t.mock.method(AbortSignal, 'timeout', milliseconds => { timeout = milliseconds; return AbortSignal.abort(); });
  const env = setup(t);
  await env.handler(event());
  assert.equal(timeout, 5 * 60 * 1000);
  assert.equal(env.calls.length, 0);
  assert.equal(env.client.historyCalls.length, 0);
  assert.equal(env.statuses.at(-1).stage, 'ready');
  assert.ok(env.statuses.some(info => info.lastError === 'ABORTED'));
});

test('failed partial report delivery is not automatically resent or reanalyzed', async t => {
  t.mock.method(console, 'error', () => {});
  const env = setup(t, { analyze: async () => analysisResult({ content: 'Ответ '.repeat(2000) }) });
  const original = env.client.sendMessage.bind(env.client);
  let attempts = 0;
  env.client.sendMessage = async (...args) => {
    attempts += 1;
    if (attempts === 3) throw new Error('private-delivery-error');
    return original(...args);
  };
  await env.handler(event());
  assert.equal(env.calls.length, 1);
  assert.equal(attempts, 3);
  assert.equal(env.client.sent.length, 2, 'only initial status and first output part sent');
  assert.ok(!env.client.edits.at(-1).text.includes('private-delivery-error'));
  await env.handler(event());
  assert.equal(env.calls.length, 1, 'duplicate event must not restart billing');
  env.client.sendMessage = original;
  await env.handler(event(11));
  assert.equal(env.calls.length, 2, 'the lock must be released for a new command');
});

test('history acquisition failure and safety overflow do not invoke analysis', async t => {
  t.mock.method(console, 'error', () => {});
  const env = setup(t);
  env.client.historyError = new Error('private-fetch-error');
  await env.handler(event());
  assert.equal(env.calls.length, 0);
  assert.ok(!env.client.edits.at(-1).text.includes('private-fetch-error'));
  const oversized = setup(t, { maxMessages: 2 });
  await oversized.handler(event());
  assert.equal(oversized.calls.length, 0);
  assert.match(oversized.client.edits.at(-1).text, /история больше ограничения|лимит загрузки|ограничения загрузки/u);
});

test('help and missing AI configuration do not load private histories or call AI', async t => {
  const help = setup(t);
  await help.handler(event(10, '/analysis_help'));
  assert.equal(help.calls.length, 0);
  assert.equal(help.client.historyCalls.length, 0);
  assert.match(help.client.sent[0].message, /Результат видят участники/u);
  const missing = setup(t, { withoutAI: true });
  await missing.handler(event());
  assert.equal(missing.client.historyCalls.length, 0);
  assert.match(missing.client.sent[0].message, /OPENAI_API_KEY/u);
});
