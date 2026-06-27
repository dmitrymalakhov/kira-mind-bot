import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type {
  AiUsageBreakdownRow,
  AiUsageOperation,
  AiUsageQuery,
  AiUsageSummaryResponse,
  AiUsageTimeseriesPoint,
} from '../types';
import { fetchAiUsageSummary } from '../api';

type PeriodPreset = '1' | '7' | '30' | 'custom';
type SuccessFilter = 'all' | 'success' | 'failure';

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
  chat: 'Chat',
  response: 'Responses',
  embedding: 'Embeddings',
  transcription: 'Transcription',
  unknown: 'Unknown',
};

function formatNumber(value: number) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(value));
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatLatency(latencyMs: number) {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return '—';
  if (latencyMs < 1000) return `${Math.round(latencyMs)} мс`;
  return `${(latencyMs / 1000).toFixed(2)} c`;
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBucketLabel(point: AiUsageTimeseriesPoint, bucket: 'hour' | 'day') {
  return new Date(point.bucketStart).toLocaleString('ru-RU', bucket === 'hour'
    ? { day: '2-digit', month: '2-digit', hour: '2-digit' }
    : { day: '2-digit', month: '2-digit' });
}

function buildQuery(filters: FilterDraft): AiUsageQuery {
  const query: AiUsageQuery = {};
  if (filters.period === 'custom') {
    if (filters.from) query.from = filters.from;
    if (filters.to) query.to = filters.to;
  } else {
    query.days = filters.period;
  }
  if (filters.provider) query.provider = filters.provider;
  if (filters.operation) query.operation = filters.operation;
  if (filters.success === 'success') query.success = true;
  if (filters.success === 'failure') query.success = false;
  if (filters.fallbackOnly) query.fallbackUsed = true;
  return query;
}

function StatCard({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        borderRadius: '18px',
        bgcolor: 'rgba(15, 23, 42, 0.64)',
        borderColor: 'rgba(148, 163, 184, 0.18)',
      }}
    >
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h5" fontWeight={800} sx={{ mt: 0.5 }}>{value}</Typography>
      {caption ? (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          {caption}
        </Typography>
      ) : null}
    </Paper>
  );
}

function BreakdownTable({ title, rows, metric }: { title: string; rows: AiUsageBreakdownRow[]; metric: 'tokens' | 'calls' }) {
  const maxValue = Math.max(...rows.map((row) => metric === 'tokens' ? row.totalTokens : row.calls), 0);

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        borderRadius: '20px',
        bgcolor: 'rgba(15, 23, 42, 0.56)',
        borderColor: 'rgba(148, 163, 184, 0.18)',
      }}
    >
      <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1.25 }}>
        {title}
      </Typography>
      <Stack spacing={1.25}>
        {rows.length ? rows.map((row) => {
          const value = metric === 'tokens' ? row.totalTokens : row.calls;
          const progress = maxValue > 0 ? (value / maxValue) * 100 : 0;
          return (
            <Box key={`${title}-${row.key}`}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 0.4 }}>
                <Typography variant="body2" fontWeight={700} sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {row.key}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {metric === 'tokens' ? formatNumber(row.totalTokens) : formatNumber(row.calls)}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={progress}
                sx={{
                  height: 8,
                  borderRadius: 999,
                  bgcolor: 'rgba(148, 163, 184, 0.14)',
                  '& .MuiLinearProgress-bar': {
                    borderRadius: 999,
                    background: metric === 'tokens'
                      ? 'linear-gradient(90deg, #38bdf8 0%, #22c55e 100%)'
                      : 'linear-gradient(90deg, #f59e0b 0%, #f97316 100%)',
                  },
                }}
              />
              <Typography variant="caption" color="text.secondary">
                calls {formatNumber(row.calls)} · input {formatNumber(row.inputTokens)} · output {formatNumber(row.outputTokens)}
              </Typography>
            </Box>
          );
        }) : (
          <Typography variant="body2" color="text.secondary">Нет данных</Typography>
        )}
      </Stack>
    </Paper>
  );
}

