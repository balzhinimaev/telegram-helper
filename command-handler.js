import { parseCommand, collectHistory, splitPlainText, ANALYSIS_MARKER } from './telegram-commands.js';
import { AnalysisError, safeError } from './analysis-engine.js';

export const HELP = `Команды (отправляй сам в нужный личный чат):
суперанализ — вся доступная история, глубокий разбор участников и перспектив.
суперанализ: стоит ли продолжать общение? — тот же разбор с твоим вопросом.
анализ 50 — кратко о последних 50 сообщениях.
/question О чём мы договорились? number:100 — ответ по истории.
/analysis_help — эта справка.

Результат видят участники этого чата. Только текст и подписи: голос, изображения и удалённые сообщения не анализируются. Число обработанных сообщений, модель и расходы будут указаны в отчёте. Обычные фразы и входящие команды AI не запускают.`;

function errorNotice(error) {
  if (error instanceof AnalysisError) {
    const cost = Number(error.details?.cost || 0);
    return safeError(error) + (cost ? ` Учтённый расход завершённых запросов: $${cost.toFixed(4)}.` : '') + (error.details?.failedRequestMayBeBilled ? ' Неудачный запрос тоже мог быть тарифицирован; автоматических повторов нет.' : '');
  }
  if (error?.userMessage) return String(error.userMessage);
  if (error?.code === 'BUDGET_EXCEEDED' || error?.code === 'TOKEN_BUDGET_EXCEEDED') {
    return 'Вся история не помещается в установленный бюджет. Анализ не сокращён до последних сообщений. Используй «анализ 500» или настрой лимиты на сервере.';
  }
  if (error?.status === 401 || error?.status === 403) return 'OpenAI отклонил ключ или доступ к модели. Проверь настройки на сервере.';
  if (error?.status === 429) return 'OpenAI временно ограничил запросы или закончилась квота. Автоматических платных повторов нет.';
  if (error?.code === 'HISTORY_TOO_LARGE') return 'Доступная история больше ограничения загрузки. Не выдаю часть за весь диалог. Лимит можно увеличить в настройках.';
  if (error?.code === 'HISTORY_UNAVAILABLE') return 'Telegram не отдал историю полностью. Анализ неполной загрузки не запущен; попробуй позже.';
  return 'Не удалось завершить анализ. Частичный разбор не выдан за полный. Готовые части сохранены; можно снова отправить команду. Подробности: безопасный код ошибки в консоли сервера.';
}

