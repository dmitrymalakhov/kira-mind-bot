import {
    fuseMemoryRetrievalCandidates,
    MemoryRetrievalCandidate,
} from './memoryRetrieval';

export interface MemoryRetrievalEvalCandidate {
    id: string;
    content: string;
    semanticScore: number;
    tags?: string[];
    /** false имитирует отсечение кандидата dense-порогом. */
    semanticCandidate?: boolean;
}

export interface MemoryRetrievalEvalCase {
    id: string;
    query: string;
    relevantIds: string[];
    forbiddenIds?: string[];
    k?: number;
    candidates: MemoryRetrievalEvalCandidate[];
}

export interface MemoryRetrievalEvalThresholds {
    minHybridRecallAtK?: number;
    minHybridMrr?: number;
    maxHybridForbiddenHitRate?: number;
    minRecallLift?: number;
}

export interface MemoryRetrievalEvalDataset {
    name: string;
    defaultK?: number;
    thresholds?: MemoryRetrievalEvalThresholds;
    cases: MemoryRetrievalEvalCase[];
}

export interface MemoryRetrievalEvalCaseResult {
    id: string;
    query: string;
    k: number;
    semanticIds: string[];
    hybridIds: string[];
    semanticRecall: number;
    hybridRecall: number;
    semanticReciprocalRank: number;
    hybridReciprocalRank: number;
    semanticForbiddenHit: boolean;
    hybridForbiddenHit: boolean;
}

export interface MemoryRetrievalEvalMetrics {
    recallAtK: number;
    mrr: number;
    forbiddenHitRate: number;
}

export interface MemoryRetrievalEvalReport {
    dataset: string;
    cases: MemoryRetrievalEvalCaseResult[];
    semantic: MemoryRetrievalEvalMetrics;
    hybrid: MemoryRetrievalEvalMetrics;
    recallLift: number;
    passed: boolean;
    failures: string[];
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function recallAtK(ids: string[], relevantIds: string[], k: number): number {
    if (relevantIds.length === 0) return 1;
    const top = new Set(ids.slice(0, k));
    return relevantIds.filter(id => top.has(id)).length / relevantIds.length;
}

function reciprocalRank(ids: string[], relevantIds: string[]): number {
    const relevant = new Set(relevantIds);
    const index = ids.findIndex(id => relevant.has(id));
    return index >= 0 ? 1 / (index + 1) : 0;
}

function hasForbiddenHit(ids: string[], forbiddenIds: string[] | undefined, k: number): boolean {
    if (!forbiddenIds || forbiddenIds.length === 0) return false;
    const forbidden = new Set(forbiddenIds);
    return ids.slice(0, k).some(id => forbidden.has(id));
}

function toCandidate(candidate: MemoryRetrievalEvalCandidate): MemoryRetrievalCandidate {
    return {
        id: candidate.id,
        content: candidate.content,
        score: candidate.semanticScore,
        tags: candidate.tags,
    };
}

export function evaluateMemoryRetrievalDataset(dataset: MemoryRetrievalEvalDataset): MemoryRetrievalEvalReport {
    const cases = dataset.cases.map((testCase): MemoryRetrievalEvalCaseResult => {
        const k = testCase.k ?? dataset.defaultK ?? 3;
        const semanticCandidates = testCase.candidates
            .filter(candidate => candidate.semanticCandidate !== false)
            .map(toCandidate)
            .sort((a, b) => b.score - a.score);
        // Dataset содержит небольшой labelled pool; Qdrant full-text candidate
        // generation проверяется отдельно интеграционным тестом.
        const lexicalCandidates = testCase.candidates.map(toCandidate);
        const hybrid = fuseMemoryRetrievalCandidates(
            testCase.query,
            semanticCandidates,
            lexicalCandidates,
            Math.max(k, testCase.candidates.length)
        );
        const semanticIds = semanticCandidates.map(candidate => candidate.id);
        const hybridIds = hybrid.map(candidate => candidate.id);

        return {
            id: testCase.id,
            query: testCase.query,
            k,
            semanticIds: semanticIds.slice(0, k),
            hybridIds: hybridIds.slice(0, k),
            semanticRecall: recallAtK(semanticIds, testCase.relevantIds, k),
            hybridRecall: recallAtK(hybridIds, testCase.relevantIds, k),
            semanticReciprocalRank: reciprocalRank(semanticIds, testCase.relevantIds),
            hybridReciprocalRank: reciprocalRank(hybridIds, testCase.relevantIds),
            semanticForbiddenHit: hasForbiddenHit(semanticIds, testCase.forbiddenIds, k),
            hybridForbiddenHit: hasForbiddenHit(hybridIds, testCase.forbiddenIds, k),
        };
    });

    const forbiddenCaseIndices = dataset.cases
        .map((testCase, index) => (testCase.forbiddenIds?.length ?? 0) > 0 ? index : -1)
        .filter(index => index >= 0);
    const semantic: MemoryRetrievalEvalMetrics = {
        recallAtK: average(cases.map(item => item.semanticRecall)),
        mrr: average(cases.map(item => item.semanticReciprocalRank)),
        forbiddenHitRate: forbiddenCaseIndices.length > 0
            ? average(forbiddenCaseIndices.map(index => cases[index].semanticForbiddenHit ? 1 : 0))
            : 0,
    };
    const hybrid: MemoryRetrievalEvalMetrics = {
        recallAtK: average(cases.map(item => item.hybridRecall)),
        mrr: average(cases.map(item => item.hybridReciprocalRank)),
        forbiddenHitRate: forbiddenCaseIndices.length > 0
            ? average(forbiddenCaseIndices.map(index => cases[index].hybridForbiddenHit ? 1 : 0))
            : 0,
    };
    const recallLift = hybrid.recallAtK - semantic.recallAtK;
    const failures: string[] = [];
    const thresholds = dataset.thresholds ?? {};

    if (thresholds.minHybridRecallAtK !== undefined && hybrid.recallAtK < thresholds.minHybridRecallAtK) {
        failures.push(`hybrid recall@k ${hybrid.recallAtK.toFixed(3)} < ${thresholds.minHybridRecallAtK.toFixed(3)}`);
    }
    if (thresholds.minHybridMrr !== undefined && hybrid.mrr < thresholds.minHybridMrr) {
        failures.push(`hybrid MRR ${hybrid.mrr.toFixed(3)} < ${thresholds.minHybridMrr.toFixed(3)}`);
    }
    if (
        thresholds.maxHybridForbiddenHitRate !== undefined &&
        hybrid.forbiddenHitRate > thresholds.maxHybridForbiddenHitRate
    ) {
        failures.push(
            `hybrid forbidden hit rate ${hybrid.forbiddenHitRate.toFixed(3)} > ` +
            thresholds.maxHybridForbiddenHitRate.toFixed(3)
        );
    }
    if (thresholds.minRecallLift !== undefined && recallLift < thresholds.minRecallLift) {
        failures.push(`recall lift ${recallLift.toFixed(3)} < ${thresholds.minRecallLift.toFixed(3)}`);
    }

    return {
        dataset: dataset.name,
        cases,
        semantic,
        hybrid,
        recallLift,
        passed: failures.length === 0,
        failures,
    };
}
