import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  MenuItem,
  useMediaQuery,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import FocusTrap from '@mui/material/Unstable_TrapFocus';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FullscreenExitIcon from '@mui/icons-material/FullscreenExit';
import { EdgeArrowProgram, EdgeLineProgram } from 'sigma/rendering';
import { deriveAtlasView } from '../memoryAtlasView';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import { atlasNodeLabel, findAtlasNodes } from '../memoryAtlasPresentation';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrong';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';
import Sigma from 'sigma';
import { fetchMemoryGraph, fetchMemoryRecord } from '../api';
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
      label: atlasNodeLabel(node),
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
      type: edge.directed ? 'arrow' : 'line',
      kind: edge.kind,
      atlasEdge: edge,
    };
    if (edge.directed) graph.addDirectedEdgeWithKey(edge.id, edge.source, edge.target, attributes);
    else graph.addUndirectedEdgeWithKey(edge.id, edge.source, edge.target, attributes);
  }

  return graph;
}

function visibleNeighbors(graph: AtlasGraph, node: string, kinds: Set<MemoryGraphEdgeKind>, visibleEdges?: Set<string>) {
  const neighbors = new Set<string>();
  graph.forEachEdge(node, (edge, attributes, source, target) => {
    if ((!visibleEdges || visibleEdges.has(edge)) && kinds.has(attributes.kind)) neighbors.add(source === node ? target : source);
  });
  return [...neighbors].sort((a, b) => graph.degree(b) - graph.degree(a));
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
  fullContent, detailLoading, detailError, visibleDegree,
}: {
  visibleDegree?: number;
  fullContent?: string;
  detailLoading?: boolean;
  detailError?: boolean;
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
    <Box sx={{ p: 2.25, overflowWrap: 'anywhere' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: nodeColor(node), flex: '0 0 auto' }} />
        <Typography variant="overline" color="text.secondary">
          {node.nodeType === 'person' ? 'Личность' : DOMAIN_LABELS[node.domain] || node.domain}
        </Typography>
      </Box>
      <Typography variant="subtitle2" fontWeight={700} sx={{ lineHeight: 1.45 }}>
        {node.nodeType === 'person' ? node.label : 'Воспоминание'}
      </Typography>
      {node.nodeType !== 'person' && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1.25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.7 }}>
          {fullContent ?? (node.content || node.label)}
        </Typography>
      )}
      {detailLoading && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Загружаем полный текст…</Typography>}
      {detailError && <Alert severity="warning" sx={{ mt: 1 }}>Не удалось загрузить полный текст. Показан сокращённый фрагмент.</Alert>}
      <Box sx={{ display: 'flex', gap: 0.6, flexWrap: 'wrap', mt: 1.5 }}>
        <Chip size="small" variant="outlined" label={node.memoryKind} />
        <Chip size="small" variant="outlined" label={node.status} />
        <Chip size="small" variant="outlined" label={`Связей по фильтрам: ${visibleDegree ?? node.degree}`} />
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
                  <Typography variant="body2" sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{neighbor.label}</Typography>
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
  const atlasRootRef = useRef<HTMLDivElement | null>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement | null>(null);
  const flowCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pathPositionsRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  const viewRef = useRef<ReturnType<typeof deriveAtlasView> | null>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [fullscreen, setFullscreen] = useState(false);
  const [flowEnabled, setFlowEnabled] = useState(true);
  const [domains, setDomains] = useState<Set<string>>(() => new Set());
  const [personId, setPersonId] = useState<string | null>(null);
  const [depth, setDepth] = useState<1 | 2 | 3>(2);
  const [showIsolated, setShowIsolated] = useState(true);
  const [pathSourceId, setPathSourceId] = useState<string | null>(null);
  const [pathTargetId, setPathTargetId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const detailsRef = useRef<HTMLDivElement | null>(null);
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
  const [nodeSearch, setNodeSearch] = useState('');
  const [detail, setDetail] = useState<{ nodeId: string; content?: string; loading?: boolean; error?: boolean } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [visibleEdgeKinds, setVisibleEdgeKinds] = useState<Set<MemoryGraphEdgeKind>>(() => new Set(ALL_EDGE_KINDS));

  const view = useMemo(() => deriveAtlasView(data?.nodes || [], data?.edges || [], {
    domains, edgeKinds: visibleEdgeKinds, personId, depth, showIsolated,
    pathSourceId, pathTargetId,
  }), [data, domains, visibleEdgeKinds, personId, depth, showIsolated, pathSourceId, pathTargetId]);
  viewRef.current = view;

  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; atlasRootRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setFullscreen(false); } };
    document.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', escape); fullscreenButtonRef.current?.focus(); };
  }, [fullscreen]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => { rendererRef.current?.resize(); rendererRef.current?.scheduleRefresh(); });
    return () => window.cancelAnimationFrame(frame);
  }, [fullscreen]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setSelectedNodeId(null); setPersonId(null); setPathSourceId(null); setPathTargetId(null);
    selectedNodeRef.current = null;
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
      renderer = new Sigma<AtlasNodeAttributes, AtlasEdgeAttributes>(graph, container, {
        allowInvalidContainer: true,
        defaultNodeColor: DOMAIN_COLORS.general,
        defaultEdgeColor: EDGE_COLORS.relation,
        edgeProgramClasses: { line: EdgeLineProgram, arrow: EdgeArrowProgram },
        enableEdgeEvents: false,
        hideEdgesOnMove: true,
        hideLabelsOnMove: true,
        labelDensity: 0.12,
        labelSize: 12,
        labelGridCellSize: graph.order > 5000 ? 160 : 120,
        labelRenderedSizeThreshold: graph.order > 5000 ? 10 : 8,
        maxCameraRatio: 12,
        minCameraRatio: 0.05,
        renderEdgeLabels: false,
        labelColor: { color: '#DCE8F8' },
        defaultDrawNodeLabel: (context, node, settings) => {
          if (!node.label) return;
          context.save(); context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
          const left = node.x > context.canvas.clientWidth * 0.65;
          context.textAlign = left ? 'right' : 'left'; context.textBaseline = 'middle'; context.fillStyle = '#DCE8F8';
          context.fillText(node.label, node.x + (left ? -1 : 1) * (node.size + 6), node.y);
          context.restore();
        },
        defaultDrawNodeHover: (context, node, settings) => {
          context.save();
          context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
          const label = node.label || '', x = node.x + node.size + 7;
          context.fillStyle = '#142238';
          context.fillRect(x - 4, node.y - settings.labelSize, context.measureText(label).width + 8, settings.labelSize + 8);
          context.fillStyle = '#F1F5F9';
          context.fillText(label, x, node.y + settings.labelSize / 3);
          context.beginPath(); context.arc(node.x, node.y, node.size + 2, 0, Math.PI * 2);
          context.strokeStyle = '#E2E8F0'; context.lineWidth = 2; context.stroke();
          context.restore();
        },
        stagePadding: 36,
        zIndex: true,
        nodeReducer: (node, attributes) => {
          if (viewRef.current && !viewRef.current.nodeIds.has(node)) return { ...attributes, hidden: true };
          const path = viewRef.current?.path;
          if (path) return { ...attributes, highlighted: node === selectedNodeRef.current, label: atlasNodeLabel(attributes.atlasNode, 32),
            forceLabel: path.nodes.length <= 8 || node === path.nodes[0] || node === path.nodes[path.nodes.length - 1], zIndex: 3 };
          const focused = selectedNodeRef.current || focusNodeRef.current;
          if (!focused) return { ...attributes, label: attributes.atlasNode.nodeType === 'person' ? attributes.label : '' };
          if (node === focused) {
            return { ...attributes, highlighted: true, forceLabel: true, zIndex: 4 };
          }
          if (neighborSetRef.current.has(node)) {
            return { ...attributes, label: neighborLabelSetRef.current.has(node) ? attributes.label : '', forceLabel: false, zIndex: 3 };
          }
          return { ...attributes, color: '#17243A', label: '', size: 2, zIndex: 0 };
        },
        edgeReducer: (edge, attributes) => {
          if (viewRef.current && !viewRef.current.edgeIds.has(edge)) return { ...attributes, hidden: true };
          const focused = selectedNodeRef.current || focusNodeRef.current;
          const [source, target] = graph.extremities(edge);
          if (viewRef.current?.path || focused && (source === focused || target === focused)) {
            return { ...attributes, color: EDGE_COLORS[attributes.kind], size: Math.max(1.8, attributes.size) };
          }
          return { ...attributes, size: Math.max(0.5, attributes.size * 0.65) };
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
      const neighbors = node ? visibleNeighbors(graph, node, visibleEdgeKindsRef.current, viewRef.current?.edgeIds) : [];
      neighborSetRef.current = new Set(neighbors);
      neighborLabelSetRef.current = new Set(neighbors.slice(0, 8));
      scheduleFocusRefresh();
    };
    renderer.on('enterNode', ({ node }) => { if (!selectedNodeRef.current) setFocus(node); });
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
      pathPositionsRef.current = null;
      focusNodeRef.current = null;
      selectedNodeRef.current = null;
      neighborSetRef.current = new Set();
      neighborLabelSetRef.current = new Set();
    };
  }, [data]);

  useEffect(() => {
    const renderer = rendererRef.current, graph = graphRef.current;
    if (!renderer || !graph) return;
    const selected = selectedNodeRef.current;
    if (selected && !view.nodeIds.has(selected) && !pathTargetId) {
      selectedNodeRef.current = null; focusNodeRef.current = null; setSelectedNodeId(null);
    }
    const focused = selectedNodeRef.current || focusNodeRef.current;
    const neighbors = focused && graph.hasNode(focused) ? visibleNeighbors(graph, focused, visibleEdgeKindsRef.current, view.edgeIds) : [];
    neighborSetRef.current = new Set(neighbors); neighborLabelSetRef.current = new Set(neighbors.slice(0, 8));
    renderer.refresh();
  }, [view, pathTargetId]);

  useEffect(() => {
    const renderer = rendererRef.current, graph = graphRef.current; if (!renderer || !graph) return;
    const filtered = domains.size || personId || pathTargetId || visibleEdgeKinds.size !== ALL_EDGE_KINDS.length || !showIsolated;
    if (filtered) {
      layoutRef.current?.stop(); setLayoutRunning(false);
      if (layoutTimerRef.current !== null) { window.clearTimeout(layoutTimerRef.current); layoutTimerRef.current = null; }
    }
    const path = viewRef.current?.path;
    if (path && !pathPositionsRef.current) {
      const positions = new Map<string, { x: number; y: number }>();
      graph.forEachNode((id, attributes) => positions.set(id, { x: attributes.x, y: attributes.y }));
      pathPositionsRef.current = positions;
    }
    const positions = pathPositionsRef.current;
    if (positions) {
      const lane = new Map((path?.nodes || []).map((id, index) => [id, { x: index * 25, y: index % 2 ? 5 : -5 }]));
      graph.updateEachNodeAttributes((id, attributes) => ({ ...attributes, ...positions.get(id), ...lane.get(id) }), { attributes: ['x', 'y'] });
      if (!path) pathPositionsRef.current = null;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (filtered) for (const node of viewRef.current?.nodes || []) {
      const position = graph.getNodeAttributes(node.id);
      minX = Math.min(minX, position.x); maxX = Math.max(maxX, position.x);
      minY = Math.min(minY, position.y); maxY = Math.max(maxY, position.y);
    }
    renderer.setCustomBBox(Number.isFinite(minX) ? { x: [minX - 2, maxX + 2], y: [minY - 2, maxY + 2] } : null);
    renderer.refresh(); renderer.getCamera().animatedReset({ duration: reducedMotion ? 0 : 250 });
  }, [data, domains, personId, depth, visibleEdgeKinds, showIsolated, pathTargetId, reducedMotion]);

  useEffect(() => {
    const canvas = flowCanvasRef.current, renderer = rendererRef.current, graph = graphRef.current;
    if (!canvas || !renderer || !graph) return;
    const context = canvas.getContext('2d'); if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!flowEnabled || reducedMotion || !view.flowEdges.length) return;
    let frame: number | null = null, last = 0, intersects = true;
    const draw = (time: number) => {
      frame = null;
      if (!intersects || document.hidden) return;
      if (time - last >= 33) {
        last = time;
        const { width, height } = renderer.getDimensions(), ratio = Math.min(window.devicePixelRatio || 1, 2);
        if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
        context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
        for (const [index, edge] of view.flowEdges.entries()) {
          const from = renderer.graphToViewport(graph.getNodeAttributes(edge.source)), to = renderer.graphToViewport(graph.getNodeAttributes(edge.target));
          const progress = (time / 2600 + index * 0.17) % 1, x = from.x + (to.x - from.x) * progress, y = from.y + (to.y - from.y) * progress;
          if (x < 0 || x > width || y < 0 || y > height) continue;
          context.beginPath(); context.arc(x, y, 2.4, 0, Math.PI * 2);
          context.fillStyle = '#A5F3FC'; context.shadowColor = '#22D3EE'; context.shadowBlur = 10; context.fill();
        }
        context.shadowBlur = 0;
      }
      frame = window.requestAnimationFrame(draw);
    };
    const wake = () => { if (frame === null && intersects && !document.hidden) frame = window.requestAnimationFrame(draw); };
    const observer = new IntersectionObserver(entries => { intersects = entries[0]?.isIntersecting ?? false; wake(); });
    observer.observe(canvas); document.addEventListener('visibilitychange', wake); wake();
    return () => { if (frame !== null) window.cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange', wake); context.clearRect(0, 0, canvas.width, canvas.height); };
  }, [data, view, flowEnabled, reducedMotion]);

  const selectedNode = useMemo(
    () => data?.nodes.find((node) => node.id === selectedNodeId) || null,
    [data, selectedNodeId],
  );

  useEffect(() => {
    if (!selectedNode?.memoryId || selectedNode.nodeType !== 'memory') { setDetail(null); return; }
    const controller = new AbortController(), nodeId = selectedNode.id;
    setDetail({ nodeId, loading: true });
    void fetchMemoryRecord(selectedNode.domain, selectedNode.memoryId, { profile: query.profile, userId: query.userId }, controller.signal)
      .then(record => { if (!controller.signal.aborted) setDetail({ nodeId, content: record.content }); })
      .catch(() => { if (!controller.signal.aborted) setDetail({ nodeId, error: true }); });
    return () => controller.abort();
  }, [selectedNode, query.profile, query.userId]);

  useEffect(() => { detailsRef.current?.scrollTo({ top: 0 }); }, [selectedNodeId]);

  const selectedLinks = useMemo<NodeLink[]>(() => {
    if (!data || !selectedNodeId) return [];
    const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
    return data.edges
      .filter((edge) => view.edgeIds.has(edge.id) && (edge.source === selectedNodeId || edge.target === selectedNodeId))
      .map((edge) => ({
        edge,
        neighbor: nodesById.get(edge.source === selectedNodeId ? edge.target : edge.source),
      }))
      .filter((link): link is NodeLink => Boolean(link.neighbor))
      .sort((a, b) => b.edge.weight - a.edge.weight);
  }, [data, selectedNodeId, view]);

  const selectLinkedNode = (nodeId: string) => {
    const graph = graphRef.current;
    const renderer = rendererRef.current;
    setSelectedNodeId(nodeId);
    if (!graph || !renderer || !graph.hasNode(nodeId)) return;
    selectedNodeRef.current = nodeId;
    focusNodeRef.current = nodeId;
    setSelectedNodeId(nodeId);
    const neighbors = visibleNeighbors(graph, nodeId, visibleEdgeKindsRef.current, viewRef.current?.edgeIds);
    neighborSetRef.current = new Set(neighbors);
    neighborLabelSetRef.current = new Set(neighbors.slice(0, 8));
    // A scheduled refresh temporarily leaves raw graph coordinates in the cache.
    // Process synchronously before using normalized coordinates for the camera.
    renderer.refresh();
    const display = renderer.getNodeDisplayData(nodeId);
    if (display && !viewRef.current?.path) {
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
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const toggleEdgeKind = (kind: MemoryGraphEdgeKind) => {
    const next = new Set(visibleEdgeKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setVisibleEdgeKinds(next);
    visibleEdgeKindsRef.current = next;
    const focused = focusNodeRef.current, graph = graphRef.current;
    if (focused && graph?.hasNode(focused)) {
      const neighbors = visibleNeighbors(graph, focused, next);
      neighborSetRef.current = new Set(neighbors);
      neighborLabelSetRef.current = new Set(neighbors.slice(0, 8));
    }
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

  const nodeChoices = useMemo(() => findAtlasNodes(view.nodes, nodeSearch), [view.nodes, nodeSearch]);
  const clearSelection = () => {
    setPathTargetId(null); setSelectedNodeId(null); selectedNodeRef.current = null; focusNodeRef.current = null;
    neighborSetRef.current = new Set(); neighborLabelSetRef.current = new Set(); rendererRef.current?.scheduleRefresh();
  };

  const people = (data?.nodes || []).filter(node => node.nodeType === 'person');
  const setMode = (mode: 'all' | 'sources' | 'people') => {
    setVisibleEdgeKinds(new Set(mode === 'sources' ? ['derived_from', 'episode', 'identity'] : mode === 'people' ? ['identity', 'person_relation'] : ALL_EDGE_KINDS));
  };
  visibleEdgeKindsRef.current = visibleEdgeKinds;
  const resetFilters = () => { setDomains(new Set()); setPersonId(null); setPathTargetId(null); setVisibleEdgeKinds(new Set(ALL_EDGE_KINDS)); setShowIsolated(true); };

  return (
    <FocusTrap open={fullscreen}>
    <Box ref={atlasRootRef} tabIndex={-1} role={fullscreen ? 'dialog' : undefined} aria-modal={fullscreen || undefined} aria-label="Атлас знаний"
      sx={{ ...(fullscreen ? { position: 'fixed', inset: 0, zIndex: 1400, p: { xs: 1, md: 2 }, height: '100dvh', display: 'flex', flexDirection: 'column', overflow: 'auto', bgcolor: '#050B17' } : {}), outline: 'none' }}>
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderRadius: 2, borderColor: 'rgba(34,211,238,0.3)', background: 'linear-gradient(125deg, #101F35, #0C1428)', boxShadow: '0 0 30px #0891b211', flexShrink: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <HubOutlinedIcon color="primary" fontSize="small" />
          <Typography variant="subtitle2" fontWeight={700}>Memory Atlas · Карта знаний</Typography>
          {data && (
            <>
              <Chip size="small" label={`${view.nodes.length.toLocaleString('ru-RU')} / ${data.stats.totalNodes.toLocaleString('ru-RU')} узлов`} />
              <Chip size="small" label={`${view.edges.length.toLocaleString('ru-RU')} связей на карте`} />

            </>
          )}
          <Box sx={{ flex: 1 }} />
          <Button ref={fullscreenButtonRef} size="small" startIcon={fullscreen ? <FullscreenExitIcon /> : <FullscreenIcon />}
            aria-expanded={fullscreen} onClick={() => setFullscreen(value => !value)}>{fullscreen ? 'Выйти из полного экрана' : 'На весь экран'}</Button>
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
              <Button aria-label={layoutRunning ? 'Остановить раскладку' : 'Продолжить раскладку'} size="small" variant="outlined" onClick={toggleLayout} disabled={!data?.edges.length}>
                {layoutRunning ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Вписать граф">
            <span>
              <Button
                size="small"
                variant="outlined"
                aria-label="Вписать граф"
                onClick={() => rendererRef.current?.getCamera().animatedReset({ duration: 350 })}
                disabled={!data?.nodes.length}
              >
                <CenterFocusStrongIcon fontSize="small" />
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Перезагрузить данные">
            <span>
              <Button aria-label="Перезагрузить атлас" size="small" variant="outlined" onClick={() => setReloadToken((value) => value + 1)} disabled={loading}>
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
                aria-pressed={visibleEdgeKinds.has(kind)}
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
          </Box>
        )}
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }}>
          <Button size="small" onClick={() => setMode('all')}>Все связи</Button>
          <Button size="small" onClick={() => setMode('sources')}>Источники знаний</Button>
          <Button size="small" onClick={() => setMode('people')}>Связи людей</Button>
          <Chip size="small" clickable label="Все темы" aria-pressed={!domains.size} color={!domains.size ? 'primary' : 'default'} onClick={() => setDomains(new Set())} />
          {visibleDomains.map(([domain, count]) => <Chip key={domain} size="small" clickable
            label={`${DOMAIN_LABELS[domain] || domain} · ${count}`} aria-pressed={domains.has(domain)} variant={domains.has(domain) ? 'filled' : 'outlined'}
            onClick={() => setDomains(current => { const next = new Set(current); if (next.has(domain)) next.delete(domain); else next.add(domain); return next; })}
            sx={{ borderColor: DOMAIN_COLORS[domain], color: domains.has(domain) ? '#fff' : DOMAIN_COLORS[domain], bgcolor: domains.has(domain) ? `${DOMAIN_COLORS[domain]}55` : undefined }} />)}
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ mt: 2 }}>
          <Autocomplete size="small" slotProps={{ popper: { sx: { zIndex: 1600 } } }} sx={{ flex: 1, minWidth: 160 }} options={people} value={people.find(node => node.id === personId) || null}
            getOptionLabel={node => node.label} getOptionKey={node => node.id} isOptionEqualToValue={(a, b) => a.id === b.id}
            onChange={(_, node) => { setPersonId(node?.id || null); setPathTargetId(null); setSelectedNodeId(null); selectedNodeRef.current = null; focusNodeRef.current = null; }}
            renderInput={params => <TextField {...params} label="Связи человека" placeholder="Все люди" />} />
          <TextField select size="small" sx={{ minWidth: 130 }} label="Глубина связей" disabled={!personId} value={depth}
            onChange={event => setDepth(Number(event.target.value) as 1 | 2 | 3)}>
            <MenuItem value={1}>1 шаг</MenuItem><MenuItem value={2}>2 шага</MenuItem><MenuItem value={3}>3 шага</MenuItem>
          </TextField>
          <Autocomplete size="small" slotProps={{ popper: { sx: { zIndex: 1600 } } }} sx={{ flex: 1, minWidth: 180 }} options={(data?.nodes || []).filter(node => node.id !== (personId || pathSourceId || selectedNodeId))}
            value={data?.nodes.find(node => node.id === pathTargetId) || null} disabled={!personId && !selectedNodeId}
            getOptionLabel={node => atlasNodeLabel(node, 70)} getOptionKey={node => node.id} isOptionEqualToValue={(a, b) => a.id === b.id}
            onChange={(_, node) => { setPathSourceId(node ? personId || selectedNodeId : null); setPathTargetId(node?.id || null); }}
            renderInput={params => <TextField {...params} label="Показать путь к узлу" placeholder="Выберите человека или воспоминание" />} />
        </Stack>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mt: 1 }}>
          <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={showIsolated} onChange={(_, checked) => setShowIsolated(checked)} />} label={<Typography variant="caption">Узлы без связей</Typography>} />
          <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={flowEnabled && !reducedMotion} disabled={reducedMotion} onChange={(_, checked) => setFlowEnabled(checked)} />} label={<Typography variant="caption">Поток знаний</Typography>} />
          <Button size="small" onClick={resetFilters}>Сбросить фильтры</Button>
          <Typography variant="caption" color="text.secondary">Стрелки и импульсы: сохранённый источник → запись. Остальные линии показывают связь, а не передачу знания.</Typography>
        </Stack>
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
          gridTemplateColumns: fullscreen ? { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) 360px' } : { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) 380px' },
          flex: fullscreen ? 1 : undefined, minHeight: fullscreen ? 360 : undefined,
          alignItems: 'stretch',
          overflow: 'hidden',
          borderRadius: 1,
          bgcolor: '#08111F',
        }}
      >
        <Box sx={{ position: 'relative', height: fullscreen ? '100%' : { xs: 420, md: 'clamp(520px, 72vh, 800px)' }, minHeight: 360, overflow: 'hidden', backgroundImage: 'radial-gradient(ellipse at 50% 40%, #142F4E55, transparent 65%), linear-gradient(#22D3EE08 1px, transparent 1px), linear-gradient(90deg, #22D3EE08 1px, transparent 1px)', backgroundSize: '100% 100%, 32px 32px, 32px 32px' }}>
          <Stack direction="row" spacing={1} sx={{ position: 'absolute', top: 12, left: 12, zIndex: 2 }}>
            <Button aria-label="Приблизить граф" variant="outlined" size="small" onClick={() => rendererRef.current?.getCamera().animatedZoom({ duration: 200 })}><AddIcon /></Button>
            <Button aria-label="Отдалить граф" variant="outlined" size="small" onClick={() => rendererRef.current?.getCamera().animatedUnzoom({ duration: 200 })}><RemoveIcon /></Button>
            {selectedNodeId && <Button size="small" onClick={clearSelection}>Снять выбор</Button>}
          </Stack>
          <Box ref={containerRef} sx={{ position: 'absolute', inset: 0 }} aria-label="WebGL-граф памяти" />
          <Box component="canvas" ref={flowCanvasRef} aria-hidden="true" sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
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
          {!loading && data && view.nodes.length === 0 && (
            <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', p: 3 }}>
              <Alert severity="info">Нет узлов для выбранных фильтров или путь не найден. Измените фильтры либо конечный узел.</Alert>
            </Box>
          )}
          {!loading && data && data.nodes.length > 0 && (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ position: 'absolute', left: 12, bottom: 8, pointerEvents: 'none' }}
            >
              {selectedNodeId ? 'Подсвечены связи выбранного узла' : 'Выберите узел на графе или найдите его в списке справа'} {layoutRunning ? '· размещаем узлы…' : ''}
            </Typography>
          )}
        </Box>
        <Box ref={detailsRef} sx={{ borderLeft: { lg: '1px solid' }, borderTop: { xs: '1px solid', lg: 'none' }, borderColor: 'divider', bgcolor: 'background.paper', minHeight: 0, maxHeight: fullscreen ? '100%' : { lg: 'clamp(520px, 72vh, 800px)' }, overflow: 'auto' }}>
          <Box sx={{ p: 2 }}>
            <TextField fullWidth size="small" type="search" label="Найти узел в атласе" value={nodeSearch}
              helperText="Поиск по загруженным воспоминаниям"
              onChange={event => setNodeSearch(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter' && nodeChoices[0]) selectLinkedNode(nodeChoices[0].id); }} />
            {((!view.path && !selectedNode) || nodeSearch.trim()) && <Stack spacing={0.5} sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary">{nodeSearch.trim() ? 'Результаты · до 12 узлов' : 'Люди и связанные воспоминания'}</Typography>
              {!nodeChoices.length && !loading && <Typography variant="body2">Ничего не найдено.</Typography>}
              {nodeChoices.map(node => <Button key={node.id} aria-label={`Открыть узел: ${atlasNodeLabel(node)}`} onClick={() => { selectLinkedNode(node.id); setNodeSearch(''); }}
                sx={{ textAlign: 'left', justifyContent: 'flex-start', textTransform: 'none', color: 'text.primary', p: 1 }}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2" sx={{ overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{node.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{node.nodeType === 'person' ? 'Человек' : DOMAIN_LABELS[node.domain] || node.domain} · связей: {view.degreeById.get(node.id) || 0}</Typography>
                </Box>
              </Button>)}
            </Stack>}
            {selectedNode && <Button size="small" sx={{ mt: 1 }} onClick={clearSelection}>Вернуться к списку</Button>}
          </Box>
          {view.path && <Box sx={{ px: 2, pb: 2 }}>
            <Typography variant="subtitle2" color="primary.light">Путь по сохранённым связям · переходов: {view.path.edges.length}</Typography>
            <Stack spacing={1} sx={{ mt: 1 }}>{view.path.nodes.map((id, index) => {
              const node = data?.nodes.find(node => node.id === id); if (!node) return null;
              const edge = index ? data?.edges.find(edge => edge.id === view.path!.edges[index - 1]) : null;
              return <Box key={id}>{edge && <Typography variant="caption" color="text.secondary">{edge.directed ? '↓' : '↔'} {EDGE_LABELS[edge.kind]}</Typography>}
                <Button size="small" onClick={() => selectLinkedNode(id)} sx={{ display: 'block', textAlign: 'left', textTransform: 'none' }}>{atlasNodeLabel(node, 70)}</Button>
              </Box>;
            })}</Stack>
          </Box>}
          {view.pathMissing && <Alert severity="info" sx={{ mx: 2, mb: 2 }}>В загруженных данных нет пути с выбранными типами связей и направлением источников.</Alert>}
          <Divider />
          {(!view.path || selectedNode) && <NodeDetails node={selectedNode} visibleDegree={selectedNodeId ? view.degreeById.get(selectedNodeId) : undefined} links={selectedLinks} onSelect={selectLinkedNode}
            fullContent={detail?.nodeId === selectedNodeId ? detail.content : undefined}
            detailLoading={detail?.nodeId === selectedNodeId && detail.loading}
            detailError={detail?.nodeId === selectedNodeId && detail.error} />}
        </Box>
      </Paper>
    </Box>
    </FocusTrap>
  );
}
