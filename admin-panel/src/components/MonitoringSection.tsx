import { memo, useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Collapse, Divider, Paper, Stack, Tooltip, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import type { MonitoringCheck, MonitoringCheckCategory, MonitoringHealthResponse } from '../types';
import { fetchMonitoringHealth } from '../api';
import { AiUsageSection } from './AiUsageSection';
import { getStatusAppearance } from './monitoring/statusPalette';

const CATEGORY_LABELS: Record<MonitoringCheckCategory, string> = { runtime: 'Исполнение', storage: 'Хранилище', telegram: 'Telegram', ai: 'Провайдеры ИИ' };
const STATUS_LABELS = { ok: 'исправно', warn: 'предупреждений', down: 'ошибок', disabled: 'отключено' } as const;
const CATEGORY_ORDER: MonitoringCheckCategory[] = ['runtime', 'storage', 'telegram', 'ai'];
const formatDateTime = (iso?: string | null) => iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const formatLatency = (value?: number) => typeof value !== 'number' ? '—' : value < 1000 ? `${value} мс` : `${(value / 1000).toFixed(2)} с`;
const pluralize = (value: number, one: string, few: string, many: string) => {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
};

function CheckCell({ check }: { check: MonitoringCheck }) {
  const [open, setOpen] = useState(false);
  const appearance = getStatusAppearance(check.status);
  const meta = Object.entries(check.meta ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '');
  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden', borderRadius: '12px', borderColor: open ? appearance.border : 'rgba(148,163,184,.16)', bgcolor: 'rgba(15,23,42,.48)' }}>
      <Box component="button" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', border: 0, color: 'inherit', font: 'inherit', textAlign: 'left', bgcolor: 'transparent', p: 1.1, cursor: 'pointer', '&:hover': { bgcolor: 'rgba(148,163,184,.05)' }, '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: -2 } }}>
        <FiberManualRecordIcon sx={{ fontSize: 10, color: appearance.dot, flexShrink: 0 }} />
        <Typography variant="body2" fontWeight={700} sx={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{check.label}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>{formatLatency(check.latencyMs)}</Typography>
        <ExpandMoreIcon aria-hidden sx={{ fontSize: 18, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 160ms' }} />
      </Box>
      <Collapse in={open} timeout="auto" unmountOnExit>
        <Divider />
        <Box sx={{ p: 1.25 }}>
          <Typography variant="body2">{check.summary}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: .75, whiteSpace: 'pre-wrap' }}>{check.details}</Typography>
          <Stack direction="row" spacing={.75} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
            <Chip size="small" label={`${appearance.label} · ${check.key}`} sx={{ bgcolor: appearance.bg, color: appearance.text, border: '1px solid', borderColor: appearance.border }} />
            <Chip size="small" variant="outlined" label={`Проверено: ${formatDateTime(check.checkedAt)}`} />
            {meta.map(([key, value]) => <Tooltip key={key} title={key} arrow><Chip size="small" variant="outlined" label={`${key}: ${String(value)}`} /></Tooltip>)}
          </Stack>
        </Box>
      </Collapse>
    </Paper>
  );
}

export const MonitoringSection = memo(function MonitoringSection() {
  const [data, setData] = useState<MonitoringHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async (manual = false) => {
    manual ? setRefreshing(true) : setLoading(true);
    try { setData(await fetchMonitoringHealth()); setError(null); }
    catch (value) { setError(value instanceof Error ? value.message : 'Не удалось загрузить проверки мониторинга'); }
    finally { setLoading(false); setRefreshing(false); }
  };
  useEffect(() => { void load(); const id = window.setInterval(() => void load(true), 30000); return () => window.clearInterval(id); }, []);
  const groups = useMemo(() => {
    const result = new Map<MonitoringCheckCategory, MonitoringCheck[]>();
    CATEGORY_ORDER.forEach((category) => result.set(category, []));
    (data?.checks ?? []).forEach((check) => result.get(check.category)?.push(check));
    return result;
  }, [data]);
  if (loading && !data) return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress /></Box>;
  const checks = data?.checks ?? [];
  const counts = checks.reduce<Record<string, number>>((acc, check) => { acc[check.status] = (acc[check.status] ?? 0) + 1; return acc; }, {});
  const categoryCount = new Set(checks.map((check) => check.category)).size;
  const overall = getStatusAppearance(data?.overallStatus ?? 'down');
  return (
    <Box>
      <Box id="monitor-overview" sx={{ scrollMarginTop: 20 }}>
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: '14px', borderColor: overall.border, bgcolor: 'rgba(15,23,42,.58)' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
            <Chip label={overall.label} sx={{ bgcolor: overall.bg, color: overall.text, border: '1px solid', borderColor: overall.border, fontWeight: 800 }} />
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>Снимок: {formatDateTime(data?.generatedAt)}</Typography>
            {(['ok', 'warn', 'down', 'disabled'] as const).map((status) => <Chip key={status} size="small" label={`${STATUS_LABELS[status]} ${counts[status] ?? 0}`} variant="outlined" sx={{ color: getStatusAppearance(status).text, borderColor: getStatusAppearance(status).border }} />)}
            <Chip size="small" variant="outlined" label={`${categoryCount} ${pluralize(categoryCount, 'категория', 'категории', 'категорий')}`} />
            <Button size="small" variant="outlined" startIcon={refreshing ? <CircularProgress size={13} color="inherit" /> : <RefreshIcon />} onClick={() => void load(true)} disabled={refreshing}>Проверить сейчас</Button>
          </Box>
        </Paper>
      </Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Box id="monitor-deps" sx={{ scrollMarginTop: 20 }}>
        <Stack spacing={1.75}>
          {CATEGORY_ORDER.map((category) => {
            const categoryChecks = groups.get(category) ?? [];
            if (!categoryChecks.length) return null;
            return <Box key={category}><Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: .75 }}><Chip size="small" label={CATEGORY_LABELS[category]} variant="outlined" /><Typography variant="caption" color="text.secondary">{categoryChecks.length} {pluralize(categoryChecks.length, 'проверка', 'проверки', 'проверок')}</Typography></Box><Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: .75 }}>{categoryChecks.map((check) => <CheckCell key={check.key} check={check} />)}</Box></Box>;
          })}
        </Stack>
      </Box>
      <AiUsageSection />
    </Box>
  );
});
