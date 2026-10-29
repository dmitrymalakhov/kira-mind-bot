// This file is appended to the host-built bundle; study/studyConfig are supplied
// by researchDecisions.cjs. It deliberately imports no bot modules.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const OpenAI = require('openai');
let callCount = 0;
const records = [];
const output = value => { records.push(value); process.stdout.write(JSON.stringify(value) + '\n'); };

async function bootstrap() {
    const platformRoot = process.env.KIRA_PLATFORM_DATA_DIR || '/app/accounts';
    const binding = JSON.parse(fs.readFileSync(path.join(platformRoot, 'import/current-account.json'), 'utf8'));
    if (binding.phase !== 'active') throw new Error('No active trusted account binding');
    let worker;
    for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(item => {
                const index = item.indexOf('='); return [item.slice(0,index), item.slice(index+1)];
            }));
            if (env.KIRA_TENANT_ID === binding.accountId) { worker = env; break; }
        } catch {}
    }
    if (!worker?.OPENAI_API_KEY) throw new Error('No configured OpenAI key');
    const { Client } = require('pg');
    const db = new Client({ host: worker.DB_HOST, port: Number(worker.DB_PORT || 5432), user: worker.DB_USER,
        password: worker.DB_PASSWORD, database: worker.DB_NAME, options: '-c default_transaction_read_only=on', connectionTimeoutMillis: 5000 });
    let settings;
    try { await db.connect(); settings = Object.fromEntries((await db.query("SELECT key,value FROM bot_settings WHERE key IN ('AI_MODEL_PRESET','AI_MODEL_POLICY')")).rows.map(row => [row.key,row.value])); }
    finally { await db.end(); }
    let policy; try { policy = JSON.parse(settings.AI_MODEL_POLICY); } catch {}
    const registry = JSON.parse(fs.readFileSync('admin-panel/src/ai-model-presets.json', 'utf8'));
    const preset = settings.AI_MODEL_PRESET || worker.AI_MODEL_PRESET || 'gpt-balanced';
    const models = policy?.models || registry.presets?.[preset]?.models || {};
    const baseline = models[studyConfig.reflectionTriage ? 'lightweightText' : 'intentClassification'];
    if (baseline?.provider !== 'openai' || !baseline.model) throw new Error('This study requires an explicitly configured OpenAI classification route');
    output({ type: 'configuration', at: new Date().toISOString(), sourceHash: studyConfig.sourceHash, customGateway: Boolean(worker.OPENAI_BASE_URL),
        preset, routes: Object.fromEntries(['intentClassification','fastDialogue','runtimePlanning','lightweightText'].map(task => [task,models[task]])),
        syntheticInputsOnly: true, privatePayloads: 0, mcpCalls: 0, telegramMessages: 0, settingsWrites: 0,
        concurrency: 2, maxCalls: studyConfig.maxCalls, repeats: studyConfig.repeats, thresholds: studyConfig.thresholds || {},
        reflectionTriage: studyConfig.reflectionTriage === true,integratedMcp: studyConfig.integratedMcp === true,integrationControl: studyConfig.integrationControl === true });
    return { baseline, client: new OpenAI({ apiKey: worker.OPENAI_API_KEY, baseURL: worker.OPENAI_BASE_URL || undefined, maxRetries: 0 }) };
}

const safeError = error => ({ status: error.status, errorType: error.constructor.name,
    code: typeof error.code === 'string' && /^[a-z_]{1,60}$/.test(error.code) ? error.code : undefined });
async function dispatch(client, variant, item, model) {
    if (++callCount > studyConfig.maxCalls) throw new Error('Study call budget exhausted');
    if (variant.startsWith('decisions-')) {
        const type = variant.endsWith('choice') ? 'choice' : 'predicate';
        const derived = variant === 'decisions-derived-choice';
        const lean = variant.includes('-lean-');
        const instructions = studyConfig.reflectionTriage ? studyConfig.reflectionInstructions : item.kind === 'triage' ? lean ? 'Новое сообщение и его метаданные.' : study.triageInstructions : study.routingInstructions;
        const questions = studyConfig.reflectionTriage ? [{ type: 'predicate',name: 'urgent',instructions }] : study.questions(type,item.kind,lean || derived,derived);
        if (studyConfig.reflectionTriage && model !== 'gpt-6-luna') throw new Error('Reflection study cannot substitute a different model');
        const result = await client.post('/decisions', { body: { model: 'gpt-6-luna',
            input: [{ role: 'user', content: [{ type: 'input_text', text: instructions },
                { type: 'input_json', data: studyConfig.reflectionTriage ? { senderName: 'Синтетический контакт',text: item.message } : study.inputFor(item) }] }], questions, prompt_cache_key: `kira-synthetic-${studyConfig.sourceHash.slice(0,16)}` },
            timeout: 15000, maxRetries: 0 });
        if (!study.validDecision(result,questions)) throw new Error('Malformed decision response');
        const refused = result.answers.some(answer => answer.type === 'refusal');
        const threshold = studyConfig.thresholds?.[variant]?.[item.kind] ?? 0.8;
        return { actual: study.normalizeDecision(result,derived ? 'derived-choice' : type,threshold), probabilities: result.answers, usage: result.usage, model: result.model, refused, threshold };
    }
    const current = ['current-json','fast-current','fast-fixed'].includes(variant);
    const system = studyConfig.reflectionTriage ? `${studyConfig.reflectionInstructions}\nВерни только JSON {"urgent":true|false}.` : item.kind === 'triage' ? `${study.triageInstructions}\nВерни только JSON {"notify":true|false}.`
        : current ? variant === 'fast-fixed' ? studyConfig.fastFixedSystem : variant === 'fast-current' ? studyConfig.fastSystem : studyConfig.system : `${study.routingInstructions}\n${study.compactSchema}`;
    const user = studyConfig.reflectionTriage ? JSON.stringify({ senderName: 'Синтетический контакт',text: item.message }) : current ? `Текущая дата и время: 28 октября 2026 года 12:00 Europe/Amsterdam\n${studyConfig.mcpContext}\n` +
        `История: ${JSON.stringify(item.history || [])}\nНовая реплика: ${item.message}` : JSON.stringify(study.inputFor(item));
    const result = await client.chat.completions.create({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        response_format: { type: 'json_object' }, reasoning_effort: variant === 'compact-low' ? 'low' : 'none',
        max_completion_tokens: studyConfig.reflectionTriage ? 32 : current ? 1536 : variant === 'compact-low' ? 1024 : 512, store: false }, { timeout: 30000, maxRetries: 0 });
    let parsed = JSON.parse(result.choices?.[0]?.message?.content || '');
    if (studyConfig.integratedMcp && current) parsed = normalizeMcpSelection(parsed,study.servers.map(server => server.id));
    if (item.kind === 'triage' ? typeof (studyConfig.reflectionTriage ? parsed.urgent : parsed.notify) !== 'boolean' : !parsed.details && !['none','read','write'].includes(parsed.mcpAccess)) throw new Error('Malformed chat response');
    return { actual: study.normalizeChat(parsed), usage: result.usage, model: result.model };
}

