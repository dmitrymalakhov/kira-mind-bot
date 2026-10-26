import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotContext, SearchResult } from '../types';
import { ownerRelationshipIntent, isFocusedPersonalRecall, personalRecallQueries } from '../utils/personalRecallIntent';
import { recallOwnerRelationship } from '../utils/personalRelationshipRecall';
import { fetchAgentMemoryContext } from '../utils/agentMemoryContext';
import { decideKnowledgeSource } from '../utils/knowledgeSource';
import * as vector from '../services/VectorServiceFactory';
import * as multi from '../utils/multiQueryMemory';
import * as today from '../utils/todayImportance';
import { normalizePersonRelationDescriptor } from '../utils/personRelation';

const OWNER = '740991';

test('a bare relationship role cannot create a provisional person named wife', () => {
    assert.equal(normalizePersonRelationDescriptor({type:'spouse_of',targetRole:'third_party',targetName:'жена'}, {subject:'user',evidence:'У пользователя есть жена.'}),undefined);
    assert.deepEqual(normalizePersonRelationDescriptor({type:'spouse_of',targetRole:'third_party',targetName:'Лада Тестовая'}, {subject:'user',evidence:'Лада Тестовая — жена пользователя.'}), {type:'spouse_of',targetRole:'third_party',targetName:'Лада Тестовая'});
});
function edge(overrides: Partial<SearchResult> = {}): SearchResult {
    return { id: 'synthetic-edge', domain: 'family', content: 'Супруга пользователя — Лада Тестовая.',
        tags: ['person_relation', 'relation_type:spouse_of', 'relation_subject:user', 'relation_object_person_id:synthetic-lada', 'relation_object_name:Лада Тестовая'],
        subject: 'user', confidence: .95, importance: .8, score: 1, status: 'active', timestamp: new Date(), ...overrides };
}
function store(records: SearchResult[]) {
    const calls: string[] = [];
    return { calls, getMemoriesByTag: async (userId: string, tag: string) => {
        assert.equal(userId, OWNER); calls.push(tag); return records.filter(record => record.tags.includes(tag));
    } };
}

test('focused owner recall accepts Russian cases and excludes compound requests and other people spouses', () => {
    for (const message of ['А кто моя жена?', 'Как зовут мою супругу?', 'Ты помнишь имя моей жены?', 'Кто мой муж?', 'Ты помнишь где я работаю?']) {
        assert.equal(isFocusedPersonalRecall(message), true, message);
        assert.equal(decideKnowledgeSource(message).source, 'personal');
    }
    for (const message of ['Кто жена моего друга?', 'Как зовут его жену?', 'Напиши моей жене', 'Кто моя жена и напомни позвонить?', 'С работы пришёл']) assert.equal(isFocusedPersonalRecall(message), false, message);
    assert.equal(ownerRelationshipIntent('Кто жена моего друга?'), null);
    assert.equal(ownerRelationshipIntent('Что думает моя коллега?')?.type, 'coworker_of');
    assert.ok(personalRecallQueries('Где я работаю?').includes('работает'));
});

test('a saved owner edge gives the name without semantic similarity or a language model', async () => {
    const service = store([edge(), edge({id:'synthetic-unrelated',tags:['person_relation','relation_type:spouse_of','relation_subject_person_id:synthetic-third','relation_object_person_id:synthetic-other','relation_object_name:Чужая Тестовая']})]);
    const result = await recallOwnerRelationship(service, OWNER, 'Кто моя жена?');
    assert.equal(result.complete, true); assert.equal(result.name, 'Лада Тестовая');
    assert.deepEqual(service.calls, ['relation_type:spouse_of']);
    assert.match(result.context, /Лада Тестовая/); assert.doesNotMatch(result.context, /Чужая/);
    assert.equal(result.memories.length, 1);
});

test('reverse symmetric edges resolve the other endpoint, never the owner name', async () => {
    const result = await recallOwnerRelationship(store([edge({subject:'contact', tags:['person_relation','relation_type:spouse_of','relation_subject_person_id:synthetic-lada','relation_object:user','contact_name:Лада Тестовая','relation_object_name:Владелец Тестовый']})]), OWNER, 'Как зовут мою жену?');
    assert.equal(result.name, 'Лада Тестовая');
});

test('identity hydration follows only the saved stable endpoint and needs one consistent name', async () => {
    const relation = edge({tags:edge().tags.filter(tag=>!tag.startsWith('relation_object_name:'))});
    const person = edge({id:'synthetic-person-record', subject:'contact',content:'[Лада Тестовая] Любит рисовать.',tags:['person_id:synthetic-lada','contact_name:Лада Тестовая']});
    const service = store([relation,person,edge({id:'synthetic-name-collision',tags:['person_id:synthetic-other','contact_name:Лада Другая']})]);
    const result = await recallOwnerRelationship(service, OWNER, 'Кто моя жена?');
    assert.equal(result.name,'Лада Тестовая'); assert.equal(result.memories.length,2);
    assert.deepEqual(service.calls,['relation_type:spouse_of','person_id:synthetic-lada']);
});

