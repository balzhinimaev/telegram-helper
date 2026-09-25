/** Pure command parsing, bounded history acquisition and plain-text Telegram output. */
export const ANALYSIS_MARKER = '[TG-ANALYSIS]';
const DEFAULT_MAX_MESSAGES = 100_000;

function positiveInteger(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

/** Only explicit commands, never conversational trigger phrases. */
export function parseCommand(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /[\r\n]/u.test(text)) return null;
  if (/^\/analysis_help$/iu.test(text)) return { mode: 'help' };
  const superMatch = /^(?:суперанализ|\/superanalysis|\/super)(?::\s*(.+))?$/iu.exec(text);
  if (superMatch) return { mode: 'super', limit: 'all', ...(superMatch[1] ? { question: superMatch[1].trim() } : {}) };
  const briefMatch = /^анализ(?:\s+([0-9]+))?$/iu.exec(text);
  if (briefMatch) {
    const limit = briefMatch[1] ? positiveInteger(briefMatch[1]) : undefined;
    return limit === null ? null : { mode: 'brief', ...(limit ? { limit } : {}) };
  }
  const questionMatch = /^\/question\s+(.+)$/iu.exec(text);
  if (!questionMatch) return null;
  let question = questionMatch[1].trim();
  const limitMatch = /(?:^|\s)number:([^\s]+)$/iu.exec(question);
  let limit;
  if (limitMatch) {
    limit = limitMatch[1].toLowerCase() === 'all' ? 'all' : (/^[0-9]+$/u.test(limitMatch[1]) ? positiveInteger(limitMatch[1]) : null);
    if (limit === null) return null;
    question = question.slice(0, limitMatch.index).trim();
  }
  if (!question) return null;
  return { mode: 'question', question, ...(limit === undefined ? {} : { limit }) };
}

function isServiceText(text) {
  // Every part/status from this version uses the marker. Older unmarked AI prose
  // cannot be identified safely; callers can exclude known sent message IDs.
  return text.startsWith(ANALYSIS_MARKER)
    || /^(?:🔍 Получаю сообщения\.\.\.|❓ Получаю (?:ВСЕ сообщения и думаю над ответом|контекст и думаю над ответом)\.\.\.|📝 Найдено \d+ сообщений(?: \(весь диалог\))?\. Анализирую(?: вопрос)?\.\.\.)$/u.test(text);
}

function isLegacyReport(msg, text) {
  // The old app published HTML, but Telegram history returns its plain text.
  // Recognize only exact outgoing wrappers, never arbitrary old AI-like prose.
  if (!msg.out) return false;
  const analysisHeader = '📊 АНАЛИЗ ДИАЛОГА';
  const questionHeader = '❓ ОТВЕТ НА ВОПРОС';
  const statsFooter = /^💡 Статистика: \d+ токенов \(\d+ промт \+ \d+ ответ\)$/u;
  const contextFooter = /^💡 Контекст: \d+ сообщений \| \d+ токенов$/u;
  if (text === analysisHeader || text === questionHeader || statsFooter.test(text) || contextFooter.test(text)) return true;
  const lines = text.split(/\r?\n/u);
  return (lines[0] === analysisHeader && statsFooter.test(lines.at(-1)))
    || (lines[0] === questionHeader && contextFooter.test(lines.at(-1)));
}

function stableSender(msg, ownerId) {
  if (msg.senderId !== undefined && msg.senderId !== null) return String(msg.senderId);
  const from = msg.fromId;
  if (from?.userId !== undefined) return String(from.userId);
  if (from?.channelId !== undefined) return `-100${from.channelId}`;
  if (from?.chatId !== undefined) return `-${from.chatId}`;
  if (msg.sender?.id !== undefined) {
    const type = msg.sender.className ?? msg.sender.constructor?.name;
    return type === 'Channel' ? `-100${msg.sender.id}` : type === 'Chat' ? `-${msg.sender.id}` : String(msg.sender.id);
  }
  // Telegram may omit fromId in an owner's outgoing private history message.
  // `out` is MTProto metadata, not something a chat participant can put in text.
  if (msg.out && ownerId !== undefined) return String(ownerId);
  if (!msg.out && msg.peerId?.userId !== undefined) return String(msg.peerId.userId);
  // Do not invent a single person for unrelated messages with no sender metadata.
  return `unknown:${msg.id}`;
}

