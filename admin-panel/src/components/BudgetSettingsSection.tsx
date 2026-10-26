import { useEffect, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card,
  CardContent, CircularProgress, IconButton, Stack, Switch, Tooltip, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { type BudgetMode } from '../../../ai/budgetMode';
import { BACKGROUND_FEATURES, type BackgroundFeature, type BackgroundFeatureState } from '../../../ai/backgroundFeatures';
import { fetchBackgroundFeatures, saveBackgroundFeature, saveBudgetMode } from '../api';

interface Props {
  onToast: (message: string, severity: 'success' | 'error') => void;
}
function pauseLabel(feature: BackgroundFeatureState) {
  if (!feature.enabled || feature.effective) return '';
  if (feature.blockedBy === 'budget') return 'Пауза: экономия AI';
  if (feature.blockedBy === 'telegram') return 'Нужна личная Telegram-сессия';
  return `Пауза: ${feature.blockedBy ? BACKGROUND_FEATURES[feature.blockedBy].title : 'настройки'}`;
}

export function BudgetSettingsSection({ onToast }: Props) {
  const [mode, setMode] = useState<BudgetMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [features, setFeatures] = useState<BackgroundFeatureState[]>([]);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await fetchBackgroundFeatures();
      setMode(result.mode);
      setFeatures(result.features);
    } catch { setError('Не удалось загрузить функции. Повторите обновление.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function changeMode(enabled: boolean) {
    setSaving(true);
    setError('');
    try {
      const result = await saveBudgetMode(enabled ? 'maximum' : 'normal');
      setMode(result.mode);
      const snapshot = await fetchBackgroundFeatures();
      setMode(snapshot.mode);
      setFeatures(snapshot.features);
      onToast(result.message, 'success');
    } catch { setError('Не удалось сохранить режим. Повторите попытку.'); }
    finally { setSaving(false); }
  }
  async function changeFeature(feature: BackgroundFeature, enabled: boolean) {
    setSaving(true);
    setError('');
    try {
      const result = await saveBackgroundFeature(feature, enabled);
      const snapshot = await fetchBackgroundFeatures();
      setMode(snapshot.mode);
      setFeatures(snapshot.features);
      onToast(result.message, 'success');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить функцию.'); }
    finally { setSaving(false); }
  }

  function featureRow(feature: BackgroundFeatureState, label = feature.title, details = false) {
    const paused = pauseLabel(feature);
    return <Stack key={feature.key} direction="row" alignItems="center" spacing={2} sx={{ py: details ? 1.25 : 0.5, borderTop: '1px solid', borderColor: 'divider' }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography component="label" htmlFor={`feature-${feature.key}`} variant="body2">{label}</Typography>
        {paused && <Typography variant="caption" color="warning.main" display="block">{paused}</Typography>}
        {details && <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>{feature.description}</Typography>}
      </Box>
      <Switch id={`feature-${feature.key}`} checked={feature.enabled} disabled={loading || saving}
        inputProps={{ 'aria-label': feature.title }} onChange={(_, enabled) => void changeFeature(feature.key, enabled)} />
    </Stack>;
  }

  return <Card id="budget-settings" sx={{ height: '100%' }}><CardContent>
    <Stack spacing={1.5}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="subtitle1" component="h2" fontWeight={600}>Фоновые функции</Typography>
        <Tooltip title="Обновить состояния"><Box component="span"><IconButton size="small" aria-label="Обновить фоновые функции" onClick={() => void load()} disabled={loading || saving}>
          {loading || saving ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
        </IconButton></Box></Tooltip>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Tooltip title="Приостанавливает автоматические AI-функции, сохраняя ваш выбор. Ручные запросы и обычные напоминания работают.">
          <Typography component="label" htmlFor="budget-mode" variant="body2">Экономия AI</Typography>
        </Tooltip>
        <Switch id="budget-mode" checked={mode === 'maximum'} disabled={loading || saving || mode === null}
          inputProps={{ 'aria-label': 'Максимальная экономия' }} onChange={(_, enabled) => void changeMode(enabled)} />
      </Stack>
      {mode === 'maximum' && <Typography variant="caption" color="text.secondary">Автоматические AI-функции на паузе.</Typography>}
      <>
        <Box>{[...new Set(features.map(feature => feature.group))].map((group, index) => (
          <Accordion disableGutters key={group}>
            <AccordionSummary expandIcon={<ExpandMoreIcon />} id={`background-group-${index}`} aria-controls={`background-group-details-${index}`}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ width: '100%', pr: 1 }}>
                <Typography variant="body2" fontWeight={600}>{group}</Typography>
                <Typography variant="caption" color="text.secondary">{features.filter(feature => feature.group === group && feature.effective).length} / {features.filter(feature => feature.group === group).length}</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>{features.filter(feature => feature.group === group).map(feature => featureRow(feature, feature.title, true))}</AccordionDetails>
          </Accordion>
        ))}</Box>
        <Typography variant="caption" color="text.secondary">Сохраняется сразу. При паузе выбранные функции остаются включёнными в настройках.</Typography>
      </>
    </Stack>
  </CardContent></Card>;
}
