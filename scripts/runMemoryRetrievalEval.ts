import fs from 'node:fs';
import path from 'node:path';
import {
    evaluateMemoryRetrievalDataset,
    MemoryRetrievalEvalDataset,
} from '../utils/memoryRetrievalEval';

const datasetPath = path.resolve(
    process.argv[2] ?? path.join(process.cwd(), 'scripts/fixtures/memory-retrieval.synthetic.json')
);
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8')) as MemoryRetrievalEvalDataset;
const report = evaluateMemoryRetrievalDataset(dataset);

console.log(`Memory retrieval eval: ${report.dataset}`);
console.table(report.cases.map(item => ({
    case: item.id,
    k: item.k,
    semantic: item.semanticIds.join(', '),
    hybrid: item.hybridIds.join(', '),
    semanticRecall: item.semanticRecall.toFixed(2),
    hybridRecall: item.hybridRecall.toFixed(2),
    forbidden: item.hybridForbiddenHit ? 'hit' : 'ok',
})));
console.log(JSON.stringify({
    semantic: report.semantic,
    hybrid: report.hybrid,
    recallLift: report.recallLift,
    passed: report.passed,
    failures: report.failures,
}, null, 2));

if (!report.passed) process.exitCode = 1;
