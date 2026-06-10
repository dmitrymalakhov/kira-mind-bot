import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Paper,
  Switch,
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
import AddIcon from '@mui/icons-material/Add';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import SearchIcon from '@mui/icons-material/Search';
import { createMemory, deleteMemory, fetchMemories, updateMemory } from '../api';
import type {
  MemoryFormPayload,
  MemoryFocus,
  MemoryKind,
  MemoryProfile,
  MemoryQuery,
  MemoryRecord,
  MemoryStats,
  MemoryStatus,
} from '../types';

const PROFILE_OPTIONS: Array<{ value: MemoryProfile; label: string }> = [
  { value: 'KiraMindBot', label: 'Kira' },
];

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

const KIND_LABELS: Record<string, string> = {
  fact: 'Факт',
  episode: 'Эпизод',
  chapter: 'Глава',
  trait: 'Черта',
  preference: 'Предпочтение',
  goal: 'Цель',
  open_loop: 'Открытая линия',
  relationship: 'Связь',
  routine: 'Рутина',
  boundary: 'Граница',
  promise: 'Обещание',
  prospective: 'Будущее',
  portrait: 'Портрет',
  event: 'Событие',
  state: 'Состояние',
  unknown: 'Неясно',
};

const STATUS_LABELS: Record<string, string> = {
  active: 'Активно',
  planned: 'Запланировано',
  done: 'Завершено',
  superseded: 'Заменено',
  expired: 'Истекло',
  unknown: 'Неясно',
};

const FOCUS_LABELS: Record<string, string> = {
  open_loops: 'Открытые линии',
  stale: 'Возможно устарело',
  low_confidence: 'Низкая уверенность',
  weak_evidence: 'Weak evidence',
  no_source: 'Без источника',
  anchors: 'Якоря',
  synthetic: 'Сводки и индексы',
  contacts: 'Контакты',
};

const DEFAULT_DOMAINS = Object.keys(DOMAIN_LABELS);
const DEFAULT_KINDS = Object.keys(KIND_LABELS);
const DEFAULT_STATUSES = Object.keys(STATUS_LABELS);
const DEFAULT_FOCUSES = Object.keys(FOCUS_LABELS);

type ToastFn = (message: string, severity: 'success' | 'error' | 'info') => void;

interface MemoryFilterDraft {
  profile: MemoryProfile;
  userId: string;
  domain: string;
  kind: MemoryKind | '';
  status: MemoryStatus | '';
  focus: MemoryFocus | '';
  q: string;
  includeSynthetic: boolean;
  limit: number;
}

const DEFAULT_DRAFT: MemoryFilterDraft = {
  profile: 'KiraMindBot',
  userId: '',
  domain: '',
  kind: '',
  status: '',
  focus: '',
  q: '',
  includeSynthetic: true,
  limit: 100,
};

const EMPTY_FORM: MemoryFormPayload = {
  profile: 'KiraMindBot',
  userId: '',
  domain: 'general',
  content: '',
  importance: 0.72,
  confidence: 0.82,
  tags: [],
  memoryKind: 'fact',
  status: 'active',
  isAnchor: false,
  subject: 'user',
  predicate: '',
  object: '',
  sourceContext: '',
};

function buildQuery(draft: MemoryFilterDraft, offset = 0): MemoryQuery {
  return {
    profile: draft.profile,
    userId: draft.userId.trim() || undefined,
    domain: draft.domain || undefined,
    kind: draft.kind || undefined,
    status: draft.status || undefined,
    focus: draft.focus || undefined,
    q: draft.q.trim() || undefined,
    includeSynthetic: draft.includeSynthetic,
    limit: draft.limit,
    offset,
  };
}

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