export function createCommandHandler({ client, meId, analyzer, state, targetIds = new Set(), defaultLimit = 50, maxMessages = 100000, status = () => {} }) {
  let active = false;
  return async event => {
    const message = event?.message;
    // Commands cost money and publish replies: only the authenticated owner's outgoing DM.
    if (!message?.out || (message.senderId != null && String(message.senderId) !== String(meId)) || !message.peerId?.userId || !message.message) return;
    const chat = String(message.peerId.userId);
    if (targetIds.size && !targetIds.has(chat)) return;
    const command = parseCommand(message.message);
    if (!command || state.has(chat, message.id)) return;
    state.remember('handled', chat, message.id);
    const send = async text => {
      const sent = await client.sendMessage(message.peerId, { message: `${ANALYSIS_MARKER}\n${text}`, parseMode: false, linkPreview: false });
      state.remember('sent', chat, sent.id);
      return sent;
    };
    if (command.mode === 'help') { await send(HELP); return; }
    if (active) { await send('Уже выполняется анализ. Дождись результата и повтори команду — второй платный запрос не запущен.'); return; }
    active = true;
    let progressMessage;
    let lastEdit = 0;
    const progress = async (text, force = false) => {
      if (!progressMessage || (!force && Date.now() - lastEdit < 12000)) return;
      lastEdit = Date.now();
      try { await client.editMessage(message.peerId, { message: progressMessage.id, text: `${ANALYSIS_MARKER}\n${text}`, parseMode: false, linkPreview: false }); } catch { /* Progress never breaks analysis or triggers retries. */ }
    };
    try {
      if (!analyzer) { await send('Для анализа нужен OPENAI_API_KEY в .env на сервере.'); return; }
      status({ stage: 'history' });
      progressMessage = await send('Получаю историю до этой команды. Проверю объём и бюджет до обращения к AI.');
      const history = await collectHistory(client, message.peerId, {
        beforeId: message.id, limit: command.limit ?? defaultLimit, ownerId: String(meId),
        excludeIds: state.excluded(chat), maxMessages,
        signal: AbortSignal.timeout(5 * 60 * 1000),
        onProgress: info => progress(`Загружено сообщений: ${info.included}. Проверяю всю доступную историю до команды.`),
      });
      const records = history.messages.map(m => ({ ...m, name: String(m.sender) === String(meId) ? `${m.name || 'Владелец аккаунта'} (автор команды)` : m.name }));
      if (records.length === (history.stats.mediaOnly || 0)) { await progress('Не найдено текстовых сообщений для анализа. Содержимое вложений не распознаётся.', true); return; }
      const question = command.mode === 'brief'
        ? 'Дай краткий разбор последних сообщений: основная тема, наблюдаемое настроение, взаимность и один полезный следующий шаг. Не делай вывод о всей истории отношений.'
        : command.question;
      const result = await analyzer.analyze({ chatId: chat, messages: records, ownerId: String(meId), question,
        onProgress: async info => {
          status({ stage: info.stage });
          const suffix = info.total ? ` ${info.completed || 0}/${info.total}` : '';
          await progress(`Обрабатываю историю${suffix}. Готовые части используются повторно; лимит расходов проверяется.`);
        },
      });
      const mediaCount = records.filter(m => m.media).length;
      const coverage = command.limit === 'all'
        ? 'Вся доступная текстовая история до команды; итог основан на сжатых разборах частей.'
        : `Последние сообщения (лимит ${command.limit ?? defaultLimit}), не весь диалог.`;
      const header = command.mode === 'super' ? 'СУПЕРАНАЛИЗ ДИАЛОГА' : command.mode === 'question' ? 'ОТВЕТ ПО ПЕРЕПИСКЕ' : 'АНАЛИЗ ДИАЛОГА';
      const cost = Number(result.cost || 0).toFixed(4);
      const footer = `\n\nОХВАТ И РАСХОД\n${coverage}\nСообщений: ${records.length}; с медиа: ${mediaCount}. Вложения не распознавались.\nПериод: ${records[0]?.date?.slice(0,10) || '—'} — ${records.at(-1)?.date?.slice(0,10) || '—'}.\nМодель: ${result.model}; токенов этого запуска: ${result.usage?.totalTokens || 0}; оценка API: $${cost}${result.cacheHit ? ' (готовый результат из кэша)' : ''}.\nУдалённое, звонки и общение вне чата недоступны. Это анализ переписки, не знание о человеке целиком.`;
      const body = result.content.replace(/^(?:СУПЕРАНАЛИЗ ДИАЛОГА|РАЗБОР ПЕРЕПИСКИ)\n\n/, '');
      const chunks = splitPlainText(`${header}\n\n${body}${footer}`, 3400);
      for (let i = 0; i < chunks.length; i++) await send(`${chunks.length > 1 ? `Часть ${i+1}/${chunks.length}\n` : ''}${chunks[i]}`);
      await progress('Анализ готов. Результат ниже; повторная команда использует кэш для неизменившейся истории.', true);
      status({ stage: 'ready', lastAnalysis: new Date().toISOString() });
    } catch (error) {
      // Never print raw API errors, prompts, keys or Telegram messages.
      const code = String(error?.code || error?.name || 'ANALYSIS_ERROR').replace(/[^A-Z_a-z0-9-]/g, '').slice(0,70);
      console.error(`Analysis failed: ${code}`);
      const notice = errorNotice(error);
      if (progressMessage) await progress(notice, true); else await send(notice);
      status({ stage: 'ready', lastError: code });
    } finally { active = false; status({ stage: 'ready' }); }
  };
}
