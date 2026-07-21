import { EnhancedSessionData, updateDialogueContext } from "../services/dialogueSummarizer";
import { BotContext, ConversationTurn } from "../types";
import { factAnalysisManager } from './factAnalysisTimer';
import { devLog } from "../utils";
import { quickFactCheck, extractExplicitRememberFact } from './enhancedFactExtraction';
import { saveMemory } from './enhancedDomainMemory';
import { rememberFact } from './domainMemory';
import { normalizeContactLookupValue, saveContactMemoryFactOrAsk } from './contactMemory';
import { containsMultipleAssertions } from './atomicAssertion';

const MAX_HISTORY_LENGTH = 10;
/** Время жизни факта в short-term буфере (мс) */
const RECENT_FACT_TTL = 10 * 60 * 1000; // 10 минут

/** Добавляет факт в short-term буфер сессии и чистит устаревшие */
function pushRecentFact(ctx: BotContext, content: string): void {
    if (!ctx.session.recentlySavedFacts) ctx.session.recentlySavedFacts = [];
    const now = Date.now();
    // Очищаем устаревшие
    ctx.session.recentlySavedFacts = ctx.session.recentlySavedFacts.filter(
        f => now - f.savedAt < RECENT_FACT_TTL
    );
    ctx.session.recentlySavedFacts.push({ content, savedAt: now });
    // Ограничиваем размер
    if (ctx.session.recentlySavedFacts.length > 20) {
        ctx.session.recentlySavedFacts = ctx.session.recentlySavedFacts.slice(-15);
    }
}

function shouldSkipFactExtractionForBrowserTask(ctx: BotContext, content: string): boolean {
    if (ctx.session.activeBrowserTask || ctx.session.pendingBrowserTask) return true;

    return /(?:https?:\/\/|www\.|\b(?:lamoda|ламода|quizium|квизиум)\b|(?:открой|зайди|перейди|найди|посмотри|запиши|забронируй|зарегистрируй|нажми|кликни)[\s\S]{0,80}(?:сайт|браузер|страниц|форм|lamoda|ламода|quizium|квизиум|\.ru|\.com))/iu
        .test(content);
}

