import { Fragment, memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import type {
  AiUsageBreakdownRow,
  AiUsageFailureRecord,
  AiUsageOperation,
  AiUsageQuery,
  AiUsageSummaryResponse,
  AiUsageTraceChain,
} from '../types';
import { fetchAiUsageSummary } from '../api';

type PeriodPreset = '1' | '7' | '30' | 'custom';
type SuccessFilter = 'all' | 'success' | 'failure';
type QuickFilter =
  | 'all'
  | 'gemini503'
  | 'provider-errors'
  | 'recovered-fallback'
  | 'user-visible-failures';

interface FilterDraft {
  period: PeriodPreset;
  from: string;
  to: string;
  provider: string;
  operation: AiUsageOperation | '';
  success: SuccessFilter;
  fallbackOnly: boolean;
}

const DEFAULT_FILTERS: FilterDraft = {
  period: '7',
  from: '',
  to: '',
  provider: '',
  operation: '',
  success: 'all',
  fallbackOnly: false,
};

const OPERATION_LABELS: Record<AiUsageOperation, string> = {
  chat: 'Диалог',
  response: 'Ответы',
  embedding: 'Векторизация',
  transcription: 'Расшифровка',
  unknown: 'Другая',
};

const QUICK_FILTER_LABELS: Record<QuickFilter, string> = {
  all: 'Все цепочки',
  gemini503: 'Gemini 503',
  'provider-errors': 'Ошибки сервиса',
  'recovered-fallback': 'Восстановлено резервом',
  'user-visible-failures': 'Ошибки для пользователя',
};

const formatNumber = (value: number) =>
  new Intl.NumberFormat('ru-RU').format(Math.round(value));
const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
const formatLatency = (value: number) =>
  !Number.isFinite(value) || value <= 0
    ? '—'
    : value < 1000
      ? `${Math.round(value)} мс`
      : `${(value / 1000).toFixed(2)} с`;
const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const buildQuery = (filters: FilterDraft): AiUsageQuery => {
  const query: AiUsageQuery =
    filters.period === 'custom'
      ? {
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.to ? { to: filters.to } : {}),
        }
      : { days: filters.period };

  if (filters.provider) query.provider = filters.provider;
  if (filters.operation) query.operation = filters.operation;
  if (filters.success !== 'all') query.success = filters.success === 'success';
  if (filters.fallbackOnly) query.fallbackUsed = true;
  return query;
};

const validateFilters = (filters: FilterDraft) => {
  if (filters.period !== 'custom') return null;
  if (!filters.from && !filters.to) {
    return 'Для произвольного периода укажите хотя бы одну дату';
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    return 'Дата «От» должна быть раньше даты «До»';
  }
  return null;
};

const matchesGemini503 = (row: AiUsageTraceChain) =>
  row.attempts.some(
    (attempt) => attempt.provider === 'gemini' && attempt.errorStatus === 503,
  );

const matchesFailure = (row: AiUsageFailureRecord, filter: QuickFilter) =>
  filter === 'all' ||
  (filter === 'gemini503' && row.provider === 'gemini' && row.errorStatus === 503) ||
  (filter === 'provider-errors' &&
    Boolean(row.errorCategory) &&
    row.errorCategory !== 'unknown');

const matchesTrace = (row: AiUsageTraceChain, filter: QuickFilter) =>
  filter === 'all' ||
  (filter === 'gemini503' && matchesGemini503(row)) ||
  (filter === 'provider-errors' &&
    row.attempts.some(
      (attempt) => Boolean(attempt.errorCategory) && attempt.errorCategory !== 'unknown',
    )) ||
  (filter === 'recovered-fallback' && row.outcome === 'recovered_fallback') ||
  (filter === 'user-visible-failures' && row.outcome === 'failed');

