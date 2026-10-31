'use strict';
// --bundle creates a self-contained synthetic evaluation for the configured account
// container. It reads only routing settings/credentials; no memories or transports.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] !== '--bundle' || !args[1]) throw Error('Build server, then --bundle /tmp/behavior-eval.cjs');
const { INTENT_CLASSIFIER_INSTRUCTIONS } = require('../dist/orchestration/intentPrompt');
const { BEHAVIOR_REFLECTION_RULES } = require('../dist/services/behaviorMemoryService');
const { AVAILABILITY_REVIEW_RULES } = require('../dist/utils/availabilityVerification');
const { behaviorSafetyCases, behaviorReflectionCases } = require('../dist/scripts/fixtures/behavior-safety.synthetic');
const payload = { classifier: INTENT_CLASSIFIER_INSTRUCTIONS, reflection: BEHAVIOR_REFLECTION_RULES, availability: AVAILABILITY_REVIEW_RULES,
    cases: behaviorSafetyCases, reflections: behaviorReflectionCases.map(item => ({ ...item, required: item.required?.source })) };
fs.writeFileSync(args[1], `const suite = ${JSON.stringify(payload)};\n(${live.toString()})().catch(() => { process.stdout.write(JSON.stringify({ fatal: true, message: 'Evaluation unavailable; private diagnostics suppressed' })+'\\n'); process.exitCode=1; });\n`, { mode: 0o600 });
console.log(JSON.stringify({ bundled: true, cases: payload.cases.length * 2 + payload.reflections.length + 2 }));

async function live() {
    const fs = require('node:fs'), path = require('node:path');
    const OpenAI = require('openai');
    const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
    const binding = JSON.parse(fs.readFileSync(path.join(process.env.KIRA_PLATFORM_DATA_DIR || '/app/accounts', 'import/current-account.json'), 'utf8'));
    if (binding.phase !== 'active') throw Error('Inactive binding');
    let worker;
    for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => {
                const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
            }));
            if (env.KIRA_TENANT_ID === binding.accountId) { worker = env; break; }
        } catch {}
    }
    if (!worker?.OPENAI_API_KEY) throw Error('Configured provider unavailable');
    const { Client } = require('pg');
    const db = new Client({ host: worker.DB_HOST, port: Number(worker.DB_PORT || 5432), user: worker.DB_USER,
        password: worker.DB_PASSWORD, database: worker.DB_NAME, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 });
    let settings;
    try { await db.connect(); settings = Object.fromEntries((await db.query("SELECT key,value FROM bot_settings WHERE key IN ('AI_MODEL_PRESET','AI_MODEL_POLICY')")).rows.map(row => [row.key, row.value])); }
    finally { await db.end(); }
    let policy; try { policy = JSON.parse(settings.AI_MODEL_POLICY); } catch {}
    const registry = JSON.parse(fs.readFileSync('admin-panel/src/ai-model-presets.json', 'utf8'));
    const models = policy?.models || registry.presets?.[settings.AI_MODEL_PRESET || worker.AI_MODEL_PRESET || 'gpt-balanced']?.models || {};
    const client = new OpenAI({ apiKey: worker.OPENAI_API_KEY, baseURL: worker.OPENAI_BASE_URL || undefined, maxRetries: 0 });
    emit({ syntheticInputsOnly: true, memoryReads: 0, memoryWrites: 0, messagesSent: 0, maxCalls: 31 });
    let calls = 0, failed = 0;
    async function infer(task, system, data) {
        const route = models[task];
        if (!route || route.provider !== 'openai' || ++calls > 31) throw Error('Unsupported route or budget');
        const result = await client.chat.completions.create({ model: route.model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }],
            response_format: { type: 'json_object' }, reasoning_effort: route.generation?.reasoningEffort || 'none', max_completion_tokens: task === 'memoryExtraction' ? 1000 : 1536, store: false }, { timeout: 40000, maxRetries: 0 });
        return JSON.parse(result.choices[0]?.message?.content || '');
    }
    const jobs = [];
    for (const mode of ['intentClassification', 'fastDialogue']) for (const item of suite.cases) jobs.push(async () => {
        const result = await infer(mode, suite.classifier + (mode === 'fastDialogue' ? '\nДобавь fastReply:{mode:"answer"|"review"|"defer"|"route",answer?:string}. На самодостаточный простой вопрос можно сразу ответить. Для действий, проверки и исправлений mode=route.' : ''),
            { dateTime: '30 октября 2026, Europe/Amsterdam', history: item.history || [], newMessage: item.message });
        const details = result.details || {};
        const actual = { feedback: Boolean(details.behavioralFeedback), availability: details.externalVerification === 'availability' };
        const ok = actual.feedback === item.feedback && actual.availability === item.availability &&
            (!actual.feedback || typeof details.behavioralFeedback.evidence === 'string' && item.message.includes(details.behavioralFeedback.evidence));
        if (!ok) failed++;
        emit({ id: item.id, mode, ok, actual, intent: result.intent });
    });
    for (const item of suite.reflections) jobs.push(async () => {
        const result = await infer('memoryExtraction', suite.reflection, { ownerMessage: item.ownerMessage, history: item.history || [], existingLessons: [] });
        const ok = result.safeToLearn === item.learn && (!item.learn || new RegExp(item.required, 'iu').test(result.check || ''));
        if (!ok) failed++;
        emit({ id: item.id, mode: 'reflection', ok, actual: result });
    });
    // The sources are supplied fixtures. These cases test judgment, not internet coverage.
    for (const closed of [true, false]) jobs.push(async () => {
        const result = await infer('memoryExtraction', suite.availability + '\nЭто тест: доступен только следующий синтетический набор страниц. Никакого реального поиска; не придумывай другие источники.', {
            request: 'Выбираем тестовый музей на субботу 31 октября.', draft: 'Музей открыт каждый день, можно идти.',
            sources: [{ url: 'https://museum.example/old', datedAt: '2021-01-01', text: 'Музей открыт каждый день.' },
                { url: 'https://museum.example/status', datedAt: '2026-10-25', text: closed ? 'Музей закрылся навсегда.' : 'По субботам открыт с 12 до 18. Билеты в кассе, наличие неизвестно.' },
                { url: 'https://maps.example/museum', datedAt: '2026-10-26', text: closed ? 'Больше не работает.' : 'Музей работает. Часы субботы: 12–18.' }],
        });
        const statuses = result.items?.map(item => item.status) || [];
        const ok = statuses.length > 0 && (closed ? statuses.every(s => s !== 'verified') : statuses.includes('verified'));
        if (!ok) failed++;
        emit({ id: closed ? 'closed-evidence' : 'open-evidence', mode: 'verification-judgment', ok, actual: result });
    });
    let index = 0;
    await Promise.all(Array.from({ length: 2 }, async () => { while (index < jobs.length) {
        const job = jobs[index++]; try { await job(); } catch { failed++; emit({ ok: false, error: 'provider_or_contract_unavailable' }); }
    } }));
    emit({ complete: true, calls, failed, passed: jobs.length - failed });
    if (failed) process.exitCode = 1;
}
