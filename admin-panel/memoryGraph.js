'use strict';

const DEFAULT_RELATION_WEIGHT = 0.55;
const MAX_NODE_CONTENT_CHARS = 420;
const MAX_NODE_TAGS = 14;

function clamp01(value, fallback = DEFAULT_RELATION_WEIGHT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function compactText(value, max = MAX_NODE_CONTENT_CHARS) {
  const text = String(value || '')
    .replace(/^\[[^\]]+\]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => String(tag || '').trim()).filter(Boolean))];
}

function tagValue(tags, prefix) {
  const tag = tags.find((candidate) => candidate.startsWith(`${prefix}:`));
  return tag ? tag.slice(prefix.length + 1).trim() : '';
}

function memoryNodeKey(domain, id) {
  return `memory:${String(domain || 'general')}:${String(id)}`;
}

function personNodeKey(personId) {
  return `person:${String(personId)}`;
}

const SYMMETRIC_PERSON_RELATIONS = new Set([
  'spouse_of',
  'partner_of',
  'ex_partner_of',
  'sibling_of',
  'relative_of',
  'friend_of',
  'coworker_of',
  'works_with',
  'studies_with',
  'lives_with',
  'neighbor_of',
  'knows',
]);

function canonicalPersonRelation(type, source, target, direction) {
  let relationType = compactText(type, 40) || 'knows';
  let relationSource = source;
  let relationTarget = target;
  if (relationType === 'child_of') {
    relationType = 'parent_of';
    [relationSource, relationTarget] = [relationTarget, relationSource];
  } else if (relationType === 'reports_to') {
    relationType = 'manager_of';
    [relationSource, relationTarget] = [relationTarget, relationSource];
  }

  const symmetric = direction === 'symmetric' || SYMMETRIC_PERSON_RELATIONS.has(relationType);
  if (symmetric && relationSource > relationTarget) {
    [relationSource, relationTarget] = [relationTarget, relationSource];
  }
  return { relationType, source: relationSource, target: relationTarget, directed: !symmetric };
}

function allocateMemoryGraphDomainLimits(domainCounts, limit) {
  const active = domainCounts.filter((item) => item.count > 0);
  const allocation = new Map(active.map((item) => [item.domain, 0]));
  if (!active.length || limit <= 0) return allocation;
  const total = active.reduce((sum, item) => sum + item.count, 0);
  if (total <= limit) {
    for (const item of active) allocation.set(item.domain, item.count);
    return allocation;
  }

  const weightTotal = active.reduce((sum, item) => sum + Math.sqrt(item.count), 0);
  let allocated = 0;
  for (const item of active) {
    const share = Math.max(1, Math.floor(limit * Math.sqrt(item.count) / weightTotal));
    const quota = Math.min(item.count, share);
    allocation.set(item.domain, quota);
    allocated += quota;
  }

  const byCapacity = [...active].sort((a, b) => {
    const remainingA = a.count - (allocation.get(a.domain) || 0);
    const remainingB = b.count - (allocation.get(b.domain) || 0);
    return remainingB - remainingA;
  });
  while (allocated < limit) {
    let changed = false;
    for (const item of byCapacity) {
      const current = allocation.get(item.domain) || 0;
      if (current >= item.count) continue;
      allocation.set(item.domain, current + 1);
      allocated++;
      changed = true;
      if (allocated >= limit) break;
    }
    if (!changed) break;
  }
  return allocation;
}

function memoryLabel(record) {
  const content = compactText(record.content, 132);
  if (content) return content;
  const statement = [record.predicate, record.object].filter(Boolean).join(': ');
  return compactText(statement, 132) || `Память ${String(record.id).slice(0, 8)}`;
}

function personLabel(tags, personId) {
  const label = tagValue(tags, 'contact_name')
    || tagValue(tags, 'contact')
    || tagValue(tags, 'contact_alias')
    || tagValue(tags, 'contact_username');
  return compactText(label, 80) || `Человек ${String(personId).slice(0, 8)}`;
}

function normalizeRelation(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim();
  const domain = String(value.domain || '').trim().toLowerCase();
  if (!id || !domain) return null;
  return {
    id,
    domain,
    type: compactText(value.type || 'semantic', 40) || 'semantic',
    weight: clamp01(value.weight),
    cue: compactText(value.cue, 140) || undefined,
  };
}

function normalizeGraphRecord(record) {
  const tags = normalizeTags(record.tags);
  const domain = String(record.domain || 'general').trim().toLowerCase() || 'general';
  const id = String(record.id || '').trim();
  const relatedIds = Array.isArray(record.relatedIds)
    ? record.relatedIds.map(normalizeRelation).filter(Boolean)
    : [];
  const sourceMemoryIds = Array.isArray(record.sourceMemoryIds)
    ? [...new Set(record.sourceMemoryIds.map(String).map((value) => value.trim()).filter(Boolean))]
    : [];

  return {
    ...record,
    id,
    domain,
    tags,
    relatedIds,
    sourceMemoryIds,
    sourceEpisodeId: record.sourceEpisodeId ? String(record.sourceEpisodeId).trim() : '',
    confidence: clamp01(record.confidence, 0.6),
    importance: clamp01(record.importance, 0.5),
    strength: clamp01(record.strength, 0.5),
    memoryKind: String(record.memoryKind || 'fact'),
    status: String(record.status || 'active'),
    timestamp: record.timestamp || null,
    synthetic: Boolean(record.synthetic),
    isAnchor: Boolean(record.isAnchor),
  };
}

