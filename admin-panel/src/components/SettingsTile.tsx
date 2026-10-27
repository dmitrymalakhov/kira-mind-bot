import type { ReactNode } from 'react';
import { Box, ButtonBase, Card, Stack, Typography } from '@mui/material';
import ArrowOutwardIcon from '@mui/icons-material/ArrowOutward';
export function SettingsTile({ icon, title, description, value, onClick, tint = '#EDF1E7' }: {
  icon: ReactNode; title: string; description: string; value?: string; onClick: () => void; tint?: string;
}) {
  return <Card sx={{ height: '100%' }}><ButtonBase onClick={onClick} aria-label={`Настроить: ${title}`}
    sx={{ p: 3, display: 'block', width: '100%', height: '100%', textAlign: 'left', '&:hover': { bgcolor: 'action.hover' } }}>
    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 2.5 }}>
      <Box sx={{ display: 'grid', placeItems: 'center', width: 42, height: 42, borderRadius: 2.5, bgcolor: tint, color: 'text.primary', '& svg': { fontSize: 23 } }}>{icon}</Box>
      <ArrowOutwardIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
    </Stack>
    <Typography component="h3" variant="subtitle1" sx={{ mb: .5 }}>{title}</Typography>
    <Typography variant="body2" color="text.secondary">{description}</Typography>
    {value && <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'primary.main', overflowWrap: 'anywhere' }}>{value}</Typography>}
  </ButtonBase></Card>;
}
