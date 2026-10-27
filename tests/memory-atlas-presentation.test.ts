import assert from 'node:assert/strict';
import { test } from 'node:test';
import { atlasNodeLabel, findAtlasNodes } from '../admin-panel/src/memoryAtlasPresentation';
import type { MemoryGraphNode } from '../admin-panel/src/types';
const node = (id: string, extra: Partial<MemoryGraphNode> = {}): MemoryGraphNode => ({ id, nodeType: 'memory', label: 'Synthetic label', content: '',
    domain: 'general', memoryKind: 'fact', status: 'active', confidence: 1, importance: 0.5, strength: 1, isAnchor: false,
    synthetic: false, timestamp: null, tags: [], flags: [], degree: 1, ...extra });

test('canvas labels are bounded and preserve Unicode while the full record stays intact', () => {
    const record = node('synthetic', { label: 'Синтетическая запись про тестовый проект и длинное описание '.repeat(20) });
    const original = record.label;
    assert.ok(Array.from(atlasNodeLabel(record)).length <= 42);
    assert.ok(atlasNodeLabel(record).endsWith('…'));
    assert.equal(record.label, original);
    assert.equal(atlasNodeLabel({ label: '  Тест\n  подписи ' }), 'Тест подписи');
    assert.equal(atlasNodeLabel({ label: '😀'.repeat(50) }), '😀'.repeat(41) + '…');
});

test('node picker searches all loaded content and prioritizes people and connected anchors deterministically', () => {
    const data = [node('isolated', { degree: 0 }), node('anchor', { isAnchor: true }),
        node('person', { nodeType: 'person', label: 'Тестовый человек' }), node('long', { content: 'Невидимый в подписи синтетический маяк' })];
    assert.equal(findAtlasNodes(data, '')[0].id, 'person');
    assert.equal(findAtlasNodes(data, '')[1].id, 'anchor');
    assert.deepEqual(findAtlasNodes(data, '  МАЯК  синтетический ').map(item => item.id), ['long']);
    assert.equal(findAtlasNodes(data, '', 2).length, 2);
    assert.deepEqual(findAtlasNodes(data, 'missing'), []);
});

import { deriveAtlasView, type AtlasFilters } from '../admin-panel/src/memoryAtlasView';
import type { MemoryGraphEdge, MemoryGraphEdgeKind } from '../admin-panel/src/types';
const atlasNodes = [node('person-a', { nodeType: 'person', label: 'Тестовый человек A' }), node('person-b', { nodeType: 'person', label: 'Тестовый человек B' }),
    node('source', { domain: 'work' }), node('derived', { domain: 'health' }), node('isolated', { domain: 'work' })];
const edge = (id: string, source: string, target: string, kind: MemoryGraphEdgeKind, directed = false): MemoryGraphEdge => ({ id, source, target, kind, directed, relationType: kind, weight: 1 });
const atlasEdges = [edge('a-source', 'person-a', 'source', 'identity'), edge('source-derived', 'source', 'derived', 'derived_from', true), edge('derived-b', 'derived', 'person-b', 'identity')];
const filters = (patch: Partial<AtlasFilters> = {}): AtlasFilters => ({ domains: new Set(), edgeKinds: new Set(['identity', 'derived_from', 'relation', 'episode', 'person_relation']),
    personId: null, depth: 2, showIsolated: true, pathSourceId: null, pathTargetId: null, ...patch });

test('atlas topic and relationship filters remove unrelated nodes and edges together', () => {
    const view = deriveAtlasView(atlasNodes, atlasEdges, filters({ domains: new Set(['work']), showIsolated: false }));
    assert.deepEqual([...view.nodeIds].sort(), ['person-a', 'source']);
    assert.deepEqual([...view.edgeIds], ['a-source']);
    assert.equal(view.degreeById.get('source'), 1); assert.equal(view.degreeById.get('person-a'), 1);
    assert.ok(view.edges.every(edge => view.nodeIds.has(edge.source) && view.nodeIds.has(edge.target)));
    const kinds = deriveAtlasView(atlasNodes, atlasEdges, filters({ edgeKinds: new Set(['derived_from']), showIsolated: false }));
    assert.deepEqual([...kinds.nodeIds].sort(), ['derived', 'source']);
    assert.deepEqual([...kinds.edgeIds], ['source-derived']);
    assert.equal(deriveAtlasView(atlasNodes, atlasEdges, filters({ edgeKinds: new Set(), showIsolated: false })).nodeIds.size, 0);
});

test('person exploration follows only the selected number of saved links', () => {
    const one = deriveAtlasView(atlasNodes, atlasEdges, filters({ personId: 'person-a', depth: 1 }));
    const three = deriveAtlasView(atlasNodes, atlasEdges, filters({ personId: 'person-a', depth: 3 }));
    assert.deepEqual([...one.nodeIds].sort(), ['person-a', 'source']);
    assert.deepEqual([...three.nodeIds].sort(), ['derived', 'person-a', 'person-b', 'source']);
    const noSources = deriveAtlasView(atlasNodes, atlasEdges, filters({ personId: 'person-a', depth: 3, edgeKinds: new Set(['identity']) }));
    assert.equal(noSources.nodeIds.has('person-b'), false);
});

test('knowledge paths respect provenance direction and never invent missing or filtered hops', () => {
    const forward = deriveAtlasView(atlasNodes, atlasEdges, filters({ pathSourceId: 'person-a', pathTargetId: 'person-b' }));
    assert.deepEqual(forward.path, { nodes: ['person-a', 'source', 'derived', 'person-b'], edges: ['a-source', 'source-derived', 'derived-b'] });
    assert.equal(forward.pathMissing, false);
    const reverse = deriveAtlasView(atlasNodes, atlasEdges, filters({ pathSourceId: 'person-b', pathTargetId: 'person-a' }));
    assert.equal(reverse.path, null); assert.equal(reverse.pathMissing, true); assert.equal(reverse.edgeIds.size, 0);
    const hidden = deriveAtlasView(atlasNodes, atlasEdges, filters({ pathSourceId: 'person-a', pathTargetId: 'person-b', domains: new Set(['work']) }));
    assert.equal(hidden.pathMissing, true); assert.equal(hidden.nodes.length, 0);
    const disconnected = deriveAtlasView(atlasNodes, atlasEdges, filters({ pathSourceId: 'person-a', pathTargetId: 'isolated' }));
    assert.equal(disconnected.pathMissing, true);
});

test('only genuine directed source links produce bounded animated knowledge flow', () => {
    const mixed = [...atlasEdges, edge('undirected-source', 'source', 'isolated', 'derived_from'), edge('manager', 'person-a', 'person-b', 'person_relation', true)];
    assert.deepEqual(deriveAtlasView(atlasNodes, mixed, filters()).flowEdges.map(edge => edge.id), ['source-derived']);
    assert.equal(deriveAtlasView(atlasNodes, mixed, filters({ edgeKinds: new Set(['identity', 'person_relation']) })).flowEdges.length, 0);
    const many = Array.from({ length: 100 }, (_, index) => edge('source-' + index, 'source', 'derived', 'derived_from', true));
    assert.equal(deriveAtlasView(atlasNodes, many, filters()).flowEdges.length, 24);
});
