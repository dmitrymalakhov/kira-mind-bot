/**
 * Opt-in real-provider validation of the shared classifier contract.
 * Only synthetic messages are sent. No owner bearer, memory, history, Telegram or HealthKit access.
 * Usage: npm run test:ts -- scripts/evalWorkouts.ts --env-file /path/to/provider.env
 */
import * as fs from 'node:fs';
import * as dotenv from 'dotenv';

async function main() {
    const index = process.argv.indexOf('--env-file');
    if (index !== -1) {
        const file = process.argv[index + 1];
        if (!file) throw new Error('Missing provider env path');
        const values = dotenv.parse(fs.readFileSync(file));
        for (const [key, value] of Object.entries(values)) {
            if (/^(OPENAI_|GEMINI_|ZAI_|OPENROUTER_|KIMI_|LM_STUDIO_)/.test(key) || key === 'AI_MODEL_PRESET') process.env[key] = value;
        }
    }
    process.env.NODE_ENV = 'test';
    process.env.KIRA_BOT_TOKEN = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
    process.env.KIRA_ALLOWED_USER_ID = '739503';
    process.env.KIRA_ADMIN_USER_ID = '739503';
    process.env.ASSISTANT_PROFILE = 'KiraMindBot';
    delete process.env.KIRA_DECISIONS_ENABLED;
    const { INTENT_CLASSIFIER_INSTRUCTIONS, buildIntentClassifierInput, completeClassificationContract } = require('../orchestration/intentPrompt') as typeof import('../orchestration/intentPrompt');
    const { createJsonChatCompletionForTask } = require('../ai/chatCompletion') as typeof import('../ai/chatCompletion');
    const { resolveModelForTaskAsync } = require('../ai/modelResolver') as typeof import('../ai/modelResolver');
    const route = await resolveModelForTaskAsync('intentClassification');
    console.log(JSON.stringify({ evaluation: 'workouts-shared-classifier-v1', provider: route.modelRef.provider, model: route.modelRef.model }));
    const cases: Array<{ id: string; message: string; expected: 'none' | 'read' | 'write'; history?: Array<{ role: string; content: string }>; forwarded?: boolean }> = [
        { id: 'finish-paraphrase', message: 'На сегодня с занятием всё, заканчиваем.', expected: 'write', history: [{ role: 'bot', content: 'Сейчас записывается твоя тренировка Киры.' }] },
        { id: 'pause-context', message: 'Сделаю перерыв, поставь на паузу.', expected: 'write', history: [{ role: 'bot', content: 'Твоя пробежка записывается в Кире.' }] },
        { id: 'negated-control-read', message: 'Не останавливай тренировку, просто скажи текущий пульс.', expected: 'read' },
        { id: 'quoted-control', message: 'В инструкции написано «заверши тренировку». Объясни значение этой кнопки.', expected: 'none' },
        { id: 'general-sport', message: 'Как улучшить технику бега?', expected: 'none' },
        { id: 'workout-heart-rate', message: 'Какой у меня был средний пульс вчера на велосипеде?', expected: 'read' },
        { id: 'daily-steps', message: 'Сколько шагов набралось сегодня?', expected: 'read' },
        { id: 'create-plan', message: 'Составь мне тренировку на полчаса без оборудования.', expected: 'write' },
        { id: 'plan-paraphrase', message: 'Подготовь программу занятия для меня: двадцать минут дома, без инвентаря.', expected: 'write' },
        { id: 'plan-theory', message: 'Объясни принципы планирования спортивных занятий.', expected: 'none' },
        { id: 'save-template', message: 'Сохрани этот план как мой шаблон силовой тренировки.', expected: 'write', history: [{ role: 'bot', content: 'Синтетический план: разминка, три упражнения с собственным весом, заминка.' }] },
        { id: 'reminder-only', message: 'Напомни завтра закончить тренировку вовремя.', expected: 'none' },
        { id: 'capability-only', message: 'Ты умеешь завершать тренировки с часов?', expected: 'none' },
        { id: 'clarification', message: 'Бег, минут на двадцать.', expected: 'write', history: [{ role: 'user', content: 'Начни тренировку.' }, { role: 'bot', content: 'Какой вид тренировки начать?' }] },
        { id: 'topic-switch', message: 'А теперь объясни фотосинтез.', expected: 'none', history: [{ role: 'user', content: 'Начни тренировку.' }, { role: 'bot', content: 'Какую тренировку начать?' }] },
        { id: 'set-entry', message: 'Запиши подход: синтетический присед, восемь повторений с шестьюдесятью килограммами.', expected: 'write' },
        { id: 'negated-start', message: 'Сегодня не будем начинать занятие.', expected: 'none' },
        { id: 'comparison', message: 'Сопоставь две последние мои пробежки по темпу и пульсу.', expected: 'read' },
    ];
    let failed = 0;
    for (const item of cases) {
        try {
            const input = buildIntentClassifierInput({ message: item.message, dateTime: '2 апреля 2030, вторник, 14:00', mcpContext: 'Нет подключённых MCP.', messageHistory: item.history ?? [], isForwarded: item.forwarded });
            const result = await completeClassificationContract((repair?: string) => createJsonChatCompletionForTask('intentClassification', {
                messages: [{ role: 'system', content: INTENT_CLASSIFIER_INSTRUCTIONS + (repair ? '\n' + repair : '') }, { role: 'user', content: input }],
                response_format: { type: 'json_object' }, max_completion_tokens: 1536,
            }));
            const actual = result.details.workoutAccess ?? 'none', passed = actual === item.expected;
            if (!passed) failed++;
            console.log(JSON.stringify({ id: item.id, expected: item.expected, actual, intent: result.intent, passed }));
        } catch (error) {
            failed++;
            console.log(JSON.stringify({ id: item.id, passed: false, errorType: error instanceof Error ? error.name : 'unknown' }));
        }
    }
    console.log(JSON.stringify({ total: cases.length, passed: cases.length - failed, failed }));
    if (failed) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ failed: true, errorType: error instanceof Error ? error.name : 'unknown' })); process.exitCode = 1; });
