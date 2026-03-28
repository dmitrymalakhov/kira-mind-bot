import { EnhancedSessionData, updateDialogueContext } from "../services/dialogueSummarizer";
import { BotContext } from "../types";
import { factAnalysisManager } from './factAnalysisTimer';
import { devLog } from "../utils";
import { quickFactCheck, extractExplicitRememberFact } from './enhancedFactExtraction';
import { saveMemory } from './enhancedDomainMemory';
import { rememberFact } from './domainMemory';

const MAX_HISTORY_LENGTH = 10;

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
            // Явная просьба «Запомни, что …» — сохраняем в векторную БД (долговременная память)
        const explicitFact = extractExplicitRememberFact(content);
        if (explicitFact) {
            devLog(`Explicit remember: saving to vector DB (long-term, anchor): "${explicitFact.content}"`);
            await saveMemory(ctx, explicitFact.domain, explicitFact.content, explicitFact.importance, [], true);
            rememberFact(ctx, explicitFact.domain, explicitFact.content);
        }

            // Дополнительно проверяем через LLM (пропускаем, если уже сохранили по явной просьбе)
            const quickFacts = explicitFact ? [] : await quickFactCheck(content);
            if (quickFacts.length > 0) {
                devLog(`Quick fact check found ${quickFacts.length} facts, saving immediately`);
                for (const fact of quickFacts) {
                    await saveMemory(ctx, fact.domain, fact.content, fact.importance, fact.tags);
                    rememberFact(ctx, fact.domain, fact.content);
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
