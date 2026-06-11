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
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import SyncProblemIcon from '@mui/icons-material/SyncProblem';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import type {
  MonitoringCheck,
  MonitoringCheckCategory,
  MonitoringCheckStatus,
  MonitoringHealthResponse,
} from '../types';
import { fetchMonitoringHealth } from '../api';

const CATEGORY_LABELS: Record<MonitoringCheckCategory, string> = {
  runtime: 'Runtime',
  storage: 'Storage',
  telegram: 'Telegram',
  ai: 'AI Providers',
};

const CATEGORY_ORDER: MonitoringCheckCategory[] = ['runtime', 'storage', 'telegram', 'ai'];

function formatDateTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatLatency(latencyMs?: number) {
  if (typeof latencyMs !== 'number') return '—';
  if (latencyMs < 1000) return `${latencyMs} мс`;
  return `${(latencyMs / 1000).toFixed(2)} c`;
}

function getOverallStatusLabel(status: MonitoringHealthResponse['overallStatus']) {
  if (status === 'ok') return 'Все основные зависимости доступны';
  if (status === 'degraded') return 'Есть деградации, но не всё упало';
  return 'Есть критические недоступные зависимости';
}

function getStatusAppearance(status: MonitoringCheckStatus | MonitoringHealthResponse['overallStatus']) {
  if (status === 'ok') {
    return {
      color: '#8af0c0',
      bg: 'rgba(16, 185, 129, 0.14)',
      border: 'rgba(110, 231, 183, 0.26)',
      icon: <CheckCircleOutlineIcon fontSize="small" />,
      label: 'OK',
    };
  }

  if (status === 'warn' || status === 'degraded') {
    return {
      color: '#ffd37d',
      bg: 'rgba(245, 158, 11, 0.14)',
      border: 'rgba(253, 224, 71, 0.26)',
      icon: <SyncProblemIcon fontSize="small" />,
      label: status === 'warn' ? 'WARN' : 'DEGRADED',
    };
  }

  if (status === 'disabled') {
    return {
      color: '#cbd5e1',
      bg: 'rgba(148, 163, 184, 0.14)',
      border: 'rgba(148, 163, 184, 0.24)',
      icon: <PauseCircleOutlineIcon fontSize="small" />,
      label: 'DISABLED',
    };
  }

  return {
    color: '#ff9f9f',
    bg: 'rgba(239, 68, 68, 0.14)',
    border: 'rgba(252, 165, 165, 0.26)',
    icon: <ErrorOutlineIcon fontSize="small" />,
    label: 'DOWN',
  };
}

function MonitoringCheckCard({ check }: { check: MonitoringCheck }) {
  const [open, setOpen] = useState(false);
  const appearance = getStatusAppearance(check.status);
  const metaEntries = Object.entries(check.meta ?? {}).filter(([, value]) => value !== null && value !== undefined && value !== '');

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.75,
        borderRadius: '18px',
        borderColor: appearance.border,
        bgcolor: 'rgba(15, 23, 42, 0.72)',
        boxShadow: '0 12px 32px rgba(2, 6, 23, 0.16)',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5, alignItems: 'flex-start' }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" fontWeight={700}>
            {check.label}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {check.summary}
          </Typography>
        </Box>
        <Chip
          size="small"
          icon={appearance.icon}
          label={appearance.label}
          sx={{
            bgcolor: appearance.bg,
            color: appearance.color,
            border: '1px solid',
            borderColor: appearance.border,
            fontWeight: 700,
            alignSelf: 'flex-start',
          }}
        />
      </Box>

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.25 }}>
        <Chip size="small" variant="outlined" label={`Latency: ${formatLatency(check.latencyMs)}`} />
        <Chip size="small" variant="outlined" label={`Проверено: ${formatDateTime(check.checkedAt)}`} />
        {metaEntries.slice(0, 3).map(([key, value]) => (
          <Tooltip key={key} title={key} arrow>
            <Chip size="small" variant="outlined" label={`${key}: ${String(value)}`} />
          </Tooltip>
        ))}
      </Stack>

      <Box sx={{ mt: 1.25, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="caption" color="text.secondary">
          {check.key}
        </Typography>
        <IconButton size="small" onClick={() => setOpen((value) => !value)} aria-label="Показать детали">
          <ExpandMoreIcon
            sx={{
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 160ms ease',
            }}
          />
        </IconButton>
      </Box>

      <Collapse in={open}>
        <Divider sx={{ my: 1.25 }} />
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {check.details}
        </Typography>
        {metaEntries.length > 3 && (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1.25 }}>
            {metaEntries.slice(3).map(([key, value]) => (
              <Chip key={key} size="small" variant="outlined" label={`${key}: ${String(value)}`} />
            ))}
          </Stack>
        )}
      </Collapse>
    </Paper>
  );
}

export function MonitoringSection() {
  const [data, setData] = useState<MonitoringHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (isManualRefresh = false) => {
    if (isManualRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await fetchMonitoringHealth();
      setData(response);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить monitoring health');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
    const intervalId = window.setInterval(() => {
      void load(true);
    }, 30_000);

    return () => window.clearInterval(intervalId);
  }, []);

  const groupedChecks = useMemo(() => {
    const groups = new Map<MonitoringCheckCategory, MonitoringCheck[]>();
    for (const category of CATEGORY_ORDER) {
      groups.set(category, []);
    }

    for (const check of data?.checks ?? []) {
      const existing = groups.get(check.category);
      if (existing) {
        existing.push(check);
      } else {
        groups.set(check.category, [check]);
      }
    }

    return groups;
  }, [data]);

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  const overallAppearance = getStatusAppearance(data?.overallStatus ?? 'down');

  return (
    <Box>
      <Paper
        variant="outlined"
        sx={{
          p: { xs: 1.75, md: 2.25 },
          mb: 2.5,
          borderRadius: '24px',
          borderColor: overallAppearance.border,
          background:
            'radial-gradient(circle at top right, rgba(59, 130, 246, 0.14), transparent 30%), linear-gradient(180deg, rgba(15,23,42,0.92) 0%, rgba(17,24,39,0.84) 100%)',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 2,
            alignItems: { xs: 'flex-start', md: 'center' },
            flexDirection: { xs: 'column', md: 'row' },
          }}
        >
          <Box>
            <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 1.2 }}>
              Общий статус
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
              <Chip
                icon={overallAppearance.icon}
                label={overallAppearance.label}
                sx={{
                  bgcolor: overallAppearance.bg,
                  color: overallAppearance.color,
                  border: '1px solid',
                  borderColor: overallAppearance.border,
                  fontWeight: 800,
                }}
              />
              <Typography variant="h6" fontWeight={800}>
                {getOverallStatusLabel(data?.overallStatus ?? 'down')}
              </Typography>
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Последний snapshot: {formatDateTime(data?.generatedAt)}
            </Typography>
          </Box>

          <Button
            variant="outlined"
            startIcon={refreshing ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            Обновить
          </Button>
        </Box>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2.5 }}>
          {error}
        </Alert>
      )}

      <Stack spacing={2.5}>
        {CATEGORY_ORDER.map((category) => {
          const checks = groupedChecks.get(category) ?? [];
          if (!checks.length) return null;

          return (
            <Box key={category}>
              <Typography variant="h6" fontWeight={800} sx={{ mb: 1.25 }}>
                {CATEGORY_LABELS[category]}
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' }, gap: 1.5 }}>
                {checks.map((check) => (
                  <MonitoringCheckCard key={check.key} check={check} />
                ))}
              </Box>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