async function main() {
    const { baseline, client } = await bootstrap();
    let variants = studyConfig.variants.length ? studyConfig.variants : ['current-json','fast-current','compact-none','compact-low','decisions-predicate','decisions-choice'];
    const cases = (studyConfig.integrationControl ? study.integrationRoutingCases() : studyConfig.reflectionTriage ? study.reflectionTriageCases().filter(item => (item.split === 'heldout') === studyConfig.heldout) : studyConfig.heldout ? [...study.heldoutCases(),...(studyConfig.heldoutTriage ? study.heldoutTriageCases() : [])] : [...study.routingCases(),...study.triageCases()]).filter(item => !studyConfig.ids.length || studyConfig.ids.includes(item.id));
    if (!cases.length) throw new Error('No matching synthetic cases');
    // One bounded endpoint probe per API. A denied endpoint is never replayed
    // for every basket item or redirected to a different gateway.
    for (const api of ['chat','decisions']) {
        const variant = variants.find(value => api === 'decisions' ? value.startsWith('decisions-') : !value.startsWith('decisions-'));
        if (!variant) continue;
        const started = performance.now();
        try {
            const probe = await dispatch(client, variant, cases[0], baseline.model);
            output({ type: 'probe', api, ok: true, durationMs: Math.round(performance.now()-started), model: probe.model, usage: probe.usage });
        } catch (error) {
            output({ type: 'probe', api, ok: false, durationMs: Math.round(performance.now()-started), ...safeError(error) });
            variants = variants.filter(value => api === 'decisions' ? !value.startsWith('decisions-') : value.startsWith('decisions-'));
        }
    }
    const jobs = [];
    for (let repeat = 0; repeat < studyConfig.repeats; repeat++) for (let index = 0; index < cases.length; index++) {
        const item = cases[index];
        const rotated = [...variants.slice(index % Math.max(1,variants.length)), ...variants.slice(0,index % Math.max(1,variants.length))];
        for (const variant of rotated) {
            if (item.kind === 'triage' && ['current-json','fast-current','compact-low'].includes(variant)) continue;
            if (studyConfig.integratedMcp && item.kind !== 'routing') continue;
            if (item.kind === 'triage' && variant.includes('-lean-') && !studyConfig.heldoutTriage) continue;
            if (item.kind === 'triage' && variant === 'decisions-derived-choice') continue;
            jobs.push({ item, variant, repeat });
        }
    }
    if (callCount + jobs.length > studyConfig.maxCalls) throw new Error('Requested run exceeds study call budget');
    let cursor = 0;
    await Promise.all(Array.from({ length: 2 }, async () => {
        while (cursor < jobs.length) {
            const { item, variant, repeat } = jobs[cursor++];
            const row = { type: 'case', variant, id: item.id, kind: item.kind, split: item.split, repeat,
                supportsServers: studyConfig.integratedMcp || !['current-json','fast-current','fast-fixed'].includes(variant) };
            const started = performance.now();
            try {
                const result = await dispatch(client,variant,item,baseline.model);
                Object.assign(row,result);
                row.errors = study.check(item,result.actual,row.supportsServers);
                if (result.refused) row.errors.push('refusal');
                row.ok = row.errors.length === 0;
            } catch (error) { Object.assign(row,safeError(error),{ ok: false, errors: ['request'] }); }
            row.durationMs = Math.round(performance.now()-started);
            output(row);
        }
    }));
    output({ type: 'summary', callCount, groups: study.summarize(records), thresholds: study.thresholdSweep(records) });
}
main().catch(() => { output({ type: 'fatal', message: 'Research stopped; bootstrap/provider details suppressed', callCount }); process.exitCode = 1; });
