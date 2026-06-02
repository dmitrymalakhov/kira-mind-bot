import { BotContext } from '../types';
import { FactExtractionService } from '../services/FactExtractionService';
import { saveMemory } from './enhancedDomainMemory';
import { devLog, parseLLMJson } from '../utils';
import { rememberFact } from './domainMemory';
import openai, { openAiModels } from '../openai';
import { normalizeContactLookupValue, saveContactMemoryFactOrAsk } from './contactMemory';
import { createMemoryEpisode, updateWorkingMemoryFromMessages } from '../services/MemoryEpisodeService';

interface QuickFact {
    content: string;
    domain: string;
    importance: number;
    tags: string[];
}

const factService = new FactExtractionService();

function sourceMessageIds(messages: any[]): string[] {
    return messages
        .map((m, index) => {
            const ts = m.timestamp instanceof Date
                ? m.timestamp.getTime()
                : new Date(m.timestamp ?? Date.now()).getTime();
            return `${m.role || 'message'}:${ts}:${index}`;
        })
        .slice(-12);
}

/** Паттерны явной просьбы запомнить — при совпадении факт сразу сохраняется в векторную БД (долговременная память). */
const EXPLICIT_REMEMBER_PATTERNS: RegExp[] = [
    // «Запомни, что …» / «Запомни что …» / «Запомни: …»
    /запомни\s*(?:,|что|:)\s*(.+)/i,
    // «Запомни это: …» / «Запомни на будущее что …»
    /запомни\s+(?:это|на будущее)\s*(?:[:\s,]+|что\s+)?(.+)/i,
    // «Сохрани в память что …» / «Сохрани что …»
    /сохрани\s+в память\s*(?:,|что|:)\s*(.+)/i,
    /сохрани\s*(?:,|что|:)\s*(.+)/i,
    // «Запиши что …» / «Запиши, что …»
    /запиши\s*(?:,|что)\s*(.+)/i,
    // «Не забывай что …» / «Не забывай, что …»
    /не забывай\s*(?:,|что)\s*(.+)/i,
    // «Важно запомнить что …» / «Нужно запомнить …»
    /(?:важно|нужно)\s+запомнить\s*(?:,|что)?\s*(.+)/i,
    // «Хочу чтобы ты запомнила …» / «Запомни пожалуйста что …»
    /(?:хочу\s+чтобы\s+ты\s+запомнила?|запомни\s+пожалуйста)\s*(?:,|что)?\s*(.+)/i,
    // English
    /remember\s+that\s+(.+)/i,
    /keep in mind\s+(?:that\s+)?(.+)/i,
    /don't forget\s+that\s+(.+)/i,
    /save\s+(?:to memory|that)\s+(.+)/i,
    // Общий «Запомни …» (одно или несколько слов после)
    /^запомни\s+(.+)/i,
];

const EXPLICIT_REMEMBER_IMPORTANCE = 0.95;
const EXPLICIT_REMEMBER_DOMAIN = 'personal';

export interface ExplicitRememberFact {
    content: string;
    domain: string;
    importance: number;
    /** Имя контакта, если факт о третьем лице, а не о самом пользователе */
    contactName?: string;
}

/**
 * Слово имени/фамилии: начинается с буквы (рус/лат, любой регистр), только буквы.
 * Захватываем от 1 до 3 слов (имя + фамилия + отчество).
 */
const NAME_WORD = '[А-ЯЁA-Zа-яёa-z][А-ЯЁA-Zа-яёa-z-]*';
const NAME_PATTERN = `(${NAME_WORD}(?:\\s+${NAME_WORD}){0,2})`;
const CAPITALIZED_NAME_WORD = '[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]*';
const CAPITALIZED_NAME_PATTERN = `(${CAPITALIZED_NAME_WORD}(?:\\s+${CAPITALIZED_NAME_WORD}){0,2})`;
const USERNAME_PATTERN = '(@[a-zA-Z0-9_]{3,32})';

