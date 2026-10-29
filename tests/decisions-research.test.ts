import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
const study = require('../scripts/lib/decisionResearch');

test('built diagnostic bundles include compiler helpers and load the reflection contract without bot configuration', () => {
    const directory = mkdtempSync(path.join(tmpdir(),'kira-research-bundle-'));
    try {
        const file = path.join(directory,'study.cjs');
        const run = spawnSync(process.execPath,['scripts/researchDecisions.cjs','--bundle',file,'--reflection-triage'], { cwd: path.join(__dirname,'..'),encoding: 'utf8' });
        assert.equal(run.status,0,run.stderr);
        const source = readFileSync(file,'utf8').split('// This file is appended to the host-built bundle;')[0];
        const result = runInNewContext(source+'\nnormalizeMcpSelection({intent:"РАЗГОВОР",details:{mcpServers:["crm","unknown"]}},["crm"]);');
        assert.equal(result.details.mcpAccess,'read'); assert.equal(JSON.stringify(result.details.mcpServers),'["crm"]');
        assert.match(source,/своевременной рефлексии/);
    } finally { rmSync(directory,{ recursive: true,force: true }); }
});

test('research basket separates calibration/validation and includes all expected synthetic source combinations', () => {
    const cases = [...study.routingCases(),...study.triageCases()];
    assert.equal(cases.length,64);
    assert.equal(new Set(cases.map((item: any) => item.id)).size,cases.length);
    assert.equal(cases.filter((item: any) => item.split === 'validation').length,32);
    for (const item of study.routingCases()) for (const server of item.expected.servers) assert.ok(study.servers.some((entry: any) => entry.id === server));
    assert.ok(cases.some((item: any) => item.expected.servers?.length > 1));
    assert.ok(cases.some((item: any) => item.history?.length));
    const heldout = [...study.heldoutCases(),...study.heldoutTriageCases()];
    assert.equal(heldout.length,32);
    assert.ok(heldout.every((item: any) => !cases.some((old: any) => old.id === item.id || old.message === item.message)));
    const reflection = study.reflectionTriageCases();
    assert.equal(reflection.length,48);
    for (const split of ['calibration','validation','heldout']) {
        const group = reflection.filter((item: any) => item.split === split);
        assert.equal(group.length,16); assert.equal(group.filter((item: any) => item.expected.notify).length,8);
    }
    assert.equal(new Set(reflection.map((item: any) => item.message)).size,reflection.length);
    const integration = study.integrationRoutingCases();
    assert.equal(integration.length,16);
    assert.ok(integration.every((item: any) => item.split === 'heldout' && ![...cases,...heldout].some((old: any) => old.message === item.message || old.id === item.id)));
});

test('research scoring distinguishes coarse routing from exact service selection', () => {
    const price = study.routingCases().find((item: any) => item.id === 'price');
    const actual = { mcpAccess: 'read', mcpAllowWeb: false, memoryTask: 'none' };
    assert.deepEqual(study.check(price,actual,false),[]);
    assert.deepEqual(study.check(price,actual,true),['servers']);
    assert.deepEqual(study.check(price,{ ...actual,servers: ['market','warehouse'] }),['servers']);
    assert.deepEqual(study.check(price,{ ...actual,servers: ['market'],mcpAccess: 'write' }),['mcpAccess']);
    const web = study.routingCases().find((item: any) => item.id === 'explicit-web');
    assert.deepEqual(study.check(web,{ mcpAccess: 'none',servers: [],memoryTask: 'none',mcpAllowWeb: true }),['mcpAllowWeb']);
    assert.deepEqual(study.check(price,{ ...actual,servers: ['market'],mcpAllowWeb: true }),['mcpAllowWeb']);
});

test('summary counts unsupported exact-source metrics separately and preserves provider token accounting', () => {
    const rows = [
        { type: 'case',variant: 'current-json',kind: 'routing',split: 'calibration',id: 'price',ok: true,errors: [],supportsServers: false,durationMs: 100,
            usage: { prompt_tokens: 1000,completion_tokens: 50,prompt_tokens_details: { cached_tokens: 500,cache_write_tokens: 300 } } },
        { type: 'case',variant: 'compact-none',kind: 'routing',split: 'calibration',id: 'price',ok: false,errors: ['servers'],supportsServers: true,durationMs: 200 },
    ];
    const [coarse,exact] = study.summarize(rows);
    assert.equal(coarse.sourceAccuracy,null); assert.equal(coarse.commonAccuracy,1);
    assert.equal(coarse.inputTokens,1000); assert.equal(coarse.cachedTokens,500); assert.equal(coarse.cacheWriteTokens,300);
    assert.equal(exact.sourceAccuracy,0); assert.equal(exact.commonAccuracy,1); assert.equal(exact.accuracy,0);
});

