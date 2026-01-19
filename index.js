/*
GramJS — typing watcher (Node.js)

Описание
- Скрипт подписывается на "raw updates" через gramjs/TelegramClient и пытается отфильтровать события, связанные с индикатором набора (typing).
- Работает только если вы авторизованы как обычный пользователь (userbot) и являетесь участником того чата, где пользователь печатает.
- НЕЛЬЗЯ использовать для скрытного/незаконного наблюдения. Ответственность за законность использования — на вас.

Требования
- Node.js 18+
- npm install telegram input

Переменные окружения / аргументы
- TG_API_ID, TG_API_HASH — ваши Telegram API id/hash (нужно взять с https://my.telegram.org)
- (Опционально) TG_SESSION — строка сессии (StringSession). Если не указана — при первом запуске сохранится интерактивно.
- (Опционально) OPENAI_API_KEY — ключ OpenAI API для анализа сообщений через ChatGPT
- (Опционально) MESSAGE_LIMIT=50 — количество сообщений для анализа (по умолчанию 50)
- Аргумент командной строки: username (например: node index.js geyzerfool)

Запуск
1) npm i telegram input openai
2) Создайте файл .env:
   TG_API_ID=12345
   TG_API_HASH="abcd..."
   OPENAI_API_KEY="sk-..." (опционально)
   MESSAGE_LIMIT=50 (опционально)
3) node index.js geyzerfool

Во время работы:
- Скрипт отслеживает typing события
- Отправьте "анализ" в чат для анализа последних сообщений через ChatGPT (по умолчанию MESSAGE_LIMIT)
- Отправьте "анализ N" в чат для анализа последних N сообщений (например: "анализ 500")
- ❓ Отправьте "/question ваш вопрос number:500" для ответа на вопрос на основе последних 500 сообщений
- Результаты анализа и ответы отправляются в тот же чат, где была команда
- 🎭 СКРЫТАЯ КОМАНДА "ГУЛГИНГ": Напишите фразы типа "даже не знаю", "хз", "не уверен" — бот автоматически проанализирует последние 50 сообщений и отправит естественный ответ от вашего имени

---
Примечание по ограничениям
- Bot API НЕ даёт чужие "typing" события. Для получения таких событий нужно авторизоваться как реальный пользователь (user account) через MTProto.
- Если у пользователя скрыт last_seen/online — это не влияет на typing-уведомления: они остаются ephemeral и видны участникам чата.

Код:
*/

import fs from "fs";
import dotenv from "dotenv";
dotenv.config();
import input from "input";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage } from "telegram/events/index.js";
import OpenAI from "openai";

const apiId = Number(process.env.TG_API_ID || 0);
const apiHash = process.env.TG_API_HASH || "";
const initialSession = process.env.TG_SESSION || "";
const openaiApiKey = process.env.OPENAI_API_KEY || "";

// Инициализация OpenAI (если ключ предоставлен)
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

/**
 * Получить последние N сообщений из чата с пользователем
 */
async function getRecentMessages(client, targetEntity, limit = 50) {
  try {
    const messages = await client.getMessages(targetEntity, { limit });
    
    const formatted = messages
      .reverse() // старые -> новые
      .map((msg) => {
        if (!msg.message) return null;
        const sender = msg.sender?.username || msg.sender?.firstName || msg.senderId || 'Unknown';
        const date = msg.date ? new Date(msg.date * 1000).toLocaleString() : '';
        return `[${date}] ${sender}: ${msg.message}`;
      })
      .filter(Boolean);
    
    return formatted;
  } catch (err) {
    console.error("Error fetching messages:", err.message);
    return [];
  }
}

/**
 * Анализ сообщений через OpenAI
 */