function percent(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

function confidenceColor(value: number): 'success' | 'warning' | 'error' {
  if (value >= 0.72) return 'success';
  if (value >= 0.55) return 'warning';
  return 'error';
}

function statusColor(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  if (status === 'active' || status === 'done') return 'success';
  if (status === 'planned') return 'info';
  if (status === 'unknown') return 'warning';
  if (status === 'expired' || status === 'superseded') return 'error';
  return 'default';
}

function tagsText(tags: string[]) {
  return tags.join(', ');
}

function tagsFromText(text: string) {
  return [...new Set(text.split(',').map((tag) => tag.trim()).filter(Boolean))];
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

function MemoryStatsStrip({ stats }: { stats: MemoryStats | null }) {
  const topDomains = stats?.byDomain.slice(0, 7) ?? [];
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(4, 1fr)' }, gap: 1.5, mb: 2 }}>
      <StatBox label="Воспоминаний" value={String(stats?.total ?? 0)} caption={`якорей: ${stats?.anchors ?? 0}`} />
      <StatBox label="Средняя уверенность" value={percent(stats?.avgConfidence)} caption={`низкая: ${stats?.lowConfidence ?? 0}`} />
      <StatBox label="Открытые линии" value={String(stats?.openLoops ?? 0)} caption={`возможно устарело: ${stats?.stale ?? 0}`} />
      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.paper', borderRadius: 1 }}>
        <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 0.75 }}>
          Домены
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {topDomains.length ? topDomains.map((item) => (
            <Chip
              key={item.domain}
              size="small"
              label={`${DOMAIN_LABELS[item.domain] ?? item.domain}: ${item.count}`}
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

function ReviewFocusStrip({
  active,
  stats,
  onSelect,
}: {
  active: MemoryFocus | '';
  stats: MemoryStats | null;
  onSelect: (focus: MemoryFocus | '') => void;
}) {
  const counts: Record<string, number> = {
    open_loops: stats?.openLoops ?? 0,
    stale: stats?.stale ?? 0,
    low_confidence: stats?.lowConfidence ?? 0,
    weak_evidence: stats?.weakEvidence ?? 0,
    no_source: stats?.noSource ?? 0,
    anchors: stats?.anchors ?? 0,
    synthetic: stats?.synthetic ?? 0,
    contacts: stats?.contacts ?? 0,
  };

  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 2, bgcolor: 'background.paper', borderRadius: 1 }}>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1 }}>
        Очередь ревизии
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
        <Chip
          size="small"
          label="Всё"
          color={active ? 'default' : 'primary'}
          variant={active ? 'outlined' : 'filled'}
          onClick={() => onSelect('')}
          sx={{ fontSize: '11px' }}
        />
        {(Object.keys(FOCUS_LABELS) as MemoryFocus[]).map((focus) => (
          <Chip
            key={focus}
            size="small"
            label={`${FOCUS_LABELS[focus]}: ${counts[focus] ?? 0}`}
            color={active === focus ? 'primary' : (counts[focus] ?? 0) > 0 ? 'warning' : 'default'}
            variant={active === focus ? 'filled' : 'outlined'}
            onClick={() => onSelect(focus)}
            sx={{ fontSize: '11px' }}
          />
        ))}
      </Box>
    </Paper>
  );
}

function DreamingSummary({ stats }: { stats: MemoryStats | null }) {
  const openLoop = stats?.dreaming.openLoopIndex;
  const uncertainty = stats?.dreaming.uncertaintyIndex;
  const items = [
    { title: 'Открытые линии', record: openLoop },
    { title: 'Сомнения памяти', record: uncertainty },
  ];

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper', borderRadius: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <AutoAwesomeIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" fontWeight={700}>
          Фоновая консолидация
        </Typography>
        {stats?.lastUpdatedAt && (
          <Typography variant="caption" color="text.secondary">
            Последнее обновление: {formatDateTime(stats.lastUpdatedAt)}
          </Typography>
        )}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 1.5 }}>
        {items.map((item) => (
          <Box key={item.title} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5, minHeight: 112 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
              {item.title}
            </Typography>
            {item.record ? (
              <>
                <Typography variant="body2" sx={{ mt: 0.75, whiteSpace: 'pre-wrap' }}>
                  {item.record.content.replace(/^\[[^\]]+\]\s*/u, '').slice(0, 900)}
                </Typography>
                <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1 }}>
                  {formatDateTime(item.record.timestamp)} · источников: {item.record.confirmationCount || item.record.sourceMemoryIds.length || '—'}
                </Typography>
              </>
            ) : (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                Индекс ещё не создан. Его создаёт фоновая консолидация или команда /memory_consolidate.
              </Typography>
            )}
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

