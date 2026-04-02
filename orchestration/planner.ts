import type { Plan, PlanStep, PlanningInput } from './types';
import { devLog, parseLLMJson } from '../utils';
import openai from '../openai';
import { llmCache, LLM_CACHE_TTL } from '../utils/llmCache';

const AVAILABLE_STEPS = `
- memory — подтянуть контекст из долговременной памяти (что бот знает о пользователе). Использовать первым, если ответ должен учитывать личные данные.
- resolveContact — узнать из памяти имя человека по роли (жена, муж, мама, коллега и т.д.). Параметр relationship: слово из запроса (жена, муж, мама). Ставить перед readMessages, если пользователь просит переписку "с женой", "с мамой" и т.п.
- webSearch — поиск в интернете. Использовать, если нужны актуальные данные, новости, факты из сети. Параметр asContext: true — если результат нужен для следующего шага (conversation или sendMessage), иначе ответ сразу из поиска.
- conversation — ответить пользователю с учётом накопленного контекста (память, поиск). Обычно последний шаг в цепочке.
- reminder — создать напоминание.
- readMessages — работа с перепиской в Telegram: показать сообщения или изучить переписку с контактом и сохранить факты. После resolveContact не указывать relationship повторно. Параметр asContext: true — если результат анализа нужен для следующего шага (conversation или sendMessage).
- sendMessage — отправить сообщение контакту.
- imageGeneration — сгенерировать изображение.
- maps — карты, маршруты, места.
- negotiateOnBehalf — договориться с контактом от имени пользователя: начать переписку, при необходимости спрашивать пользователя что ответить.
- unclearIntent — уточнить намерение, если непонятно.
- capabilities — ответить текстом о возможностях бота (что умеет, чем может помочь). Использовать, когда пользователь спрашивает «что ты умеешь», «расскажи о себе», «твои возможности» и т.п.
`.trim();

/**
 * Строит план выполнения на основе запроса пользователя.
 * Нейросеть решает, что делать и в каком порядке (какие шаги и с какими параметрами).
 */
export async function createPlan(input: PlanningInput): Promise<Plan> {
    const { message, classification } = input;
    const intent = classification.intent || 'РАЗГОВОР';

    const cacheKey = `plan:${intent}:${message.slice(0, 200)}`;
    const cached = llmCache.get<Plan>(cacheKey);
    if (cached) {
        devLog('createPlan: cache hit');
        return cached;
    }

    const prompt = `Запрос пользователя: "${message}"
Предварительно определённый интент: ${intent}

Доступные шаги (выполняются строго по порядку):
${AVAILABLE_STEPS}

Цепочка шагов выполняется последовательно: каждый агент получает накопленный контекст от предыдущих (память, результат поиска и т.д.) и может дополнять его для следующих. Определи все шаги, нужные для запроса, в правильном порядке. Верни JSON:
{ "steps": [ { "agentId": "ид_шага", "params": { ... } }, ... ] }

Правила (обязательно):
- Если в запросе несколько действий (например, «найди в интернете X и отправь жене», «поищи рецепт и напиши Маше») — включи в цепочку все нужные шаги по порядку: сначала memory (и при необходимости webSearch с asContext: true), затем sendMessage. Результат webSearch с asContext: true передаётся следующему шагу (conversation или sendMessage) по конвейеру.
- Если пользователь просит проанализировать чат/переписку и затем отправить сообщение в этот же чат (или куда-то ещё) на основе анализа — у readMessages указывай asContext: true, следующим шагом ставь sendMessage.
- Если пользователь просит написать или отправить сообщение кому-то — в плане ОБЯЗАТЕЛЬНО шаг sendMessage (один или после memory/webSearch/readMessages), НЕ подменяй на conversation.
- Если пользователь просит договориться с кем-то, провести переговоры, решить вопрос с контактом (переписка с уточнениями) — шаг negotiateOnBehalf (один или после memory/resolveContact).
- Переписка "с женой", "с мамой" и т.п. — СНАЧАЛА resolveContact с params: { "relationship": "жена" }, ПОТОМ readMessages.
- Поиск в интернете — memory и webSearch. Если результат поиска нужен следующему шагу (ответ в чат или отправка сообщения) — у webSearch укажи params: { "asContext": true }.
- Для напоминания — reminder. Для картинки — imageGeneration. Для карт — maps.
- Для запроса о возможностях бота («что умеешь», «расскажи о себе», «твои функции») — один шаг capabilities.
- Минимум один шаг. params можно опустить или передать пустой объект.`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты планировщик. Строишь цепочку агентов по смыслу запроса: шаги выполняются по порядку, контекст (память, результат поиска и т.д.) передаётся по конвейеру следующему агенту. Отвечай только валидным JSON с полем steps (массив объектов с agentId и опционально params). agentId только из списка: memory, resolveContact, webSearch, conversation, reminder, readMessages, sendMessage, negotiateOnBehalf, imageGeneration, maps, unclearIntent, capabilities.',
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
        const steps: PlanStep[] = Array.isArray(parsed.steps)
            ? parsed.steps
                .filter((s: unknown) => s && typeof s === 'object' && 'agentId' in s)
                .map((s: any) => ({
                    agentId: normalizeAgentId(s.agentId),
                    params: typeof s.params === 'object' && s.params !== null ? s.params : undefined,
                }))
                .filter((s: PlanStep) => s.agentId)
            : [];
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
        const respondingAgentIds = new Set(['conversation', 'reminder', 'readMessages', 'sendMessage', 'negotiateOnBehalf', 'imageGeneration', 'maps', 'unclearIntent', 'capabilities']);
        const hasRespondingStep = steps.some((s) => respondingAgentIds.has(s.agentId));
        if (intent === 'РАЗГОВОР' && !hasRespondingStep) {
            devLog('Planner: intent РАЗГОВОР but no responding step in plan, appending conversation');
            console.log("[ORCH] planner: intent РАЗГОВОР but plan had no reply step, appending conversation");
            steps.push({ agentId: 'conversation' });
        }
        devLog('Planner: LLM plan', steps.map((s) => s.agentId));
        const plan: Plan = { steps };
        llmCache.set(cacheKey, plan, LLM_CACHE_TTL.PLAN);
        return plan;
    } catch (e) {
        console.error('Planner error:', e);
        return fallbackPlan(intent, message);
    }
}

const VALID_IDS = new Set<string>([
    'memory', 'resolveContact', 'webSearch', 'conversation', 'reminder',
    'readMessages', 'sendMessage', 'negotiateOnBehalf', 'imageGeneration', 'maps', 'unclearIntent', 'capabilities',
]);

function normalizeAgentId(id: string): PlanStep['agentId'] {
    const n = String(id).trim();
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
    const m = message.toLowerCase();
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
            return { steps: [{ agentId: 'memory' }, { agentId: 'webSearch' }] };
        case 'ОТПРАВКА_СООБЩЕНИЯ':
            return { steps: [{ agentId: 'sendMessage' }] };
        case 'ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ':
            return { steps: [{ agentId: 'negotiateOnBehalf' }] };
        case 'НЕОПРЕДЕЛЕНО':
            return { steps: [{ agentId: 'unclearIntent' }] };
        case 'ВОЗМОЖНОСТИ_БОТА':
            return { steps: [{ agentId: 'capabilities' }] };
        case 'РАЗГОВОР':
            return { steps: [{ agentId: 'memory' }, { agentId: 'conversation' }] };
        default:
            return { steps: [{ agentId: 'conversation' }] };
    }
}
