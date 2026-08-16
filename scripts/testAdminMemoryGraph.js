'use strict';

const assert = require('assert');
const {
  allocateMemoryGraphDomainLimits,
  buildMemoryGraph,
  compactText,
  memoryNodeKey,
} = require('../admin-panel/memoryGraph');

const episode = {
  id: 'episode-memory',
  domain: 'general',
  content: '[ЭПИЗОД ПАМЯТИ: ТЕСТ] Обсуждение поездки',
  memoryKind: 'episode',
  sourceEpisodeId: 'episode-1',
  confidence: 0.75,
  importance: 0.7,
  strength: 0.8,
  tags: ['memory-episode'],
  relatedIds: [],
  sourceMemoryIds: [],
  synthetic: true,
};

const first = {
  id: 'fact-a',
  domain: 'travel',
  content: 'Алиса планирует поездку в мае',
  memoryKind: 'goal',
  status: 'planned',
  sourceEpisodeId: 'episode-1',
  sourceMemoryIds: ['fact-b'],
  sourceContext: 'Синтетический контекст теста',
  confidence: 0.82,
  importance: 0.8,
  strength: 0.78,
  tags: ['person_id:person-1', 'contact_name:Алиса'],
  relatedIds: [{ id: 'fact-b', domain: 'contacts', type: 'person_link', weight: 0.72 }],
};

const second = {
  id: 'fact-b',
  domain: 'contacts',
  content: 'Алиса предпочитает поезд',
  memoryKind: 'preference',
  status: 'active',
  confidence: 0.9,
  importance: 0.6,
  strength: 0.7,
  tags: ['person_id:person-1', 'contact_name:Алиса'],
  relatedIds: [{ id: 'fact-a', domain: 'travel', type: 'person_link', weight: 0.81 }],
  sourceMemoryIds: [],
};

const isolated = {
  id: 'fact-c',
  domain: 'home',
  content: 'Нужно проверить синтетический датчик',
  memoryKind: 'open_loop',
  status: 'active',
  confidence: 0.4,
  importance: 0.5,
  strength: 0.45,
  timestamp: '2020-01-01T00:00:00.000Z',
  tags: [],
  relatedIds: [{ id: 'missing', domain: 'home', type: 'semantic', weight: 0.6 }],
  sourceMemoryIds: ['missing-source'],
  sourceEpisodeId: 'missing-episode',
};

const relationship = {
  id: 'fact-relation',
  domain: 'social',
  content: 'Алиса и владелец работают вместе',
  memoryKind: 'relationship',
  status: 'active',
  confidence: 0.92,
  importance: 0.84,
  strength: 0.8,
  tags: [
    'person_id:person-1',
    'contact_name:Алиса',
    'person_relation',
    'relation_type:coworker_of',
    'relation_subject_person_id:person-1',
    'relation_object:user',
    'relation_direction:symmetric',
  ],
  relatedIds: [],
  sourceMemoryIds: [],
};

const graph = buildMemoryGraph([episode, first, second, isolated, relationship], {
  includeIdentityNodes: true,
  truncated: true,
});

assert.equal(graph.stats.memoryNodes, 5);
assert.equal(graph.stats.virtualNodes, 2);
assert.equal(graph.stats.totalNodes, 7);
assert.equal(graph.stats.totalEdges, 8);
assert.equal(graph.stats.edgeCounts.relation, 1, 'зеркальные relatedIds должны схлопываться');
assert.equal(graph.stats.edgeCounts.derived_from, 1);
assert.equal(graph.stats.edgeCounts.episode, 1);
assert.equal(graph.stats.edgeCounts.identity, 4);
assert.equal(graph.stats.edgeCounts.person_relation, 1);
assert.equal(graph.stats.isolatedMemoryNodes, 1);
assert.equal(graph.stats.unresolvedRelations, 1);
assert.equal(graph.stats.unresolvedSources, 2);
assert.equal(graph.stats.truncated, true);

const relation = graph.edges.find((edge) => edge.kind === 'relation');
assert.equal(relation.weight, 0.81, 'должна сохраняться наиболее сильная зеркальная связь');
assert.equal(relation.directed, false);

const personRelation = graph.edges.find((edge) => edge.kind === 'person_relation');
assert.equal(personRelation.relationType, 'coworker_of');
assert.equal(personRelation.directed, false);
assert.equal(personRelation.cue, 'Алиса и владелец работают вместе');

const person = graph.nodes.find((node) => node.nodeType === 'person');
assert.equal(person.label, 'Алиса');
assert.equal(person.degree, 4);

const owner = graph.nodes.find((node) => node.id === 'person:user');
assert.equal(owner.label, 'Владелец');
assert.equal(owner.degree, 2);

const isolatedNode = graph.nodes.find((node) => node.id === memoryNodeKey('home', 'fact-c'));
assert.ok(isolatedNode.flags.includes('isolated'));
assert.ok(isolatedNode.flags.includes('low_confidence'));
assert.ok(isolatedNode.flags.includes('stale'));

const graphWithoutIdentities = buildMemoryGraph([episode, first, second], { includeIdentityNodes: false });
assert.equal(graphWithoutIdentities.stats.virtualNodes, 0);
assert.equal(graphWithoutIdentities.stats.edgeCounts.identity, undefined);

assert.equal(compactText('[ТЕСТ]   короткий\nтекст', 30), 'короткий текст');
assert.equal(compactText('x'.repeat(40), 10), 'xxxxxxxxx…');

const quotas = allocateMemoryGraphDomainLimits([
  { domain: 'general', count: 100 },
  { domain: 'work', count: 25 },
  { domain: 'health', count: 1 },
  { domain: 'empty', count: 0 },
], 50);
assert.equal([...quotas.values()].reduce((sum, value) => sum + value, 0), 50);
assert.ok((quotas.get('general') || 0) > (quotas.get('work') || 0));
assert.equal(quotas.get('health'), 1, 'малый домен не должен исчезать из графа');
assert.equal(quotas.has('empty'), false);

const completeQuotas = allocateMemoryGraphDomainLimits([
  { domain: 'general', count: 3 },
  { domain: 'work', count: 2 },
], 20);
assert.deepEqual(Object.fromEntries(completeQuotas), { general: 3, work: 2 });

console.log('Admin Memory Atlas graph tests passed');
