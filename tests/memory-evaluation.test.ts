import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateMemoryEvidence } from '../scripts/memoryEvaluation';

test('an honest refusal is a failed lookup when known scoped evidence exists', () => {
    const result = evaluateMemoryEvidence({ knownAnswer: true, minEvidence: 1, targetPersonIds: ['synthetic-person'] }, {
        responseText: 'В этой выборке сведений не нашлось.', intent: 'РАЗГОВОР', evidenceIds: [], resolvedPeople: [],
    });
    assert.deepEqual(result.failures, ['retrieval_miss', 'person_not_resolved']);
});

test('identity selection without its saved proof is not counted as a grounded answer', () => {
    const result = evaluateMemoryEvidence({ knownAnswer: true, minEvidence: 1, requiredEvidenceIds: ['synthetic-owner-edge'] }, {
        responseText: 'Это Лада Тестовая.', intent: 'РАЗГОВОР', evidenceIds: ['synthetic-person-fact'], resolvedPeople: [{ personIds: ['synthetic-lada'] }],
    });
    assert.deepEqual(result.failures, ['identity_proof_lost']);
});

test('an exhausted bounded pool does not require inventing fresh facts', () => {
    const actual = { responseText: 'Новых сведений в этой выборке не нашлось.', intent: 'РАЗГОВОР', evidenceIds: ['one'], resolvedPeople: [{ personIds: ['user'], owner: true }], freshEvidenceCount: 0, noNewEvidenceInPool: true };
    assert.equal(evaluateMemoryEvidence({ knownAnswer: true, minEvidence: 1, ownerSubject: true, wantsNewEvidence: true, availableUnseenEvidence: 0 }, actual).passed, true);
    assert.deepEqual(evaluateMemoryEvidence({ knownAnswer: true, wantsNewEvidence: true, availableUnseenEvidence: 3 }, actual).failures, ['new_evidence_lost']);
});

test('duplicate tool recalls do not inflate the evidence count or excuse a wrong route', () => {
    const result = evaluateMemoryEvidence({ knownAnswer: true, minEvidence: 2 }, {
        responseText: 'Сначала уточни, что сделать.', intent: 'НЕОПРЕДЕЛЕНО', evidenceIds: ['one', 'one'], resolvedPeople: [],
    });
    assert.equal(result.evidenceCount, 1); assert.deepEqual(result.failures, ['wrong_memory_route', 'retrieval_miss']);
});

test('found evidence cannot be reported to synthesis as an empty search', () => {
    assert.deepEqual(evaluateMemoryEvidence({ knownAnswer: true, minEvidence: 1 }, {
        responseText: 'Есть сохранённый факт.', intent: 'РАЗГОВОР', evidenceIds: ['synthetic-one'], resolvedPeople: [], recallState: 'empty',
    }).failures, ['inconsistent_recall_summary']);
});

test('mentioning the expected name elsewhere cannot excuse a reversed verified identity answer', () => {
    assert.deepEqual(evaluateMemoryEvidence({ knownAnswer: true, identityName: 'Лада Тестовая' }, {
        responseText: 'Это Мирон Примеров. Он знаком с Ладой Тестовой.', evidenceIds: ['synthetic-edge'], resolvedPeople: [], identityVerified: true,
    }).failures, ['identity_answer_mismatch']);
});
