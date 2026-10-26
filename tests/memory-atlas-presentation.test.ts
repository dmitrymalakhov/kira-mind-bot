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
