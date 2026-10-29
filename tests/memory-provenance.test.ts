import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as completion from '../ai/chatCompletion';
import * as factory from '../services/VectorServiceFactory';
import * as episodes from '../services/MemoryEpisodeService';
import { FactExtractionService } from '../services/FactExtractionService';
import { extractAndSaveFactsFromConversation } from '../utils/enhancedFactExtraction';
import { memoryMessageSourceId, currentUserMemorySourceId, isIndependentMemoryEvidence } from '../utils/memoryProvenance';
import { reconsolidateAfterResponse } from '../services/MemoryReconsolidationService';

const response = (data: unknown) => ({ choices: [{ message: { content: JSON.stringify(data) } }] } as any);
const owner = '900000062';

test('source IDs survive history windows and serialization, with distinct native channel namespaces', () => {
    const message = { role: 'user', content: 'Я изучаю геометрию.', timestamp: new Date('2026-01-01') };
    const expected = memoryMessageSourceId(message);
    assert.equal(memoryMessageSourceId(JSON.parse(JSON.stringify(message))), expected);
    assert.equal(memoryMessageSourceId([{}, message][1] as any), expected);
    assert.notEqual(memoryMessageSourceId({ ...message, content: 'Я изучаю алгебру.' }), expected);
    assert.equal(isIndependentMemoryEvidence({ sourceMessageIds: [`user:${message.timestamp.getTime()}:7`] }, { sourceMessageIds: [expected] }), false);
    const ctx = { from: { id: Number(owner) }, chat: { id: Number(owner) }, message: { message_id: 7 } } as any;
    assert.equal(currentUserMemorySourceId(ctx, message.content), `tg:${owner}:7`);
    assert.equal(currentUserMemorySourceId({ ...ctx, sessionStorageKey: `api:${owner}` }, message.content), `api:${owner}:7`);
    assert.equal(isIndependentMemoryEvidence({ sourceMessageIds: [`telegram:${owner}:7`] }, { sourceMessageIds: [`tg:${owner}:7`] }), false);
    assert.equal(currentUserMemorySourceId({ session: { messageHistory: [{ ...message, sourceMessageId: 'latest-source' }, { ...message, sourceMessageId: 'older-source' }] } } as any, message.content), 'latest-source');
});

test('delayed extraction requires an actual owner quote and retains atomic assertion fields', async t => {
    const content = 'Пользователь не работает в студии Учебная.';
    const evidence = 'Я не работаю в студии Учебная.';
    const good = { content, evidence, subject: 'user', domain: 'work', factType: 'personal_info', predicate: 'works_at', object: 'студии Учебная', negated: true,
        confidence: .93, importance: .7, temporalScope: 'current_state' };
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ facts: [good,
        { ...good, evidence: 'Ты работаешь в другой студии.' }, { ...good, evidence: 'выдуманная цитата' },
        { ...good, predicate: undefined }, { ...good, negated: undefined }, { ...good, confidence: '0.93' },
    ] }));
    const facts = await new FactExtractionService().extractFactsFromDialogue([{ userMessage: evidence, botResponse: 'Ты работаешь в другой студии.', timestamp: new Date(), isUserInitiated: true }]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].predicate, 'works_at'); assert.equal(facts[0].object, 'студии Учебная');
    assert.equal(facts[0].negated, true); assert.equal(facts[0].confidence, .93); assert.equal(facts[0].sourceContext, evidence);
});

