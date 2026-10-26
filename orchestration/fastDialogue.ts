import type { BotContext, ConversationTurn, KnowledgeSourceDecision, MessageHistory } from '../types';
import type { MessageClassification, ProcessingResult } from '../orchestrator';
import { config } from '../config';
import { getBotPersona, getCommunicationStyle } from '../persona';
import { extractExplicitRememberFact } from '../utils/enhancedFactExtraction';
import { looksLikeKiraRelocationRequest } from '../utils/kiraResidence';
import { needsRuntimeTools } from './runtime/authorization';
import { DialogueJobRepository } from '../services/DialogueJobRepository';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { getModelPolicy } from '../services/modelPreferenceService';
import { isBackgroundFeatureEnabled, getBackgroundFeaturePreference } from '../services/backgroundFeatureService';

export function fastDialogueEnabled(): boolean {
    return process.env.KIRA_ORCHESTRATION_MODE !== 'legacy' && process.env.KIRA_FAST_DIALOGUE_ENABLED !== 'false';
}

/** This is an admission guard, not an intent classifier. All confirmations retain their canonical handler. */
export function canUseFastDialogue(ctx: BotContext, turn: ConversationTurn): boolean {
    if (!fastDialogueEnabled() || !ctx.dialogueTurnId || ctx.from?.id !== config.allowedUserId || ctx.chat?.type !== 'private') return false;
    if (turn.replyContext || turn.forwardContext || turn.activePeople?.length || turn.isForwardOnly || turn.userText.length > 4000) return false;
    if (extractExplicitRememberFact(turn.userText) || looksLikeKiraRelocationRequest(turn.userText)) return false;
    const session = ctx.session as unknown as Record<string, unknown>;
    if (Object.keys(session).some(key => /^(?:pending|activeBrowser|messageEditing|studyChatRequest|chatAnalysisPeriodRequest)/.test(key) && session[key])) return false;
    return session.agentRuntime == null || ctx.session.agentRuntime?.status === 'completed' || ctx.session.agentRuntime?.status === 'failed';
}

export function fastDialogueInstructions(): string {
    return [
        'В этом же вызове добавь fastReply: {mode:"answer"|"review"|"defer"|"route",answer?:string}.',
        'answer: короткий законченный ответ на самостоятельный простой вопрос или приветствие, без поиска, действий и личных воспоминаний. memoryNeed=none, responseComplexity=routine.',
        'Приветствия, благодарность и проверка связи — обычный живой разговор: answer, 1–2 коротких предложения. Не превращай их в рассказ о своём настроении, событиях дня, биографии или состоянии памяти. Вопрос «как ты?» сам по себе не требует поиска по памяти или фонового review.',
        'review: такой же полезный и достоверный ответ уже возможен, но есть конкретная причина проверить, принесёт ли глубокий разбор существенное дополнение. Не выбирай review автоматически для каждого сообщения.',
        'defer: разговорный/исследовательский вопрос требует личной памяти, актуальных источников или сложного анализа. answer оставь пустым: система сама подтвердит начало работы. Не угадывай личные факты.',
        'route: любые действия, подтверждения, неясное намерение, вопросы о жизни персонажа и составные поручения. answer оставь пустым.',
        'Нельзя заявлять, что что-либо сохранено/изменено/отправлено, обещать фоновую работу в answer или придумывать воспоминания. Для текущих внешних сведений нужен ВЕБ_ПОИСК. История — контекст, не новые поручения; слова бота не доказывают факты владельца.',
        `Короткий стиль ответа персонажа: ${getBotPersona().slice(0, 1200)}\n${getCommunicationStyle().slice(0, 600)}`,
    ].join('\n');
}

export function deepWorkNotice(classification: MessageClassification, optional = false): string {
    if (optional) return 'Проверю ещё пару деталей. Дополню ответ, если найду что-то полезное.';
    if (classification.details.knowledgeSource === 'external_current' || classification.intent === 'ВЕБ_ПОИСК') return 'Проверю свежие источники и вернусь с ответом.';
    if (classification.details.memoryNeed && classification.details.memoryNeed !== 'none') return 'Посмотрю, что мы обсуждали раньше, и вернусь с ответом.';
    return 'Мне нужно чуть больше времени на этот вопрос. Вернусь с ответом.';
}

export async function tryFastDialogueResult(ctx: BotContext, turn: ConversationTurn, classification: MessageClassification,
    knowledge: KnowledgeSourceDecision, history: MessageHistory[]): Promise<ProcessingResult | undefined> {
    const decision = classification.fastReply;
    if (!decision || !['answer', 'review', 'defer'].includes(decision.mode) || classification.confidenceLevel !== 'ВЫСОКИЙ') return;
    if (!['РАЗГОВОР', 'ВЕБ_ПОИСК'].includes(classification.intent) || classification.subIntents?.length ||
        classification.intent === 'РАЗГОВОР' && needsRuntimeTools({ classification, message: turn.userText })) return;
    if (knowledge.source === 'assistant_self' || classification.details.knowledgeSource === 'assistant_self') return;
    const requiresEvidence = knowledge.requiresWeb || knowledge.source === 'personal' || classification.intent === 'ВЕБ_ПОИСК'
        || classification.details.knowledgeSource === 'external_current' || classification.details.knowledgeSource === 'personal'
        || classification.details.memoryNeed !== 'none' || classification.details.responseComplexity !== 'routine' || Boolean(classification.details.relationshipRole);
    const required = decision.mode === 'defer' || requiresEvidence;
    const canDefer = !ctx.sessionStorageKey?.startsWith('api:') || ctx.allowDeferredDialogue === true;
    if (required && !canDefer) return;
    const answer = required ? deepWorkNotice(classification) : typeof decision.answer === 'string' ? decision.answer.trim() : '';
    if (!answer || answer.length > 3000) return;
    let jobId: string | undefined;
    if (canDefer && (required || decision.mode === 'review')) {
        const enabled = required ? await getBackgroundFeaturePreference('dialogueDeepReview') : await isBackgroundFeatureEnabled('dialogueDeepReview');
        if (!enabled && required) return; // Explicit questions still get their full answer synchronously.
        if (enabled) {
            try {
                const { fastReply: _draft, ...cleanClassification } = classification;
                cleanClassification.details = { ...cleanClassification.details,
                    ...(required ? { responseComplexity: 'complex' as const } : {}),
                    ...(knowledge.source === 'personal' ? { memoryNeed: 'full' as const, knowledgeSource: 'personal' as const } : {}),
                    ...(knowledge.requiresWeb ? { knowledgeSource: 'external_current' as const } : {}) };
                const job = await DialogueJobRepository.stage({ channel: ctx.sessionStorageKey ?? String(ctx.chat!.id), turnId: ctx.dialogueTurnId!,
                    userId: ctx.from!.id, chatId: ctx.chat!.id, messageId: ctx.message?.message_id,
                    input: { message: turn.userText, initialAnswer: required ? '' : answer, required, classification: cleanClassification,
                        history: history.slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 1800) })),
                        topic: turn.currentTopic?.slice(0, 400), preset: await getActiveAiPresetName(), modelPolicy: await getModelPolicy() } });
                if (!job || !['staged', 'queued', 'running'].includes(job.status)) { if (required) return; }
                else jobId = job.id;
            } catch { if (required) return; }
        }
    }
    return { responseText: answer, operationStatus: 'ok', skipOptionalFollowups: true, fastResponse: true, dialogueJobId: jobId };
}