function isStaleGraphRecord(record, now = Date.now()) {
  if (record.tags.includes('possibly-stale') || record.tags.includes('sleep-softened') || record.status === 'unknown') {
    return true;
  }
  if (!record.timestamp) return false;
  const timestamp = new Date(record.timestamp).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  if (record.memoryKind === 'state' && age > 120 * 24 * 60 * 60 * 1000) return true;
  const openLoopKind = ['open_loop', 'goal', 'promise', 'prospective'].includes(record.memoryKind)
    || record.status === 'planned'
    || record.tags.includes('temporal_scope:future_plan');
  return openLoopKind && age > 60 * 24 * 60 * 60 * 1000;
}

function buildMemoryNode(record) {
  const flags = [];
  if (record.confidence < 0.55) flags.push('low_confidence');
  if (record.isAnchor) flags.push('anchor');
  if (record.synthetic) flags.push('synthetic');
  if (isStaleGraphRecord(record)) flags.push('stale');
  if (record.status === 'superseded' || record.status === 'expired') flags.push(record.status);
  if (!record.sourceEpisodeId && record.sourceMemoryIds.length === 0 && !record.sourceContext) flags.push('no_source');

  return {
    id: memoryNodeKey(record.domain, record.id),
    nodeType: 'memory',
    memoryId: record.id,
    label: memoryLabel(record),
    content: compactText(record.content),
    domain: record.domain,
    memoryKind: record.memoryKind,
    status: record.status,
    subject: record.subject ? String(record.subject) : undefined,
    predicate: compactText(record.predicate, 120) || undefined,
    object: compactText(record.object, 180) || undefined,
    confidence: record.confidence,
    importance: record.importance,
    strength: record.strength,
    isAnchor: record.isAnchor,
    synthetic: record.synthetic,
    timestamp: record.timestamp,
    sourceEpisodeId: record.sourceEpisodeId || undefined,
    tags: record.tags.slice(0, MAX_NODE_TAGS),
    flags,
  };
}