test('a quick-pass prefix cannot suppress a different delayed assertion, including a negative update', async t => {
    const text = 'Я больше не работаю в студии Учебная и работаю в студии Контрольная.';
    const saved: any[] = [];
    t.mock.method(episodes, 'createMemoryEpisode', async () => ({ id: 'synthetic-episode' } as any));
    t.mock.method(episodes, 'updateWorkingMemoryFromMessages', async () => {});
    t.mock.method(factory, 'getVectorService', () => ({ searchMemories: async () => [], searchAllDomains: async () => [], saveMemory: async (value: any) => { saved.push(value); return `saved-${saved.length}`; } } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async (task: string) => response(task === 'messageAnalysis' ? { facts: [
        { content: 'Пользователь больше не работает в студии Учебная.', evidence: 'Я больше не работаю в студии Учебная', subject: 'user', predicate: 'works_at', object: 'студии Учебная', negated: true, confidence: .93, importance: .4, domain: 'work', temporalScope: 'current_state' },
        { content: 'Пользователь работает в студии Контрольная.', evidence: 'работаю в студии Контрольная', subject: 'user', predicate: 'works_at', object: 'студии Контрольная', negated: false, confidence: .91, importance: .4, domain: 'work', temporalScope: 'current_state' },
    ] } : { state_change: false }));
    const message = { role: 'user', content: text, timestamp: new Date('2026-01-01'), sourceMessageId: `api:${owner}:7` };
    const ctx = { from: { id: Number(owner) }, session: { messageHistory: [message], quickFactContents: ['Пользователь больше не работает в студии Совсем другая.'], domains: {} } } as any;
    assert.equal(await extractAndSaveFactsFromConversation(ctx), 2);
    assert.deepEqual(saved.map(value => [value.predicate, value.object, value.negated, value.confidence]), [
        ['works_at', 'студии Учебная', true, .93], ['works_at', 'студии Контрольная', false, .91],
    ]);
    assert.ok(saved.every(value => value.sourceMessageIds.length === 1 && value.sourceMessageIds[0] === message.sourceMessageId));
});

test('a model cannot reconfirm a fact from assistant text or an invented quote', async t => {
    const record = { id: 'source', content: 'Пользователь изучает геометрию.', domain: 'education', timestamp: new Date(), importance: .7, tags: ['subject:user'], subject: 'user', confidence: .6, status: 'active' } as any;
    let writes = 0;
    let evidence = '';
    t.mock.method(factory, 'getVectorService', () => ({ fetchMemoryById: async () => record, updateMemory: async () => { writes++; } } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ decisions: [{ index: 0, action: 'confirm', confirmationEvidence: evidence }] }));
    const run = () => reconsolidateAfterResponse({ from: { id: Number(owner) }, chat: { type: 'private' } } as any, 'Спасибо, это помогло.', 'Ты изучаешь геометрию.', [{ ...record, score: .9 }]);
    await run(); evidence = 'Ты изучаешь геометрию.'; await run(); evidence = 'Я подтверждаю факт.'; await run();
    assert.equal(writes, 0);
});

test('a real owner confirmation is bound to the current channel message', async t => {
    const record = { id: 'source', content: 'Пользователь изучает геометрию.', domain: 'education', timestamp: new Date(), importance: .7,
        userId: owner, tags: ['subject:user'], subject: 'user', predicate: 'studies', object: 'геометрию', confidence: .6, status: 'active' } as any;
    const writes: any[] = [];
    const text = 'Да, я по-прежнему изучаю геометрию.';
    t.mock.method(factory, 'getVectorService', () => ({ fetchMemoryById: async () => record, updateMemory: async (...args: any[]) => { writes.push(args); } } as any));
    t.mock.method(completion, 'createChatCompletionForTask', async () => response({ decisions: [{ index: 0, action: 'confirm', confirmationEvidence: text }] }));
    await reconsolidateAfterResponse({ from: { id: Number(owner) }, chat: { id: Number(owner), type: 'private' }, sessionStorageKey: `api:${owner}`, message: { message_id: 8 } } as any,
        text, 'Помню.', [{ ...record, score: .9 }]);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0][3].confirmation.sourceMessageIds, [`api:${owner}:8`]);
    assert.equal(writes[0][2].content, record.content);
    assert.equal(typeof writes[0][3].expectedAssertion, 'string');
});
