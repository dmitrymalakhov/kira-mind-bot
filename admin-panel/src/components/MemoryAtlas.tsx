import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import Sigma from 'sigma';
import { fetchMemoryGraph } from '../api';
import type {
  MemoryGraphEdge,
  MemoryGraphEdgeKind,
  MemoryGraphNode,
  MemoryGraphResponse,
  MemoryQuery,
} from '../types';

interface AtlasNodeAttributes {
  x: number;
  y: number;
  size: number;
  label: string;
  color: string;
  zIndex: number;
  atlasNode: MemoryGraphNode;
  [key: string]: unknown;
}

interface AtlasEdgeAttributes {
  size: number;
  color: string;
  weight: number;
  kind: MemoryGraphEdgeKind;
  atlasEdge: MemoryGraphEdge;
  [key: string]: unknown;
}

type AtlasGraph = Graph<AtlasNodeAttributes, AtlasEdgeAttributes>;
type AtlasRenderer = Sigma<AtlasNodeAttributes, AtlasEdgeAttributes>;

const DOMAIN_COLORS: Record<string, string> = {
  work: '#2563EB',
  health: '#10B981',
  family: '#F97316',
  finance: '#EAB308',
  education: '#8B5CF6',
  hobbies: '#EC4899',
  travel: '#06B6D4',
  social: '#0EA5E9',
  home: '#84CC16',
  personal: '#A855F7',
  entertainment: '#F43F5E',
  general: '#64748B',
  contacts: '#D946EF',
};

const DOMAIN_LABELS: Record<string, string> = {
  work: 'Работа',
  health: 'Здоровье',
  family: 'Семья',
  finance: 'Финансы',
  education: 'Образование',
  hobbies: 'Хобби',
  travel: 'Путешествия',
  social: 'Общение',
  home: 'Дом',
  personal: 'Личное',
  entertainment: 'Развлечения',
  general: 'Общее',
  contacts: 'Контакты',
};

const EDGE_COLORS: Record<MemoryGraphEdgeKind, string> = {
  relation: '#94A3B8',
  derived_from: '#8B5CF6',
  episode: '#06B6D4',
  identity: '#D946EF',
  person_relation: '#F97316',
};

const EDGE_LABELS: Record<MemoryGraphEdgeKind, string> = {
  relation: 'Связи памяти',
  derived_from: 'Источники',
  episode: 'Эпизоды',
  identity: 'Личности',
  person_relation: 'Отношения людей',
};

const PERSON_RELATION_LABELS: Record<string, string> = {
  spouse_of: 'супруг(а)',
  partner_of: 'партнёр',
  ex_partner_of: 'бывший партнёр',
  parent_of: 'родитель',
  sibling_of: 'брат / сестра',
  relative_of: 'родственник',
  friend_of: 'друг',
  coworker_of: 'коллега',
  works_with: 'работают вместе',
  manager_of: 'руководитель',
  client_of: 'клиент',
  studies_with: 'учатся вместе',
  lives_with: 'живут вместе',
  neighbor_of: 'сосед',
  knows: 'знакомы',
  introduced_by: 'познакомились через',
};

function relationLabel(edge: MemoryGraphEdge): string {
  return edge.kind === 'person_relation'
    ? PERSON_RELATION_LABELS[edge.relationType] ?? edge.relationType
    : edge.relationType;
}

const FLAG_LABELS: Record<string, string> = {
  anchor: 'Якорь',
  identity: 'Личность',
  isolated: 'Изолировано в графе',
  low_confidence: 'Низкая уверенность',
  no_source: 'Без источника',
  stale: 'Возможно устарело',
  synthetic: 'Синтетическое',
  superseded: 'Заменено',
  expired: 'Истекло',
};

const GRAPH_LIMITS = [1000, 3000, 6000, 10000];
const ALL_EDGE_KINDS = Object.keys(EDGE_LABELS) as MemoryGraphEdgeKind[];

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initialPosition(node: MemoryGraphNode, domainIndex: number, domainCount: number) {
  const seed = hashString(node.id);
  const clusterAngle = (Math.PI * 2 * domainIndex) / Math.max(1, domainCount);
  const clusterRadius = domainCount > 1 ? 38 : 0;
  const localAngle = (seed % 3600) / 3600 * Math.PI * 2;
  const localRadius = 2 + Math.sqrt((seed >>> 8) % 1000) / Math.sqrt(1000) * 12;
  return {
    x: Math.cos(clusterAngle) * clusterRadius + Math.cos(localAngle) * localRadius,
    y: Math.sin(clusterAngle) * clusterRadius + Math.sin(localAngle) * localRadius,
  };
}