function buildMemoryGraph(inputRecords, options = {}) {
  const includeIdentityNodes = options.includeIdentityNodes !== false;
  const records = inputRecords.map(normalizeGraphRecord).filter((record) => record.id);
  const nodes = records.map(buildMemoryNode);
  const nodeByKey = new Map(nodes.map((node) => [node.id, node]));
  const keysByRawId = new Map();
  const episodeNodeBySourceId = new Map();

  for (const record of records) {
    const key = memoryNodeKey(record.domain, record.id);
    const current = keysByRawId.get(record.id) || [];
    current.push(key);
    keysByRawId.set(record.id, current);
    if (record.memoryKind === 'episode' && record.sourceEpisodeId) {
      episodeNodeBySourceId.set(record.sourceEpisodeId, key);
    }
  }

  const edgesById = new Map();
  let unresolvedRelations = 0;
  let unresolvedSources = 0;

  const addEdge = (edge, dedupeKey = edge.id) => {
    if (!nodeByKey.has(edge.source) || !nodeByKey.has(edge.target) || edge.source === edge.target) return;
    const existing = edgesById.get(dedupeKey);
    if (existing && existing.weight >= edge.weight) return;
    edgesById.set(dedupeKey, { ...edge, id: dedupeKey });
  };

  for (const record of records) {
    const source = memoryNodeKey(record.domain, record.id);
    for (const relation of record.relatedIds) {
      const target = memoryNodeKey(relation.domain, relation.id);
      if (!nodeByKey.has(target)) {
        unresolvedRelations++;
        continue;
      }
      const pair = [source, target].sort();
      const edgeId = `relation:${relation.type}:${pair[0]}:${pair[1]}`;
      addEdge({
        id: edgeId,
        source: pair[0],
        target: pair[1],
        kind: 'relation',
        relationType: relation.type,
        weight: relation.weight,
        cue: relation.cue,
        directed: false,
      });
    }

    for (const sourceMemoryId of record.sourceMemoryIds) {
      const candidates = keysByRawId.get(sourceMemoryId) || [];
      const target = candidates.length === 1 ? candidates[0] : candidates.find((key) => key !== source);
      if (!target) {
        unresolvedSources++;
        continue;
      }
      const edgeId = `derived:${target}:${source}`;
      addEdge({
        id: edgeId,
        source: target,
        target: source,
        kind: 'derived_from',
        relationType: 'source_memory',
        weight: 0.86,
        directed: true,
      });
    }

    if (record.sourceEpisodeId && record.memoryKind !== 'episode') {
      const episodeNode = episodeNodeBySourceId.get(record.sourceEpisodeId);
      if (episodeNode) {
        const edgeId = `episode:${episodeNode}:${source}`;
        addEdge({
          id: edgeId,
          source: episodeNode,
          target: source,
          kind: 'episode',
          relationType: 'same_episode',
          weight: 0.9,
          directed: true,
        });
      } else {
        unresolvedSources++;
      }
    }
  }

  if (includeIdentityNodes) {
    const personNodeById = new Map();
    const ensurePersonNode = (personId, label, timestamp, owner = false) => {
      const id = personNodeKey(personId);
      let personNode = personNodeById.get(id);
      if (!personNode) {
        personNode = {
          id,
          nodeType: 'person',
          personId,
          label: compactText(label, 80) || (owner ? 'Владелец' : `Человек ${String(personId).slice(0, 8)}`),
          content: owner
            ? 'Владелец памяти'
            : 'Каноническая личность, связанная с воспоминаниями',
          domain: 'contacts',
          memoryKind: 'person',
          status: 'active',
          confidence: 1,
          importance: owner ? 1 : 0.86,
          strength: 0.9,
          isAnchor: true,
          synthetic: true,
          timestamp,
          tags: [],
          flags: ['identity'],
        };
        personNodeById.set(id, personNode);
        nodeByKey.set(id, personNode);
        nodes.push(personNode);
      } else if (!owner && personNode.label.startsWith('Человек ') && label) {
        personNode.label = compactText(label, 80);
      }
      return personNode;
    };
    const linkIdentity = (personId, record, label, owner = false) => {
      const personNode = ensurePersonNode(personId, label, record.timestamp, owner);
      const memoryKey = memoryNodeKey(record.domain, record.id);
      const edgeId = `identity:${personNode.id}:${memoryKey}`;
      addEdge({
        id: edgeId,
        source: personNode.id,
        target: memoryKey,
        kind: 'identity',
        relationType: 'person_link',
        weight: 1,
        directed: false,
      });
      return personNode;
    };

    for (const record of records) {
      const personId = tagValue(record.tags, 'person_id');
      if (!personId) continue;
      linkIdentity(personId, record, personLabel(record.tags, personId));
    }

    for (const record of records) {
      if (!record.tags.includes('person_relation')) continue;
      const relationType = tagValue(record.tags, 'relation_type');
      const subjectRole = tagValue(record.tags, 'relation_subject');
      const subjectPersonId = tagValue(record.tags, 'relation_subject_person_id');
      const objectRole = tagValue(record.tags, 'relation_object');
      const objectPersonId = tagValue(record.tags, 'relation_object_person_id');
      const objectName = tagValue(record.tags, 'relation_object_name');
      const direction = tagValue(record.tags, 'relation_direction');

      const subjectNode = subjectRole === 'user'
        ? linkIdentity('user', record, 'Владелец', true)
        : subjectPersonId
          ? linkIdentity(subjectPersonId, record, personLabel(record.tags, subjectPersonId))
          : null;
      const objectNode = objectRole === 'user'
        ? linkIdentity('user', record, 'Владелец', true)
        : objectPersonId
          ? linkIdentity(objectPersonId, record, objectName)
          : null;
      if (!subjectNode || !objectNode || !relationType) {
        unresolvedRelations++;
        continue;
      }

      const relation = canonicalPersonRelation(
        relationType,
        subjectNode.id,
        objectNode.id,
        direction,
      );
      const edgeId = `person-relation:${relation.relationType}:${relation.source}:${relation.target}`;
      addEdge({
        id: edgeId,
        source: relation.source,
        target: relation.target,
        kind: 'person_relation',
        relationType: relation.relationType,
        weight: Math.max(0.45, record.confidence),
        cue: compactText(record.content, 140) || undefined,
        directed: relation.directed,
      });
    }
  }

  const edges = [...edgesById.values()];
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) || 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) || 0) + 1);
  }
  let isolatedMemoryNodes = 0;
  for (const node of nodes) {
    node.degree = degree.get(node.id) || 0;
    if (node.nodeType === 'memory' && node.degree === 0) {
      isolatedMemoryNodes++;
      node.flags.push('isolated');
    }
  }

  const edgeCounts = {};
  for (const edge of edges) edgeCounts[edge.kind] = (edgeCounts[edge.kind] || 0) + 1;

  return {
    nodes,
    edges,
    stats: {
      memoryNodes: records.length,
      virtualNodes: nodes.length - records.length,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      isolatedMemoryNodes,
      unresolvedRelations,
      unresolvedSources,
      edgeCounts,
      truncated: Boolean(options.truncated),
    },
  };
}

module.exports = {
  allocateMemoryGraphDomainLimits,
  buildMemoryGraph,
  compactText,
  memoryNodeKey,
};
