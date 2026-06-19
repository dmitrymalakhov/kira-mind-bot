import type { Plan, PlanStep, PlanningInput } from './types';
import { devLog, parseLLMJson } from '../utils';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { llmCache, LLM_CACHE_TTL } from '../utils/llmCache';
import { isTodayImportanceRequest } from '../utils/todayImportanceIntent';

const AVAILABLE_STEPS = `
ВАЖНО: контекст из долговременной памяти (факты о пользователе) подтягивается АВТОМАТИЧЕСКИ ко всем шагам. НЕ нужно добавлять отдельный шаг memory — все агенты уже получают память.

- resolveContact — узнать из памяти имя человека по роли (жена, муж, мама, коллега и т.д.). Параметр relationship: слово из запроса в именительном падеже (жена, муж, мама). Ставить перед readMessages/sendMessage/negotiateOnBehalf, если пользователь упоминает роль вместо имени.
- webSearch — поиск в интернете. Использовать, если нужны актуальные данные, новости, факты из сети. Если после webSearch есть ещё шаги — результат автоматически передаётся следующему шагу по конвейеру.
- conversation — ответить пользователю с учётом накопленного контекста (память, поиск). Обычно последний шаг в цепочке.
- reminder — создать напоминание.
- readMessages — работа с перепиской в Telegram: показать сообщения или изучить переписку с контактом и сохранить факты. Если после readMessages есть ещё шаги — результат анализа автоматически передаётся следующему шагу.
- sendMessage — отправить сообщение контакту.
- imageGeneration — сгенерировать изображение.
- maps — карты, маршруты, адреса и физические места на карте. Не использовать для расписания событий, игр, квизов, афиши или билетов.
- negotiateOnBehalf — договориться с контактом от имени пользователя: начать переписку, при необходимости спрашивать пользователя что ответить.
- unclearIntent — уточнить намерение, если непонятно.
- capabilities — ответить нейросетью по каталогу возможностей бота: что умеет, умеет ли конкретное действие, как правильно попросить. Использовать, когда пользователь спрашивает «что ты умеешь», «можешь ли ты X», «как попросить тебя X», «твои возможности» и т.п.
- selfStudy — провести самоизучение ассистента: проанализировать собственные возможности, ограничения, операционные потребности, недавнее состояние и сохранить отчёт в самопамять. Использовать, когда пользователь просит «изучи себя», «проанализируй свои возможности и потребности», «пойми чего тебе не хватает».
- browserTask — выполнить задачу в браузере через Playwright: записаться, заполнить форму, забронировать, нажать кнопку на сайте или выполнить явную просьбу «используй браузер».
- health — личный дневник здоровья: открыть мониторинг, сохранить запись о еде/напитке/симптомах/лекарстве/самочувствии/коже/давлении/активности, показать, проанализировать или экспортировать записи.
`.trim();

const BROWSER_CONTINUATION_RE = /^Продолжи задачу в браузере через Playwright\.|browserSessionId:/i;

function hasSubIntent(
    classification: PlanningInput['classification'],
    intent: string
): boolean {
    return classification.subIntents?.some((subIntent) => subIntent.intent === intent) ?? false;
}

function postProcessPlan(plan: Plan, classification: PlanningInput['classification']): Plan {
    const intent = classification.intent || 'РАЗГОВОР';

    if (intent === 'БРАУЗЕР_ЗАДАЧА') {
        return { steps: [{ agentId: 'browserTask' }] };
    }

    if (intent === 'ЗДОРОВЬЕ') {
        return { steps: [{ agentId: 'health' }] };
    }

    if (intent === 'НЕОПРЕДЕЛЕНО') {
        return { steps: [{ agentId: 'unclearIntent' }] };
    }

    if (intent === 'САМОИЗУЧЕНИЕ') {
        return { steps: [{ agentId: 'selfStudy' }] };
    }

    if (intent === 'ВЕБ_ПОИСК' && !hasSubIntent(classification, 'КАРТЫ_ЛОКАЦИИ')) {
        const withoutMaps = plan.steps.filter((s) => s.agentId !== 'maps');
        return { steps: withoutMaps.length ? withoutMaps : [{ agentId: 'webSearch' }] };
    }

    return plan;
}