function nodeColor(node: MemoryGraphNode) {
  if (node.nodeType === 'person') return '#D946EF';
  if (node.status === 'superseded' || node.status === 'expired') return '#94A3B8';
  return DOMAIN_COLORS[node.domain] || DOMAIN_COLORS.general;
}

function nodeSize(node: MemoryGraphNode) {
  if (node.nodeType === 'person') return 10;
  const degreeBoost = Math.min(4.5, Math.log2(node.degree + 1) * 1.25);
  return 3.2 + node.importance * 3.5 + node.strength * 2 + degreeBoost + (node.isAnchor ? 2.2 : 0);
}

function createAtlasGraph(data: MemoryGraphResponse) {
  const graph: AtlasGraph = new Graph({ type: 'mixed', multi: true, allowSelfLoops: false });
  const domains = [...new Set(data.nodes.map((node) => node.domain))].sort();
  const domainIndex = new Map(domains.map((domain, index) => [domain, index]));

  for (const node of data.nodes) {
    const position = initialPosition(node, domainIndex.get(node.domain) || 0, domains.length);
    graph.addNode(node.id, {
      ...position,
      label: node.label,
      size: nodeSize(node),
      color: nodeColor(node),
      zIndex: node.isAnchor || node.nodeType === 'person' ? 2 : 1,
      atlasNode: node,
    });
  }

  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    const attributes: AtlasEdgeAttributes = {
      size: 0.35 + edge.weight * 1.25,
      color: EDGE_COLORS[edge.kind],
      weight: Math.max(0.05, edge.weight),
      kind: edge.kind,
      atlasEdge: edge,
    };
    if (edge.directed) graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, attributes);
    else graph.addUndirectedEdgeWithKey(edge.id, edge.source, edge.target, attributes);
  }

  return graph;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDateTime(value: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface NodeLink {
  edge: MemoryGraphEdge;
  neighbor: MemoryGraphNode;
}

function NodeDetails({
  node,
  links,
  onSelect,
}: {
  node: MemoryGraphNode | null;
  links: NodeLink[];
  onSelect: (nodeId: string) => void;
}) {
  if (!node) {
    return (
      <Box sx={{ p: 2.25 }}>
        <Typography variant="subtitle2" fontWeight={700}>Навигация по атласу</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, lineHeight: 1.55 }}>
          Наведите курсор на узел, чтобы подсветить его соседей. Нажмите на узел, чтобы закрепить выбор и увидеть детали.
        </Typography>
        <Divider sx={{ my: 2 }} />
        <Typography variant="caption" color="text.disabled">
          Размер узла учитывает важность, силу и количество связей. Цвет показывает домен, серый цвет — заменённую или истёкшую память.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2.25, overflow: 'auto', height: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: nodeColor(node), flex: '0 0 auto' }} />
        <Typography variant="overline" color="text.secondary">
          {node.nodeType === 'person' ? 'Личность' : DOMAIN_LABELS[node.domain] || node.domain}
        </Typography>
      </Box>
      <Typography variant="subtitle2" fontWeight={700} sx={{ lineHeight: 1.45 }}>
        {node.label}
      </Typography>
      {node.content && node.content !== node.label && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
          {node.content}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap', mt: 1.5 }}>
        <Chip size="small" variant="outlined" label={node.memoryKind} />
        <Chip size="small" variant="outlined" label={node.status} />
        <Chip size="small" variant="outlined" label={`Связей: ${node.degree}`} />
      </Box>
      {node.flags.length > 0 && (
        <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap', mt: 1 }}>
          {node.flags.map((flag) => (
            <Chip
              key={flag}
              size="small"
              color={flag === 'low_confidence' || flag === 'isolated' ? 'warning' : 'default'}
              label={FLAG_LABELS[flag] || flag}
              sx={{ fontSize: '11px' }}
            />
          ))}
        </Box>
      )}
      <Divider sx={{ my: 2 }} />
      <Box sx={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 0.75, fontSize: 13 }}>
        <Typography variant="caption" color="text.disabled">Уверенность</Typography>
        <Typography variant="caption">{percent(node.confidence)}</Typography>
        <Typography variant="caption" color="text.disabled">Важность</Typography>
        <Typography variant="caption">{percent(node.importance)}</Typography>
        <Typography variant="caption" color="text.disabled">Сила</Typography>
        <Typography variant="caption">{percent(node.strength)}</Typography>
        <Typography variant="caption" color="text.disabled">Дата</Typography>
        <Typography variant="caption">{formatDateTime(node.timestamp)}</Typography>
        {node.subject && (
          <>
            <Typography variant="caption" color="text.disabled">Субъект</Typography>
            <Typography variant="caption">{node.subject}</Typography>
          </>
        )}
      </Box>
      {node.tags.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.disabled">Теги</Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.75 }}>
            {node.tags.map((tag) => <Chip key={tag} size="small" variant="outlined" label={tag} sx={{ fontSize: '10px' }} />)}
          </Box>
        </>
      )}
      {links.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="caption" color="text.disabled">Ближайшие связи</Typography>
          <Box sx={{ display: 'grid', gap: 0.6, mt: 0.75 }}>
            {links.slice(0, 12).map(({ edge, neighbor }) => (
              <Button
                key={edge.id}
                size="small"
                variant="text"
                onClick={() => onSelect(neighbor.id)}
                sx={{
                  justifyContent: 'flex-start',
                  textAlign: 'left',
                  textTransform: 'none',
                  minWidth: 0,
                  px: 0.75,
                  color: 'text.primary',
                }}
              >
                <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: EDGE_COLORS[edge.kind], mr: 0.8, flex: '0 0 auto' }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="caption" display="block" noWrap>{neighbor.label}</Typography>
                  <Typography variant="caption" color="text.disabled" display="block" noWrap>
                    {EDGE_LABELS[edge.kind]} · {relationLabel(edge)} · {percent(edge.weight)}
                  </Typography>
                </Box>
              </Button>
            ))}
          </Box>
        </>
      )}
      {node.memoryId && (
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 2, wordBreak: 'break-all' }}>
          ID: {node.memoryId}
        </Typography>
      )}
    </Box>
  );
}

