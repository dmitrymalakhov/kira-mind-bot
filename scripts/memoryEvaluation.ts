/** Mechanical checks complement a model judge; an honest refusal can still be a retrieval failure. */
export interface MemoryEvaluationExpectation {
    knownAnswer: boolean;
    minEvidence?: number;
    targetPersonIds?: string[];
    ownerSubject?: boolean;
    requiredEvidenceIds?: string[];
    wantsNewEvidence?: boolean;
    availableUnseenEvidence?: number;
    allowEmptyContinuation?: boolean;
    identityName?: string;
}

export interface MemoryEvaluationObservation {
    responseText: string;
    intent?: string;
    evidenceIds: string[];
    resolvedPeople: Array<{ personIds: string[]; owner?: boolean }>;
    freshEvidenceCount?: number;
    noNewEvidenceInPool?: boolean;
    recallState?: string;
    identityVerified?: boolean;
}

export function evaluateMemoryEvidence(expected: MemoryEvaluationExpectation, actual: MemoryEvaluationObservation): {
    passed: boolean; failures: string[]; evidenceCount: number;
} {
    const failures: string[] = [];
    const evidence = new Set(actual.evidenceIds);
    if (!actual.responseText.trim()) failures.push('missing_answer');
    if (expected.knownAnswer && actual.intent && actual.intent !== 'РАЗГОВОР') failures.push('wrong_memory_route');
    if (expected.knownAnswer && !expected.allowEmptyContinuation && actual.recallState === 'empty' && evidence.size > 0) failures.push('inconsistent_recall_summary');
    if (!expected.allowEmptyContinuation && expected.minEvidence && evidence.size < expected.minEvidence) failures.push('retrieval_miss');
    if (expected.targetPersonIds?.length && !actual.resolvedPeople.some(person =>
        person.personIds.some(id => expected.targetPersonIds!.includes(id)))) failures.push('person_not_resolved');
    if (expected.ownerSubject && !actual.resolvedPeople.some(person => person.owner)) failures.push('owner_not_resolved');
    if (expected.requiredEvidenceIds?.length && !expected.requiredEvidenceIds.some(id => evidence.has(id))) failures.push('identity_proof_lost');
    if (expected.identityName && actual.identityVerified && actual.responseText.trim() !== `Это ${expected.identityName}.`) failures.push('identity_answer_mismatch');
    if (expected.wantsNewEvidence && (expected.availableUnseenEvidence ?? 0) > 0 && actual.freshEvidenceCount === 0) failures.push('new_evidence_lost');
    return { passed: failures.length === 0, failures, evidenceCount: evidence.size };
}
