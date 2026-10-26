import type { MemoryGraphEdge, MemoryGraphEdgeKind, MemoryGraphNode } from './types';

export interface AtlasFilters {
  domains: ReadonlySet<string>;
  edgeKinds: ReadonlySet<MemoryGraphEdgeKind>;
  personId: string | null;
  depth: 1 | 2 | 3;
  showIsolated: boolean;
  pathSourceId: string | null;
  pathTargetId: string | null;
}
export interface AtlasPath { nodes: string[]; edges: string[] }

export function deriveAtlasView(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[], filters: AtlasFilters) {
  const allowed = new Set(nodes.filter(node => node.nodeType === 'person' || !filters.domains.size || filters.domains.has(node.domain)).map(node => node.id));
  const matchingPeople = new Set<string>();
  if (filters.domains.size) for (const edge of edges) {
    if (edge.kind !== 'identity' || !allowed.has(edge.source) || !allowed.has(edge.target)) continue;
    matchingPeople.add(edge.source); matchingPeople.add(edge.target);
  }
  const candidates = edges.filter(edge => filters.edgeKinds.has(edge.kind) && allowed.has(edge.source) && allowed.has(edge.target)
    && (!filters.domains.size || edge.kind !== 'person_relation' || matchingPeople.has(edge.source) && matchingPeople.has(edge.target)));
  const adjacency = new Map<string, Array<{ node: string; edge: MemoryGraphEdge; forward: boolean }>>();
  for (const edge of candidates) {
    for (const [from, to, forward] of [[edge.source, edge.target, true], [edge.target, edge.source, false]] as const) {
      const list = adjacency.get(from) || []; list.push({ node: to, edge, forward }); adjacency.set(from, list);
    }
  }
  let visible = new Set(nodes.filter(node => allowed.has(node.id) && (adjacency.has(node.id) || filters.showIsolated && node.nodeType === 'memory')).map(node => node.id));
  let path: AtlasPath | null = null;
  let pathMissing = false;
  const source = filters.pathSourceId || filters.personId;
  if (filters.pathTargetId && source) {
    // Only saved directed edges can be followed forward; identity/association edges are bidirectional.
    const previous = new Map<string, { from: string; edge: string }>();
    const visited = new Set<string>();
    const queue: string[] = [];
    if (allowed.has(source)) { queue.push(source); visited.add(source); }
    for (let index = 0; index < queue.length && !visited.has(filters.pathTargetId); index++) {
      for (const step of adjacency.get(queue[index]) || []) {
        if (step.edge.directed && !step.forward || visited.has(step.node)) continue;
        visited.add(step.node); previous.set(step.node, { from: queue[index], edge: step.edge.id }); queue.push(step.node);
      }
    }
    if (visited.has(filters.pathTargetId)) {
      const pathNodes = [filters.pathTargetId], pathEdges: string[] = [];
      let cursor = filters.pathTargetId;
      while (cursor !== source) {
        const step = previous.get(cursor)!; pathEdges.push(step.edge); pathNodes.push(step.from); cursor = step.from;
      }
      path = { nodes: pathNodes.reverse(), edges: pathEdges.reverse() }; visible = new Set(path.nodes);
    } else { visible = new Set(); pathMissing = true; }
  } else if (filters.personId) {
    const queue: Array<{ id: string; depth: number }> = allowed.has(filters.personId) ? [{ id: filters.personId, depth: 0 }] : [];
    visible = new Set(queue.map(node => node.id));
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]; if (current.depth >= filters.depth) continue;
      for (const step of adjacency.get(current.id) || []) {
        if (visible.has(step.node)) continue;
        visible.add(step.node); queue.push({ id: step.node, depth: current.depth + 1 });
      }
    }
  }
  const pathEdges = path ? new Set(path.edges) : null;
  const visibleEdges = candidates.filter(edge => visible.has(edge.source) && visible.has(edge.target) && (!pathEdges || pathEdges.has(edge.id)));
  const edgeIds = new Set(visibleEdges.map(edge => edge.id));
  const degreeById = new Map([...visible].map(id => [id, 0]));
  for (const edge of visibleEdges) { degreeById.set(edge.source, (degreeById.get(edge.source) || 0) + 1); degreeById.set(edge.target, (degreeById.get(edge.target) || 0) + 1); }
  return { nodeIds: visible, edgeIds, degreeById, nodes: nodes.filter(node => visible.has(node.id)), edges: visibleEdges, path, pathMissing,
    flowEdges: visibleEdges.filter(edge => edge.directed && ['derived_from', 'episode'].includes(edge.kind)).slice(0, 24) };
}