function TimeseriesChart({ summary }: { summary: AiUsageSummaryResponse }) {
  const points = summary.timeseries.points;
  const maxTokens = Math.max(...points.map((point) => point.totalTokens), 0);
  const bucket = summary.timeseries.bucket;

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        borderRadius: '20px',
        bgcolor: 'rgba(15, 23, 42, 0.56)',
        borderColor: 'rgba(148, 163, 184, 0.18)',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 1.5, alignItems: 'center' }}>
        <Box>
          <Typography variant="subtitle1" fontWeight={800}>Таймсерия токенов</Typography>
          <Typography variant="caption" color="text.secondary">
            Buckets: {bucket === 'hour' ? 'почасовые' : 'подневные'}
          </Typography>
        </Box>
        <Chip size="small" label={`Точек: ${points.length}`} variant="outlined" />
      </Box>
      {points.length ? (
        <Box sx={{ display: 'flex', gap: 0.75, alignItems: 'flex-end', minHeight: 190, overflowX: 'auto', pb: 1 }}>
          {points.map((point) => {
            const height = maxTokens > 0 ? Math.max(12, (point.totalTokens / maxTokens) * 140) : 12;
            return (
              <Tooltip
                key={point.bucketStart}
                title={`${formatBucketLabel(point, bucket)} · total ${formatNumber(point.totalTokens)} · calls ${formatNumber(point.calls)}`}
                arrow
              >
                <Box sx={{ minWidth: 24, textAlign: 'center' }}>
                  <Box
                    sx={{
                      height,
                      borderRadius: '10px 10px 4px 4px',
                      background: point.failedCalls > 0
                        ? 'linear-gradient(180deg, #fb7185 0%, #ef4444 100%)'
                        : 'linear-gradient(180deg, #38bdf8 0%, #22c55e 100%)',
                      border: '1px solid rgba(255,255,255,0.08)',
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {bucket === 'hour'
                      ? new Date(point.bucketStart).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit' })
                      : new Date(point.bucketStart).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}
                  </Typography>
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">Нет данных по выбранному периоду</Typography>
      )}
    </Paper>
  );
}

export function AiUsageSection() {
  const [draft, setDraft] = useState<FilterDraft>(DEFAULT_FILTERS);
  const [applied, setApplied] = useState<FilterDraft>(DEFAULT_FILTERS);
  const [data, setData] = useState<AiUsageSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerOptions = useMemo(() => {
    return (data?.breakdowns.providers ?? [])
      .map((row) => row.key)
      .filter((key) => key && key !== 'other');
  }, [data]);

  const load = async (filters: FilterDraft, isManualRefresh = false) => {
    if (isManualRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await fetchAiUsageSummary(buildQuery(filters));
      setData(response);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить AI usage analytics');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load(applied);
  }, [applied]);

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  const summary = data;

  return (
    <Stack spacing={2.5} sx={{ mt: 3 }}>
      <Paper
        variant="outlined"
        sx={{
          p: { xs: 1.5, md: 2 },
          borderRadius: '24px',
          borderColor: 'rgba(56, 189, 248, 0.22)',
          background:
            'radial-gradient(circle at top left, rgba(34, 197, 94, 0.10), transparent 28%), radial-gradient(circle at top right, rgba(56, 189, 248, 0.12), transparent 30%), linear-gradient(180deg, rgba(15,23,42,0.92) 0%, rgba(17,24,39,0.84) 100%)',
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: { xs: 'stretch', md: 'center' }, flexDirection: { xs: 'column', md: 'row' } }}>
          <Box>
            <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 1.2 }}>
              AI Usage
            </Typography>
            <Typography variant="h6" fontWeight={800}>
              Токены, вызовы, fallback и ошибки по моделям
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
              Последнее обновление: {summary ? formatDateTime(summary.generatedAt) : '—'}
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={refreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
            onClick={() => void load(applied, true)}
            disabled={refreshing}
          >
            Обновить
          </Button>
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(6, 1fr)' }, gap: 1.25, mt: 2 }}>
          <TextField
            select
            size="small"
            label="Период"
            value={draft.period}
            onChange={(event) => setDraft((prev) => ({ ...prev, period: event.target.value as PeriodPreset }))}
          >
            <MenuItem value="1">24h</MenuItem>
            <MenuItem value="7">7d</MenuItem>
            <MenuItem value="30">30d</MenuItem>
            <MenuItem value="custom">Custom</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            label="Provider"
            value={draft.provider}
            onChange={(event) => setDraft((prev) => ({ ...prev, provider: event.target.value }))}
          >
            <MenuItem value="">Все</MenuItem>
            {providerOptions.map((provider) => (
              <MenuItem key={provider} value={provider}>{provider}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Operation"
            value={draft.operation}
            onChange={(event) => setDraft((prev) => ({ ...prev, operation: event.target.value as AiUsageOperation | '' }))}
          >
            <MenuItem value="">Все</MenuItem>
            {Object.entries(OPERATION_LABELS).map(([value, label]) => (
              <MenuItem key={value} value={value}>{label}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Статус"
            value={draft.success}
            onChange={(event) => setDraft((prev) => ({ ...prev, success: event.target.value as SuccessFilter }))}
          >
            <MenuItem value="all">Все</MenuItem>
            <MenuItem value="success">Только success</MenuItem>
            <MenuItem value="failure">Только failure</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            label="Fallback"
            value={draft.fallbackOnly ? 'true' : 'false'}
            onChange={(event) => setDraft((prev) => ({ ...prev, fallbackOnly: event.target.value === 'true' }))}
          >
            <MenuItem value="false">Все</MenuItem>
            <MenuItem value="true">Только fallback</MenuItem>
          </TextField>
          <Button variant="contained" onClick={() => setApplied(draft)}>
            Применить
          </Button>
        </Box>

        {draft.period === 'custom' ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(180px, 220px))' }, gap: 1.25, mt: 1.25 }}>
            <TextField
              size="small"
              label="From"
              type="date"
              value={draft.from}
              InputLabelProps={{ shrink: true }}
              onChange={(event) => setDraft((prev) => ({ ...prev, from: event.target.value }))}
            />
            <TextField
              size="small"
              label="To"
              type="date"
              value={draft.to}
              InputLabelProps={{ shrink: true }}
              onChange={(event) => setDraft((prev) => ({ ...prev, to: event.target.value }))}
            />
          </Box>
        ) : null}
      </Paper>

      {error ? <Alert severity="error">{error}</Alert> : null}

      {summary ? (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr 1fr', xl: 'repeat(7, 1fr)' }, gap: 1.25 }}>
            <StatCard label="Вызовы" value={formatNumber(summary.totals.calls)} caption={`success ${formatNumber(summary.totals.successfulCalls)} · failed ${formatNumber(summary.totals.failedCalls)}`} />
            <StatCard label="Total tokens" value={formatNumber(summary.totals.totalTokens)} />
            <StatCard label="Input tokens" value={formatNumber(summary.totals.inputTokens)} />
            <StatCard label="Output tokens" value={formatNumber(summary.totals.outputTokens)} />
            <StatCard label="Latency" value={formatLatency(summary.totals.avgLatencyMs)} />
            <StatCard label="Error rate" value={formatPercent(summary.totals.errorRate)} />
            <StatCard label="Usage coverage" value={formatPercent(summary.coverage.usageCoverageRate)} caption={`${formatNumber(summary.coverage.callsWithoutUsage)} без usage`} />
          </Box>

          <TimeseriesChart summary={summary} />

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 1.5 }}>
            <BreakdownTable title="По моделям" rows={summary.breakdowns.models} metric="tokens" />
            <BreakdownTable title="По провайдерам" rows={summary.breakdowns.providers} metric="tokens" />
            <BreakdownTable title="По задачам" rows={summary.breakdowns.tasks} metric="tokens" />
            <BreakdownTable title="По операциям" rows={summary.breakdowns.operations} metric="calls" />
          </Box>

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 1.5 }}>
            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: '20px', bgcolor: 'rgba(15, 23, 42, 0.56)', borderColor: 'rgba(148, 163, 184, 0.18)' }}>
              <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1.25 }}>Лидеры по токенам</Typography>
              <Stack spacing={1}>
                {summary.leaders.modelsByTokens.map((row) => (
                  <Chip key={`model-token-${row.key}`} label={`${row.key}: ${formatNumber(row.totalTokens)} токенов`} variant="outlined" />
                ))}
                <Divider />
                {summary.leaders.tasksByTokens.map((row) => (
                  <Chip key={`task-token-${row.key}`} label={`${row.key}: ${formatNumber(row.totalTokens)} токенов`} variant="outlined" />
                ))}
              </Stack>
            </Paper>

            <Paper variant="outlined" sx={{ p: 1.5, borderRadius: '20px', bgcolor: 'rgba(15, 23, 42, 0.56)', borderColor: 'rgba(148, 163, 184, 0.18)' }}>
              <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1.25 }}>Лидеры по количеству вызовов</Typography>
              <Stack spacing={1}>
                {summary.leaders.modelsByCalls.map((row) => (
                  <Chip key={`model-call-${row.key}`} label={`${row.key}: ${formatNumber(row.calls)} вызовов`} variant="outlined" />
                ))}
                <Divider />
                {summary.leaders.tasksByCalls.map((row) => (
                  <Chip key={`task-call-${row.key}`} label={`${row.key}: ${formatNumber(row.calls)} вызовов`} variant="outlined" />
                ))}
              </Stack>
            </Paper>
          </Box>

          <Paper variant="outlined" sx={{ p: 1.5, borderRadius: '20px', bgcolor: 'rgba(15, 23, 42, 0.56)', borderColor: 'rgba(148, 163, 184, 0.18)' }}>
            <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1.25 }}>Последние ошибки</Typography>
            {summary.recentFailures.length ? (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Время</TableCell>
                    <TableCell>Provider / Model</TableCell>
                    <TableCell>Task</TableCell>
                    <TableCell>Operation</TableCell>
                    <TableCell>Ошибка</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {summary.recentFailures.map((row) => (
                    <TableRow key={`${row.createdAt}-${row.model}-${row.taskKey}`}>
                      <TableCell>{formatDateTime(row.createdAt)}</TableCell>
                      <TableCell>
                        <Typography variant="body2">{row.provider}</Typography>
                        <Typography variant="caption" color="text.secondary">{row.model}</Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{row.taskKey}</Typography>
                        <Typography variant="caption" color="text.secondary">{row.preset}</Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={`${OPERATION_LABELS[row.operation]}${row.fallbackUsed ? ' · fallback' : ''}`}
                          variant="outlined"
                        />
                      </TableCell>
                      <TableCell sx={{ maxWidth: 420 }}>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                          {row.errorMessage || 'Без текста ошибки'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Typography variant="body2" color="text.secondary">Ошибок за выбранный период нет</Typography>
            )}
          </Paper>
        </>
      ) : null}
    </Stack>
  );
}