export async function addToHistory(
    ctx: BotContext,
    role: string,
    content: string,
    options: { turn?: ConversationTurn } = {},
) {
    ctx.session.messageHistory.unshift({
        role,
        content,
        timestamp: new Date(),
    });
    devLog('Added message to history:', { role, content });

    if (role === 'user') {
        const currentHistoryItem = ctx.session.messageHistory[0];
        const sourceMessageIds = currentHistoryItem
            ? [`${currentHistoryItem.role}:${currentHistoryItem.timestamp.getTime()}:0`]
            : undefined;
        if (ctx.session.pendingContactMemory || ctx.session.pendingContactLookup) {
            devLog('Skip fact extraction: message is pending contact-memory clarification/lookup');
        } else if (shouldSkipFactExtractionForBrowserTask(ctx, content)) {
            devLog('Skip fact extraction: browser task or active browser session');
        } else {
            factAnalysisManager.scheduleAnalysis(ctx);
            devLog('Scheduled delayed fact analysis');

            try {
                // Парсим reply-контекст, если сообщение является ответом на другое
                // Формат: [В ответ на "текст оригинала" от Отправитель]: инструкция пользователя
                const replyPrefixMatch = content.match(/^\[В ответ на "([\s\S]*?)" от [^\]]+\]:\s*([\s\S]+)$/);
                const repliedText = replyPrefixMatch ? replyPrefixMatch[1] : null;
                const userInstruction = replyPrefixMatch ? replyPrefixMatch[2] : content;

                // Явная просьба «Запомни, что …» — сохраняем в векторную БД (долговременная память)
                // Используем только текст инструкции (без reply-префикса), чтобы регексы корректно сработали
                const explicitFact = extractExplicitRememberFact(userInstruction);
                const explicitRequiresExtraction = Boolean(explicitFact && containsMultipleAssertions(explicitFact.content));
                if (explicitFact && !explicitRequiresExtraction) {
                    if (explicitFact.contactName) {
                        const factContent = repliedText ?? explicitFact.content;
                        devLog(`Explicit remember (contact): resolving identity before save: "${factContent}"`);
                        await saveContactMemoryFactOrAsk(ctx, {
                            contactName: explicitFact.contactName,
                            content: factContent,
                            domain: explicitFact.domain,
                            importance: explicitFact.importance,
                            tags: [],
                            isAnchor: true,
                            memoryMetadata: {
                                sourceContext: factContent,
                                sourceMessageIds,
                                extractionMethod: 'explicit',
                                subject: 'contact',
                                predicate: explicitFact.domain || 'stated_fact',
                                object: factContent,
                                negated: /(?:^|\s)не\s/iu.test(factContent),
                            },
                        });
                    } else {
                        devLog(`Explicit remember: saving to vector DB (long-term, anchor): "${explicitFact.content}"`);
                        const saved = await saveMemory(ctx, explicitFact.domain, explicitFact.content, explicitFact.importance, [], true, {
                            sourceContext: content,
                            sourceMessageIds,
                            extractionMethod: 'explicit',
                            subject: 'user',
                            predicate: explicitFact.domain || 'stated_fact',
                            object: explicitFact.content,
                            negated: /(?:^|\s)не\s/iu.test(explicitFact.content),
                        });
                        if (saved) {
                            rememberFact(ctx, explicitFact.domain, explicitFact.content);
                            pushRecentFact(ctx, explicitFact.content);
                        }
                    }
                }

                // Дополнительно проверяем через LLM (пропускаем, если уже сохранили по явной просьбе)
                const contextualContactName = options.turn?.activePeople?.find(person => person.contactName && !person.contactId && !person.personId)?.contactName;
                const quickFacts = explicitRequiresExtraction
                    ? await quickFactCheck(explicitFact!.content, contextualContactName)
                    : explicitFact ? [] : await quickFactCheck(userInstruction, contextualContactName);
                if (quickFacts.length > 0) {
                    devLog(`Quick fact check found ${quickFacts.length} facts, saving immediately`);
                    // Сохраняем контент quick-фактов в session, чтобы delayed analysis мог их пропустить
                    if (!ctx.session.quickFactContents) ctx.session.quickFactContents = [];
                    for (const fact of quickFacts) {
                        if (fact.subject === 'unknown' || fact.subject === 'third_party') continue;
                        if (fact.subject === 'contact') {
                            const activeIdentity = options.turn?.replyContext?.contactId
                                ? {
                                    contactId: options.turn.replyContext.contactId,
                                    contactName: options.turn.replyContext.contactName,
                                }
                                : options.turn?.activePeople?.[0];
                            const effectiveContactName = fact.contactName || activeIdentity?.contactName || (
                                activeIdentity?.contactId ? `contact-${activeIdentity.contactId}` : undefined
                            );
                            if (!effectiveContactName) {
                                devLog('Quick contact fact skipped: identity is not explicit or reply-resolved');
                                continue;
                            }
                            const resolvedContactId = activeIdentity?.contactId && (
                                (!fact.contactName && Boolean(effectiveContactName)) ||
                                (Boolean(activeIdentity.contactName) && normalizeContactLookupValue(fact.contactName ?? '') === normalizeContactLookupValue(activeIdentity.contactName ?? ''))
                            )
                                ? activeIdentity.contactId
                                : undefined;
                            const result = await saveContactMemoryFactOrAsk(ctx, {
                                contactName: effectiveContactName,
                                content: fact.content,
                                domain: fact.domain,
                                importance: fact.importance,
                                tags: fact.tags,
                                memoryMetadata: {
                                    sourceContext: content,
                                    sourceMessageIds,
                                    extractionMethod: 'quick',
                                    subject: 'contact',
                                    predicate: fact.predicate,
                                    object: fact.object,
                                    negated: fact.negated,
                                },
                            }, {
                                askOnAmbiguous: false,
                                resolvedContactId,
                            });
                            if (result.status === 'saved') {
                                const savedContent = result.content ?? fact.content;
                                pushRecentFact(ctx, savedContent);
                                ctx.session.quickFactContents.push(savedContent);
                            }
                            continue;
                        }
                        if (fact.subject !== 'user') continue;
                        const saved = await saveMemory(ctx, fact.domain, fact.content, fact.importance, fact.tags, false, {
                            sourceContext: content,
                            sourceMessageIds,
                            extractionMethod: 'quick',
                            subject: 'user',
                            predicate: fact.predicate,
                            object: fact.object,
                            negated: fact.negated,
                        });
                        if (saved) {
                            rememberFact(ctx, fact.domain, fact.content);
                            pushRecentFact(ctx, fact.content);
                            ctx.session.quickFactContents.push(fact.content);
                        }
                    }
                    // Ограничиваем размер массива
                    if (ctx.session.quickFactContents.length > 50) {
                        ctx.session.quickFactContents = ctx.session.quickFactContents.slice(-30);
                    }
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error('Ошибка извлечения/сохранения факта:', e);
                if (ctx.session) ctx.session.lastFactSaveError = `Ошибка при сохранении в память: ${msg}`;
            }
        }
    }

    if (ctx.session.messageHistory.length > MAX_HISTORY_LENGTH) {
        ctx.session = await updateDialogueContext(ctx.session as EnhancedSessionData);
    }
}