/**
 * Строит план выполнения на основе запроса пользователя.
 * Нейросеть решает, что делать и в каком порядке (какие шаги и с какими параметрами).
 */
export async function createPlan(input: PlanningInput): Promise<Plan> {
    const { message, classification } = input;
    const intent = classification.intent || 'РАЗГОВОР';

    if (BROWSER_CONTINUATION_RE.test(message)) {
        return { steps: [{ agentId: 'browserTask' }] };
    }

    if (intent === 'БРАУЗЕР_ЗАДАЧА') {
        return { steps: [{ agentId: 'browserTask' }] };
    }

    if (intent === 'ЗДОРОВЬЕ') {
        return { steps: [{ agentId: 'health' }] };
    }

    if (intent === 'НЕОПРЕДЕЛЕНО') {
        return { steps: [{ agentId: 'unclearIntent' }] };
    }

    if (intent === 'САМОИЗУЧЕНИЕ') {
        return { steps: [{ agentId: 'selfStudy' }] };
    }

    if (isTodayImportanceRequest(message)) {
        return { steps: [{ agentId: 'conversation' }] };
    }

    if (intent === 'НАПОМИНАНИЕ' && !classification.subIntents?.length) {
        return { steps: [{ agentId: 'reminder' }] };
    }

    const cacheKey = `plan:${intent}:${message.slice(0, 200)}`;
    const cached = llmCache.get<Plan>(cacheKey);
    if (cached) {
        devLog('createPlan: cache hit');
        return postProcessPlan(cached, input.classification);
    }

    const subIntentsBlock = input.classification.subIntents?.length
        ? `\nДополнительные намерения (запрос составной, включи шаги для ВСЕХ намерений):
${input.classification.subIntents.map((s, i) => `  ${i + 1}. ${s.intent}${s.details ? ' — детали: ' + JSON.stringify(s.details) : ''}`).join('\n')}\n`
        : '';

    const prompt = `Запрос пользователя: "${message}"
Предварительно определённый интент: ${intent}${subIntentsBlock}
Доступные шаги (выполняются строго по порядку):
${AVAILABLE_STEPS}

Цепочка шагов выполняется последовательно: каждый агент получает накопленный контекст от предыдущих (память, результат поиска и т.д.) и может дополнять его для следующих. Контекст из долговременной памяти подтягивается АВТОМАТИЧЕСКИ — НЕ добавляй шаг memory. Определи все шаги, нужные для запроса, в правильном порядке. Верни JSON:
{ "steps": [ { "agentId": "ид_шага", "params": { ... } }, ... ] }

Правила (обязательно):
- НЕ включай шаг memory — память подтягивается автоматически ко ВСЕМ агентам.
- Если есть дополнительные намерения (subIntents выше) — включи шаги для ВСЕХ намерений в один план. Например, при intent=НАПОМИНАНИЕ + subIntent=ОТПРАВКА_СООБЩЕНИЯ → план: [resolveContact (если нужно), sendMessage, reminder].
- Если в запросе несколько действий (например, «найди в интернете X и отправь жене», «поищи рецепт и напиши Маше») — включи в цепочку все нужные шаги по порядку: при необходимости resolveContact, затем webSearch, затем sendMessage. Результат каждого шага автоматически передаётся следующему по конвейеру.
- Если пользователь просит проанализировать чат/переписку и затем отправить сообщение в этот же чат (или куда-то ещё) на основе анализа — readMessages, затем sendMessage.
- Если пользователь просит написать или отправить сообщение кому-то — в плане ОБЯЗАТЕЛЬНО шаг sendMessage (один или после resolveContact/webSearch/readMessages), НЕ подменяй на conversation.
- Если пользователь просит договориться с кем-то, провести переговоры, решить вопрос с контактом (переписка с уточнениями) — шаг negotiateOnBehalf (один или после resolveContact).
- Переписка "с женой", "с мамой" и т.п. — СНАЧАЛА resolveContact с params: { "relationship": "жена" }, ПОТОМ readMessages.
- Поиск в интернете — webSearch. Если после поиска нужен ещё шаг — результат автоматически передаётся дальше.
- Афиша, расписание, ближайшие игры/квизы/мероприятия/билеты в городе — webSearch, НЕ maps. Слово «ближайшие» в таких запросах обычно значит ближайшие по времени.
- Для напоминания — reminder. Для картинки — imageGeneration. Для карт/маршрутов/адресов/физических мест поблизости — maps.
- Для запроса о возможностях бота («что умеешь», «можешь ли ты X», «как попросить тебя X», «твои функции») — один шаг capabilities.
- Для просьбы провести самоизучение («изучи себя», «проанализируй свои возможности/ограничения/потребности», «пойми чего тебе не хватает») — один шаг selfStudy.
- Для задачи в браузере (записаться, заполнить форму, забронировать, нажать кнопку на сайте или «используй браузер») — browserTask.
- Для дневника здоровья, мониторинга самочувствия, записи еды/симптомов/лекарств/кожи/давления, анализа дневника за день/неделю/месяц или экспорта дневника — health.
- Минимум один шаг. params можно опустить или передать пустой объект.`;

    try {
        const resp = await createChatCompletionForTask('browserPlanning', {
            messages: [
                {
                    role: 'system',
                    content: 'Ты планировщик. Строишь цепочку агентов по смыслу запроса: шаги выполняются по порядку, контекст (память, результат поиска и т.д.) передаётся по конвейеру следующему агенту. Память подтягивается автоматически — НЕ включай шаг memory. Отвечай только валидным JSON с полем steps (массив объектов с agentId и опционально params). agentId только из списка: resolveContact, webSearch, conversation, reminder, readMessages, sendMessage, negotiateOnBehalf, imageGeneration, maps, unclearIntent, capabilities, selfStudy, browserTask, health.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 1, // модель поддерживает только default (1)
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const parsed = parseLLMJson<{ steps?: unknown[] }>(text);
        if (!parsed) {
            devLog('Planner: no JSON in response, using fallback');
            return fallbackPlan(intent, message);
        }
        let steps: PlanStep[] = Array.isArray(parsed.steps)
            ? parsed.steps
                .filter((s: unknown) => s && typeof s === 'object' && 'agentId' in s)
                .map((s: any) => ({
                    agentId: normalizeAgentId(s.agentId),
                    params: typeof s.params === 'object' && s.params !== null ? s.params : undefined,
                }))
                .filter((s: PlanStep) => s.agentId)
            : [];
        steps = postProcessPlan({ steps }, input.classification).steps;
        if (steps.length === 0) return fallbackPlan(intent, message);
        // Если интент — отправка сообщения, в плане обязан быть sendMessage; иначе пользователь получит уточняющий диалог вместо черновика сообщения.
        if (intent === 'ОТПРАВКА_СООБЩЕНИЯ' && !steps.some((s) => s.agentId === 'sendMessage')) {
            devLog('Planner: intent ОТПРАВКА_СООБЩЕНИЯ but no sendMessage in plan, using fallback');
            console.log("[ORCH] planner: intent ОТПРАВКА_СООБЩЕНИЯ but LLM plan had no sendMessage, using fallback");
            return fallbackPlan(intent, message);
        }
        // Для проверки сообщений всегда используем fallback — readMessages сам возвращает ответ,
        // добавление conversation после него ломает клавиатуру выбора периода.
        if (intent === 'ПРОВЕРКА_СООБЩЕНИЙ') {
            devLog('Planner: intent ПРОВЕРКА_СООБЩЕНИЙ, using fallback plan');
            console.log("[ORCH] planner: intent ПРОВЕРКА_СООБЩЕНИЙ, using fallback");
            return fallbackPlan(intent, message);
        }
        // Шаги, которые дают ответ пользователю. Если план содержит только memory/resolveContact — ответа не будет.
        const respondingAgentIds = new Set(['conversation', 'reminder', 'readMessages', 'sendMessage', 'negotiateOnBehalf', 'imageGeneration', 'maps', 'unclearIntent', 'capabilities', 'selfStudy', 'browserTask', 'health']);
        const hasRespondingStep = steps.some((s) => respondingAgentIds.has(s.agentId));
        if (intent === 'РАЗГОВОР' && !hasRespondingStep) {
            devLog('Planner: intent РАЗГОВОР but no responding step in plan, appending conversation');
            console.log("[ORCH] planner: intent РАЗГОВОР but plan had no reply step, appending conversation");
            steps.push({ agentId: 'conversation' });
        }
        devLog('Planner: LLM plan', steps.map((s) => s.agentId));
        const plan: Plan = postProcessPlan({ steps }, input.classification);
        llmCache.set(cacheKey, plan, LLM_CACHE_TTL.PLAN);
        return plan;
    } catch (e) {
        console.error('Planner error:', e);
        return fallbackPlan(intent, message);
    }
}

const VALID_IDS = new Set<string>([
    'memory', 'resolveContact', 'webSearch', 'conversation', 'reminder',
    'readMessages', 'sendMessage', 'negotiateOnBehalf', 'imageGeneration', 'maps', 'unclearIntent', 'capabilities', 'selfStudy', 'browserTask', 'health',
]);

function normalizeAgentId(id: string): PlanStep['agentId'] {
    const n = String(id).trim();
    // memory — no-op, подтягивается автоматически; отфильтровываем если LLM всё равно сгенерировал
    if (n === 'memory') return '' as PlanStep['agentId'];
    if (VALID_IDS.has(n)) return n as PlanStep['agentId'];
    if (n === 'resolve_contact') return 'resolveContact';
    return 'conversation';
}

function normalizeRelationship(word: string): string {
    const w = word.toLowerCase();
    if (w === 'женой') return 'жена';
    if (w === 'мужем') return 'муж';
    if (w === 'мамой') return 'мама';
    if (w === 'папой') return 'папа';
    return word;
}

/** Запасной план по интенту, если LLM не вернул валидный план. */
function fallbackPlan(intent: string, message: string): Plan {
    switch (intent) {
        case 'НАПОМИНАНИЕ':
            return { steps: [{ agentId: 'reminder' }] };
        case 'ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ':
            return { steps: [{ agentId: 'imageGeneration' }] };
        case 'КАРТЫ_ЛОКАЦИИ':
            return { steps: [{ agentId: 'maps' }] };
        case 'ПРОВЕРКА_СООБЩЕНИЙ': {
            const roleMatch = message.match(/с\s+(женой|мужем|мамой|папой|\w+)/i);
            if (roleMatch)
                return { steps: [{ agentId: 'resolveContact', params: { relationship: normalizeRelationship(roleMatch[1]) } }, { agentId: 'readMessages' }] };
            return { steps: [{ agentId: 'readMessages' }] };
        }
        case 'ВЕБ_ПОИСК':
            return { steps: [{ agentId: 'webSearch' }] };
        case 'ОТПРАВКА_СООБЩЕНИЯ':
            return { steps: [{ agentId: 'sendMessage' }] };
        case 'ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ':
            return { steps: [{ agentId: 'negotiateOnBehalf' }] };
        case 'НЕОПРЕДЕЛЕНО':
            return { steps: [{ agentId: 'unclearIntent' }] };
        case 'ВОЗМОЖНОСТИ_БОТА':
            return { steps: [{ agentId: 'capabilities' }] };
        case 'САМОИЗУЧЕНИЕ':
            return { steps: [{ agentId: 'selfStudy' }] };
        case 'БРАУЗЕР_ЗАДАЧА':
            return { steps: [{ agentId: 'browserTask' }] };
        case 'ЗДОРОВЬЕ':
            return { steps: [{ agentId: 'health' }] };
        case 'РАЗГОВОР':
            return { steps: [{ agentId: 'conversation' }] };
        default:
            return { steps: [{ agentId: 'conversation' }] };
    }
}