function mediaKind(media) {
  if (!media) return undefined;
  const type = media.className ?? media.constructor?.name;
  if (type === 'MessageMediaEmpty') return undefined;
  if (type === 'MessageMediaPhoto') return 'photo';
  if (type === 'MessageMediaWebPage') return 'webpage';
  if (type === 'MessageMediaPoll') return 'poll';
  if (type === 'MessageMediaGeo' || type === 'MessageMediaGeoLive' || type === 'MessageMediaVenue') return 'location';
  if (type === 'MessageMediaContact') return 'contact';
  const attributes = media.document?.attributes ?? [];
  for (const attribute of attributes) {
    const attr = attribute.className ?? attribute.constructor?.name;
    if (attr === 'DocumentAttributeSticker') return 'sticker';
    if (attr === 'DocumentAttributeAudio') return attribute.voice ? 'voice' : 'audio';
    if (attr === 'DocumentAttributeVideo') return attribute.roundMessage ? 'video-note' : 'video';
  }
  return type === 'MessageMediaDocument' ? 'document' : 'media';
}

function isoDate(value) {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export class HistoryCollectionError extends Error {
  constructor(code, stats) {
    const texts = {
      HISTORY_TOO_LARGE: 'History exceeds the configured message safety limit; no partial analysis was returned.',
      HISTORY_UNAVAILABLE: 'Could not finish loading Telegram history; no partial analysis was returned.',
      HISTORY_INVALID: 'Telegram returned malformed history metadata; no partial analysis was returned.',
      ABORTED: 'History loading was cancelled.',
    };
    super(texts[code] ?? texts.HISTORY_UNAVAILABLE);
    this.name = code === 'ABORTED' ? 'AbortError' : 'HistoryCollectionError';
    this.code = code;
    this.stats = { ...stats, fullHistory: false, complete: false };
  }
}

function abortable(promise, signal, stats) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new HistoryCollectionError('ABORTED', stats));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new HistoryCollectionError('ABORTED', stats));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Acquire all accessible history strictly before the command ID. Finite limits
 * count included messages, not commands/statuses. Captions are kept verbatim;
 * attachments are NOT downloaded or transcribed. A partial fetch always throws.
 * `fullHistory` means iterator exhaustion, not inaccessible/deleted history.
 */
