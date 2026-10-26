import { BotContext } from '../types';
import { extractAndSaveFactsFromConversation } from './enhancedFactExtraction';
import { persistSessionNow } from '../services/SessionStorage';
import { isBackgroundFeatureEnabled } from '../services/backgroundFeatureService';
import { summarizeDialogue } from '../services/dialogueSummarizer';

interface PendingAnalysis {
    /** Контекст нужен для доступа к ctx.session при отложенном анализе (session обновляется по ссылке при MemorySessionStorage) */
    ctx: BotContext;
    conversationStart: number;
    firstMessageAt: number;
    messageCount: number;
    debounceTimerId: NodeJS.Timeout;
    maxWaitTimerId?: NodeJS.Timeout;
}

class FactAnalysisManager {
    private static instance: FactAnalysisManager;
    private pendingAnalyses = new Map<number | string, PendingAnalysis>();
    private readonly ANALYSIS_DELAY = 2 * 60 * 1000; // 2 минуты тишины
    private readonly MAX_WAIT = 5 * 60 * 1000; // максимум 5 минут с первого сообщения
    private readonly MESSAGE_THRESHOLD = 5; // или каждые 5 пользовательских сообщений

    public static getInstance(): FactAnalysisManager {
        if (!FactAnalysisManager.instance) {
            FactAnalysisManager.instance = new FactAnalysisManager();
        }
        return FactAnalysisManager.instance;
    }

    public scheduleAnalysis(ctx: BotContext): void {
        const userId = ctx.sessionStorageKey ?? ctx.from?.id;
        if (!userId) return;

        const existing = this.pendingAnalyses.get(userId);

        if (existing) {
            existing.ctx = ctx as BotContext;
            existing.conversationStart = this.findConversationStart(ctx);
            existing.messageCount += 1;
            clearTimeout(existing.debounceTimerId);
            existing.debounceTimerId = this.createDebounceTimer(userId);

            if (existing.messageCount >= this.MESSAGE_THRESHOLD) {
                void this.executeAnalysis(userId, 'message-threshold');
            }
            return;
        }

        const pending: PendingAnalysis = {
            ctx: ctx as BotContext,
            conversationStart: this.findConversationStart(ctx),
            firstMessageAt: Date.now(),
            messageCount: 1,
            debounceTimerId: this.createDebounceTimer(userId),
            maxWaitTimerId: setTimeout(() => {
                void this.executeAnalysis(userId, 'max-wait');
            }, this.MAX_WAIT),
        };

        this.pendingAnalyses.set(userId, pending);
    }

    private createDebounceTimer(userId: number | string): NodeJS.Timeout {
        return setTimeout(() => {
            void this.executeAnalysis(userId, 'debounce');
        }, this.ANALYSIS_DELAY);
    }

    private findConversationStart(ctx: BotContext): number {
        const index = ctx.session.lastFactAnalysisIndex || 0;
        return index >= ctx.session.messageHistory.length ? 0 : index;
    }

    private async executeAnalysis(userId: number | string, reason: 'debounce' | 'max-wait' | 'message-threshold'): Promise<void> {
        const analysis = this.pendingAnalyses.get(userId);
        if (!analysis) return;

        clearTimeout(analysis.debounceTimerId);
        if (analysis.maxWaitTimerId) {
            clearTimeout(analysis.maxWaitTimerId);
        }

        try {
            if (!await isBackgroundFeatureEnabled('deferredFacts')) return;
            console.log(`🧠 Запуск анализа фактов для ${userId}. Причина: ${reason}. Сообщений накоплено: ${analysis.messageCount}`);
            await extractAndSaveFactsFromConversation(
                analysis.ctx,
                analysis.conversationStart
            );
            if (analysis.ctx.session.messageHistory.length >= 10) {
                const snapshot = analysis.ctx.session.messageHistory.slice();
                const summary = await summarizeDialogue(snapshot, analysis.ctx.session.dialogueSummary);
                // Change only the summary: a new foreground turn may have arrived during inference.
                if (summary) analysis.ctx.session.dialogueSummary = summary;
            }
            await persistSessionNow(analysis.ctx);
        } catch (error) {
            console.error('Error in delayed fact analysis:', error);
        } finally {
            this.pendingAnalyses.delete(userId);
        }
    }

    public cancelAnalysis(userId: number | string): void {
        const analysis = this.pendingAnalyses.get(userId);
        if (analysis) {
            clearTimeout(analysis.debounceTimerId);
            if (analysis.maxWaitTimerId) {
                clearTimeout(analysis.maxWaitTimerId);
            }
            this.pendingAnalyses.delete(userId);
        }
    }

    public getPendingAnalysis(userId?: number | string): PendingAnalysis | undefined {
        if (!userId) return undefined;
        return this.pendingAnalyses.get(userId);
    }
}

export const factAnalysisManager = FactAnalysisManager.getInstance();
