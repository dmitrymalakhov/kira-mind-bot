import { BotContext, ConversationTurn, MemoryEntry, MemoryStatus, MemorySubject } from '../types';
import { getVectorService } from './VectorServiceFactory';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { devLog, parseLLMJson } from '../utils';
import { estimateHumanMemoryMetrics, inferMemoryKind } from '../utils/enhancedDomainMemory';
import { RecalledMemoryRef } from '../utils/multiQueryMemory';
import { config } from '../config';
import { containsMultipleAssertions } from '../utils/atomicAssertion';

const MAX_RECALLED_FOR_RECONSOLIDATION = 6;
const RECONSOLIDATION_TIMEOUT_MS = 4500;
const MIN_RECALL_SCORE = 0.42;

type ReconsolidationAction = 'noop' | 'confirm' | 'update' | 'supersede';

interface ReconsolidationDecision {
    index?: number;
    action?: ReconsolidationAction;
    content?: string;
    confidenceDelta?: number;
    status?: MemoryStatus;
    reason?: string;
    subject?: MemorySubject;
    predicate?: string;
    object?: string;
}

interface ReconsolidationResponse {
    decisions?: ReconsolidationDecision[];
}

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        fn(),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function shouldSkipExchange(userMessage: string, botResponse: string): boolean {
    const normalized = userMessage.trim().toLowerCase();
    if (normalized.length < 8) return true;
    if (/^(спасибо|ок|ладно|понял|поняла|да|нет|ага|угу|хорошо)$/iu.test(normalized)) return true;
    if (!botResponse.trim()) return true;
    return false;
}

function compactMemoryForPrompt(memory: RecalledMemoryRef, index: number): string {
    const meta = [
        `idx=${index}`,
        `id=${memory.id}`,
        `domain=${memory.domain}`,
        `kind=${memory.memoryKind ?? 'unknown'}`,
        `confidence=${(memory.confidence ?? 0.6).toFixed(2)}`,
        memory.status ? `status=${memory.status}` : '',
        `score=${memory.score.toFixed(2)}`,
    ].filter(Boolean).join('; ');
    return `${meta}; content="${memory.content.slice(0, 500)}"`;
}

function isSyntheticRecalledMemory(memory: RecalledMemoryRef): boolean {
    const kind = memory.memoryKind ?? '';
    if (['episode', 'chapter', 'portrait'].includes(kind)) return true;
    if (memory.content.startsWith('[ЭПИЗОД ПАМЯТИ:')) return true;
    if (memory.content.startsWith('[ГЛАВА ПАМЯТИ:')) return true;
    if (memory.content.startsWith('[МОДЕЛЬ ПАМЯТИ:')) return true;
    if (memory.content.startsWith('[ИНДЕКС ОТКРЫТЫХ ЛИНИЙ ПАМЯТИ]')) return true;
    if (memory.content.startsWith('[ИНДЕКС СОМНЕНИЙ ПАМЯТИ]')) return true;
    return false;
}

