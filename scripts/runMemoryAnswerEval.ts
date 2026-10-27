import { memoryAnswerEvalCases, checkMemoryAnswer } from './fixtures/memory-answer.synthetic';
import { runKiraRuntime } from '../orchestration/runtime/kernel';
import { config } from '../config';
import type { BotContext } from '../types';

/** Run inside an initialized, read-only diagnostic runtime with its normal model policy.
 * No private question, memory, Telegram transport, retrieval or persistence is accessed.
 */
export async function runMemoryAnswerEval(options: { includeAnswers?: boolean } = {}) {
    const style = config.communicationStyle;
    config.communicationStyle = 'Естественно, спокойно, конкретно и по делу.';
    try {
        const results = [];
        for (const item of memoryAnswerEvalCases()) {
            const ctx = { from: { id: 740893 }, chat: { id: 740893, type: 'private' }, session: { messageHistory: [],
                dialogueSummary: 'Старая сводка: ассистент утверждал, что ничего не знает.' } } as unknown as BotContext;
            const result = await runKiraRuntime({ ctx, message: item.question, isForwarded: false, forwardFrom: '', readOnly: true,
                messageHistory: item.previousAnswer ? [{ role: 'assistant', content: item.previousAnswer, timestamp: new Date() }] : [],
                classification: { intent: 'РАЗГОВОР', confidenceLevel: 'ВЫСОКИЙ', details: { memoryTask: 'lookup', memoryNeed: 'full', knowledgeSource: 'personal', responseComplexity: 'routine' } },
                enrichedContextFromMemory: item.context, memoryRecall: item.recall });
            results.push({ ...checkMemoryAnswer(item, result.responseText), ...(options.includeAnswers ? { answer: result.responseText } : {}) });
        }
        return { passed: results.every(item => item.passed), syntheticInputsOnly: true, cases: results,
            privateMemoryPayloads: 0, telegramMessages: 0, additionalReviewCalls: 0 };
    } finally { config.communicationStyle = style; }
}

if (require.main === module) {
    if (!process.argv.includes('--live')) {
        console.log('Opt-in live model eval: run in the configured diagnostic runtime with --live. Only fictional fixtures are used.');
        process.exitCode = 2;
    } else {
        // Prevent schema changes, background sessions and usage-log writes during evaluation.
        const { AppDataSource } = require('../data-source');
        AppDataSource.setOptions({ synchronize: false, logging: false, extra: { max: 2, options: '-c default_transaction_read_only=on' } });
        AppDataSource.initialize().then(() => runMemoryAnswerEval({ includeAnswers: process.argv.includes('--answers') }))
            .then((report: Awaited<ReturnType<typeof runMemoryAnswerEval>>) => { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed ? 0 : 1; })
            .catch(() => { console.error('Memory answer eval failed; provider details suppressed.'); process.exitCode = 1; })
            .finally(() => AppDataSource.isInitialized ? AppDataSource.destroy() : undefined);
    }
}
