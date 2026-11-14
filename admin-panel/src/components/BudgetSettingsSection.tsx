import { useEffect, useState } from 'react';
import { useAccountDraft } from '../accountEdits';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card,
  CardContent, CircularProgress, IconButton, Radio, Stack, Switch, Tooltip, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { type BudgetMode } from '../../../ai/budgetMode';
import type { ActivityMode, ActivityModeDescriptor } from '../../../ai/activityModes';
import { BACKGROUND_FEATURES, type BackgroundFeature, type BackgroundFeatureState } from '../../../ai/backgroundFeatures';
import { fetchBackgroundFeatures, saveActivityMode, saveBackgroundFeature, saveBudgetMode } from '../api';
import { AccountQuotaPanel } from './AccountQuotaPanel';
import type { QuotaView } from '../../../platform/publicAccounts/contracts';

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
  const [quota, setQuota] = useState<QuotaView | null>(null);
  const [mode, setMode] = useState<BudgetMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [features, setFeatures] = useState<BackgroundFeatureState[]>([]);
  const [activity, setActivity] = useState<ActivityMode | null>(null);
  const [draft, setDraft] = useState<ActivityMode | null>(null);
  const [catalog, setCatalog] = useState<ActivityModeDescriptor[]>([]);
  const [advanced, setAdvanced] = useState(false);
  useAccountDraft(Boolean(draft && activity && draft !== activity));
  function accept(result: Awaited<ReturnType<typeof fetchBackgroundFeatures>>) {
    setMode(result.mode); setFeatures(result.features); setActivity(result.activityMode);
    setDraft(result.activityMode); setCatalog(result.activityModes);
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await fetchBackgroundFeatures();
      accept(result);
    } catch { setError('Не удалось загрузить функции. Повторите обновление.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  async function changeMode(enabled: boolean) {
    setSaving(true);
    setError('');
    try {
      const result = await saveBudgetMode(enabled ? 'maximum' : 'normal');
      const snapshot = await fetchBackgroundFeatures();
      accept(snapshot);
      onToast(result.message, 'success');
    } catch { setError('Не удалось сохранить режим. Повторите попытку.'); }
    finally { setSaving(false); }
  }
  async function applyActivity() {
    if (!draft || draft === 'custom') return;
    setSaving(true); setError(''); let saved = false;
    try {
      const result = await saveActivityMode(draft); saved = true;
      accept(await fetchBackgroundFeatures()); onToast(result.message, 'success');
    } catch (failure) {
      setError(saved ? 'Режим сохранён, но состояние не удалось обновить. Нажмите обновление.' : failure instanceof Error ? failure.message : 'Не удалось сохранить режим.');
    } finally { setSaving(false); }
  }
  async function changeFeature(feature: BackgroundFeature, enabled: boolean) {
    setSaving(true);
    setError('');
    try {
      const result = await saveBackgroundFeature(feature, enabled);
      const snapshot = await fetchBackgroundFeatures();
      accept(snapshot);
      onToast(result.message, 'success');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить функцию.'); }
    finally { setSaving(false); }
  }

  function featureRow(feature: BackgroundFeatureState, label = feature.title, details = false) {
    const paused = feature.effective && BACKGROUND_FEATURES[feature.key].budgetPaused && quota?.background.remaining === 0
      ? 'Новые задачи на паузе: квота фона исчерпана' : pauseLabel(feature);
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
      <AccountQuotaPanel onQuota={setQuota} />
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="subtitle1" component="h2" fontWeight={600} id="activity-heading">Активность Киры</Typography>
        <Tooltip title="Обновить состояния"><Box component="span"><IconButton size="small" aria-label="Обновить фоновые функции" onClick={() => void load()} disabled={loading || saving}>
          {loading || saving ? <CircularProgress size={18} /> : <RefreshIcon fontSize="small" />}
        </IconButton></Box></Tooltip>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Typography variant="body2" color="text.secondary">Выберите, что Кира делает автоматически. Общение, ручные поручения, сохранённая память и обычные напоминания доступны в любом режиме.</Typography>
      {activity && <Typography variant="body2">Сейчас: <strong>{catalog.find(item => item.key === activity)?.title}</strong></Typography>}
      {mode === 'maximum' && <Alert severity="info">Фоновый AI на паузе. Применение готового режима снимет паузу.</Alert>}
      <Box role="radiogroup" aria-labelledby="activity-heading" sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }, gap: 1 }}>
        {catalog.map(item => <Box component="label" key={item.key} sx={{ display: 'flex', alignItems: 'flex-start', p: 1, border: '1px solid', borderRadius: 2,
          borderColor: draft === item.key ? 'primary.main' : 'divider', bgcolor: draft === item.key ? 'action.selected' : 'transparent',
          gridColumn: item.key === 'custom' ? '1 / -1' : 'auto', cursor: loading || saving ? 'default' : 'pointer' }}>
          <Radio name="activity-mode" value={item.key} checked={draft === item.key} disabled={loading || saving}
            inputProps={{ 'aria-label': item.title }} onChange={() => { setDraft(item.key); if (item.key === 'custom') setAdvanced(true); }} />
          <Box sx={{ minWidth: 0, pt: 1 }}><Typography variant="body2" fontWeight={600}>{item.title}</Typography>
            <Typography variant="caption" color="text.secondary">{item.description}</Typography></Box>
        </Box>)}
      </Box>
      {catalog.filter(item => item.key === draft).map(item => <Box key={item.key} aria-live="polite">
        <Box component="ul" sx={{ m: 0, pl: 2.5 }}>{item.benefits.map(benefit => <Typography key={benefit} component="li" variant="body2">{benefit}</Typography>)}</Box>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{item.costNote}</Typography>
      </Box>)}
      {draft !== 'custom' && <Button variant="contained" onClick={() => void applyActivity()} disabled={loading || saving || !draft || (draft === activity && mode === 'normal')}>Применить режим</Button>}
      <Typography variant="caption" color="text.secondary">Выбор режима меняет автоматическую активность. Качество ответов задаётся на странице моделей. Согласие на AI, ограничения аккаунта и доступ к Telegram проверяются отдельно.</Typography>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
        <Tooltip title="Приостанавливает автоматические AI-функции, сохраняя ваш выбор. Ручные запросы и обычные напоминания работают.">
          <Typography component="label" htmlFor="budget-mode" variant="body2">Приостановить фоновый AI</Typography>
        </Tooltip>
        <Switch id="budget-mode" checked={mode === 'maximum'} disabled={loading || saving || mode === null}
          inputProps={{ 'aria-label': 'Приостановить фоновый AI' }} onChange={(_, enabled) => void changeMode(enabled)} />
      </Stack>
      <Typography variant="caption" color="text.secondary">Пауза сохраняет выбранные функции. Обычные напоминания, включённый дайджест и напоминания о непрочитанных продолжают работать без AI.</Typography>
      <Accordion disableGutters expanded={advanced} onChange={(_, expanded) => setAdvanced(expanded)}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />} aria-controls="activity-custom-details" id="activity-custom-heading"><Typography variant="body2" fontWeight={600}>Настроить под себя</Typography></AccordionSummary>
        <AccordionDetails id="activity-custom-details">
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
        </AccordionDetails>
      </Accordion>
    </Stack>
  </CardContent></Card>;
}
