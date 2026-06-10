import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import { buildHealthExportUrl, fetchHealthLogs } from '../api';
import type { HealthExportFormat, HealthLogKind, HealthLogQuery, HealthLogRecord, HealthLogStats } from '../types';

const KIND_LABELS: Record<HealthLogKind, string> = {
  food: 'Еда',
  drink: 'Напиток',
  symptom: 'Симптомы',
  medication: 'Лекарство',
  activity: 'Активность',
  skin: 'Кожа',
  blood_pressure: 'Давление',
  note: 'Заметка',
};

const KIND_OPTIONS: Array<{ value: HealthLogKind | ''; label: string }> = [
  { value: '', label: 'Все типы' },
  { value: 'food', label: 'Еда' },
  { value: 'drink', label: 'Напитки' },
  { value: 'symptom', label: 'Симптомы' },
  { value: 'medication', label: 'Лекарства' },
  { value: 'activity', label: 'Активность' },
  { value: 'skin', label: 'Кожа' },
  { value: 'blood_pressure', label: 'Давление' },
  { value: 'note', label: 'Заметки' },
];

type PeriodPreset = '7' | '30' | '90' | 'all' | 'custom';

interface HealthFilterDraft {
  period: PeriodPreset;
  from: string;
  to: string;
  kind: HealthLogKind | '';
  userId: string;
  q: string;
  limit: number;
}

const DEFAULT_DRAFT: HealthFilterDraft = {
  period: '30',
  from: '',
  to: '',
  kind: '',
  userId: '',
  q: '',
  limit: 100,
};

