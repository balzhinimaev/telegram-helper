import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_MARKER, HistoryCollectionError, collectHistory, parseCommand, splitPlainText,
} from '../telegram-commands.js';

const message = (id, text = `message ${id}`, extra = {}) => ({ id, date: 1_700_000_000 + id, senderId: 101n, message: text, ...extra });
function fakeClient(items, failure) {
  return {
    calls: [],
    iterMessages(entity, options) {
      this.calls.push({ entity, options });
      return (async function* () {
        for (const item of items) yield item;
        if (failure) throw failure;
      })();
    },
  };
}

test('only explicit one-line commands and structured focus activate', () => {
  for (const command of ['суперанализ', '/superanalysis', '/super', ' СУПЕРАНАЛИЗ ']) {
    assert.deepEqual(parseCommand(command), { mode: 'super', limit: 'all' });
  }
  assert.deepEqual(parseCommand('суперанализ: Стоит ли продолжать?'), { mode: 'super', limit: 'all', question: 'Стоит ли продолжать?' });
  assert.deepEqual(parseCommand('анализ'), { mode: 'brief' });
  assert.deepEqual(parseCommand('анализ 500'), { mode: 'brief', limit: 500 });
  assert.deepEqual(parseCommand('/analysis_help'), { mode: 'help' });
  for (const text of [undefined, '', 'хз', 'не уверен', 'даже не знаю', 'анализ крови', 'суперанализ отличный', 'анализ 0', 'анализ -1', 'анализ 1.5', 'анализ 99999999999999999999', 'Вот анализ 50', '/super\nУже готово', '/super@someone', `${ANALYSIS_MARKER}\nсуперанализ`]) assert.equal(parseCommand(text), null, String(text));
});

test('question preserves its words, but only parses final optional count', () => {
  assert.deepEqual(parseCommand('/question О чём договорились? number:100'), { mode: 'question', question: 'О чём договорились?', limit: 100 });
  assert.deepEqual(parseCommand('/question Весь разговор number:ALL'), { mode: 'question', question: 'Весь разговор', limit: 'all' });
  assert.deepEqual(parseCommand('/question Что изменилось?'), { mode: 'question', question: 'Что изменилось?' });
  assert.deepEqual(parseCommand('/question Объясни number:50 в документе'), { mode: 'question', question: 'Объясни number:50 в документе' });
  for (const value of ['/question', '/question number:all', '/question вопрос number:0', '/question вопрос number:-5', '/question вопрос number:ten']) assert.equal(parseCommand(value), null);
});

test('collectHistory applies exclusive snapshot, excludes commands/statuses, deduplicates and sorts', async () => {
  const client = fakeClient([
    message(16), message(15), message(14, 'суперанализ'), message(13, `${ANALYSIS_MARKER} Анализ`, { out: true }),
    message(12, 'private prior output'), message(11), message(11), message(9, '/question Зачем?'),
    message(8, '📝 Найдено 50 сообщений. Анализирую...', { out: true }), message(7),
    message(6, '', { action: {} }), message(5, ''), message(2),
  ]);
  const progress = [];
  const result = await collectHistory(client, 'dialog', { beforeId: 15, excludeIds: new Set([12]), onProgress: stats => progress.push(stats) });
  assert.deepEqual(client.calls, [{ entity: 'dialog', options: { maxId: 15, limit: undefined, reverse: false } }]);
  assert.deepEqual(result.messages.map(item => item.id), [2, 7, 11]);
  assert.equal(result.stats.fullHistory, true);
  assert.equal(result.stats.complete, true);
  assert.equal(result.stats.scanned, 13);
  assert.equal(result.stats.outsideSnapshot, 2);
  assert.equal(result.stats.excludedCommands, 2);
  assert.equal(result.stats.excludedService, 3);
  assert.equal(result.stats.excludedIds, 1);
  assert.equal(result.stats.duplicates, 1);
  assert.equal(result.stats.empty, 1);
  assert.equal(progress.at(-1).included, 3);
  assert.equal(result.messages[0].sender, '101');
  assert.equal(result.messages[0].date, new Date(1_700_000_002_000).toISOString());
});