test('expired, negated, uncertain, future and bot-derived edges cannot establish a personal identity', async () => {
    const now=Date.parse('2030-01-01T00:00:00Z');
    for(const patch of [{status:'expired'},{status:'superseded'},{status:'planned'},{status:'done'},{negated:true},{confidence:.2},{subject:'system'},{subject:'bot'},
        {validFrom:new Date('2031-01-01')},{validTo:new Date('2029-01-01')},{expiresAt:new Date('2029-01-01')} ] as Partial<SearchResult>[]) {
        const result=await recallOwnerRelationship(store([edge(patch)]),OWNER,'Кто моя жена?',now);
        assert.equal(result.context,'',JSON.stringify(patch));assert.equal(result.complete,false);
    }
});

test('multiple active endpoints remain ambiguous even if one appears more often', async () => {
    const other=edge({id:'synthetic-other-edge',content:'Супруга — Другая Тестовая.',tags:['person_relation','relation_type:spouse_of','relation_subject:user','relation_object_person_id:synthetic-other','relation_object_name:Другая Тестовая']});
    const result=await recallOwnerRelationship(store([edge(),edge({id:'synthetic-duplicate'}),other]),OWNER,'Кто моя жена?');
    assert.equal(result.complete,false);assert.equal(result.name,undefined);assert.match(result.context,/несколькими людьми/);
});

test('old and canonical person IDs agree only through a strong contact ID, while unnamed roles never supply a name', async () => {
    const legacy=edge({id:'synthetic-legacy',subject:'contact',tags:['person_relation','relation_type:spouse_of','relation_subject_person_id:synthetic-old-lada','relation_object:user','contact_id:555111','contact_name:Лада Тестовая']});
    const unnamed=edge({id:'synthetic-unnamed',content:'У пользователя есть супруга.',tags:['person_relation','relation_type:spouse_of','relation_subject:user','relation_object_person_id:synthetic-placeholder','relation_object_name:жена']});
    const result=await recallOwnerRelationship(store([edge(),legacy,unnamed]),OWNER,'Кто моя жена?',Date.now(),{identities:async(user,ids)=>{
        assert.equal(user,OWNER);assert.ok(ids.includes('synthetic-lada'));return [{id:'synthetic-lada',displayName:'Лада Тестовая',telegramContactId:'555111'}];
    }});
    assert.equal(result.complete,true);assert.equal(result.name,'Лада Тестовая');assert.equal(result.memories.length,2);
    const sameNames=await recallOwnerRelationship(store([edge(),edge({id:'synthetic-name-twin',tags:edge().tags.map(t=>t==='relation_object_person_id:synthetic-lada'?'relation_object_person_id:synthetic-twin':t)})]),OWNER,'Кто моя жена?');
    assert.equal(sameNames.complete,false,'same name alone cannot merge two people');
});

test('a contradictory strong identity or the owner endpoint cannot be silently accepted', async () => {
    const reverse=edge({subject:'contact',tags:['person_relation','relation_type:spouse_of','relation_subject_person_id:synthetic-lada','relation_object:user','contact_id:555222','contact_name:Лада Тестовая']});
    for(const contact of ['555111',OWNER]) {
        const result=await recallOwnerRelationship(store([reverse]),OWNER,'Кто моя жена?',Date.now(),{identities:async()=>[{id:'synthetic-lada',displayName:'Лада Тестовая',telegramContactId:contact}]});
        assert.equal(result.complete,false);assert.equal(result.context,'');
    }
});

test('private focused recall overrides a wrong memoryNeed=none and protects evidence from reranker loss', async t => {
    const service=store([edge()]);t.mock.method(vector,'getVectorService',()=>service as any);
    const generic=t.mock.method(multi,'getMultiQueryMemoryContextDetailed',async()=>{throw Error('Exact evidence must not depend on generic ranking');});
    t.mock.method(today,'buildTodayImportanceContext',async()=> '');
    const ctx={from:{id:Number(OWNER)},chat:{type:'private'},session:{}} as unknown as BotContext;
    const result=await fetchAgentMemoryContext(ctx,'Кто моя жена?',{memoryNeed:'none'});
    assert.match(result.context,/Лада Тестовая/);assert.equal(generic.mock.callCount(),0);assert.equal(result.recalledMemories?.[0].id,'synthetic-edge');
    const group=await fetchAgentMemoryContext({...ctx,chat:{type:'group'}} as BotContext,'Кто моя жена?',{memoryNeed:'full'});
    assert.equal(group.context,'');assert.equal(service.calls.length,1);
});

test('employment recall cannot be suppressed by classification and preserves deterministic search cues', async t => {
    const generic=t.mock.method(multi,'getMultiQueryMemoryContextDetailed',async(_ctx:BotContext,_text:string,need?:multi.MemoryNeed)=>{
        assert.equal(need,'full');return {context:'Пользователь работает в компании «Тестовый Маяк».',recalledMemories:[]};
    });t.mock.method(today,'buildTodayImportanceContext',async()=> '');
    const result=await fetchAgentMemoryContext({from:{id:Number(OWNER)},chat:{type:'private'},session:{}} as BotContext,'Ты помнишь где я работаю?',{memoryNeed:'none'});
    assert.match(result.context,/Тестовый Маяк/);assert.match(result.context,/не означает/);assert.equal(generic.mock.callCount(),1);
});