/** Паттерны вида «о/об/про [Имя Фамилия]» в начале извлечённого содержимого */
const THIRD_PARTY_PATTERNS: RegExp[] = [
    // «инфу про @username»
    new RegExp(`^(?:эти\\s+)?(?:факты?|данные|сведения|информацию?|инфу)\\s+(?:об?\\s+|про\\s+)${USERNAME_PATTERN}`, 'i'),
    new RegExp(`^(?:об?\\s+|про\\s+)${USERNAME_PATTERN}`, 'i'),
    // «эти факты об Юрии Никишенко», «информацию про Сашу Клименко»
    new RegExp(`^(?:эти\\s+)?(?:факты?|данные|сведения|информацию?|инфу)\\s+(?:об?\\s+|про\\s+)${NAME_PATTERN}`, 'i'),
    // «об Юрии Никишенко», «о Юре», «про Сашу Никонова»
    new RegExp(`^(?:об?\\s+|про\\s+)${NAME_PATTERN}`, 'i'),
];

/** Паттерны вида «Юра любит кофе» после явного «запомни, что …». */
const THIRD_PARTY_SUBJECT_PATTERNS: RegExp[] = [
    new RegExp(`^${USERNAME_PATTERN}\\s+`, 'i'),
    new RegExp(`^${CAPITALIZED_NAME_PATTERN}\\s+(?:любит|не\\s+любит|работает|жив[её]т|переехал[аи]?|болеет|заболел[аи]?|учится|женат|замужем|развел[а-я]*|встречается|знает|умеет|предпочитает|хочет|планирует|собирается)(?=\\s|$|[,.:;!?])`),
    new RegExp(`^${NAME_PATTERN}\\s+(?:любит|не\\s+любит|работает|жив[её]т|переехал[аи]?|болеет|заболел[аи]?|учится|женат|замужем|развел[а-я]*|встречается|знает|умеет|предпочитает|хочет|планирует|собирается)(?=\\s|$|[,.:;!?])`, 'i'),
];

const NON_CONTACT_SUBJECT_WORDS = new Set([
    'я', 'меня', 'мне', 'мой', 'моя', 'моё', 'мои', 'мы', 'нас', 'нам', 'наш', 'наша', 'наши',
    'ты', 'тебя', 'тебе', 'он', 'она', 'они', 'его', 'ее', 'её', 'их',
    'жена', 'муж', 'мама', 'папа', 'сын', 'дочь', 'брат', 'сестра', 'коллега', 'друг', 'подруга',
]);

/**
 * Нормализует имя контакта.
 * Если захвачено несколько слов — используем все (полное имя с фамилией).
 */