function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDateOnly(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function severityColor(value: number | null): 'default' | 'success' | 'warning' | 'error' {
  if (value == null) return 'default';
  if (value >= 8) return 'error';
  if (value >= 5) return 'warning';
  return 'success';
}

function buildQuery(draft: HealthFilterDraft, offset = 0): HealthLogQuery {
  const query: HealthLogQuery = {
    limit: draft.limit,
    offset,
  };

  if (draft.period === 'custom') {
    if (draft.from) query.from = draft.from;
    if (draft.to) query.to = draft.to;
  } else {
    query.days = draft.period;
  }

  if (draft.kind) query.kind = draft.kind;
  if (draft.userId.trim()) query.userId = draft.userId.trim();
  if (draft.q.trim()) query.q = draft.q.trim();

  return query;
}

function StatBox({ label, value, caption }: { label: string; value: string; caption?: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.paper', borderRadius: 1 }}>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.5 }}>
        {label}
      </Typography>
      <Typography variant="h6" fontWeight={700} sx={{ lineHeight: 1.2 }}>
        {value}
      </Typography>
      {caption && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

function HealthStatsStrip({ stats }: { stats: HealthLogStats | null }) {
  const avgSeverity = stats?.avgSeverity == null ? '—' : (Math.round(stats.avgSeverity * 10) / 10).toString();
  const topKinds = stats?.byKind.slice(0, 5) ?? [];

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' }, gap: 1.5, mb: 2 }}>
      <StatBox label="Записей" value={String(stats?.total ?? 0)} />
      <StatBox label="Средняя выраженность" value={avgSeverity} caption={avgSeverity === '—' ? undefined : 'по шкале 0-10'} />
      <StatBox label="Первая запись" value={formatDateOnly(stats?.firstOccurredAt)} />
      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.paper', borderRadius: 1 }}>
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.75 }}>
          Типы
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {topKinds.length ? topKinds.map((item) => (
            <Chip
              key={item.kind}
              size="small"
              label={`${KIND_LABELS[item.kind] ?? item.kind}: ${item.count}`}
              variant="outlined"
              sx={{ fontSize: '11px' }}
            />
          )) : (
            <Typography variant="caption" color="text.secondary">Нет данных</Typography>
          )}
        </Box>
      </Paper>
    </Box>
  );
}

function HealthLogRow({ record }: { record: HealthLogRecord }) {
  const [open, setOpen] = useState(false);
  const structuredEntries = Object.entries(record.structured ?? {}).filter(([, value]) => value != null && value !== '');
  const summary = record.summary || record.rawText;

  return (
    <>
      <TableRow hover>
        <TableCell sx={{ width: 36 }}>
          <IconButton size="small" onClick={() => setOpen((v) => !v)} sx={{ p: 0.25 }}>
            {open ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography variant="body2" fontWeight={600}>
            {formatDateTime(record.occurredAt)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {record.timeOfDay || 'время суток не указано'}
          </Typography>
        </TableCell>
        <TableCell>
          <Chip
            size="small"
            label={KIND_LABELS[record.kind] ?? record.kind}
            variant="outlined"
            sx={{ fontSize: '11px' }}
          />
        </TableCell>
        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
          {record.severity == null ? (
            <Typography variant="caption" color="text.disabled">—</Typography>
          ) : (
            <Chip
              size="small"
              color={severityColor(record.severity)}
              label={`${record.severity}/10`}
              variant="outlined"
              sx={{ fontSize: '11px' }}
            />
          )}
        </TableCell>
        <TableCell>
          <Typography variant="body2" sx={{ maxWidth: 360 }}>
            {summary}
          </Typography>
          <Box sx={{ display: { xs: 'flex', md: 'none' }, gap: 0.5, flexWrap: 'wrap', mt: 0.75 }}>
            {record.severity != null && (
              <Chip
                size="small"
                color={severityColor(record.severity)}
                label={`Оценка ${record.severity}/10`}
                variant="outlined"
                sx={{ fontSize: '10px' }}
              />
            )}
            {record.userId && (
              <Chip
                size="small"
                label={`User ${record.userId}`}
                variant="outlined"
                sx={{ fontSize: '10px', fontFamily: 'monospace' }}
              />
            )}
          </Box>
          {!!record.tags.length && (
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.75 }}>
              {record.tags.slice(0, 5).map((tag) => (
                <Chip key={tag} size="small" label={tag} sx={{ height: 20, fontSize: '10px' }} />
              ))}
            </Box>
          )}
        </TableCell>
        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
          <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
            {record.userId || '—'}
          </Typography>
        </TableCell>
      </TableRow>

      <TableRow>
        <TableCell colSpan={6} sx={{ p: 0, borderBottom: open ? '1px solid' : 0, borderColor: 'divider' }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ px: 3, py: 2, bgcolor: 'action.hover' }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
                <Box>
                  <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    Исходные данные
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
                    {record.rawText}
                  </Typography>
                  <Divider sx={{ my: 1.5 }} />
                  <Typography variant="caption" color="text.secondary" display="block">
                    ID записи: <Box component="span" sx={{ fontFamily: 'monospace' }}>{record.id}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Chat ID: <Box component="span" sx={{ fontFamily: 'monospace' }}>{record.chatId || '—'}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Создано: {formatDateTime(record.createdAt)}
                  </Typography>
                  {record.photoFileId && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      Photo file_id: <Box component="span" sx={{ fontFamily: 'monospace' }}>{record.photoFileId}</Box>
                    </Typography>
                  )}
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    Структурированные поля
                  </Typography>
                  {structuredEntries.length ? (
                    <Box sx={{ mt: 1, display: 'grid', gap: 0.75 }}>
                      {structuredEntries.map(([key, value]) => (
                        <Box key={key}>
                          <Typography variant="caption" color="text.disabled" sx={{ fontFamily: 'monospace' }}>
                            {key}
                          </Typography>
                          <Typography
                            component="pre"
                            variant="body2"
                            sx={{
                              m: 0,
                              mt: 0.25,
                              p: 1,
                              bgcolor: '#0d0d1a',
                              border: '1px solid',
                              borderColor: 'divider',
                              borderRadius: 1,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              fontFamily: 'inherit',
                              fontSize: '12px',
                            }}
                          >
                            {formatValue(value)}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      Нет структурированных полей
                    </Typography>
                  )}
                </Box>
              </Box>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

export function HealthSection() {
  const theme = useTheme();
  const isDesktopTable = useMediaQuery(theme.breakpoints.up('md'));
  const [draft, setDraft] = useState<HealthFilterDraft>(DEFAULT_DRAFT);
  const [query, setQuery] = useState<HealthLogQuery>(() => buildQuery(DEFAULT_DRAFT));
  const [records, setRecords] = useState<HealthLogRecord[]>([]);
  const [stats, setStats] = useState<HealthLogStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const page = Math.floor((query.offset ?? 0) / (query.limit ?? draft.limit));
  const rowsPerPage = query.limit ?? draft.limit;

  const activeFilterLabel = useMemo(() => {
    if (draft.period === 'custom') return 'Произвольный период';
    if (query.days === 'all') return 'Весь дневник';
    return `Последние ${query.days ?? 30} дней`;
  }, [draft.period, query.days]);

  const load = async (nextQuery = query) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchHealthLogs(nextQuery);
      setRecords(data.records);
      setStats(data.stats);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить дневник здоровья');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const applyFilters = () => {
    setQuery(buildQuery(draft, 0));
  };

  const resetFilters = () => {
    setDraft(DEFAULT_DRAFT);
    setQuery(buildQuery(DEFAULT_DRAFT, 0));
  };

  const download = (format: HealthExportFormat) => {
    const link = document.createElement('a');
    link.href = buildHealthExportUrl(format, query);
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={600}>Дневник здоровья</Typography>
          <Typography variant="caption" color="text.secondary">
            {activeFilterLabel}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Tooltip title="Обновить">
            <span>
              <IconButton onClick={() => load(query)} disabled={loading} size="small">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          {(['txt', 'csv', 'json'] as HealthExportFormat[]).map((format) => (
            <Button
              key={format}
              size="small"
              variant="outlined"
              startIcon={<DownloadIcon fontSize="small" />}
              onClick={() => download(format)}
              sx={{ fontSize: '12px', minWidth: 0 }}
            >
              {format.toUpperCase()}
            </Button>
          ))}
        </Box>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper', borderRadius: 1 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.1fr 1fr 1fr' }, gap: 1.5 }}>
          <TextField
            select
            size="small"
            label="Период"
            value={draft.period}
            onChange={(event) => setDraft((prev) => ({ ...prev, period: event.target.value as PeriodPreset }))}
          >
            <MenuItem value="7">Последние 7 дней</MenuItem>
            <MenuItem value="30">Последние 30 дней</MenuItem>
            <MenuItem value="90">Последние 90 дней</MenuItem>
            <MenuItem value="all">Весь дневник</MenuItem>
            <MenuItem value="custom">Даты вручную</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            label="Тип"
            value={draft.kind}
            onChange={(event) => setDraft((prev) => ({ ...prev, kind: event.target.value as HealthLogKind | '' }))}
          >
            {KIND_OPTIONS.map((option) => (
              <MenuItem key={option.value || 'all'} value={option.value}>{option.label}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="User ID"
            value={draft.userId}
            onChange={(event) => setDraft((prev) => ({ ...prev, userId: event.target.value }))}
            inputProps={{ inputMode: 'numeric' }}
          />
        </Box>

        {draft.period === 'custom' && (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5, mt: 1.5 }}>
            <TextField
              size="small"
              type="date"
              label="С даты"
              value={draft.from}
              onChange={(event) => setDraft((prev) => ({ ...prev, from: event.target.value }))}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              size="small"
              type="date"
              label="По дату"
              value={draft.to}
              onChange={(event) => setDraft((prev) => ({ ...prev, to: event.target.value }))}
              InputLabelProps={{ shrink: true }}
            />
          </Box>
        )}

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 160px auto auto' }, gap: 1.5, mt: 1.5 }}>
          <TextField
            size="small"
            label="Поиск"
            value={draft.q}
            onChange={(event) => setDraft((prev) => ({ ...prev, q: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyFilters();
            }}
          />
          <TextField
            select
            size="small"
            label="Строк"
            value={draft.limit}
            onChange={(event) => setDraft((prev) => ({ ...prev, limit: Number(event.target.value) }))}
          >
            {[50, 100, 250, 500].map((limit) => (
              <MenuItem key={limit} value={limit}>{limit}</MenuItem>
            ))}
          </TextField>
          <Button
            variant="contained"
            startIcon={<SearchIcon fontSize="small" />}
            onClick={applyFilters}
            sx={{ fontWeight: 600 }}
          >
            Найти
          </Button>
          <Button variant="text" onClick={resetFilters} sx={{ color: 'text.secondary' }}>
            Сбросить
          </Button>
        </Box>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>
      )}

      <HealthStatsStrip stats={stats} />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={32} />
        </Box>
      ) : records.length === 0 ? (
        <Alert severity="info">
          В выбранной выборке нет записей дневника здоровья.
        </Alert>
      ) : (
        <Paper variant="outlined" sx={{ bgcolor: 'background.paper', overflow: 'hidden', borderRadius: 1 }}>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: isDesktopTable ? 760 : 'auto' }}>
              <TableHead>
                <TableRow>
                  <TableCell />
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Время</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Тип</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px', display: { xs: 'none', md: 'table-cell' } }}>Оценка</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Запись</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px', display: { xs: 'none', md: 'table-cell' } }}>User ID</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {records.map((record) => (
                  <HealthLogRow key={record.id} record={record} />
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={total}
            page={page}
            rowsPerPage={rowsPerPage}
            rowsPerPageOptions={[50, 100, 250, 500]}
            labelRowsPerPage="Строк"
            labelDisplayedRows={({ from, to, count }) => `${from}-${to} из ${count}`}
            onPageChange={(_, nextPage) => {
              setQuery((prev) => ({ ...prev, offset: nextPage * rowsPerPage }));
            }}
            onRowsPerPageChange={(event) => {
              const nextLimit = Number(event.target.value);
              setDraft((prev) => ({ ...prev, limit: nextLimit }));
              setQuery((prev) => ({ ...prev, limit: nextLimit, offset: 0 }));
            }}
          />
        </Paper>
      )}
    </Box>
  );
}