async function askReconsolidationLlm(
    userMessage: string,
    botResponse: string,
    recalled: RecalledMemoryRef[]
): Promise<ReconsolidationDecision[]> {
    const memories = recalled.map(compactMemoryForPrompt).join('\n');
    const resp = await createChatCompletionForTask('memoryExtraction', {
        messages: [
            {
                role: 'system',
                content: 'Ты обновляешь долговременную память после вспоминания. Отвечай только валидным JSON.',
            },
            {
                role: 'user',
                content: `Ассистент использовал эти воспоминания в ответе:
${memories}

Новый обмен:
Пользователь: ${userMessage.slice(0, 900)}
Ассистент: ${botResponse.slice(0, 900)}

Определи, надо ли реконсолидировать использованные воспоминания.

Действия:
- noop: обмен не меняет это воспоминание.
- confirm: пользователь прямо подтвердил или естественно усилил это воспоминание.
- update: пользователь уточнил ровно одно атомарное утверждение. content, subject, predicate и object описывают одну и ту же мысль.
- supersede: воспоминание явно устарело, но новый канонический факт лучше сохранит отдельный fact extraction; пометь старое неактуальным.

Правила:
- Не выдумывай.
- Не обновляй память из слов ассистента, если пользователь это не подтвердил.
- Если пользователь поправил ассистента ("нет, не X, а Y") — это update.
- Если исходная запись содержит несколько независимых утверждений, НЕ переписывай её целиком: supersede допустим только когда все утверждения опровергнуты, иначе noop; атомарные факты сохранит extraction.
- Не добавляй хронологию («сначала», «потом»), причинность, мотивы и эмоции, которых нет в словах пользователя.
- Для contact-факта не меняй личность по сходству имени. Если субъект поправки не доказан, noop.
- Если план стал фактом ("я уже приехал") — это update.
- confidenceDelta от -0.25 до +0.15.

JSON:
{"decisions":[{"index":0,"action":"noop|confirm|update|supersede","content":"только для update","subject":"user|contact|third_party|unknown","predicate":"атомарный предикат","object":"атомарный объект","confidenceDelta":0.0,"status":"active|planned|done|superseded|expired|unknown","reason":"коротко"}]}`,
            },
        ],
        temperature: 0,
        response_format: { type: 'json_object' },
    });
    const parsed = parseLLMJson<ReconsolidationResponse>(resp.choices[0]?.message?.content ?? '');
    return Array.isArray(parsed?.decisions) ? parsed.decisions : [];
}

function materializeMemoryUpdate(
    existing: MemoryEntry,
    nextContent: string,
    action: ReconsolidationAction,
    confidenceDelta: number,
    status?: MemoryStatus,
    assertion?: Pick<ReconsolidationDecision, 'subject' | 'predicate' | 'object'>,
): Omit<MemoryEntry, 'id'> {
    const now = new Date();
    const contentChanged = nextContent.trim() !== existing.content.trim();
    const confidence = clamp01((existing.confidence ?? 0.6) + confidenceDelta);
    const nextStatus: MemoryStatus =
        action === 'supersede'
            ? 'superseded'
            : status ?? existing.status ?? 'active';
    const memoryKind = existing.memoryKind ?? inferMemoryKind(nextContent, existing.tags ?? [], { status: nextStatus });
    const metrics = estimateHumanMemoryMetrics({
        content: nextContent,
        importance: existing.importance,
        confidence,
        tags: existing.tags,
        isAnchor: existing.isAnchor,
        emotionalTag: existing.emotionalTag,
        memoryKind,
        status: nextStatus,
        retrievalCount: existing.retrievalCount,
    });

    const subject = existing.subject;
    const synchronizedTags = (existing.tags ?? [])
        .filter(tag => !tag.startsWith('subject:'));
    if (subject) synchronizedTags.push(`subject:${subject}`);

    return {
        content: nextContent,
        domain: existing.domain,
        botId: existing.botId,
        timestamp: contentChanged ? now : existing.timestamp,
        importance: clamp01(existing.importance + (action === 'confirm' ? 0.02 : 0)),
        tags: [...new Set([...synchronizedTags, action === 'confirm' ? 'reconfirmed' : 'reconsolidated'])],
        userId: existing.userId,
        isAnchor: existing.isAnchor || undefined,
        expiresAt: action === 'supersede' ? now : existing.expiresAt,
        confidence,
        lastAccessedAt: now,
        retrievalCount: existing.retrievalCount,
        lastRetrievedAt: existing.lastRetrievedAt,
        retrievalCues: existing.retrievalCues,
        previousVersions: contentChanged
            ? [
                { content: existing.content, timestamp: existing.timestamp, confidence: existing.confidence ?? 0.6 },
                ...((existing.previousVersions ?? []).slice(0, 9)),
            ]
            : existing.previousVersions,
        relatedIds: existing.relatedIds,
        emotionalTag: existing.emotionalTag,
        sourceEpisodeId: existing.sourceEpisodeId,
        sourceContext: existing.sourceContext,
        sourceMessageIds: existing.sourceMessageIds,
        sourceMemoryIds: existing.sourceMemoryIds,
        extractionMethod: existing.extractionMethod,
        // Реконсолидация меняет предикат/объект, но не переносит факт на другого
        // субъекта. Смена субъекта требует отдельного identity-aware extraction.
        subject,
        predicate: assertion?.predicate?.trim() || existing.predicate,
        object: assertion?.object?.trim() || (contentChanged ? nextContent : existing.object),
        validFrom: existing.validFrom,
        validTo: action === 'supersede' ? now : existing.validTo,
        status: nextStatus,
        confirmationCount: action === 'confirm'
            ? (existing.confirmationCount ?? 1) + 1
            : existing.confirmationCount,
        lastConfirmedAt: action === 'confirm' ? now : existing.lastConfirmedAt,
        memoryKind,
        strength: metrics.strength,
        vividness: metrics.vividness,
        specificity: metrics.specificity,
    };
}