function normalizeContactName(name: string): string {
    // Приводим каждое слово к Title Case для консистентного ключа
    return name.trim().split(/\s+/).map(w => {
        if (!w) return w;
        // Для кириллицы: первая буква upper, остальные lower
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
}

function looksLikeConcreteContactName(name: string): boolean {
    const firstWord = name.trim().split(/\s+/)[0]?.toLowerCase();
    if (!firstWord || NON_CONTACT_SUBJECT_WORDS.has(firstWord)) return false;
    if (name.startsWith('@')) return true;
    return /^[А-ЯЁA-Zа-яёa-z][А-ЯЁA-Zа-яёa-z-]*(?:\s+[А-ЯЁA-Zа-яёa-z][А-ЯЁA-Zа-яёa-z-]*){0,2}$/.test(name.trim());
}

/**
 * Проверяет, просит ли пользователь явно что-то запомнить. Если да — возвращает факт для сохранения в векторную БД (долговременная память).
 * Если факт о третьем лице — возвращает contactName.
 */
export function extractExplicitRememberFact(message: string): ExplicitRememberFact | null {
    const trimmed = message.trim();
    if (!trimmed || trimmed.length < 3) return null;

    for (const re of EXPLICIT_REMEMBER_PATTERNS) {
        const match = trimmed.match(re);
        if (match && match[1]) {
            const content = match[1].trim();
            if (content.length < 2) return null;

            // Проверяем, о третьем ли лице этот факт
            for (const tpRe of THIRD_PARTY_PATTERNS) {
                const tpMatch = content.match(tpRe);
                if (tpMatch && tpMatch[1]) {
                    if (!looksLikeConcreteContactName(tpMatch[1])) continue;
                    return {
                        content,
                        domain: EXPLICIT_REMEMBER_DOMAIN,
                        importance: EXPLICIT_REMEMBER_IMPORTANCE,
                        contactName: normalizeContactName(tpMatch[1]),
                    };
                }
            }

            for (const tpRe of THIRD_PARTY_SUBJECT_PATTERNS) {
                const tpMatch = content.match(tpRe);
                if (tpMatch && tpMatch[1]) {
                    if (!looksLikeConcreteContactName(tpMatch[1])) continue;
                    return {
                        content,
                        domain: EXPLICIT_REMEMBER_DOMAIN,
                        importance: EXPLICIT_REMEMBER_IMPORTANCE,
                        contactName: normalizeContactName(tpMatch[1]),
                    };
                }
            }

            return {
                content,
                domain: EXPLICIT_REMEMBER_DOMAIN,
                importance: EXPLICIT_REMEMBER_IMPORTANCE,
            };
        }
    }
    return null;
}

export async function extractAndSaveFactsFromConversation(
    ctx: BotContext,
    startIndex: number = 0
): Promise<number> {
    try {
        // Анализируем только новые сообщения: история в порядке от новых к старым (index 0 = последнее)
        const totalCount = ctx.session.messageHistory.length;
        const effectiveStartIndex = startIndex >= totalCount ? 0 : Math.max(0, startIndex);
        const newCount = Math.max(0, totalCount - effectiveStartIndex);
        const recentMessages = ctx.session.messageHistory.slice(0, Math.min(10, newCount));
        const conversation = recentMessages.reverse();

        if (conversation.length < 1) {
            devLog('Нет сообщений для анализа фактов');
            return 0;
        }

        devLog(
            `🔍 Анализ фактов: ${conversation.length} сообщений в хронологическом порядке`
        );
        conversation.forEach((msg, i) => {
            devLog(`  ${i}: ${msg.role} - "${msg.content.slice(0, 50)}..."`);
        });

        const lastUserMessage = conversation.find(msg => msg.role === 'user');
        if (lastUserMessage) {
            devLog(
                `📝 Анализируем последнее сообщение пользователя: "${lastUserMessage.content.slice(0, 100)}..."`
            );
            // const singleMessageFacts = await factService.extractFactsFromSingleMessage(lastUserMessage.content);
        }

        devLog(`Анализ фактов: ${conversation.length} сообщений, начиная с индекса ${startIndex}`);

        const dialoguePairs = groupMessagesIntoDialogue(conversation);

        if (dialoguePairs.length === 0) {
            devLog('Нет пользовательских сообщений для анализа фактов');
            ctx.session.lastFactAnalysisIndex = ctx.session.messageHistory.length;
            return 0;
        }

        const episode = await createMemoryEpisode(ctx, conversation, ['delayed-fact-analysis']);
        await updateWorkingMemoryFromMessages(ctx, conversation, episode);

        const facts = await factService.extractFactsFromDialogue(dialoguePairs);

        devLog(`Извлечено фактов: ${facts.length}`);
        if (facts.length === 0) {
            console.warn('⚠️ Мониторинг качества: при анализе диалога факты не найдены');
        }

        let savedCount = 0;
        const messageIds = sourceMessageIds(conversation);
        // Список фактов, уже сохранённых quickFactCheck — пропускаем похожие
        const alreadySaved = ctx.session.quickFactContents ?? [];
        const seenFactKeys = new Set<string>();
        for (const fact of facts) {
            if (fact.confidence > 0.5 && fact.importance > 0.3) {
                const factContent = (fact.subject === 'contact' && fact.contactName)
                    ? `[${fact.contactName}] ${fact.content}`
                    : fact.content;
                const factKey = [
                    fact.subject ?? 'user',
                    fact.subject === 'contact' ? normalizeContactLookupValue(fact.contactName ?? '') : '',
                    fact.domain,
                    factContent.trim().replace(/\s+/g, ' ').toLowerCase(),
                ].join('|');

                if (seenFactKeys.has(factKey)) {
                    devLog(`⏩ Факт пропущен (дубль в текущем delayed-анализе): ${factContent.slice(0, 60)}`);
                    continue;
                }
                seenFactKeys.add(factKey);

                // Пропускаем факты, уже сохранённые quickFactCheck (нечёткое сравнение)
                const isDuplicate = alreadySaved.some(saved => {
                    const a = saved.toLowerCase();
                    const b = factContent.toLowerCase();
                    // Один содержит другой или совпадают по ключевым словам
                    return a.includes(b) || b.includes(a) ||
                        (a.length > 10 && b.length > 10 && a.slice(0, 30) === b.slice(0, 30));
                });
                if (isDuplicate) {
                    devLog(`⏩ Факт пропущен (уже сохранён quickFactCheck): ${factContent.slice(0, 60)}`);
                    continue;
                }

                if (fact.subject === 'contact' && fact.contactName) {
                    const result = await saveContactMemoryFactOrAsk(ctx, {
                        contactName: fact.contactName,
                        content: fact.content,
                        domain: fact.domain,
                        importance: fact.importance,
                        tags: fact.tags,
                        memoryMetadata: {
                            sourceEpisodeId: episode?.id,
                            sourceContext: fact.sourceContext,
                            sourceMessageIds: messageIds,
                            extractionMethod: 'delayed',
                            subject: 'contact',
                            predicate: fact.factType,
                            object: fact.content,
                        },
                    }, {
                        askOnAmbiguous: false,
                    });
                    if (result.status === 'pending') {
                        devLog(`Факт о контакте ожидает уточнения: [${fact.contactName}] ${fact.content}`);
                        continue;
                    }
                    if (result.status !== 'saved') {
                        devLog(`Факт о контакте пропущен без уточнения: [${fact.contactName}] ${fact.content}`);
                        continue;
                    }
                    devLog(`Сохранен факт о контакте [${fact.contactName}]: ${fact.content}`);
                } else {
                    const saved = await saveMemory(ctx, fact.domain, fact.content, fact.importance, fact.tags, false, {
                        sourceEpisodeId: episode?.id,
                        sourceContext: fact.sourceContext,
                        sourceMessageIds: messageIds,
                        extractionMethod: 'delayed',
                        subject: 'user',
                        predicate: fact.factType,
                        object: fact.content,
                    });
                    if (!saved) continue;
                    rememberFact(ctx, fact.domain, fact.content);
                    devLog(`Сохранен факт о пользователе: ${fact.content}`);
                }
                savedCount++;
            } else {
                devLog(`Факт отклонен (низкие показатели): ${fact.content} (conf: ${fact.confidence}, imp: ${fact.importance})`);
            }
        }

        devLog(`Сохранено фактов: ${savedCount} из ${facts.length}`);

        devLog(`📊 Статистика анализа:\n  - Всего сообщений в истории: ${ctx.session.messageHistory.length}\n  - Анализируется сообщений: ${conversation.length}\n  - Последний анализ был на индексе: ${ctx.session.lastFactAnalysisIndex}\n  - Создано диалоговых пар: ${dialoguePairs.length}`);

        ctx.session.lastFactAnalysisIndex = ctx.session.messageHistory.length;
        // Очищаем quickFactContents — delayed analysis обработал все накопленные сообщения
        ctx.session.quickFactContents = [];
        return savedCount;

    } catch (error) {
        console.error('Ошибка в анализе фактов из разговора:', error);
        return 0;
    }
}

export async function quickFactCheck(message: string): Promise<QuickFact[]> {
    const trimmed = message.trim();
    if (!trimmed) return [];

    const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const prompt = `
Определи, содержит ли сообщение пользователя ЯВНЫЕ личные факты о НЁМ САМОМ (имя, возраст, отношения, семья, личные данные, устойчивые предпочтения, работа, место жительства, текущее местонахождение, поездки и путешествия).

Сегодняшняя дата: ${today}

Сообщение:
"${trimmed}"

КРИТИЧЕСКИ ВАЖНО:
- Если сообщение содержит инструкцию запомнить или сохранить факты О КОНКРЕТНОМ ЧЕЛОВЕКЕ (например: "запомни об Иване", "сохрани эти факты о Юрии Никишенко", "запомни про Юру") — это НЕ факты о пользователе. Верни {"facts": []}.
- Если в сообщении есть реплай или цитата чужого сообщения (например "[В ответ на ...]") — не извлекай факты из цитируемого текста, только из слов самого пользователя.
- Извлекай ТОЛЬКО факты о самом пользователе, пишущем сообщение.

ВАЖНО: Если пользователь сообщает о своём ТЕКУЩЕМ местонахождении или состоянии события (поездка, путешествие, конференция и т.д.) — это факт, включай его с датой.
Примеры:
- "Я уже во Вьетнаме" → "Сейчас во Вьетнаме (с ${today})" (domain: travel, importance: 0.8)
- "Уже прилетел в Токио" → "Сейчас в Токио (с ${today})" (domain: travel, importance: 0.8)
- "Вернулся из Вьетнама" → "Вернулся из Вьетнама (${today})" (domain: travel, importance: 0.7)
- "Сейчас занят" → НЕ факт (слишком расплывчато)

Верни ТОЛЬКО JSON:
{
  "facts": [
    {
      "content": "краткий факт",
      "domain": "work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general",
      "importance": 0.0-1.0,
      "tags": ["tag1", "tag2"]
    }
  ]
}

Если явных фактов нет, верни {"facts": []}.`;

    try {
        const response = await openai.chat.completions.create({
            model: openAiModels.memoryExtractionModel,
            messages: [
                {
                    role: 'system',
                    content: 'Ты быстрый бинарный классификатор личных фактов. Отвечай строго JSON без пояснений.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 1, // модель поддерживает только default (1)
        });

        const content = response.choices[0]?.message?.content || '';
        const parsed = parseLLMJson<{ facts?: unknown[] }>(content);
        if (!parsed || !Array.isArray(parsed.facts)) return [];

        const normalizedFacts = parsed.facts
            .filter((fact: any) => fact?.content && fact?.domain)
            .map((fact: any) => ({
                content: String(fact.content).trim(),
                domain: String(fact.domain).trim() || 'general',
                importance: typeof fact.importance === 'number' ? Math.min(1, Math.max(0, fact.importance)) : 0.75,
                tags: Array.isArray(fact.tags) ? fact.tags.map((tag: unknown) => String(tag)) : [],
            }))
            .filter((fact: QuickFact) => fact.content.length > 0);

        if (normalizedFacts.length === 0) {
            console.warn('⚠️ Мониторинг качества: quickFactCheck не нашел фактов в сообщении');
        }

        return normalizedFacts;
    } catch (error) {
        console.error('Ошибка быстрого анализа фактов:', error);
        return [];
    }
}

interface DialoguePair {
    userMessage: string;
    botResponse: string;
    userReply?: string;
    timestamp: Date;
    isUserInitiated: boolean;
}

function groupMessagesIntoDialogue(messages: any[]): DialoguePair[] {
    const pairs: DialoguePair[] = [];
    const consumedUserIndexes = new Set<number>();

    devLog(`🔍 Группировка ${messages.length} сообщений в диалоги`);

    for (let i = 0; i < messages.length - 1; i++) {
        const current = messages[i];
        const next = messages[i + 1];

        devLog(`  Проверяем пару ${i}: ${current.role} -> ${next.role}`);

        if (current.role === 'user' && next.role === 'bot') {
            const userReply =
                i + 2 < messages.length && messages[i + 2].role === 'user'
                    ? messages[i + 2].content
                    : undefined;

            const pair = {
                userMessage: current.content,
                botResponse: next.content,
                userReply,
                timestamp: current.timestamp,
                isUserInitiated: true,
            };

            pairs.push(pair);
            consumedUserIndexes.add(i);
            if (userReply) consumedUserIndexes.add(i + 2);
            devLog(`✅ Создана диалоговая пара: "${current.content}" -> "${next.content}"`);
        }
    }

    for (let i = 0; i < messages.length; i++) {
        const current = messages[i];
        if (current.role !== 'user' || consumedUserIndexes.has(i)) continue;
        pairs.push({
            userMessage: current.content,
            botResponse: '[Бот ещё не отвечал]',
            timestamp: current.timestamp,
            isUserInitiated: true,
        });
        devLog(`✅ Создана одиночная пользовательская запись для анализа: "${current.content}"`);
    }

    devLog(`📊 Создано диалоговых пар: ${pairs.length}`);
    return pairs;
}
