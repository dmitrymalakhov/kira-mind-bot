import type { BotContext } from '../types';
import type { MessageHistory } from '../types';
import type { ProcessingResult, MessageClassification } from '../orchestrator';
import type { Plan, PlanStep } from './types';
import { fetchAgentMemoryContext, buildMemoryContextBlock } from '../utils/agentMemoryContext';
import { conversationAgent } from '../agents/conversationAgent';
import { reminderAgent } from '../agents/reminderAgent';
import { webSearchAgent } from '../agents/webSearchAgent';
import { readMessagesAgent } from '../agents/readMessagesAgent';
import { sendMessagesAgent } from '../agents/sendMessagesAgent';
import { negotiateOnBehalfAgent } from '../agents/negotiateOnBehalfAgent';
import { imageGenerationAgent } from '../agents/imageGenerationAgent';
import { mapsAgent } from '../agents/googleMapsAgent';
import { unclearIntentAgent } from '../agents/unclearIntentAgent';
import { resolveRelationshipFromMemory, detectRelationshipInMessage } from '../utils/resolveRelationshipFromMemory';
import { getCapabilitiesMessage } from '../capabilities';
import { devLog } from '../utils';

/** Человекочитаемые описания шагов для уведомлений пользователя */
const STEP_LABELS: Record<string, string> = {
    webSearch: '🔍 Ищу в интернете…',
    conversation: '💬 Формирую ответ…',
    reminder: '⏰ Создаю напоминание…',
    readMessages: '📨 Анализирую переписку…',
    sendMessage: '✉️ Готовлю сообщение…',
    negotiateOnBehalf: '🤝 Начинаю переговоры…',
    imageGeneration: '🎨 Генерирую изображение…',
    maps: '🗺️ Ищу на карте…',
    unclearIntent: '🤔 Уточняю запрос…',
    capabilities: '📋 Готовлю информацию…',
};

/** Шаги, которые не видны пользователю (нет полезного действия для отображения) */
const SILENT_STEPS = new Set(['memory', 'resolveContact']);

export interface ExecutePlanParams {
    ctx: BotContext;
    plan: Plan;
    message: string;
    isForwarded: boolean;
    forwardFrom: string;
    messageHistory: MessageHistory[];
    classification: MessageClassification;
    lastLocation?: { latitude: number; longitude: number; address?: string };
    /** Контекст из долговременной памяти, уже донасыщенный оркестратором до классификации и плана. Если передан — не дублируем обогащение. */
    enrichedContextFromMemory?: string;
}

/**
 * Выполняет план: передаёт каждому агенту enrichedContextFromMemory (уже донасыщенный оркестратором).
 * Если контекст не передан — донасыщаем здесь (для вызовов не из processMessage).
 *
 * Все агенты получают и используют этот контекст в своей работе.
 */