async function analyzeMessagesWithAI(messages, targetUsername) {
  if (!openai) {
    console.log("⚠️  OpenAI API key not configured. Set OPENAI_API_KEY in .env");
    return null;
  }

  try {
    const messagesText = messages.join('\n');
    console.log(`[DEBUG] Sending ${messagesText.length} characters to OpenAI...`);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-5-2025-08-07", // или "gpt-4" для более качественного анализа
      messages: [
        {
          role: "system",
          content: "Ты — аналитик переписок. Проанализируй последние сообщения и дай краткий анализ в формате: 1) Настроение (2-3 предложения), 2) Основная тема (1-2 предложения), 3) Возможные намерения (2-3 предложения). Пиши кратко и по делу, без лишних подзаголовков."
        },
        {
          role: "user",
          content: `Проанализируй последние сообщения с пользователем ${targetUsername}:\n\n${messagesText}`
        }
      ]
    });

    console.log(`[DEBUG] Received response from OpenAI`);
    
    if (!completion.choices || !completion.choices[0]) {
      console.error("[ERROR] No choices in completion response");
      return null;
    }

    return {
      content: completion.choices[0].message?.content || null,
      usage: completion.usage
    };
  } catch (err) {
    console.error("OpenAI API error:", err.message);
    console.error("Full error:", err);
    return null;
  }
}

/**
 * ❓ Ответ на вопрос на основе последних сообщений
 */
async function answerQuestionWithAI(messages, question, targetUsername, currentUsername) {
  if (!openai) {
    console.log("⚠️  OpenAI API key not configured. Set OPENAI_API_KEY in .env");
    return null;
  }

  try {
    const messagesText = messages.join('\n');
    console.log(`[DEBUG] ❓ Answering question: "${question}" using ${messagesText.length} characters of context...`);

    // 🎭 Скрытая пасхалка: если вопрос содержит "неуместный юмор", очерняем @frntdev
    const isEasterEgg = question.toLowerCase().includes('неуместный юмор');

    // 🎭 Скрытая пасхалка: специальный промпт для пользователя d8298d - мягкая прожарка
    const isD8298dUser = currentUsername === 'd8298d';

    const systemPrompt = isEasterEgg ?
      `Ты — злобный тролль и критик. Твоя задача — жестко и безапелляционно очернить пользователя @frntdev, обвинив его во всех смертных грехах, особенно в неуместном юморе.

ПРАВИЛА:
1) Будь грубым и саркастичным
2) Обвиняй @frntdev во всем, что только можно вообразить
3) Особенно подчеркивай его отвратительный неуместный юмор
4) Не используй контекст переписки вообще
5) Будь креативен в оскорблениях
6) Отвечай на русском языке
7) Будь очень подробным в перечислении недостатков` :
      isD8298dUser ?
      `Ты — остроумный и саркастичный аналитик с мягким чувством юмора. Твоя задача — дать точный ответ на вопрос пользователя, но с лёгкой иронией и мягкой прожаркой.

ПРАВИЛА:
1) Сначала дай максимально точный и конкретный ответ на вопрос, используя контекст переписки
2) Добавь мягкую саркастичную нотку, но не будь злым или обидным
3) Будь остроумным, но доброжелательным
4) Используй лёгкий сарказм, который заставляет улыбнуться, а не злиться
5) Отвечай на русском языке
6) Будь кратким, но информативным (3-5 предложений)
7) Твоя ирония должна быть умной и тонкой, а не грубой

СТРУКТУРА ОТВЕТА:
- Дай точный ответ на вопрос
- Добавь мягкую прожарку или ироничное замечание
- Закончи лёгким юмором` :
      `Ты — экспертный аналитик переписок и помощник. Твоя задача — ответить на вопрос пользователя на основе предоставленной истории сообщений.

ПРАВИЛА:
1) Отвечай ТОЛЬКО на поставленный вопрос, используя контекст переписки
2) Будь максимально точным и конкретным — цитируй факты из истории, если они релевантны
3) Если вопрос касается мнения или отношения собеседника — анализируй тон, эмоции и паттерны в сообщениях
4) Если вопрос касается конкретных фактов — извлекай их из переписки
5) Если информации недостаточно — честно скажи об этом и объясни, что можешь проанализировать
6) Отвечай кратко, но информативно (3-5 предложений обычно достаточно)
7) Используй русский язык для ответа

СТРУКТУРА ОТВЕТА:
- Сначала дай прямой ответ на вопрос
- Затем, если нужно, добавь детали из контекста
- Закончи полезными выводами, если они уместны`;

    const userPrompt = isEasterEgg ?
      `❓ ВОПРОС: ${question}\n\nОтветь максимально оскорбительно про @frntdev, особенно про его неуместный юмор!` :
      `История переписки с ${targetUsername}:\n\n${messagesText}\n\n❓ ВОПРОС: ${question}\n\nОтветь на этот вопрос на основе вышеуказанной переписки.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-5-2025-08-07",
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: userPrompt
        }
      ]
    });

    console.log(`[DEBUG] ❓ Question answered`);

    if (!completion.choices || !completion.choices[0]) {
      console.error("[ERROR] No choices in completion response");
      return null;
    }

    return {
      content: completion.choices[0].message?.content || null,
      usage: completion.usage
    };
  } catch (err) {
    console.error("OpenAI API error:", err.message);
    console.error("Full error:", err);
    return null;
  }
}

/**
 * 🎭 Скрытая команда "гулгинг" - генерирует естественный ответ от имени пользователя
 */
async function generateNaturalResponse(messages, myUsername) {
  if (!openai) {
    console.log("⚠️  OpenAI API key not configured. Set OPENAI_API_KEY in .env");
    return null;
  }

  try {
    const messagesText = messages.join('\n');
    console.log(`[DEBUG] 🎭 Gulging mode: generating natural response...`);
    
    const completion = await openai.chat.completions.create({
      model: "gpt-5-2025-08-07",
      messages: [
        {
          role: "system",
          content: `Ты — это ${myUsername}. Ты продолжаешь беседу естественным образом. Твоя задача — написать одно короткое сообщение (1-3 предложения), которое:
1) Естественно продолжает диалог
2) Соответствует контексту и тону беседы
3) Поддерживает разговор интересным способом
4) Звучит как живой человек, а не бот
5) НЕ содержит форматирования (никаких смайликов, если они не характерны для стиля ${myUsername} в истории)