export function isCompositeAssertion(content: string): boolean {
    return containsMultipleAssertions(content);
}

export function hasUnsupportedSemanticAddition(userMessage: string, nextContent: string): boolean {
    const classes = [
        /(?:^|[^\p{L}\p{N}])(?:сначала|потом|затем|после\s+этого|до\s+этого)(?=$|[^\p{L}\p{N}])/iu,
        /(?:^|[^\p{L}\p{N}])(?:поэтому|из-за\s+этого|потому\s+что|вследствие)(?=$|[^\p{L}\p{N}])/iu,
        /(?:^|[^\p{L}\p{N}])(?:пережива|тревож|боится|расстроен|мотив)[\p{L}\p{N}]*/iu,
    ];
    return classes.some(pattern => pattern.test(nextContent) && !pattern.test(userMessage));
}

export function hasExplicitSupersedeSignal(userMessage: string): boolean {
    return /(?:неверн|ошиб|устарел|больше\s+не|уже\s+не|не\s+так|это\s+не|не\s+.+,?\s+а|перестал|перестала|изменил(?:ось|ась|ся))/iu.test(userMessage);
}

function normalizedAssertionPart(value: string | undefined): string {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const PATCH_SUPPORT_STOPWORDS = new Set(['и', 'а', 'но', 'не', 'это', 'он', 'она', 'они', 'я', 'мы', 'ты', 'вы', 'его', 'ее', 'её', 'их', 'мой', 'моя', 'через', 'для', 'про', 'с', 'со', 'в', 'во', 'на', 'к', 'по', 'из']);

function assertionTokens(value: string | undefined): string[] {
    return normalizedAssertionPart(value).split(/\s+/u).filter(token => token.length > 2 && !PATCH_SUPPORT_STOPWORDS.has(token));
}

function isAtomicPatchConsistent(existing: MemoryEntry, decision: ReconsolidationDecision, content: string, userMessage: string): boolean {
    if (!existing.subject) return false;
    if (!decision.subject || !decision.predicate?.trim() || !decision.object?.trim()) return false;
    if (existing.subject && decision.subject !== existing.subject) return false;
    const normalizedObject = normalizedAssertionPart(decision.object);
    const normalizedContent = normalizedAssertionPart(content);
    if (!normalizedObject || !normalizedContent.includes(normalizedObject)) return false;
    const evidenceTokens = new Set(assertionTokens(userMessage));
    const existingTokens = new Set(assertionTokens(existing.content));
    const changedTokens = assertionTokens(decision.object)
        .filter(token => !existingTokens.has(token));
    return changedTokens.length === 0 || changedTokens.every(token => evidenceTokens.has(token));
}

function isIdentitySafeForUpdate(existing: MemoryEntry, turn?: ConversationTurn): boolean {
    if (existing.subject !== 'contact') return true;
    const replyContactId = turn?.replyContext?.contactId ?? turn?.activePeople?.[0]?.contactId;
    if (replyContactId != null) {
        return (existing.tags ?? []).includes(`contact_id:${replyContactId}`);
    }
    const replyPersonId = turn?.replyContext?.personId ?? turn?.activePeople?.[0]?.personId;
    return Boolean(replyPersonId && (existing.tags ?? []).includes(`person_id:${replyPersonId}`));
}

export async function reconsolidateAfterResponse(
    ctx: BotContext,
    userMessage: string,
    botResponse: string,
    recalledMemories: RecalledMemoryRef[] | undefined,
    turn?: ConversationTurn,
): Promise<void> {
    if (ctx.chat?.type !== 'private') return;
    if (shouldSkipExchange(userMessage, botResponse)) return;
    const svc = getVectorService();
    if (!svc) return;

    const recalled = (recalledMemories ?? [])
        .filter(memory => memory.id && memory.domain && memory.score >= MIN_RECALL_SCORE)
        .filter(memory => !isSyntheticRecalledMemory(memory))
        .slice(0, MAX_RECALLED_FOR_RECONSOLIDATION);
    if (recalled.length === 0) return;

    try {
        await withTimeout(async () => {
            const decisions = await askReconsolidationLlm(userMessage, botResponse, recalled);
            for (const decision of decisions) {
                const index = typeof decision.index === 'number' ? decision.index : -1;
                const recalledMemory = recalled[index];
                const action = decision.action;
                if (!recalledMemory || !action || action === 'noop') continue;

                const existing = await svc.fetchMemoryById(recalledMemory.id, recalledMemory.domain);
                if (!existing) continue;

                const content = action === 'update'
                    ? String(decision.content || '').trim()
                    : existing.content;
                if (action === 'update' && content.length < 8) continue;

                const existingEntry = {
                    ...existing,
                    userId: String(ctx.from?.id),
                    botId: config.botUsername.toLowerCase(),
                } as MemoryEntry;

                if (action === 'update' || action === 'supersede') {
                    if (isCompositeAssertion(existingEntry.content)) {
                        devLog('Skipped non-atomic reconsolidation update:', existing.id);
                        continue;
                    }
                    if (!isIdentitySafeForUpdate(existingEntry, turn)) {
                        devLog('Skipped reconsolidation with unverified contact identity:', existing.id);
                        continue;
                    }
                }

                if (action === 'supersede' && !hasExplicitSupersedeSignal(userMessage)) {
                    devLog('Skipped supersede without explicit user correction:', existing.id);
                    continue;
                }

                if (action === 'update') {
                    if (hasUnsupportedSemanticAddition(userMessage, content)) {
                        devLog('Skipped reconsolidation with unsupported semantic addition:', existing.id);
                        continue;
                    }
                    if (!isAtomicPatchConsistent(existingEntry, decision, content, userMessage)) {
                        devLog('Skipped inconsistent atomic reconsolidation patch:', existing.id);
                        continue;
                    }
                }

                const patch = materializeMemoryUpdate(
                    existingEntry,
                    content,
                    action,
                    typeof decision.confidenceDelta === 'number'
                        ? Math.min(0.15, Math.max(-0.25, decision.confidenceDelta))
                        : action === 'confirm'
                            ? 0.08
                            : action === 'supersede'
                                ? -0.15
                                : 0,
                    decision.status,
                    decision,
                );

                await svc.updateMemory(existing.id, existing.domain, patch);
                devLog('Memory reconsolidated:', {
                    id: existing.id,
                    action,
                    reason: decision.reason,
                    content: patch.content.slice(0, 80),
                });
            }
        }, RECONSOLIDATION_TIMEOUT_MS);
    } catch (e: any) {
        if (e?.message === 'timeout') {
            devLog('Memory reconsolidation timed out');
        } else {
            devLog('Memory reconsolidation failed:', e);
        }
    }
}