export async function executePlan(params: ExecutePlanParams): Promise<ProcessingResult> {
    const {
        ctx,
        plan,
        message,
        isForwarded,
        forwardFrom,
        messageHistory,
        classification,
        lastLocation,
        enrichedContextFromMemory: passedContext,
    } = params;

    const steps = plan.steps;
    if (steps.length === 0) {
        return { responseText: 'Не удалось построить план ответа.' };
    }

    /** Контекст из долговременной памяти: либо передан оркестратором, либо донасыщаем здесь. */
    let enrichedContextFromMemory = passedContext ?? '';
    if (enrichedContextFromMemory === '') {
        // Параллельно загружаем память и резолвим роль из сообщения
        const [initialMemory, roleInMessage] = await Promise.all([
            fetchAgentMemoryContext(ctx, message),
            detectRelationshipInMessage(message),
        ]);
        const initialBlock = buildMemoryContextBlock(initialMemory);
        if (initialBlock) enrichedContextFromMemory = initialBlock + '\n\n';
        if (roleInMessage) {
            const resolvedName = await resolveRelationshipFromMemory(ctx, roleInMessage, message);
            if (resolvedName) {
                enrichedContextFromMemory += `В запросе пользователя под «${roleInMessage}» имеется в виду: ${resolvedName} (из долговременной памяти).\n\n`;
                devLog('Executor: enriched with resolved contact', roleInMessage, '->', resolvedName);
            }
        }
    }

    /** Проверяет, есть ли после текущего шага ещё шаги (т.е. текущий — не последний). */
    const hasMoreSteps = (index: number) => index < steps.length - 1;

    /** Видимые (не-silent) шаги плана — только по ним показываем прогресс */
    const visibleSteps = steps.filter((s) => !SILENT_STEPS.has(s.agentId));
    const isMultiStepPlan = visibleSteps.length > 1;

    /** Отправить пользователю уведомление о прогрессе (только для многошаговых планов) */
    const notifyProgress = async (stepAgentId: string) => {
        if (!isMultiStepPlan) return;
        const label = STEP_LABELS[stepAgentId];
        if (!label) return;
        try {
            await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
            await ctx.reply(label);
        } catch (e) {
            devLog('Executor: failed to send progress notification', e);
        }
    };

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const nextStep = steps[i + 1];
        const isLastStep = !hasMoreSteps(i);

        devLog('Executor: step', i + 1, step.agentId, step.params);
        console.log("[ORCH] executor step", i + 1, "/", steps.length, "→", step.agentId);

        switch (step.agentId) {
            case 'resolveContact': {
                // Роль→имя уже добавлено в enrichedContextFromMemory в фазе донасыщения.
                // Но если detectRelationshipInMessage не нашёл роль, а планировщик указал relationship в params — резолвим здесь.
                const planRelationship = step.params?.relationship as string | undefined;
                if (planRelationship && !enrichedContextFromMemory.includes('имеется в виду:')) {
                    const resolvedName = await resolveRelationshipFromMemory(ctx, planRelationship, message);
                    if (resolvedName) {
                        enrichedContextFromMemory += `В запросе пользователя под «${planRelationship}» имеется в виду: ${resolvedName} (из долговременной памяти).\n\n`;
                        devLog('Executor: resolveContact step resolved', planRelationship, '->', resolvedName);
                        console.log("[ORCH] resolveContact step: role", planRelationship, "-> name", resolvedName);
                    }
                }
                break;
            }

            case 'memory': {
                // Память уже подтянута в начале выполнения; шаг оставлен для совместимости с планом.
                break;
            }

            case 'webSearch': {
                await notifyProgress('webSearch');
                const webRes = await webSearchAgent(
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    enrichedContextFromMemory || ''
                );
                // Если есть следующий шаг — передаём результат поиска по конвейеру (asContext автоматически, когда есть nextStep).
                // Если это последний шаг или asContext явно не указан при отсутствии nextStep — возвращаем результат.
                const passToNext = nextStep && (step.params?.asContext === true || hasMoreSteps(i));
                if (passToNext) {
                    enrichedContextFromMemory += '\nДополнительный контекст из поиска в интернете:\n' + webRes.responseText + '\n\n';
                } else {
                    webRes.botReaction = classification.details?.botReaction;
                    return webRes;
                }
                break;
            }

            case 'conversation': {
                console.log("[ORCH] invoking conversationAgent");
                await notifyProgress('conversation');
                const sharedMemoryContext = enrichedContextFromMemory.trim()
                    ? { domain: 'personal' as const, context: enrichedContextFromMemory.trim() }
                    : await fetchAgentMemoryContext(ctx, message).then((m) => ({ domain: m.domain as 'personal', context: m.context }));
                const conv = await conversationAgent(
                    ctx,
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    classification,
                    sharedMemoryContext
                );
                conv.botReaction = classification.details?.botReaction;
                return conv;
            }

            case 'reminder': {
                await notifyProgress('reminder');
                const reminderRes = await reminderAgent(
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    enrichedContextFromMemory || ''
                );
                if (reminderRes.reminderCreated) {
                    reminderRes.botReaction = classification.details?.botReaction;
                    return reminderRes;
                }
                if (nextStep?.agentId === 'conversation') break;
                reminderRes.botReaction = classification.details?.botReaction;
                return reminderRes;
            }

            case 'readMessages': {
                await notifyProgress('readMessages');
                const readRes = await readMessagesAgent(
                    ctx,
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    classification,
                    enrichedContextFromMemory || ''
                );
                // Если есть следующий шаг — передаём результат анализа по конвейеру.
                const passReadToNext = nextStep && (step.params?.asContext === true || hasMoreSteps(i));
                if (passReadToNext) {
                    enrichedContextFromMemory += '\nРезультат анализа переписки/чата:\n' + readRes.responseText + '\n\n';
                } else {
                    readRes.botReaction = classification.details?.botReaction;
                    return readRes;
                }
                break;
            }

            case 'sendMessage': {
                console.log("[ORCH] invoking sendMessagesAgent");
                await notifyProgress('sendMessage');
                const sendRes = await sendMessagesAgent(
                    ctx,
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    enrichedContextFromMemory || ''
                );
                sendRes.botReaction = classification.details?.botReaction;
                return sendRes;
            }

            case 'negotiateOnBehalf': {
                console.log("[ORCH] invoking negotiateOnBehalfAgent");
                await notifyProgress('negotiateOnBehalf');
                const negRes = await negotiateOnBehalfAgent(
                    ctx,
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    enrichedContextFromMemory || ''
                );
                negRes.botReaction = classification.details?.botReaction;
                return negRes;
            }

            case 'imageGeneration': {
                await notifyProgress('imageGeneration');
                const imgRes = await imageGenerationAgent(
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    enrichedContextFromMemory || ''
                );
                imgRes.botReaction = classification.details?.botReaction;
                return imgRes;
            }

            case 'maps': {
                await notifyProgress('maps');
                const mapsRes = await mapsAgent(
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    lastLocation,
                    enrichedContextFromMemory || ''
                );
                mapsRes.botReaction = classification.details?.botReaction;
                return mapsRes;
            }

            case 'unclearIntent': {
                await notifyProgress('unclearIntent');
                const unclearRes = await unclearIntentAgent(
                    message,
                    isForwarded,
                    forwardFrom,
                    messageHistory,
                    classification,
                    enrichedContextFromMemory || ''
                );
                unclearRes.botReaction = classification.details?.botReaction;
                return unclearRes;
            }

            case 'capabilities': {
                const capabilitiesText = getCapabilitiesMessage();
                return {
                    responseText: capabilitiesText,
                    botReaction: classification.details?.botReaction,
                };
            }

            default:
                devLog('Executor: unknown agentId', (step as PlanStep).agentId);
                return { responseText: 'Неизвестный тип задачи. Попробуй сформулировать иначе.' };
        }
    }

    // План выполнен, но ни один шаг не вернул ответ (только memory/resolveContact). Логируем и пробуем conversation как fallback.
    const stepIds = steps.map((s) => s.agentId);
    console.warn('[ORCH] executor: no response from plan steps:', stepIds.join(' → '), '| fallback to conversation');
    const sharedMemoryContext = enrichedContextFromMemory.trim()
        ? { domain: 'personal' as const, context: enrichedContextFromMemory.trim() }
        : await fetchAgentMemoryContext(ctx, message).then((m) => ({ domain: m.domain as 'personal', context: m.context }));
    const conv = await conversationAgent(
        ctx,
        message,
        isForwarded,
        forwardFrom,
        messageHistory,
        classification,
        sharedMemoryContext
    );
    conv.botReaction = classification.details?.botReaction;
    return conv;
}