test('threshold selection cannot use the held-out examples to improve its apparent result', () => {
    const rows = [
        { type: 'case',variant: 'decisions-predicate',kind: 'triage',id: 'triage-deadline',probabilities: [{ type: 'predicate',name: 'notify',probability: 0.7 }] },
        { type: 'case',variant: 'decisions-predicate',kind: 'triage',id: 'triage-thanks',probabilities: [{ type: 'predicate',name: 'notify',probability: 0.9 }] },
    ];
    const [sweep] = study.thresholdSweep(rows);
    assert.equal(sweep.selectedThreshold,0.65);
    assert.equal(sweep.selectedOn,'calibration-only');
    const selected = sweep.curves.find((item: any) => item.threshold === sweep.selectedThreshold);
    assert.equal(selected.calibration.errors,0); assert.equal(selected.validation.errors,1);
    assert.deepEqual(study.thresholdSweep([]),[]);
    const [heldout] = study.thresholdSweep([{ type: 'case',variant: 'decisions-predicate',kind: 'routing',id: 'heldout-new-ticket',probabilities: [] }]);
    assert.equal(heldout.selectedThreshold,null);
    assert.equal(heldout.selectedOn,'unavailable:no_calibration');
    const [refusal] = study.thresholdSweep([{ type: 'case',variant: 'decisions-predicate',kind: 'triage',id: 'triage-thanks',probabilities: [{ name: 'notify',type: 'refusal' }] }]);
    assert.ok(refusal.curves.every((item: any) => item.validation.errors === 1 && item.validation.loss > 0));
});

test('categorical responses validate names, types and probabilities before scoring', () => {
    const expected = [{ name: 'notify',type: 'predicate',instructions: 'synthetic' }];
    assert.equal(study.validDecision({ answers: [{ name: 'notify',type: 'predicate',probability: 0.9 }] },expected),true);
    assert.equal(study.validDecision({ answers: [{ name: 'wrong',type: 'predicate',probability: 0.9 }] },expected),false);
    assert.equal(study.validDecision({ answers: [{ name: 'notify',type: 'predicate',probability: 2 }] },expected),false);
    assert.equal(study.validDecision({ answers: [{ name: 'notify',type: 'refusal' }] },expected),true);
    const answer = { name: 'server_market',type: 'choice',choice: 'read',probabilities: [{ value: 'unused',probability: 0.4 },{ value: 'read',probability: 0.6 },{ value: 'write',probability: 0 }] };
    assert.deepEqual(study.normalizeDecision({ answers: [answer] },'choice',0.8).servers,[]);
    assert.deepEqual(study.normalizeDecision({ answers: [answer] },'choice',0.5).servers,['market']);
    assert.equal(study.questions('choice','routing',true,true).length,7);
    assert.equal(study.normalizeDecision({ answers: [answer] },'derived-choice',0.5).mcpAccess,'read');
    assert.equal(study.normalizeDecision({ answers: [{ name: 'mcp_access',type: 'choice',choice: 'write' }] },'derived-choice').mcpAccess,'none');
});

test('unavailable requests cannot improve source accuracy and Decisions output is not charged in the reference estimate', () => {
    const [failed] = study.summarize([{ type: 'case',variant: 'decisions-derived-choice',kind: 'routing',split: 'validation',id: 'price',ok: false,errors: ['request'],durationMs: 20 }]);
    assert.equal(failed.sourceScored,1); assert.equal(failed.sourceCorrect,0);
    assert.equal(failed.requestFailures,1); assert.equal(failed.sourceAccuracy,0);
    const group = { models: ['gpt-6-luna'],variant: 'compact-none',inputTokens: 1000000,cachedTokens: 500000,cacheWriteTokens: 100000,outputTokens: 100000 };
    assert.ok(Math.abs(study.referenceLunaCost(group)-0.1075)<1e-10);
    assert.ok(Math.abs(study.referenceLunaCost({ ...group,variant: 'decisions-choice' })-0.0575)<1e-10);
    assert.equal(study.referenceLunaCost({ ...group,models: ['unknown'] }),null);
});