function formFromRecord(record: MemoryRecord, profile: MemoryProfile, userId: string): MemoryFormPayload {
  return {
    profile,
    userId,
    domain: record.domain,
    content: record.content,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    memoryKind: record.memoryKind,
    status: record.status,
    isAnchor: record.isAnchor,
    subject: record.subject || 'user',
    predicate: record.predicate || '',
    object: record.object || '',
    sourceContext: record.sourceContext || '',
  };
}

function MemoryEditorDialog({
  open,
  mode,
  form,
  domains,
  kinds,
  statuses,
  saving,
  onChange,
  onClose,
  onSave,
}: {
  open: boolean;
  mode: 'create' | 'edit';
  form: MemoryFormPayload;
  domains: string[];
  kinds: string[];
  statuses: string[];
  saving: boolean;
  onChange: (next: MemoryFormPayload) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const [tagDraft, setTagDraft] = useState(tagsText(form.tags));

  useEffect(() => {
    setTagDraft(tagsText(form.tags));
  }, [form.tags, open]);

  const patch = (updates: Partial<MemoryFormPayload>) => onChange({ ...form, ...updates });

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="h6" fontWeight={700}>
          {mode === 'create' ? 'Добавить воспоминание' : 'Редактировать воспоминание'}
        </Typography>
        <IconButton size="small" onClick={onClose} disabled={saving} aria-label="Закрыть">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 1.5, mb: 1.5 }}>
          <TextField
            select
            size="small"
            label="Профиль"
            value={form.profile}
            onChange={(event) => patch({ profile: event.target.value as MemoryProfile })}
            disabled={mode === 'edit'}
          >
            {PROFILE_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Домен"
            value={form.domain}
            onChange={(event) => patch({ domain: event.target.value })}
            disabled={mode === 'edit'}
          >
            {domains.map((domain) => (
              <MenuItem key={domain} value={domain}>{DOMAIN_LABELS[domain] ?? domain}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="User ID"
            value={form.userId || ''}
            onChange={(event) => patch({ userId: event.target.value })}
            placeholder="по умолчанию владелец профиля"
          />
        </Box>

        <TextField
          multiline
          minRows={4}
          maxRows={12}
          fullWidth
          label="Содержание"
          value={form.content}
          onChange={(event) => patch({ content: event.target.value })}
          sx={{ mb: 1.5, '& .MuiInputBase-root': { fontSize: '13px' } }}
        />

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr 1fr' }, gap: 1.5, mb: 1.5 }}>
          <TextField
            select
            size="small"
            label="Тип"
            value={form.memoryKind}
            onChange={(event) => patch({ memoryKind: event.target.value })}
          >
            {kinds.map((kind) => (
              <MenuItem key={kind} value={kind}>{KIND_LABELS[kind] ?? kind}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Статус"
            value={form.status}
            onChange={(event) => patch({ status: event.target.value })}
          >
            {statuses.map((status) => (
              <MenuItem key={status} value={status}>{STATUS_LABELS[status] ?? status}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            type="number"
            label="Важность"
            value={form.importance}
            inputProps={{ min: 0, max: 1, step: 0.01 }}
            onChange={(event) => patch({ importance: Number(event.target.value) })}
          />
          <TextField
            size="small"
            type="number"
            label="Уверенность"
            value={form.confidence}
            inputProps={{ min: 0, max: 1, step: 0.01 }}
            onChange={(event) => patch({ confidence: Number(event.target.value) })}
          />
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1.5, mb: 1.5 }}>
          <TextField
            size="small"
            label="Предикат"
            value={form.predicate || ''}
            onChange={(event) => patch({ predicate: event.target.value })}
            placeholder="например: uses_camera"
          />
          <TextField
            size="small"
            label="Объект"
            value={form.object || ''}
            onChange={(event) => patch({ object: event.target.value })}
            placeholder="если пусто, будет использован текст"
          />
        </Box>

        <TextField
          size="small"
          fullWidth
          label="Теги через запятую"
          value={tagDraft}
          onChange={(event) => {
            setTagDraft(event.target.value);
            patch({ tags: tagsFromText(event.target.value) });
          }}
          sx={{ mb: 1.5 }}
        />

        <TextField
          multiline
          minRows={2}
          maxRows={6}
          fullWidth
          label="Источник / комментарий"
          value={form.sourceContext || ''}
          onChange={(event) => patch({ sourceContext: event.target.value })}
          sx={{ mb: 1 }}
        />

        <FormControlLabel
          control={
            <Switch
              checked={form.isAnchor}
              onChange={(event) => patch({ isAnchor: event.target.checked })}
            />
          }
          label="Якорное воспоминание"
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={saving} sx={{ color: 'text.secondary' }}>
          Отмена
        </Button>
        <Button
          variant="contained"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon fontSize="small" />}
          onClick={onSave}
          disabled={saving || form.content.trim().length < 3}
        >
          Сохранить
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function MemoryRow({
  record,
  onEdit,
  onDelete,
}: {
  record: MemoryRecord;
  onEdit: (record: MemoryRecord) => void;
  onDelete: (record: MemoryRecord) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TableRow hover>
        <TableCell sx={{ width: 36 }}>
          <IconButton
            size="small"
            onClick={() => setOpen((value) => !value)}
            sx={{ p: 0.25 }}
            aria-label={open ? 'Свернуть детали' : 'Развернуть детали'}
          >
            {open ? <KeyboardArrowUpIcon fontSize="small" /> : <KeyboardArrowDownIcon fontSize="small" />}
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography variant="body2" sx={{ maxWidth: 520 }}>
            {record.content}
          </Typography>
          <Box sx={{ display: { xs: 'flex', md: 'none' }, gap: 0.5, flexWrap: 'wrap', mt: 0.75 }}>
            <Chip size="small" label={DOMAIN_LABELS[record.domain] ?? record.domain} variant="outlined" sx={{ fontSize: '10px' }} />
            <Chip size="small" label={KIND_LABELS[record.memoryKind] ?? record.memoryKind} variant="outlined" sx={{ fontSize: '10px' }} />
            <Chip
              size="small"
              label={STATUS_LABELS[record.status] ?? record.status}
              color={statusColor(record.status)}
              variant="outlined"
              sx={{ fontSize: '10px' }}
            />
            <Chip
              size="small"
              label={percent(record.confidence)}
              color={confidenceColor(record.confidence)}
              variant="outlined"
              sx={{ fontSize: '10px' }}
            />
            <Chip
              size="small"
              label={formatDateTime(record.timestamp)}
              variant="outlined"
              sx={{ fontSize: '10px' }}
            />
          </Box>
          {!!record.tags.length && (
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.75 }}>
              {record.tags.slice(0, 5).map((tag) => (
                <Chip key={tag} size="small" label={tag} sx={{ height: 20, fontSize: '10px' }} />
              ))}
              {record.tags.length > 5 && (
                <Chip size="small" label={`+${record.tags.length - 5}`} variant="outlined" sx={{ height: 20, fontSize: '10px' }} />
              )}
            </Box>
          )}
        </TableCell>
        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
          <Chip size="small" label={DOMAIN_LABELS[record.domain] ?? record.domain} variant="outlined" sx={{ fontSize: '11px' }} />
        </TableCell>
        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
          <Chip size="small" label={KIND_LABELS[record.memoryKind] ?? record.memoryKind} variant="outlined" sx={{ fontSize: '11px' }} />
        </TableCell>
        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
          <Chip
            size="small"
            label={STATUS_LABELS[record.status] ?? record.status}
            color={statusColor(record.status)}
            variant="outlined"
            sx={{ fontSize: '11px' }}
          />
        </TableCell>
        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
          <Chip
            size="small"
            label={percent(record.confidence)}
            color={confidenceColor(record.confidence)}
            variant="outlined"
            sx={{ fontSize: '11px' }}
          />
        </TableCell>
        <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>
          <Typography variant="caption" color="text.secondary">
            {formatDateTime(record.timestamp)}
          </Typography>
        </TableCell>
        <TableCell align="right">
          <Tooltip title="Редактировать">
            <IconButton size="small" onClick={() => onEdit(record)} aria-label="Редактировать воспоминание">
              <EditIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Удалить">
            <IconButton size="small" color="error" onClick={() => onDelete(record)} aria-label="Удалить воспоминание">
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={8} sx={{ p: 0, borderBottom: open ? '1px solid' : 0, borderColor: 'divider' }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ px: 3, py: 2, bgcolor: 'action.hover' }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 2 }}>
                <Box>
                  <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    Метаданные
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                    ID: <Box component="span" sx={{ fontFamily: 'monospace' }}>{record.id}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    User ID: <Box component="span" sx={{ fontFamily: 'monospace' }}>{record.userId || '—'}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Bot ID: <Box component="span" sx={{ fontFamily: 'monospace' }}>{record.botId || '—'}</Box>
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Importance: {record.importance.toFixed(2)} · Retrievals: {record.retrievalCount} · Confirmations: {record.confirmationCount}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Last retrieved: {formatDateTime(record.lastRetrievedAt)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    Anchor: {record.isAnchor ? 'yes' : 'no'} · Synthetic: {record.synthetic ? 'yes' : 'no'}
                  </Typography>
                  {(record.predicate || record.object) && (
                    <>
                      <Divider sx={{ my: 1.5 }} />
                      <Typography variant="caption" color="text.secondary" display="block">
                        Predicate: <Box component="span" sx={{ fontFamily: 'monospace' }}>{record.predicate || '—'}</Box>
                      </Typography>
                      <Typography variant="caption" color="text.secondary" display="block">
                        Object: {record.object || '—'}
                      </Typography>
                    </>
                  )}
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    Источник и история
                  </Typography>
                  <Typography
                    component="pre"
                    variant="body2"
                    sx={{
                      m: 0,
                      mt: 1,
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
                    {record.sourceContext || 'Источник не указан'}
                  </Typography>
                  {record.previousVersions.length > 0 && (
                    <Box sx={{ mt: 1.5 }}>
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.75 }}>
                        Предыдущие версии
                      </Typography>
                      {record.previousVersions.slice(0, 3).map((version, index) => (
                        <Typography key={`${version.timestamp}-${index}`} variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                          {formatDateTime(version.timestamp)} · {percent(version.confidence)}: {version.content}
                        </Typography>
                      ))}
                    </Box>
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

export function MemorySection({ onToast }: { onToast?: ToastFn }) {
  const theme = useTheme();
  const isDesktopTable = useMediaQuery(theme.breakpoints.up('md'));
  const [draft, setDraft] = useState<MemoryFilterDraft>(DEFAULT_DRAFT);
  const [query, setQuery] = useState<MemoryQuery>(() => buildQuery(DEFAULT_DRAFT));
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [domains, setDomains] = useState<string[]>(DEFAULT_DOMAINS);
  const [kinds, setKinds] = useState<string[]>(DEFAULT_KINDS);
  const [statuses, setStatuses] = useState<string[]>(DEFAULT_STATUSES);
  const [focuses, setFocuses] = useState<string[]>(DEFAULT_FOCUSES);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'create' | 'edit'>('create');
  const [editing, setEditing] = useState<MemoryRecord | null>(null);
  const [form, setForm] = useState<MemoryFormPayload>(EMPTY_FORM);

  const page = Math.floor((query.offset ?? 0) / (query.limit ?? draft.limit));
  const rowsPerPage = query.limit ?? draft.limit;
  const activeProfile = (query.profile ?? draft.profile) as MemoryProfile;
  const activeUserId = query.userId ?? draft.userId;

  const activeFilterLabel = useMemo(() => {
    const parts = [
      PROFILE_OPTIONS.find((option) => option.value === activeProfile)?.label ?? activeProfile,
      query.domain ? DOMAIN_LABELS[query.domain] ?? query.domain : 'все домены',
      query.focus ? FOCUS_LABELS[query.focus] ?? query.focus : '',
      query.q ? `поиск: ${query.q}` : '',
    ].filter(Boolean);
    return parts.join(' · ');
  }, [activeProfile, query.domain, query.q]);

  const load = async (nextQuery = query) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchMemories(nextQuery);
      setRecords(data.records);
      setStats(data.stats);
      setTotal(data.total);
      setDomains(data.domains.length ? data.domains : DEFAULT_DOMAINS);
      setKinds(data.kinds.length ? data.kinds : DEFAULT_KINDS);
      setStatuses(data.statuses.length ? data.statuses : DEFAULT_STATUSES);
      setFocuses(data.focuses.length ? data.focuses : DEFAULT_FOCUSES);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить память');
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

  const applyFocus = (focus: MemoryFocus | '') => {
    const nextDraft = { ...draft, focus };
    setDraft(nextDraft);
    setQuery(buildQuery(nextDraft, 0));
  };

  const resetFilters = () => {
    setDraft(DEFAULT_DRAFT);
    setQuery(buildQuery(DEFAULT_DRAFT, 0));
  };

  const openCreate = () => {
    setDialogMode('create');
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      profile: activeProfile,
      userId: activeUserId || '',
      domain: draft.domain || 'general',
    });
    setDialogOpen(true);
  };

  const openEdit = (record: MemoryRecord) => {
    setDialogMode('edit');
    setEditing(record);
    setForm(formFromRecord(record, activeProfile, activeUserId || record.userId));
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      if (dialogMode === 'edit' && editing) {
        await updateMemory(editing.domain, editing.id, form);
        onToast?.('Воспоминание обновлено', 'success');
      } else {
        await createMemory(form);
        onToast?.('Воспоминание добавлено', 'success');
      }
      setDialogOpen(false);
      await load(query);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось сохранить воспоминание';
      setError(message);
      onToast?.(message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (record: MemoryRecord) => {
    const ok = window.confirm(`Удалить воспоминание?\n\n${record.content.slice(0, 220)}`);
    if (!ok) return;
    setError('');
    try {
      await deleteMemory(record.domain, record.id, { profile: activeProfile, userId: activeUserId || record.userId });
      onToast?.('Воспоминание удалено', 'success');
      await load(query);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось удалить воспоминание';
      setError(message);
      onToast?.(message, 'error');
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 2, mb: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={600}>Память</Typography>
          <Typography variant="caption" color="text.secondary">
            {activeFilterLabel}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Tooltip title="Обновить">
            <span>
              <IconButton onClick={() => load(query)} disabled={loading} size="small" aria-label="Обновить память">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            size="small"
            variant="contained"
            startIcon={<AddIcon fontSize="small" />}
            onClick={openCreate}
            sx={{ fontWeight: 600 }}
          >
            Добавить
          </Button>
        </Box>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: 'background.paper', borderRadius: 1 }}>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr 1fr 1fr' }, gap: 1.5 }}>
          <TextField
            select
            size="small"
            label="Профиль"
            value={draft.profile}
            onChange={(event) => setDraft((prev) => ({ ...prev, profile: event.target.value as MemoryProfile }))}
          >
            {PROFILE_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>{option.label}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="User ID"
            value={draft.userId}
            onChange={(event) => setDraft((prev) => ({ ...prev, userId: event.target.value }))}
            placeholder="владелец профиля"
          />
          <TextField
            select
            size="small"
            label="Домен"
            value={draft.domain}
            onChange={(event) => setDraft((prev) => ({ ...prev, domain: event.target.value }))}
          >
            <MenuItem value="">Все домены</MenuItem>
            {domains.map((domain) => (
              <MenuItem key={domain} value={domain}>{DOMAIN_LABELS[domain] ?? domain}</MenuItem>
            ))}
          </TextField>
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
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr 1fr 1.4fr auto auto' }, gap: 1.5, mt: 1.5 }}>
          <TextField
            select
            size="small"
            label="Тип"
            value={draft.kind}
            onChange={(event) => setDraft((prev) => ({ ...prev, kind: event.target.value as MemoryKind | '' }))}
          >
            <MenuItem value="">Все типы</MenuItem>
            {kinds.map((kind) => (
              <MenuItem key={kind} value={kind}>{KIND_LABELS[kind] ?? kind}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Статус"
            value={draft.status}
            onChange={(event) => setDraft((prev) => ({ ...prev, status: event.target.value as MemoryStatus | '' }))}
          >
            <MenuItem value="">Все статусы</MenuItem>
            {statuses.map((status) => (
              <MenuItem key={status} value={status}>{STATUS_LABELS[status] ?? status}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Фокус"
            value={draft.focus}
            onChange={(event) => setDraft((prev) => ({ ...prev, focus: event.target.value as MemoryFocus | '' }))}
          >
            <MenuItem value="">Вся память</MenuItem>
            {focuses.map((focus) => (
              <MenuItem key={focus} value={focus}>{FOCUS_LABELS[focus] ?? focus}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Поиск"
            value={draft.q}
            onChange={(event) => setDraft((prev) => ({ ...prev, q: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') applyFilters();
            }}
          />
          <Button variant="contained" startIcon={<SearchIcon fontSize="small" />} onClick={applyFilters} sx={{ fontWeight: 600 }}>
            Найти
          </Button>
          <Button variant="text" onClick={resetFilters} sx={{ color: 'text.secondary' }}>
            Сбросить
          </Button>
        </Box>

        <FormControlLabel
          sx={{ mt: 1 }}
          control={
            <Switch
              size="small"
              checked={draft.includeSynthetic}
              onChange={(event) => setDraft((prev) => ({ ...prev, includeSynthetic: event.target.checked }))}
            />
          }
          label={<Typography variant="caption">Показывать синтетические главы, модели и индексы</Typography>}
        />
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>
      )}

      <MemoryStatsStrip stats={stats} />
      <ReviewFocusStrip active={(query.focus ?? '') as MemoryFocus | ''} stats={stats} onSelect={applyFocus} />
      <DreamingSummary stats={stats} />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={32} />
        </Box>
      ) : records.length === 0 ? (
        <Alert severity="info">
          В выбранной выборке нет воспоминаний.
        </Alert>
      ) : (
        <Paper variant="outlined" sx={{ bgcolor: 'background.paper', overflow: 'hidden', borderRadius: 1 }}>
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: isDesktopTable ? 980 : 'auto' }}>
              <TableHead>
                <TableRow>
                  <TableCell />
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px' }}>Содержание</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px', display: { xs: 'none', md: 'table-cell' } }}>Домен</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px', display: { xs: 'none', md: 'table-cell' } }}>Тип</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px', display: { xs: 'none', md: 'table-cell' } }}>Статус</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px', display: { xs: 'none', md: 'table-cell' } }}>Уверенность</TableCell>
                  <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontSize: '12px', display: { xs: 'none', md: 'table-cell' } }}>Дата</TableCell>
                  <TableCell />
                </TableRow>
              </TableHead>
              <TableBody>
                {records.map((record) => (
                  <MemoryRow key={`${record.domain}:${record.id}`} record={record} onEdit={openEdit} onDelete={handleDelete} />
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

      <MemoryEditorDialog
        open={dialogOpen}
        mode={dialogMode}
        form={form}
        domains={domains}
        kinds={kinds}
        statuses={statuses}
        saving={saving}
        onChange={setForm}
        onClose={() => setDialogOpen(false)}
        onSave={handleSave}
      />
    </Box>
  );
}
