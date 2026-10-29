import { createJsonChatCompletionForTask } from '../ai/chatCompletion';
import type { AiPresetName } from '../ai/modelPresets';
import { parseScenePreparation, SceneService, type SceneChannel } from '../api/scene';
import type { MessageHistory } from '../types';
import { sceneIntentCases } from './fixtures/scene-intents.synthetic';

/** Opt-in live check of the AR intent decision (stage "prepare") with the configured model routing, on fictional
 *  dialogues only. It runs the service's own preparation: one classification call per case, no frame, no dialogue,
 *  storage or action. Reports routing mistakes, latency and the number of model calls.
 *    NODE_ENV=development npx ts-node scripts/evalSceneIntents.ts --live [--preset gpt-lean] */
export async function runSceneIntentEval(preset: AiPresetName) {
    const room = { roomId: '11111111-1111-4111-8111-111111111111', roomVersion: 1, coordinateSpaceId: '22222222-2222-4222-8222-222222222222',
        tracking: 'normal', avatar: { position: [0, 0, 0], yaw: 0, pose: 'standing' }, seats: [],
        objects: [{ id: '33333333-3333-4333-8333-333333333333', name: 'Письменный стол', category: 'table', center: [1, 0.37, -1], size: [1.2, 0.75, 0.7], yaw: 0, source: 'scan', present: true }] };
    const results = [];
    let calls = 0;
    for (const item of sceneIntentCases()) {
        const history: MessageHistory[] = (item.history ?? []).slice().reverse()
            .map(h => ({ role: h.role, content: h.content, timestamp: new Date(), ...(h.image ? { kind: 'image' } : {}) }) as unknown as MessageHistory);
        const channel: SceneChannel = {
            say: async () => { throw new Error('no answers in an eval'); }, look: async () => { throw new Error('no frames in an eval'); },
            visionRoute: async () => ({ available: true, provider: 'openai', model: 'eval' }), recent: async () => history, note: async () => {},
        };
        const timings: number[] = [];
        const complete: typeof createJsonChatCompletionForTask = async (task, params) => {
            calls++;
            const started = Date.now();
            try { return await createJsonChatCompletionForTask(task, params); } finally { timings.push(Date.now() - started); }
        };
        const service = new SceneService(740894, { read: async () => ({ preset, revision: 'eval' }), write: async () => ({ preset, revision: 'eval' }) }, channel, complete);
        const started = Date.now();
        const { plan } = await service.prepare(parseScenePreparation({ stage: 'prepare', text: item.text,
            scene: { ...room, observedAt: new Date().toISOString() }, ...(item.followUp ? { followUp: item.followUp } : {}) })) as any;
        const labelOk = !item.label || (plan.referent ?? '').toLowerCase().replace(/ё/g, 'е').includes(item.label);
        const passed = item.intents.includes(plan.intent) && plan.frame === item.frame && (plan.intent === 'chat' || plan.intent === 'look' || plan.intent === 'cancel' || labelOk);
        results.push({ id: item.id, passed, intent: plan.intent, frame: plan.frame, referent: plan.referent ?? null,
            expected: { intents: item.intents, frame: item.frame, ...(item.label ? { label: item.label } : {}) },
            modelMs: timings.reduce((a, b) => a + b, 0), totalMs: Date.now() - started, modelCalls: timings.length });
    }
    const ms = results.map(r => r.modelMs).sort((a, b) => a - b);
    return { preset, syntheticInputsOnly: true, cases: results.length, passed: results.filter(r => r.passed).length,
        mistakes: results.filter(r => !r.passed), modelCalls: calls, callsPerCase: calls / results.length,
        latencyMs: { median: ms[Math.floor(ms.length / 2)], p90: ms[Math.floor(ms.length * 0.9)], max: ms[ms.length - 1] }, results };
}

if (require.main === module) {
    if (!process.argv.includes('--live')) {
        console.log('Opt-in live model eval: run with --live [--preset <name>]. Only fictional dialogues are used.');
        process.exitCode = 2;
    } else {
        const i = process.argv.indexOf('--preset');
        const preset = (i > 0 ? process.argv[i + 1] : 'gpt-lean') as AiPresetName;
        const info = console.info; console.info = () => {};   // per-call usage lines; the report has the numbers
        runSceneIntentEval(preset)
            .then(report => { console.info = info; console.log(JSON.stringify(report, null, 2)); process.exitCode = report.passed === report.cases ? 0 : 1; })
            .catch(() => { console.info = info; console.error('Scene intent eval failed; provider details suppressed.'); process.exitCode = 1; });
    }
}