function Kpi({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        borderRadius: '12px',
        bgcolor: 'rgba(15,23,42,.48)',
        borderColor: 'rgba(148,163,184,.16)',
      }}
    >
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" fontWeight={800}>
        {value}
      </Typography>
      {caption && (
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

function SegmentButton({
  active,
  children,
  onClick,
  role,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
  role?: 'tab' | 'button';
}) {
  return (
    <Box
      component="button"
      type="button"
      role={role}
      aria-selected={role === 'tab' ? active : undefined}
      onClick={onClick}
      sx={{
        border: '1px solid',
        borderColor: active ? 'primary.main' : 'rgba(148,163,184,.24)',
        borderRadius: '8px',
        bgcolor: active ? 'primary.main' : 'transparent',
        color: active ? 'primary.contrastText' : 'text.secondary',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '0.8125rem',
        lineHeight: 1.5,
        minHeight: 30,
        px: 1,
        py: 0.35,
        transition: 'none',
        '&:hover': { borderColor: 'primary.light', bgcolor: active ? 'primary.main' : 'rgba(148,163,184,.08)' },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: 1 },
      }}
    >
      {children}
    </Box>
  );
}

const TimeseriesChart = memo(function TimeseriesChart({ summary }: { summary: AiUsageSummaryResponse }) {
  const points = summary.timeseries.points;
  const width = 760;
  const height = 230;
  const pad = { left: 48, right: 64, top: 18, bottom: 38 };
  const max = Math.max(...points.map((point) => point.totalTokens), 1);
  const maxFailures = Math.max(...points.map((point) => point.failedCalls), 1);
  const x = (index: number) =>
    pad.left +
    (points.length < 2
      ? 0
      : (index * (width - pad.left - pad.right)) / (points.length - 1));
  const y = (value: number) =>
    pad.top + (height - pad.top - pad.bottom) * (1 - value / max);
  const failureY = (value: number) =>
    pad.top + (height - pad.top - pad.bottom) * (1 - value / maxFailures);
  const line = points.map((point, index) => `${x(index)},${y(point.totalTokens)}`).join(' ');
  const failureLine = points
    .map((point, index) => `${x(index)},${failureY(point.failedCalls)}`)
    .join(' ');
  const area = points.length
    ? `${x(0)},${height - pad.bottom} ${line} ${x(points.length - 1)},${height - pad.bottom}`
    : '';
  const xTickStep = Math.max(1, Math.ceil(points.length / 8));
  const formatTick = (bucketStart: string) =>
    new Date(bucketStart).toLocaleString('ru-RU',
      summary.timeseries.bucket === 'hour'
        ? { day: '2-digit', month: '2-digit', hour: '2-digit' }
        : { day: '2-digit', month: '2-digit' },
    );

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.25,
        borderRadius: '14px',
        bgcolor: 'rgba(15,23,42,.48)',
        borderColor: 'rgba(148,163,184,.16)',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={800}>
            Токены во времени
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Вертикаль — токены · горизонталь — {summary.timeseries.bucket === 'hour' ? 'часы' : 'дни'}
          </Typography>
        </Box>
        <Chip size="small" variant="outlined" label={`${points.length} точек`} />
      </Box>
      {points.length ? (
        <Box sx={{ overflowX: 'auto', mt: 1 }}>
          <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="230" role="img" aria-label="График использования токенов">
            <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke="rgba(148,163,184,.35)" />
            <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="rgba(148,163,184,.35)" />
            <text x="8" y={pad.top + 4} fill="#93a4bd" fontSize="11">{formatNumber(max)}</text>
            <text x="22" y={height - pad.bottom + 4} fill="#93a4bd" fontSize="11">0</text>
            <text x={width - 4} y={pad.top + 4} textAnchor="end" fill="#fb7185" fontSize="11">
              {formatNumber(maxFailures)} ошибок
            </text>
            <polygon points={area} fill="rgba(56,189,248,.12)" />
            <polyline points={line} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinejoin="round" />
            <polyline points={failureLine} fill="none" stroke="#fb7185" strokeWidth="1.75" strokeDasharray="4 4" strokeLinejoin="round" />
            {points.map((point, index) => (
              <g key={point.bucketStart}>
                <circle cx={x(index)} cy={y(point.totalTokens)} r="4" fill="#38bdf8" stroke="#0f172a" strokeWidth="2">
                  <title>{`${new Date(point.bucketStart).toLocaleString('ru-RU')} · ${formatNumber(point.totalTokens)} токенов`}</title>
                </circle>
                <circle cx={x(index)} cy={failureY(point.failedCalls)} r="3.5" fill="#fb7185" stroke="#0f172a" strokeWidth="1.5">
                  <title>{`${new Date(point.bucketStart).toLocaleString('ru-RU')} · ${formatNumber(point.failedCalls)} неудачных вызовов`}</title>
                </circle>
                {(index % xTickStep === 0 || index === points.length - 1) && (
                  <text x={x(index)} y={height - 14} textAnchor="middle" fill="#93a4bd" fontSize="10">
                    {formatTick(point.bucketStart)}
                  </text>
                )}
              </g>
            ))}
          </svg>
          <Stack direction="row" spacing={2} justifyContent="center" sx={{ mt: -0.5 }}>
            <Typography variant="caption" color="text.secondary">
              <Box component="span" sx={{ display: 'inline-block', width: 14, height: 2, bgcolor: '#38bdf8', mr: 0.75, verticalAlign: 'middle' }} />
              Токены
            </Typography>
            <Typography variant="caption" color="text.secondary">
              <Box component="span" sx={{ display: 'inline-block', width: 14, borderTop: '2px dashed #fb7185', mr: 0.75, verticalAlign: 'middle' }} />
              Неудачные вызовы
            </Typography>
          </Stack>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ py: 5 }}>
          Нет данных за выбранный период
        </Typography>
      )}
    </Paper>
  );
});

