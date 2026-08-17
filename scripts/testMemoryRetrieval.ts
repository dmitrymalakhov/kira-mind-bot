import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    extractMemoryEntities,
    fuseMemoryRetrievalCandidates,
    scoreMemoryEntityMatch,
    scoreMemoryLexicalMatch,
} from '../utils/memoryRetrieval';
import {
    evaluateMemoryRetrievalDataset,
    MemoryRetrievalEvalDataset,
} from '../utils/memoryRetrievalEval';

const fixturePath = path.join(process.cwd(), 'scripts/fixtures/memory-retrieval.synthetic.json');
const dataset = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as MemoryRetrievalEvalDataset;
const report = evaluateMemoryRetrievalDataset(dataset);

assert.equal(report.passed, true, report.failures.join('; '));
assert.ok(report.hybrid.recallAtK > report.semantic.recallAtK);
assert.equal(report.hybrid.forbiddenHitRate, 0);

const lexical = scoreMemoryLexicalMatch('Рейс S7-104 вылетает в 09:15', 'Когда рейс S7-104?');
assert.deepEqual(lexical.matchedTokens, ['рейс', 's7-104']);
assert.ok(lexical.score >= 0.8);

const entity = scoreMemoryEntityMatch(
    '[Марина] любит улун',
    ['contact_name:марина'],
    'Что любит Марина?'
);
assert.deepEqual(entity.matchedEntities, ['марина']);
assert.equal(entity.score, 1);
assert.ok(!extractMemoryEntities('Что любит Марина?').includes('что'));

const fused = fuseMemoryRetrievalCandidates(
    'Как связаться с @north_star?',
    [{ id: 'wrong', content: 'Telegram: @north_sea', score: 0.76 }],
    [{ id: 'exact', content: 'Telegram: @north_star', score: 0 }],
    2
);
assert.equal(fused[0].id, 'exact');
assert.equal(fused[0].scoreDetails.semanticScore, 0);
assert.equal(fused[0].scoreDetails.entityScore, 1);
assert.deepEqual(fused[0].scoreDetails.candidateSources, ['lexical']);

console.log('Memory hybrid retrieval and eval tests passed');