export async function collectHistory(client, entity, {
  beforeId, limit = 'all', excludeIds = [], onProgress,
  maxMessages = DEFAULT_MAX_MESSAGES, signal, ownerId,
} = {}) {
  if (!positiveInteger(beforeId)) throw new TypeError('beforeId must be a positive message ID');
  if (limit !== 'all' && !positiveInteger(limit)) throw new TypeError('limit must be a positive integer or all');
  if (!positiveInteger(maxMessages)) throw new TypeError('maxMessages must be a positive integer');
  if (limit !== 'all' && Number(limit) > maxMessages) throw new RangeError('limit exceeds maxMessages');
  if (typeof client?.iterMessages !== 'function') throw new TypeError('client.iterMessages is required');
  const omitted = new Set([...excludeIds].map(String));
  const seenIds = new Set();
  const messages = [];
  const stats = {
    beforeId: Number(beforeId), requestedLimit: limit === 'all' ? 'all' : Number(limit),
    scanned: 0, included: 0, excludedCommands: 0, excludedService: 0,
    excludedIds: 0, duplicates: 0, outsideSnapshot: 0, empty: 0,
    mediaMessages: 0, mediaOnly: 0, missingDates: 0, unknownSenders: 0,
    oldestDate: null, newestDate: null, fullHistory: false, complete: false,
    scope: 'accessible-history-before-command',
  };
  let iterator;
  try {
    if (signal?.aborted) throw new HistoryCollectionError('ABORTED', stats);
    // Installed GramJS iterMessages uses undefined for no limit and maxId as an
    // exclusive offset when newest-first. Use that direction to make N latest.
    iterator = client.iterMessages(entity, { maxId: Number(beforeId), limit: undefined, reverse: false })[Symbol.asyncIterator]();
    while (true) {
      const step = await abortable(iterator.next(), signal, stats);
      if (signal?.aborted) throw new HistoryCollectionError('ABORTED', stats);
      if (step.done) {
        stats.fullHistory = true;
        break;
      }
      stats.scanned += 1;
      if (stats.scanned > Number(maxMessages)) throw new HistoryCollectionError('HISTORY_TOO_LARGE', stats);
      const msg = step.value;
      const id = positiveInteger(msg?.id);
      if (!id) throw new HistoryCollectionError('HISTORY_INVALID', stats);
      if (id >= beforeId) { stats.outsideSnapshot += 1; continue; }
      if (seenIds.has(id)) { stats.duplicates += 1; continue; }
      seenIds.add(id);
      if (omitted.has(String(id))) { stats.excludedIds += 1; continue; }
      const text = typeof msg.message === 'string' ? msg.message : typeof msg.text === 'string' ? msg.text : '';
      if (parseCommand(text)) { stats.excludedCommands += 1; continue; }
      if ((msg.out && isServiceText(text.trim())) || isLegacyReport(msg, text.trim())) { stats.excludedService += 1; continue; }
      if (msg.action || msg.className === 'MessageService') { stats.excludedService += 1; continue; }
      const media = mediaKind(msg.media);
      if (!text.trim() && !media) { stats.empty += 1; continue; }
      const sender = stableSender(msg, ownerId);
      const date = isoDate(msg.date);
      const name = [msg.sender?.firstName, msg.sender?.lastName].filter(part => typeof part === 'string' && part.trim()).join(' ')
        || (typeof msg.sender?.title === 'string' ? msg.sender.title : '')
        || (typeof msg.sender?.username === 'string' ? `@${msg.sender.username}` : '');
      const record = { id, date, sender, text: text.trim() ? text : `[${media}: содержимое вложения не прочитано]`, ...(media ? { media, mediaOnly: !text.trim() } : {}), ...(name ? { name } : {}) };
      messages.push(record);
      stats.included = messages.length;
      if (media) stats.mediaMessages += 1;
      if (media && !text.trim()) stats.mediaOnly += 1;
      if (!date) stats.missingDates += 1;
      if (sender.startsWith('unknown:')) stats.unknownSenders += 1;
      if (onProgress && messages.length % 500 === 0) await onProgress({ ...stats });
      if (limit !== 'all' && messages.length >= Number(limit)) break;
    }
    messages.sort((a, b) => a.id - b.id);
    const dates = messages.map(message => message.date).filter(Boolean).sort();
    stats.oldestDate = dates[0] ?? null;
    stats.newestDate = dates.at(-1) ?? null;
    stats.complete = true;
    if (onProgress) await onProgress({ ...stats });
    if (signal?.aborted) throw new HistoryCollectionError('ABORTED', stats);
    return { messages, stats };
  } catch (error) {
    if (error instanceof HistoryCollectionError) throw error;
    // Telegram/RPC exception text may contain phone numbers or other private data.
    throw new HistoryCollectionError(signal?.aborted ? 'ABORTED' : 'HISTORY_UNAVAILABLE', stats);
  } finally {
    if (typeof iterator?.return === 'function') {
      try {
        const closing = iterator.return();
        // An async generator may queue return() behind a stalled next(). Do not
        // turn cancellation into another indefinite wait.
        if (signal?.aborted) Promise.resolve(closing).catch(() => {});
        else await closing;
      } catch { /* Never replace a scrubbed error. */ }
    }
  }
}

/** Split plain text losslessly with a conservative UTF-16 budget, not HTML. */
export function splitPlainText(text, max = 3500) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!Number.isInteger(max) || max < 2 || max > 4095) throw new RangeError('max must be an integer from 2 to 4095');
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + max, text.length);
    // Never split an astral code point across messages.
    if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end -= 1;
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= offset + Math.floor(max / 2)) end = newline + 1;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}
