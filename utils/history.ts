import { EnhancedSessionData, updateDialogueContext } from "../services/dialogueSummarizer";
import { BotContext } from "../types";
import { factAnalysisManager } from './factAnalysisTimer';
import { devLog } from "../utils";
import { quickFactCheck, extractExplicitRememberFact } from './enhancedFactExtraction';
import { saveMemory } from './enhancedDomainMemory';
import { rememberFact } from './domainMemory';

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

export async function addToHistory(ctx: BotContext, role: string, content: string) {
    ctx.session.messageHistory.unshift({
        role,
        content,
        timestamp: new Date(),
    });
    devLog('Added message to history:', { role, content });

    if (role === 'user') {
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
            if (explicitFact) {
                if (explicitFact.contactName) {
                    // Факт о третьем лице: сохраняем с префиксом [Имя]
                    // Если есть текст реплая — используем его как содержимое факта
                    const factContent = repliedText
                        ? `[${explicitFact.contactName}] ${repliedText}`
                        : `[${explicitFact.contactName}] ${explicitFact.content}`;
                    const contactTag = `contact:${explicitFact.contactName}`;
                    devLog(`Explicit remember (contact): saving to vector DB: "${factContent}"`);
                    await saveMemory(ctx, explicitFact.domain, factContent, explicitFact.importance, [contactTag], true);
                    rememberFact(ctx, explicitFact.domain, factContent);
                    pushRecentFact(ctx, factContent);
                } else {
                    devLog(`Explicit remember: saving to vector DB (long-term, anchor): "${explicitFact.content}"`);
                    await saveMemory(ctx, explicitFact.domain, explicitFact.content, explicitFact.importance, [], true);
                    rememberFact(ctx, explicitFact.domain, explicitFact.content);
                    pushRecentFact(ctx, explicitFact.content);
                }
            }

            // Дополнительно проверяем через LLM (пропускаем, если уже сохранили по явной просьбе)
            const quickFacts = explicitFact ? [] : await quickFactCheck(content);
            if (quickFacts.length > 0) {
                devLog(`Quick fact check found ${quickFacts.length} facts, saving immediately`);
                // Сохраняем контент quick-фактов в session, чтобы delayed analysis мог их пропустить
                if (!ctx.session.quickFactContents) ctx.session.quickFactContents = [];
                for (const fact of quickFacts) {
                    await saveMemory(ctx, fact.domain, fact.content, fact.importance, fact.tags);
                    rememberFact(ctx, fact.domain, fact.content);
                    pushRecentFact(ctx, fact.content);
                    ctx.session.quickFactContents.push(fact.content);
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

    if (ctx.session.messageHistory.length > MAX_HISTORY_LENGTH) {
        ctx.session = await updateDialogueContext(ctx.session as EnhancedSessionData);
    }
}