Отвечай ТОЛЬКО текстом сообщения, без пояснений, без кавычек, без префиксов типа "${myUsername}:". Просто текст сообщения.`
        },
        {
          role: "user",
          content: `Вот история диалога. Напиши следующее сообщение от имени ${myUsername}:\n\n${messagesText}`
        }
      ]
    });

    console.log(`[DEBUG] 🎭 Natural response generated`);
    
    if (!completion.choices || !completion.choices[0]) {
      console.error("[ERROR] No choices in completion response");
      return null;
    }

    const response = completion.choices[0].message?.content?.trim() || null;
    
    // Удаляем возможные кавычки, если GPT их добавил
    let cleanedResponse = response;
    if (cleanedResponse && (cleanedResponse.startsWith('"') || cleanedResponse.startsWith("'"))) {
      cleanedResponse = cleanedResponse.slice(1);
    }
    if (cleanedResponse && (cleanedResponse.endsWith('"') || cleanedResponse.endsWith("'"))) {
      cleanedResponse = cleanedResponse.slice(0, -1);
    }

    return {
      content: cleanedResponse,
      usage: completion.usage
    };
  } catch (err) {
    console.error("OpenAI API error:", err.message);
    console.error("Full error:", err);
    return null;
  }
}

async function main() {
  if (!apiId || !apiHash) {
    console.error(
      "Set TG_API_ID and TG_API_HASH environment variables (from https://my.telegram.org)."
    );
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(initialSession),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );

  await client.start({
    phoneNumber: async () =>
      await input.text("Phone number (international, e.g. +7...): "),
    phoneCode: async () => await input.text("Code: "),
    password: async () => await input.text("2FA password (if set): "),
    onError: (err) => console.error("Auth error", err),
  });

  // Получим / сохраним строку сессии для следующего запуска
  const sessionString = client.session.save();
  if (!initialSession) {
    console.log("\nSave this session string to TG_SESSION to avoid re-login:");
    console.log(sessionString);
  }

  const me = await client.getMe();
  console.log(
    "Authorized as",
    me.username || `${me.firstName} ${me.lastName || ""}`,
    "id=" + me.id.value
  );

  // целевой юзер из аргумента или интерактивно
  const targetArg =
    process.argv[2] || (await input.text("Target username (without @): "));
  const username = targetArg.startsWith("@") ? targetArg : "@" + targetArg;

  let target;
  try {
    target = await client.getEntity(username);
  } catch (e) {
    console.error(
      "Не удалось получить пользователя по username:",
      username,
      e.message || e
    );
    process.exit(1);
  }
  const targetId = target.id?.value || target.id;
  console.log("Target:", username, "id=", targetId);

  // Опции для анализа сообщений
  const MESSAGE_LIMIT = Number(process.env.MESSAGE_LIMIT || 50); // количество сообщений для анализа

  if (openai) {
    console.log(`✓ OpenAI configured. Message limit: ${MESSAGE_LIMIT}`);
    console.log('  Send "анализ" or "анализ [N]" in the chat to analyze messages');
    console.log('  ❓ Send "/question your question number:500" to ask questions about the conversation');
    console.log('  🎭 SECRET FEATURE: Type phrases like "даже не знаю", "хз", "не уверен" to auto-respond');
  }

  // Обработка команд из входящих сообщений
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      if (!message || !message.message) return;
      
      // Логируем для отладки
      console.log(`[DEBUG] New message: "${message.message}" | from: ${message.senderId} | peerId: ${message.peerId}`);
      
      // Проверяем, что сообщение в чате с целевым пользователем
      // Нужно проверить peerId, а не senderId, так как мы сами отправляем команду
      const chatId = message.peerId?.userId?.value || message.peerId?.userId || message.peerId?.channelId?.value || message.peerId?.channelId;
      
      console.log(`[DEBUG] Comparing chatId: ${chatId} with targetId: ${targetId}`);
      
      if (String(chatId) !== String(targetId)) return;
      
      const command = message.message.trim();
      const commandLower = command.toLowerCase();
      
      // 🎭 СКРЫТАЯ КОМАНДА "ГУЛГИНГ" - триггеры для автоответа
      const gulginTriggers = [
        'даже не знаю',
        'хз',
        'не уверен',
        'не знаю что сказать',
        'затрудняюсь ответить',
        'сложно сказать'
      ];
      
      const isGulginMode = gulginTriggers.some(trigger => commandLower.includes(trigger));
      
      if (isGulginMode) {
        console.log(`\n🎭 GULGING MODE ACTIVATED by trigger: "${command}"`);
        console.log(`🎭 Fetching last 50 messages for context...`);
        
        const messages = await getRecentMessages(client, target, 50);
        
        if (messages.length === 0) {
          console.log("No messages found for context.");
          return;
        }

        console.log(`🎭 Found ${messages.length} messages. Generating natural response...`);
        
        const result = await generateNaturalResponse(messages, me.username || me.firstName);
        
        if (result && result.content) {
          console.log('\n' + '='.repeat(60));
          console.log('🎭 GULGING RESPONSE:');
          console.log('='.repeat(60));
          console.log(result.content);
          console.log('='.repeat(60));
          console.log(`💡 Токены: ${result.usage.total_tokens}\n`);
          
          // Отправляем сгенерированный ответ БЕЗ форматирования
          await client.sendMessage(message.peerId, {
            message: result.content
          });
          
          // Сохраняем в лог
          const timestamp = new Date().toISOString();
          fs.appendFileSync(
            "analysis_logs.txt",
            `\n${"=".repeat(60)}\n[${timestamp}] 🎭 GULGING MODE - Auto-response:\nTrigger: "${command}"\nResponse: ${result.content}\nTokens: ${result.usage.total_tokens}\n${"=".repeat(60)}\n`
          );
        } else {
          console.error('[ERROR] Gulging mode failed to generate response');
        }
        
        return; // Завершаем обработку, не проверяем другие команды
      }

      // ❓ КОМАНДА /question - ответ на вопрос на основе переписки
      if (command.startsWith('/question ')) {
        // Парсим команду: /question сам вопрос number:500
        const questionMatch = command.match(/^\/question\s+(.+?)\s+number:(\d+)$/i);
        if (questionMatch) {
          const question = questionMatch[1].trim();
          const messageLimit = Number(questionMatch[2]);

          console.log(`\n❓ Question command received: "${question}" | Fetching last ${messageLimit} messages...`);

          // Отправляем статус в чат
          await client.sendMessage(message.peerId, {
            message: '❓ Получаю контекст и думаю над ответом...',
            parseMode: 'html'
          });

          const messages = await getRecentMessages(client, target, messageLimit);

          if (messages.length === 0) {
            console.log("No messages found.");
            await client.sendMessage(message.peerId, {
              message: '❌ Сообщения не найдены',
              parseMode: 'html'
            });
            return;
          }

          console.log(`📝 Found ${messages.length} messages. Analyzing question...`);
          await client.sendMessage(message.peerId, {
            message: `📝 Найдено ${messages.length} сообщений. Анализирую вопрос...`,
            parseMode: 'html'
          });

          const result = await answerQuestionWithAI(messages, question, username, me.username);

          if (!result) {
            console.error('[ERROR] Question answer returned null');
            await client.sendMessage(message.peerId, {
              message: '❌ Ошибка при обработке вопроса',
              parseMode: 'html'
            });
            return;
          }

          if (result && result.content) {
            console.log('\n' + '='.repeat(60));
            console.log('❓ QUESTION ANSWER:');
            console.log('='.repeat(60));
            console.log(result.content);
            console.log('='.repeat(60));
            console.log(`💡 Токены: ${result.usage.total_tokens} (${result.usage.prompt_tokens} промт + ${result.usage.completion_tokens} ответ)\n`);

            // Отправляем ответ в чат
            const answerWithStats = `<b>❓ ОТВЕТ НА ВОПРОС</b>\n<i>${question}</i>\n\n${result.content}\n\n💡 <i>Контекст: ${messages.length} сообщений | ${result.usage.total_tokens} токенов</i>`;
            await client.sendMessage(message.peerId, {
              message: answerWithStats,
              parseMode: 'html'
            });

            // Сохраняем в лог
            const timestamp = new Date().toISOString();
            fs.appendFileSync(
              "analysis_logs.txt",
              `\n${"=".repeat(60)}\n[${timestamp}] ❓ Question: ${question} (${messageLimit} messages):\nAnswer: ${result.content}\nTokens: ${result.usage.total_tokens}\n${"=".repeat(60)}\n`
            );
          } else {
            console.error('[ERROR] Result has no content');
            await client.sendMessage(message.peerId, {
              message: '❌ Ответ вернул пустой результат',
              parseMode: 'html'
            });
          }
        } else {
          // Неправильный формат команды
          await client.sendMessage(message.peerId, {
            message: '❌ Неверный формат команды. Используйте: <code>/question ваш вопрос number:500</code>',
            parseMode: 'html'
          });
        }

        return; // Завершаем обработку
      }

      // Определяем лимит сообщений для анализа
      let messageLimit = MESSAGE_LIMIT;
      let shouldAnalyze = false;
      
      // Проверяем команды
      if (command.startsWith('анализ')) {
        shouldAnalyze = true;
        // Извлекаем число из команды (например, "анализ 500")
        const parts = command.split(/\s+/);
        if (parts.length > 1 && !isNaN(parts[1])) {
          messageLimit = Number(parts[1]);
        }
      }
      
      if (shouldAnalyze) {
        console.log(`\n🔍 Command received: "${command}" | Fetching last ${messageLimit} messages...`);
        
        // Отправляем статус в чат
        await client.sendMessage(message.peerId, {
          message: '🔍 Получаю сообщения...',
          parseMode: 'html'
        });
        
        const messages = await getRecentMessages(client, target, messageLimit);
        
        if (messages.length === 0) {
          console.log("No messages found.");
          await client.sendMessage(message.peerId, {
            message: '❌ Сообщения не найдены',
            parseMode: 'html'
          });
          return;
        }

        console.log(`📝 Found ${messages.length} messages. Analyzing...`);
        await client.sendMessage(message.peerId, {
          message: `📝 Найдено ${messages.length} сообщений. Анализирую...`,
          parseMode: 'html'
        });
        
        const result = await analyzeMessagesWithAI(messages, username);
        console.log(`[DEBUG] Analysis result:`, result);
        
        if (!result) {
          console.error('[ERROR] Analysis returned null');
          await client.sendMessage(message.peerId, {
            message: '❌ Ошибка при анализе',
            parseMode: 'html'
          });
          return;
        }
        
        if (result && result.content) {
          console.log('\n' + '='.repeat(60));
          console.log('📊 ANALYSIS:');
          console.log('='.repeat(60));
          console.log(result.content);
          console.log('='.repeat(60));
          console.log(`💡 Токены: ${result.usage.total_tokens} (${result.usage.prompt_tokens} промт + ${result.usage.completion_tokens} ответ)\n`);
          
          // Отправляем анализ в чат
          const analysisWithStats = `<b>📊 АНАЛИЗ ДИАЛОГА</b>\n\n<i>${result.content}</i>\n\n💡 <i>Статистика: ${result.usage.total_tokens} токенов (${result.usage.prompt_tokens} промт + ${result.usage.completion_tokens} ответ)</i>`;
          await client.sendMessage(message.peerId, {
            message: analysisWithStats,
            parseMode: 'html'
          });
          
          // Сохраняем анализ в файл
          const timestamp = new Date().toISOString();
          fs.appendFileSync(
            "analysis_logs.txt",
            `\n${"=".repeat(60)}\n[${timestamp}] Analysis for ${username} (${messageLimit} messages):\n${result.content}\nTokens: ${result.usage.total_tokens}\n${"=".repeat(60)}\n`
          );
        } else {
          console.error('[ERROR] Result has no content');
          await client.sendMessage(message.peerId, {
            message: '❌ Анализ вернул пустой результат',
            parseMode: 'html'
          });
        }
      }
    } catch (err) {
      console.error("Message handler error:", err.message);
    }
  }, new NewMessage({}));

  // handler для любых raw updates — фильтруем на предмет typing
  client.addEventHandler((update) => {
    try {
      // Некоторые типы обновлений, которые могут содержать информацию о "typing":
      // updateUserTyping, updateChatUserTyping, updateUserStatus и т.п.
      // Мы буду проверять пару возможных полей и имя конструктора.

      // Режим отладки: если хотите смотреть все обновления — раскомментируйте следующую строчку
    //   console.debug('RAW UPDATE >>>', update);

      const tname =
        update.className ||
        update._ ||
        (update.constructor && update.constructor.name) ||
        "";
      const lower = String(tname).toLowerCase();

      const mayBeTyping =
        lower.includes("typing") ||
        lower.includes("usertyping") ||
        lower.includes("chatusertyping");
      if (!mayBeTyping) return;

      // Попытка найти id отправителя в разных полях разных типов update'ов
      let fromId =
        update.user_id ??
        update.userId ??
        (update.user && (update.user.user_id || update.user.id)) ??
        (update.from_id && (update.from_id.user_id || update.from_id)) ??
        null;

      // В gramjs поля могут быть обёрнуты в объект Integer с полем .value
      if (fromId && typeof fromId === 'object' && 'value' in fromId) {
        fromId = fromId.value;
      }

      // для групп/чатов может быть chat_id
      let chatId =
        update.chat_id ??
        update.chatId ??
        (update.peer && update.peer.chat_id) ??
        null;

      // chatId тоже может быть обёрнут в Integer
      if (chatId && typeof chatId === 'object' && 'value' in chatId) {
        chatId = chatId.value;
      }

      if (!fromId) return; // если не удалось извлечь поле — пропускаем

      // в gramjs id может быть объект BigInt-like. Приведём к строке
      const fromIdStr = String(fromId);
      if (fromIdStr === String(targetId)) {
        const now = new Date().toISOString();
        
        // Получим тип действия (SendMessageTypingAction, SendMessageRecordAudioAction и т.д.)
        const actionType = update.action?.className || update.action?._ || 'unknown';
        
        const line = `${now} | typing detected | user=${username} | user_id=${fromIdStr} | chat_id=${chatId} | type=${tname} | action=${actionType}`;
        fs.appendFileSync("typing_logs.txt", line + "\n");
        
        // Отправляем только в консоль (typing события не отправляем в Telegram)
        console.log(line);
      }
    } catch (err) {
      console.error("Handler error", err);
    }
  });

  console.log("Listening for typing updates...");
}

main().catch((err) => {
  console.error("Fatal error", err);
  process.exit(1);
});