export function MemoryAtlas({ query, refreshToken = 0 }: { query: MemoryQuery; refreshToken?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<AtlasGraph | null>(null);
  const rendererRef = useRef<AtlasRenderer | null>(null);
  const layoutRef = useRef<FA2Layout<AtlasNodeAttributes, AtlasEdgeAttributes> | null>(null);
  const layoutTimerRef = useRef<number | null>(null);
  const focusNodeRef = useRef<string | null>(null);
  const selectedNodeRef = useRef<string | null>(null);
  const neighborSetRef = useRef<Set<string>>(new Set());
  const neighborLabelSetRef = useRef<Set<string>>(new Set());
  const visibleEdgeKindsRef = useRef<Set<MemoryGraphEdgeKind>>(new Set(ALL_EDGE_KINDS));
  const [data, setData] = useState<MemoryGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [renderError, setRenderError] = useState('');
  const [nodeLimit, setNodeLimit] = useState(3000);
  const [includeIdentityNodes, setIncludeIdentityNodes] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [visibleEdgeKinds, setVisibleEdgeKinds] = useState<Set<MemoryGraphEdgeKind>>(() => new Set(ALL_EDGE_KINDS));

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const { limit: _listLimit, offset: _offset, ...filters } = query;
    fetchMemoryGraph({
      ...filters,
      limit: nodeLimit,
      includeIdentityNodes,
    }, controller.signal)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setSelectedNodeId(null);
        selectedNodeRef.current = null;
      })
      .catch((reason) => {
        if (!cancelled && !(reason instanceof Error && reason.name === 'AbortError')) {
          setError(reason instanceof Error ? reason.message : 'Не удалось загрузить граф памяти');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [includeIdentityNodes, nodeLimit, query, refreshToken, reloadToken]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !data || data.nodes.length === 0) return undefined;
    setRenderError('');
    const graph = createAtlasGraph(data);
    graphRef.current = graph;
    let renderer: AtlasRenderer;
    try {
      renderer = new Sigma(graph, container, {
        allowInvalidContainer: true,
        defaultNodeColor: DOMAIN_COLORS.general,
        defaultEdgeColor: EDGE_COLORS.relation,
        enableEdgeEvents: false,
        hideEdgesOnMove: true,
        hideLabelsOnMove: true,
        labelDensity: graph.order > 5000 ? 0.24 : 0.55,
        labelGridCellSize: graph.order > 5000 ? 160 : 120,
        labelRenderedSizeThreshold: graph.order > 5000 ? 10 : 8,
        maxCameraRatio: 12,
        minCameraRatio: 0.05,
        renderEdgeLabels: false,
        labelColor: { color: '#DCE8F8' },
        stagePadding: 36,
        zIndex: true,
        nodeReducer: (node, attributes) => {
          const focused = focusNodeRef.current;
          if (!focused) return attributes;
          if (node === focused) {
            return { ...attributes, highlighted: true, forceLabel: true, zIndex: 4 };
          }
          if (neighborSetRef.current.has(node)) {
            return { ...attributes, forceLabel: neighborLabelSetRef.current.has(node), zIndex: 3 };
          }
          return { ...attributes, color: '#263552', label: '', zIndex: 0 };
        },
        edgeReducer: (edge, attributes) => {
          if (!visibleEdgeKindsRef.current.has(attributes.kind)) return { ...attributes, hidden: true };
          const focused = focusNodeRef.current;
          if (!focused) return attributes;
          const [source, target] = graph.extremities(edge);
          if (source === focused || target === focused) {
            return { ...attributes, color: EDGE_COLORS[attributes.kind], size: Math.max(1.3, attributes.size) };
          }
          return { ...attributes, color: '#1E293B', size: 0.2 };
        },
      });
    } catch (reason) {
      setRenderError(reason instanceof Error ? reason.message : 'WebGL недоступен');
      graphRef.current = null;
      return undefined;
    }
    rendererRef.current = renderer;
    let refreshFrame: number | null = null;

    const scheduleFocusRefresh = () => {
      if (refreshFrame !== null) return;
      refreshFrame = window.requestAnimationFrame(() => {
        refreshFrame = null;
        renderer.refresh();
      });
    };

    const setFocus = (node: string | null) => {
      if (focusNodeRef.current === node) return;
      focusNodeRef.current = node;
      const neighbors = node ? graph.neighbors(node) : [];
      neighborSetRef.current = new Set(neighbors);
      neighborLabelSetRef.current = new Set(neighbors.slice(0, 40));
      scheduleFocusRefresh();
    };
    renderer.on('enterNode', ({ node }) => setFocus(node));
    renderer.on('leaveNode', () => setFocus(selectedNodeRef.current));
    renderer.on('clickNode', ({ node }) => {
      setSelectedNodeId(node);
      selectedNodeRef.current = node;
      setFocus(node);
    });
    renderer.on('clickStage', () => {
      setSelectedNodeId(null);
      selectedNodeRef.current = null;
      setFocus(null);
    });

    let layout: FA2Layout<AtlasNodeAttributes, AtlasEdgeAttributes> | null = null;
    setLayoutRunning(false);
    if (graph.order > 1 && graph.size > 0) {
      const settings = forceAtlas2.inferSettings(graph);
      layout = new FA2Layout(graph, {
        settings: {
          ...settings,
          barnesHutOptimize: graph.order > 250,
          barnesHutTheta: 0.6,
          edgeWeightInfluence: 0.7,
          gravity: graph.order > 5000 ? 1.8 : 1.25,
          scalingRatio: graph.order > 5000 ? 14 : 10,
          slowDown: graph.order > 5000 ? 12 : 7,
          strongGravityMode: false,
        },
        getEdgeWeight: 'weight',
      });
      layoutRef.current = layout;
      layout.start();
      setLayoutRunning(true);
      const duration = graph.order > 6000 ? 6500 : graph.order > 2000 ? 5000 : 3500;
      layoutTimerRef.current = window.setTimeout(() => {
        layout?.stop();
        setLayoutRunning(false);
        layoutTimerRef.current = null;
      }, duration);
    } else {
      layoutRef.current = null;
    }

    return () => {
      if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
      if (refreshFrame !== null) window.cancelAnimationFrame(refreshFrame);
      layoutTimerRef.current = null;
      layout?.kill();
      renderer.kill();
      layoutRef.current = null;
      rendererRef.current = null;
      graphRef.current = null;
      focusNodeRef.current = null;
      selectedNodeRef.current = null;
      neighborSetRef.current = new Set();
      neighborLabelSetRef.current = new Set();
    };
  }, [data]);

  const selectedNode = useMemo(
    () => data?.nodes.find((node) => node.id === selectedNodeId) || null,
    [data, selectedNodeId],
  );

  const selectedLinks = useMemo<NodeLink[]>(() => {
    if (!data || !selectedNodeId) return [];
    const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
    return data.edges
      .filter((edge) => edge.source === selectedNodeId || edge.target === selectedNodeId)
      .map((edge) => ({
        edge,
        neighbor: nodesById.get(edge.source === selectedNodeId ? edge.target : edge.source),
      }))
      .filter((link): link is NodeLink => Boolean(link.neighbor))
      .sort((a, b) => b.edge.weight - a.edge.weight);
  }, [data, selectedNodeId]);

  const selectLinkedNode = (nodeId: string) => {
    const graph = graphRef.current;
    const renderer = rendererRef.current;
    if (!graph || !renderer || !graph.hasNode(nodeId)) return;
    selectedNodeRef.current = nodeId;
    focusNodeRef.current = nodeId;
    setSelectedNodeId(nodeId);
    const neighbors = graph.neighbors(nodeId);
    neighborSetRef.current = new Set(neighbors);
    neighborLabelSetRef.current = new Set(neighbors.slice(0, 40));
    renderer.scheduleRefresh();
    const display = renderer.getNodeDisplayData(nodeId);
    if (display) {
      renderer.getCamera().animate({ x: display.x, y: display.y, ratio: Math.min(renderer.getCamera().ratio, 0.75) }, { duration: 300 });
    }
  };

  const visibleDomains = useMemo(() => {
    if (!data) return [];
    const counts = new Map<string, number>();
    for (const node of data.nodes) {
      if (node.nodeType !== 'memory') continue;
      counts.set(node.domain, (counts.get(node.domain) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9);
  }, [data]);

  const toggleEdgeKind = (kind: MemoryGraphEdgeKind) => {
    const next = new Set(visibleEdgeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setVisibleEdgeKinds(next);
    visibleEdgeKindsRef.current = next;
    rendererRef.current?.scheduleRefresh();
  };

  const toggleLayout = () => {
    const layout = layoutRef.current;
    if (!layout) return;
    if (layout.isRunning()) {
      layout.stop();
      if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = null;
      setLayoutRunning(false);
    } else {
      layout.start();
      setLayoutRunning(true);
      if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
      layoutTimerRef.current = window.setTimeout(() => {
        layout.stop();
        setLayoutRunning(false);
        layoutTimerRef.current = null;
      }, 4500);
    }
  };

  return (
    <Box>
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderRadius: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <HubOutlinedIcon color="primary" fontSize="small" />
          <Typography variant="subtitle2" fontWeight={700}>Memory Atlas</Typography>
          {data && (
            <>
              <Chip size="small" label={`${data.stats.totalNodes.toLocaleString('ru-RU')} узлов`} />
              <Chip size="small" label={`${data.stats.totalEdges.toLocaleString('ru-RU')} связей`} />
              <Chip
                size="small"
                color={data.stats.isolatedMemoryNodes ? 'warning' : 'default'}
                label={`изолировано: ${data.stats.isolatedMemoryNodes}`}
              />
              <Chip
                size="small"
                color={data.stats.unresolvedRelations + data.stats.unresolvedSources ? 'warning' : 'default'}
                label={`вне графа: ${data.stats.unresolvedRelations + data.stats.unresolvedSources}`}
              />
            </>
          )}
          <Box sx={{ flex: 1 }} />
          <TextField
            select
            size="small"
            label="Воспоминаний"
            value={nodeLimit}
            onChange={(event) => setNodeLimit(Number(event.target.value))}
            sx={{ width: 112 }}
          >
            {GRAPH_LIMITS.map((limit) => <MenuItem key={limit} value={limit}>{limit.toLocaleString('ru-RU')}</MenuItem>)}
          </TextField>
          <FormControlLabel
            sx={{ m: 0 }}
            control={(
              <Switch
                size="small"
                checked={includeIdentityNodes}
                onChange={(event) => setIncludeIdentityNodes(event.target.checked)}
              />
            )}
            label={<Typography variant="caption">Личности</Typography>}
          />
          <Tooltip title={layoutRunning ? 'Остановить раскладку' : 'Продолжить раскладку'}>
            <span>
              <Button size="small" variant="outlined" onClick={toggleLayout} disabled={!data?.edges.length}>
                {layoutRunning ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Вписать граф">
            <span>
              <Button
                size="small"
                variant="outlined"
                onClick={() => rendererRef.current?.getCamera().animatedReset({ duration: 350 })}
                disabled={!data?.nodes.length}
              >
                <CenterFocusStrongIcon fontSize="small" />
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Перезагрузить данные">
            <span>
              <Button size="small" variant="outlined" onClick={() => setReloadToken((value) => value + 1)} disabled={loading}>
                <RefreshIcon fontSize="small" />
              </Button>
            </span>
          </Tooltip>
        </Box>

        {data && (
          <Box sx={{ display: 'flex', gap: 0.7, alignItems: 'center', flexWrap: 'wrap', mt: 1.25 }}>
            {ALL_EDGE_KINDS.map((kind) => (
              <Chip
                key={kind}
                size="small"
                clickable
                variant={visibleEdgeKinds.has(kind) ? 'filled' : 'outlined'}
                label={`${EDGE_LABELS[kind]}: ${data.stats.edgeCounts[kind] || 0}`}
                onClick={() => toggleEdgeKind(kind)}
                sx={{
                  fontSize: '11px',
                  bgcolor: visibleEdgeKinds.has(kind) ? EDGE_COLORS[kind] : undefined,
                  color: visibleEdgeKinds.has(kind) ? '#fff' : undefined,
                  '&:hover': { bgcolor: visibleEdgeKinds.has(kind) ? EDGE_COLORS[kind] : undefined },
                }}
              />
            ))}
            <Divider orientation="vertical" flexItem sx={{ mx: 0.3 }} />
            {visibleDomains.map(([domain, count]) => (
              <Box key={domain} sx={{ display: 'flex', alignItems: 'center', gap: 0.4 }}>
                <Box sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: DOMAIN_COLORS[domain] || DOMAIN_COLORS.general }} />
                <Typography variant="caption" color="text.secondary">
                  {DOMAIN_LABELS[domain] || domain} {count}
                </Typography>
              </Box>
            ))}
          </Box>
        )}
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}
      {renderError && <Alert severity="error" sx={{ mb: 1.5 }}>Не удалось запустить WebGL: {renderError}</Alert>}
      {data?.stats.truncated && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          Показано {data.stats.memoryNodes.toLocaleString('ru-RU')} воспоминаний; просмотрено {data.stats.scannedMemoryNodes.toLocaleString('ru-RU')} из {data.stats.availableMemoryNodes.toLocaleString('ru-RU')} доступных записей. Увеличьте лимит для более полного атласа.
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 320px' },
          minHeight: { xs: 560, md: 660 },
          overflow: 'hidden',
          borderRadius: 1,
          bgcolor: '#08111F',
        }}
      >
        <Box sx={{ position: 'relative', minHeight: { xs: 560, md: 660 }, overflow: 'hidden' }}>
          <Box ref={containerRef} sx={{ position: 'absolute', inset: 0 }} aria-label="WebGL-граф памяти" />
          {loading && (
            <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', bgcolor: 'rgba(8,17,31,0.86)', zIndex: 5 }}>
              <Box sx={{ textAlign: 'center' }}>
                <CircularProgress size={34} />
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                  Собираем атлас памяти…
                </Typography>
              </Box>
            </Box>
          )}
          {!loading && data?.nodes.length === 0 && (
            <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 3 }}>
              <Alert severity="info">Для выбранных фильтров нет узлов.</Alert>
            </Box>
          )}
          {!loading && data && data.nodes.length > 0 && (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ position: 'absolute', left: 12, bottom: 8, pointerEvents: 'none' }}
            >
              WebGL · ForceAtlas2 Worker {layoutRunning ? '· раскладка считается' : '· раскладка остановлена'}
            </Typography>
          )}
        </Box>
        <Box sx={{ borderLeft: { lg: '1px solid' }, borderTop: { xs: '1px solid', lg: 'none' }, borderColor: 'divider', bgcolor: 'background.paper', minHeight: 0 }}>
          <NodeDetails node={selectedNode} links={selectedLinks} onSelect={selectLinkedNode} />
        </Box>
      </Paper>
    </Box>
  );
}
