import type { MemoryGraphNode } from './types';

// Labels are visual navigation hints. The complete record remains in the details panel.
export function atlasNodeLabel(node: Pick<MemoryGraphNode, 'label'>, limit = 42): string {
  const characters = Array.from(node.label.replace(/\s+/gu, ' ').trim());
  if (characters.length <= limit) return characters.join('');
  const excerpt = characters.slice(0, limit - 1).join('');
  const boundary = excerpt.lastIndexOf(' ');
  return `${boundary >= limit * 0.55 ? excerpt.slice(0, boundary) : excerpt}…`;
}

export function findAtlasNodes(nodes: MemoryGraphNode[], query: string, limit = 12): MemoryGraphNode[] {
  const terms = query.trim().toLocaleLowerCase('ru-RU').split(/\s+/u).filter(Boolean);
  return nodes.filter(node => {
    const text = `${node.label} ${node.content}`.toLocaleLowerCase('ru-RU');
    return terms.every(term => text.includes(term));
  }).sort((a, b) => Number(b.nodeType === 'person') - Number(a.nodeType === 'person')
    || Number(b.isAnchor) - Number(a.isAnchor) || b.degree - a.degree || b.importance - a.importance
    || a.id.localeCompare(b.id)).slice(0, limit);
}