const Breakdown = memo(function Breakdown({ summary }: { summary: AiUsageSummaryResponse }) {
  const [kind, setKind] = useState(0);
  const [metric, setMetric] = useState<'tokens' | 'calls'>('tokens');
  const keys = ['models', 'tasks', 'providers', 'operations'] as const;
  const labels = ['Модели', 'Задачи', 'Провайдеры', 'Операции'];
  const key = keys[kind];
  const sourceRows = metric === 'calls' && key === 'models'
    ? summary.leaders.modelsByCalls
    : metric === 'calls' && key === 'tasks'
      ? summary.leaders.tasksByCalls
      : (summary.breakdowns?.[key] ?? []) as AiUsageBreakdownRow[];
  const rows = metric === 'calls'
    ? [...sourceRows].sort((left, right) => right.calls - left.calls || right.totalTokens - left.totalTokens || left.key.localeCompare(right.key))
    : sourceRows;
  const max = Math.max(...rows.map((row) => (metric === 'tokens' ? row.totalTokens : row.calls)), 1);

  return (
    <Paper variant="outlined" sx={{ p: 1.25, borderRadius: '14px', bgcolor: 'rgba(15,23,42,.48)', borderColor: 'rgba(148,163,184,.16)' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" fontWeight={800}>Разбор по категориям</Typography>
        <Typography variant="caption" color="text.secondary">
          Обновлено: {formatDateTime(summary.generatedAt)}
        </Typography>
        <Stack direction="row" spacing={0.5} role="group" aria-label="Показатель">
          <SegmentButton active={metric === 'tokens'} onClick={() => setMetric('tokens')}>Токены</SegmentButton>
          <SegmentButton active={metric === 'calls'} onClick={() => setMetric('calls')}>Вызовы</SegmentButton>
        </Stack>
      </Box>
      <Stack direction="row" spacing={0.5} role="tablist" aria-label="Категория разбора" sx={{ overflowX: 'auto', py: 0.75, mb: 0.25 }}>
        {labels.map((label, index) => <SegmentButton key={label} role="tab" active={kind === index} onClick={() => setKind(index)}>{label}</SegmentButton>)}
      </Stack>
      <Stack spacing={0.6}>
        {rows.length ? rows.map((row) => {
          const value = metric === 'tokens' ? row.totalTokens : row.calls;
          return (
            <Box key={row.key}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                <Typography variant="body2" noWrap>{row.key}</Typography>
                <Typography variant="caption">{formatNumber(value)}</Typography>
              </Box>
              <Typography variant="caption" color="text.secondary">
                Вызовы: {formatNumber(row.calls)} · Входящие: {formatNumber(row.inputTokens)} · Исходящие: {formatNumber(row.outputTokens)}
              </Typography>
              <Box sx={{ height: 5, borderRadius: 4, bgcolor: 'rgba(148,163,184,.14)' }}>
                <Box sx={{ width: `${(value / max) * 100}%`, height: '100%', borderRadius: 4, bgcolor: metric === 'tokens' ? '#38bdf8' : '#f59e0b' }} />
              </Box>
            </Box>
          );
        }) : <Typography variant="body2" color="text.secondary">Нет данных</Typography>}
      </Stack>
    </Paper>
  );
});

function StageChip({ label, active, tone }: { label: string; active: boolean; tone: 'primary' | 'retry' | 'fallback' }) {
  const colors = { primary: '#38bdf8', retry: '#fbbf24', fallback: '#a78bfa' };
  return <Chip size="small" label={<><Box component="span" sx={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', bgcolor: colors[tone], mr: 0.6 }} />{label}</>} variant={active ? 'filled' : 'outlined'} sx={{ height: 24, opacity: active ? 1 : 0.55 }} />;
}

const outcomeLabel = (outcome: string) => outcome === 'success' ? 'Успешно' : outcome === 'recovered_fallback' ? 'Восстановлено резервом' : 'Ошибка';

const TraceTable = memo(function TraceTable({ rows }: { rows: AiUsageTraceChain[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen((value) => value === key ? null : key);
  return <Paper id="monitor-chains" variant="outlined" sx={{ p: 1.25, borderRadius: '14px', bgcolor: 'rgba(15,23,42,.48)', borderColor: 'rgba(148,163,184,.16)', scrollMarginTop: 20 }}><Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.75 }}>Цепочки маршрутизации</Typography>{rows.length ? <TableContainer><Table size="small"><TableHead><TableRow><TableCell>Время</TableCell><TableCell>Задача</TableCell><TableCell>Стадии</TableCell><TableCell>Итог</TableCell></TableRow></TableHead><TableBody>{rows.map((row) => <Fragment key={row.traceKey}><TableRow hover tabIndex={0} aria-expanded={open === row.traceKey} onClick={() => toggle(row.traceKey)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(row.traceKey); } }} sx={{ cursor: 'pointer' }}><TableCell>{formatDateTime(row.createdAt)}</TableCell><TableCell><Typography variant="body2">{row.taskKey}</Typography><Typography variant="caption" color="text.secondary">{row.primaryProvider} · {row.primaryModel}</Typography></TableCell><TableCell><Stack direction="row" spacing={0.5}><StageChip label="Основной" active tone="primary" /><StageChip label={`Повтор ${row.retryCount}`} active={row.retryStage !== 'none'} tone="retry" /><StageChip label="Резерв" active={row.fallbackStage !== 'none'} tone="fallback" /></Stack></TableCell><TableCell><Chip size="small" label={`${outcomeLabel(row.outcome)} · ${formatLatency(row.totalLatencyMs)}`} color={row.outcome === 'failed' ? 'error' : row.outcome === 'recovered_fallback' ? 'warning' : 'success'} /></TableCell></TableRow><TableRow><TableCell colSpan={4} sx={{ p: 0, border: 0 }}><Collapse in={open === row.traceKey} timeout="auto" unmountOnExit><Box sx={{ p: 1.25, bgcolor: 'rgba(2,6,23,.25)' }}><Typography variant="caption" color="text.secondary">Идентификатор: {row.traceId || 'нет'} · пресет: {row.preset || 'нет'} · запросы: {row.providerRequestIds.join(', ') || 'нет'}</Typography><Typography variant="body2" sx={{ mt: 0.5 }}>{row.primaryError || 'Ошибок нет'}</Typography><Typography variant="caption" color="text.secondary">Основная ошибка: {row.primaryErrorStatus ?? 'нет'} · {row.primaryErrorCategory || 'категория не указана'} · {row.fallbackProvider ? `резерв: ${row.fallbackProvider} · ${row.fallbackModel}` : 'резервный путь не использовался'} · попыток: {row.attempts.length}</Typography>{row.attempts.map((attempt) => <Typography key={attempt.id} variant="caption" color="text.secondary" display="block">{attempt.stage || 'старая запись'} · попытка {attempt.attempt ?? '—'} · {attempt.provider} / {attempt.model} · {attempt.operation} · {attempt.success ? 'успешно' : `${attempt.errorStatus ?? 'ошибка'} · ${attempt.errorCode || 'без кода'} · ${attempt.errorType || 'без типа'} · ${attempt.errorCategory || 'неизвестно'}`} · резерв: {attempt.fallbackUsed ? 'да' : 'нет'} · повторяемая: {attempt.retryable == null ? 'неизвестно' : attempt.retryable ? 'да' : 'нет'} · {formatLatency(attempt.latencyMs ?? 0)}{attempt.providerRequestId ? ` · ${attempt.providerRequestId}` : ''}{attempt.errorMessage ? ` · ${attempt.errorMessage}` : ''}</Typography>)}</Box></Collapse></TableCell></TableRow></Fragment>)}</TableBody></Table></TableContainer> : <Typography variant="body2" color="text.secondary">По выбранному фильтру цепочек нет</Typography>}</Paper>;
});

const FailureTable = memo(function FailureTable({ rows }: { rows: AiUsageFailureRecord[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen((value) => value === key ? null : key);
  return <Paper id="monitor-failures" variant="outlined" sx={{ p: 1.25, borderRadius: '14px', bgcolor: 'rgba(15,23,42,.48)', borderColor: 'rgba(148,163,184,.16)', scrollMarginTop: 20 }}><Typography variant="subtitle1" fontWeight={800} sx={{ mb: 0.75 }}>Последние ошибки</Typography>{rows.length ? <TableContainer><Table size="small"><TableHead><TableRow><TableCell>Время</TableCell><TableCell>Сервис и модель</TableCell><TableCell>Задача</TableCell><TableCell>Статус</TableCell></TableRow></TableHead><TableBody>{rows.map((row) => { const key = `${row.createdAt}-${row.model}-${row.taskKey}-${row.traceId || 'legacy'}`; return <Fragment key={key}><TableRow hover tabIndex={0} aria-expanded={open === key} onClick={() => toggle(key)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(key); } }} sx={{ cursor: 'pointer' }}><TableCell>{formatDateTime(row.createdAt)}</TableCell><TableCell>{row.provider}<Typography variant="caption" color="text.secondary" display="block">{row.model}</Typography></TableCell><TableCell>{row.taskKey}<Typography variant="caption" color="text.secondary" display="block">{OPERATION_LABELS[row.operation]}</Typography></TableCell><TableCell><Chip size="small" label={row.errorStatus ? `HTTP ${row.errorStatus}` : row.errorCategory || 'ошибка'} color="error" variant="outlined" /></TableCell></TableRow><TableRow><TableCell colSpan={4} sx={{ p: 0, border: 0 }}><Collapse in={open === key} timeout="auto" unmountOnExit><Box sx={{ p: 1.25, bgcolor: 'rgba(2,6,23,.25)' }}><Typography variant="body2">{row.errorMessage || 'Текст ошибки отсутствует'}</Typography><Typography variant="caption" color="text.secondary">Идентификатор: {row.traceId || 'нет'} · пресет: {row.preset || 'нет'} · стадия: {row.stage || 'нет'} · попытка: {row.attempt ?? '—'} · код: {row.errorCode || 'нет'} · тип: {row.errorType || 'нет'} · категория: {row.errorCategory || 'нет'} · резерв: {row.fallbackUsed ? 'да' : 'нет'} · повторяемая: {row.retryable == null ? 'неизвестно' : row.retryable ? 'да' : 'нет'}{row.providerRequestId ? ` · запрос: ${row.providerRequestId}` : ''}</Typography></Box></Collapse></TableCell></TableRow></Fragment>; })}</TableBody></Table></TableContainer> : <Typography variant="body2" color="text.secondary">Ошибок по выбранному фильтру нет</Typography>}</Paper>;
});

export const AiUsageSection = memo(function AiUsageSection() {
  const [draft, setDraft] = useState(DEFAULT_FILTERS);
  const [applied, setAppliedState] = useState(DEFAULT_FILTERS);
  const [summary, setSummary] = useState<AiUsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const setApplied = (filters: FilterDraft) => setAppliedState({ ...filters });
  const providerOptions = useMemo(() => (summary?.breakdowns.providers ?? []).map((row) => row.key).filter((key) => key && key !== 'other'), [summary]);
  const load = async (filters: FilterDraft) => {
    const validation = validateFilters(filters);
    if (validation) { setError(validation); return; }
    setLoading(true);
    try { setSummary(await fetchAiUsageSummary(buildQuery(filters))); setError(null); }
    catch (value) { setError(value instanceof Error ? value.message : 'Не удалось загрузить статистику использования ИИ'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(applied); }, [applied]);
  const visibleTraces = useMemo(() => (summary?.traceChains ?? []).filter((row) => matchesTrace(row, quickFilter)), [summary, quickFilter]);
  const recovered = useMemo(() => new Set((summary?.traceChains ?? []).filter((row) => row.outcome === 'recovered_fallback').map((row) => row.traceId).filter(Boolean)), [summary]);
  const visibleFailures = useMemo(() => (summary?.recentFailures ?? []).filter((row) => quickFilter === 'recovered-fallback' ? Boolean(row.traceId && recovered.has(row.traceId)) : quickFilter === 'user-visible-failures' ? !row.traceId || !recovered.has(row.traceId) : matchesFailure(row, quickFilter)), [summary, quickFilter, recovered]);

  if (loading && !summary) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}><CircularProgress /></Box>;
  return <Stack spacing={1.75} sx={{ mt: 2 }}><Box id="monitor-ai-usage" sx={{ scrollMarginTop: 20 }}><Paper variant="outlined" sx={{ p: 1.25, borderRadius: '14px', bgcolor: 'rgba(15,23,42,.48)', borderColor: 'rgba(148,163,184,.16)' }}><Box sx={{ display: 'flex', gap: 0.75, alignItems: 'center', flexWrap: 'wrap' }}><Typography variant="subtitle1" fontWeight={800} sx={{ mr: 1 }}>Использование ИИ</Typography><TextField select size="small" label="Период" value={draft.period} onChange={(e) => setDraft((p) => ({ ...p, period: e.target.value as PeriodPreset }))} sx={{ minWidth: 125 }}><MenuItem value="1">24 часа</MenuItem><MenuItem value="7">7 дней</MenuItem><MenuItem value="30">30 дней</MenuItem><MenuItem value="custom">Произвольный</MenuItem></TextField><TextField select size="small" label="Сервис ИИ" value={draft.provider} onChange={(e) => setDraft((p) => ({ ...p, provider: e.target.value }))} sx={{ minWidth: 135 }}><MenuItem value="">Все</MenuItem>{providerOptions.map((provider) => <MenuItem key={provider} value={provider}>{provider}</MenuItem>)}</TextField><TextField select size="small" label="Операция" value={draft.operation} onChange={(e) => setDraft((p) => ({ ...p, operation: e.target.value as AiUsageOperation | '' }))} sx={{ minWidth: 135 }}><MenuItem value="">Все</MenuItem>{Object.entries(OPERATION_LABELS).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}</TextField><TextField select size="small" label="Результат" value={draft.success} onChange={(e) => setDraft((p) => ({ ...p, success: e.target.value as SuccessFilter }))} sx={{ minWidth: 135 }}><MenuItem value="all">Все</MenuItem><MenuItem value="success">Успешные</MenuItem><MenuItem value="failure">С ошибкой</MenuItem></TextField><TextField select size="small" label="Резервный путь" value={draft.fallbackOnly ? 'true' : 'false'} onChange={(e) => setDraft((p) => ({ ...p, fallbackOnly: e.target.value === 'true' }))} sx={{ minWidth: 145 }}><MenuItem value="false">Все</MenuItem><MenuItem value="true">Только с резервом</MenuItem></TextField>{draft.period === 'custom' && <><TextField size="small" label="От" type="date" value={draft.from} InputLabelProps={{ shrink: true }} onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))} /><TextField size="small" label="До" type="date" value={draft.to} InputLabelProps={{ shrink: true }} onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value }))} /></>}<Button variant="contained" size="small" onClick={() => setApplied(draft)}>Применить</Button></Box><Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>{(Object.keys(QUICK_FILTER_LABELS) as QuickFilter[]).map((key) => <Chip key={key} size="small" clickable label={QUICK_FILTER_LABELS[key]} color={quickFilter === key ? 'primary' : 'default'} variant={quickFilter === key ? 'filled' : 'outlined'} onClick={() => setQuickFilter(key)} />)}</Stack></Paper></Box>{error && <Alert severity="error">{error}</Alert>}{summary && <><Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(5, 1fr)' }, gap: 0.75 }}><Kpi label="Вызовы" value={formatNumber(summary.totals.calls)} caption={`успешно ${formatNumber(summary.totals.successfulCalls)} · ошибок ${formatNumber(summary.totals.failedCalls)}`} /><Kpi label="Токены" value={formatNumber(summary.totals.totalTokens)} caption={`вход ${formatNumber(summary.totals.inputTokens)} · выход ${formatNumber(summary.totals.outputTokens)}`} /><Kpi label="Средняя задержка" value={formatLatency(summary.totals.avgLatencyMs)} /><Kpi label="Доля ошибок" value={formatPercent(summary.totals.errorRate)} /><Kpi label="Полнота учёта" value={formatPercent(summary.coverage.usageCoverageRate)} caption={`${formatNumber(summary.coverage.callsWithoutUsage)} без данных`} /></Box><Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', px: 0.5 }}><Typography variant="caption" color="text.secondary">Дополнительно:</Typography><Typography variant="caption">Цепочки {formatNumber(summary.traceChains.length)}</Typography><Typography variant="caption">· Gemini 503 {formatNumber(summary.traceChains.filter(matchesGemini503).length)}</Typography><Typography variant="caption">· Восстановлено {formatNumber(summary.traceChains.filter((row) => row.outcome === 'recovered_fallback').length)}</Typography><Typography variant="caption">· Ошибок {formatNumber(summary.traceChains.filter((row) => row.outcome === 'failed').length)}</Typography></Box><TimeseriesChart summary={summary} /><Breakdown summary={summary} /><TraceTable rows={visibleTraces} /><FailureTable rows={visibleFailures} /></>}</Stack>;
});