test('all history preserves long text, exact whitespace and captions, not silently truncating', async () => {
  const text = ` \n${'Длинное сообщение 😀'.repeat(12_000)}\n `;
  const caption = ' Полная подпись \nс переносом ';
  const result = await collectHistory(fakeClient([message(3, caption, { media: { className: 'MessageMediaPhoto' } }), message(2, text)]), 'dialog', { beforeId: 4 });
  assert.equal(result.messages[0].text, text);
  assert.equal(result.messages[1].text, caption);
  assert.equal(result.messages[1].media, 'photo');
  assert.equal(result.stats.mediaMessages, 1);
  assert.equal(result.stats.mediaOnly, 0);
});

test('incoming human text is not hidden by an analysis marker', async () => {
  const result = await collectHistory(fakeClient([
    message(2, `${ANALYSIS_MARKER} мои собственные слова`, { out: false }),
    message(1, `${ANALYSIS_MARKER} отчёт скрипта`, { out: true }),
  ]), 'dialog', { beforeId: 3 });
  assert.deepEqual(result.messages.map(m => m.id), [2]);
});

test('known outgoing legacy report wrappers and standalone headers/footers are excluded', async () => {
  const oldAnalysis = '📊 АНАЛИЗ ДИАЛОГА\n\nПрежний разбор.\n\n💡 Статистика: 150 токенов (100 промт + 50 ответ)';
  const oldAnswer = '❓ ОТВЕТ НА ВОПРОС\nО чём договорились?\n\nПрежний ответ.\n\n💡 Контекст: 20 сообщений | 150 токенов';
  const outgoing = [
    oldAnalysis, oldAnswer, '📊 АНАЛИЗ ДИАЛОГА', '❓ ОТВЕТ НА ВОПРОС',
    '💡 Контекст: 20 сообщений | 150 токенов', '💡 Статистика: 150 токенов (100 промт + 50 ответ)',
  ].map((text, index) => message(20 - index, text, { out: true }));
  const incoming = outgoing.map(item => ({ ...item, id: item.id - 10, out: false }));
  const ordinary = [
    message(4, '📊 АНАЛИЗ ДИАЛОГА\nЭто моё впечатление без служебной статистики.', { out: true }),
    message(3, 'Цитата: 📊 АНАЛИЗ ДИАЛОГА\n💡 Статистика: 150 токенов (100 промт + 50 ответ)', { out: true }),
    message(2, '💡 Статистика: помогает понять разговор', { out: true }),
    message(1, 'Самостоятельный текст без маркеров; происхождение неизвестно.', { out: true }),
  ];
  const result = await collectHistory(fakeClient([...outgoing, ...incoming, ...ordinary]), 'dialog', { beforeId: 21 });
  assert.equal(result.stats.excludedService, outgoing.length);
  assert.deepEqual(result.messages.map(item => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(result.messages.find(item => item.id === 10).text, oldAnalysis);
});

test('media-only voice notes are explicitly unread, without invoking sender or download APIs', async () => {
  const client = fakeClient([message(2, '', {
    senderId: undefined, fromId: { channelId: 123n }, sender: { title: 'Public title' },
    media: { className: 'MessageMediaDocument', document: { attributes: [{ className: 'DocumentAttributeAudio', voice: true }] } },
  })]);
  const { messages, stats } = await collectHistory(client, 'dialog', { beforeId: 3 });
  assert.deepEqual(messages[0], {
    id: 2, date: new Date(1_700_000_002_000).toISOString(), sender: '-100123',
    text: '[voice: содержимое вложения не прочитано]', media: 'voice', mediaOnly: true, name: 'Public title',
  });
  assert.equal(stats.mediaOnly, 1);
});

test('missing metadata is explicit and does not invent dates or merge unknown senders', async () => {
  const { messages, stats } = await collectHistory(fakeClient([
    message(2, 'hello', { senderId: undefined, date: undefined }),
    message(1, 'world', { senderId: undefined, date: undefined }),
  ]), 'dialog', { beforeId: 3 });
  assert.deepEqual(messages.map(item => item.sender), ['unknown:1', 'unknown:2']);
  assert.equal(messages[0].date, null);
  assert.equal(stats.missingDates, 2);
  assert.equal(stats.unknownSenders, 2);
});

test('finite limit means latest included messages, not analysis commands, and does not claim full history', async () => {
  const client = fakeClient([message(9, 'анализ 2'), message(8), message(7, `${ANALYSIS_MARKER} text`, { out: true }), message(6), message(5)]);
  const { messages, stats } = await collectHistory(client, 'dialog', { beforeId: 10, limit: 2 });
  assert.deepEqual(messages.map(item => item.id), [6, 8]);
  assert.equal(stats.fullHistory, false);
  assert.equal(stats.complete, true);
  assert.equal(stats.scanned, 4);
});

test('finite limit may exhaust a short history and all history may be empty', async () => {
  const short = await collectHistory(fakeClient([message(1)]), 'dialog', { beforeId: 2, limit: 10 });
  assert.equal(short.stats.fullHistory, true);
  const empty = await collectHistory(fakeClient([]), 'dialog', { beforeId: 2 });
  assert.deepEqual(empty.messages, []);
  assert.equal(empty.stats.complete, true);
  assert.equal(empty.stats.oldestDate, null);
});

test('safety cap fails explicitly including overflows made of excluded messages', async () => {
  const client = fakeClient([message(4), message(3, 'анализ'), message(2)]);
  await assert.rejects(collectHistory(client, 'dialog', { beforeId: 5, maxMessages: 2 }), error => {
    assert.ok(error instanceof HistoryCollectionError);
    assert.equal(error.code, 'HISTORY_TOO_LARGE');
    assert.equal(error.stats.fullHistory, false);
    assert.equal(error.stats.complete, false);
    assert.equal(error.messages, undefined);
    return true;
  });
  const exactly = await collectHistory(fakeClient([message(2), message(1)]), 'dialog', { beforeId: 3, maxMessages: 2 });
  assert.equal(exactly.stats.fullHistory, true);
});

test('fetch errors are not converted into allegedly complete empty or partial histories', async () => {
  await assert.rejects(collectHistory(fakeClient([message(1)], new Error('sensitive-raw-error')), 'dialog', { beforeId: 2 }), error => {
    assert.equal(error.code, 'HISTORY_UNAVAILABLE');
    assert.equal(error.message.includes('sensitive-raw-error'), false);
    assert.equal(error.stats.included, 1);
    assert.equal(error.stats.complete, false);
    return true;
  });
  await assert.rejects(collectHistory(fakeClient([{ id: 0 }]), 'dialog', { beforeId: 2 }), { code: 'HISTORY_INVALID' });
});

test('pre-aborted signal never invokes Telegram and pending fetch can be cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = fakeClient([]);
  await assert.rejects(collectHistory(client, 'dialog', { beforeId: 2, signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(client.calls.length, 0);
  const pending = new AbortController();
  const hanging = { iterMessages: () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } }) };
  const result = collectHistory(hanging, 'dialog', { beforeId: 2, signal: pending.signal });
  pending.abort();
  await assert.rejects(result, { code: 'ABORTED' });
});

test('invalid boundaries and counts fail before acquiring history', async () => {
  for (const options of [{}, { beforeId: 0 }, { beforeId: 2, limit: 0 }, { beforeId: 2, limit: -1 }, { beforeId: 2, limit: 3, maxMessages: 2 }, { beforeId: 2, maxMessages: 0 }]) {
    const client = fakeClient([]);
    await assert.rejects(collectHistory(client, 'dialog', options));
    assert.equal(client.calls.length, 0);
  }
});

test('cancelling a stalled async generator does not wait forever for return()', async () => {
  const controller = new AbortController();
  const client = { iterMessages: async function* () { await new Promise(() => {}); yield message(1); } };
  const result = collectHistory(client, 'dialog', { beforeId: 2, signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { code: 'ABORTED' });
});

test('plain-text splitter is lossless, handles long single lines and does not split Unicode surrogate pairs', () => {
  for (const text of ['', 'short', '😀'.repeat(10_000), 'a'.repeat(10_001), `Привет\n${'аб🙂\n '.repeat(3000)}`, '<b>not parsed</b> & plain']) {
    const chunks = splitPlainText(text, 3500);
    assert.equal(chunks.join(''), text);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 3500 && chunk.length > 0);
      assert.ok(!/[\uD800-\uDBFF]$/u.test(chunk));
      assert.ok(!/^[\uDC00-\uDFFF]/u.test(chunk));
    }
  }
  assert.deepEqual(splitPlainText('🙂🙂', 3), ['🙂', '🙂']);
  assert.throws(() => splitPlainText('hello', 4096), RangeError);
  assert.throws(() => splitPlainText('hello', 1), RangeError);
});
