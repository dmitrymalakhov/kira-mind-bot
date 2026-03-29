import { useEffect, useState } from 'react';
import { Box, Chip, Tooltip, Typography, CircularProgress } from '@mui/material';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';

interface ContainerInfo {
  name: string;
  status: string;
  running: boolean;
  startedAt: string | null;
}

interface StatusResponse {
  containers: ContainerInfo[];
  serverTime: string;
}

const LABELS: Record<string, string> = {
  'kira-mind-bot': '🌸 Kira',
  'sergey-brain-bot': '🧑‍💼 Sergey',
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
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      {data.containers.map((c) => {
        const uptime = formatUptime(c.startedAt);
        const label = LABELS[c.name] ?? c.name;
        const color = c.running ? '#4ade80' : '#f87171';
        const tooltipText = c.running
          ? `${c.status}${uptime ? ` · работает ${uptime}` : ''}`
          : c.status;

        return (
          <Tooltip key={c.name} title={tooltipText} arrow>
            <Chip
              size="small"
              icon={
                <FiberManualRecordIcon sx={{ fontSize: '10px !important', color: `${color} !important` }} />
              }
              label={
                <Typography variant="caption" sx={{ fontSize: '11px' }}>
                  {label}{uptime ? ` · ${uptime}` : ''}
                </Typography>
              }
              sx={{
                bgcolor: 'transparent',
                border: '1px solid',
                borderColor: c.running ? '#14532d' : '#450a0a',
                color: c.running ? '#86efac' : '#fca5a5',
                height: 24,
                cursor: 'default',
              }}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}
