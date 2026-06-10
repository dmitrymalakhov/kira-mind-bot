import { useEffect, useState } from 'react';
import { Box, Chip, Tooltip, Typography, CircularProgress } from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';

interface ContainerInfo {
  name: string;
  status: string;
  statusLabel: string;
  details: string | null;
  running: boolean;
  startedAt: string | null;
}

interface StatusResponse {
  containers: ContainerInfo[];
  serverTime: string;
}

const LABELS: Record<string, string> = {
  'kira-mind-bot': '🌸 Kira',
};

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '';
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return '';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

function getStatusAppearance(status: string) {
  if (status === 'running') {
    return {
      dot: '#67e8f9',
      bg: 'rgba(34, 211, 238, 0.10)',
      border: 'rgba(103, 232, 249, 0.24)',
      text: '#d9fbff',
    };
  }

  if (status === 'paused' || status === 'exited' || status === 'stopped') {
    return {
      dot: '#fbbf24',
      bg: 'rgba(251, 191, 36, 0.10)',
      border: 'rgba(251, 191, 36, 0.22)',
      text: '#ffe7b0',
    };
  }

  if (status === 'restarting' || status === 'created' || status === 'removing') {
    return {
      dot: '#93c5fd',
      bg: 'rgba(96, 165, 250, 0.10)',
      border: 'rgba(147, 197, 253, 0.22)',
      text: '#dbeafe',
    };
  }

  return {
    dot: '#fca5a5',
    bg: 'rgba(248, 113, 113, 0.10)',
    border: 'rgba(248, 113, 113, 0.20)',
    text: '#ffd9d9',
  };
}

export function StatusBar() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () =>
    fetch('/api/status')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading) return <CircularProgress size={14} sx={{ color: 'text.disabled', mx: 1 }} />;
  if (!data) return null;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
      {data.containers.map((c) => {
        const uptime = formatUptime(c.startedAt);
        const label = LABELS[c.name] ?? c.name;
        const appearance = getStatusAppearance(c.status);
        const statusText = c.status === 'running'
          ? `${label} ${c.statusLabel}${uptime ? ` · ${uptime}` : ''}`
          : `${label}: ${c.statusLabel}`;
        const tooltipText = c.details || null;

        const chip = (
          <Chip
            size="small"
            icon={
              <FiberManualRecordIcon sx={{ fontSize: '9px !important', color: `${appearance.dot} !important` }} />
            }
            label={
              <Typography variant="caption" sx={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.01em' }}>
                {statusText}
              </Typography>
            }
            sx={{
              height: 26,
              px: 0.25,
              borderRadius: '13px',
              bgcolor: appearance.bg,
              border: '1px solid',
              borderColor: appearance.border,
              color: appearance.text,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
              cursor: 'default',
              '& .MuiChip-icon': {
                ml: 0.75,
                mr: '-2px',
              },
              '& .MuiChip-label': {
                px: 1,
              },
            }}
          />
        );

        return tooltipText ? (
          <Tooltip key={c.name} title={tooltipText} arrow>
            <Box component="span">{chip}</Box>
          </Tooltip>
        ) : (
          <Box key={c.name}>
            {chip}
          </Box>
        );
      })}
    </Box>
  );
}
