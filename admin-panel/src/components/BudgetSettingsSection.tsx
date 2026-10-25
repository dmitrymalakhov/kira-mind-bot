import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardContent, Chip, CircularProgress,
  FormControlLabel, Stack, Switch, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { BUDGET_MODE_COPY, BUDGET_MODES, type BudgetMode } from '../../../ai/budgetMode';
import { BACKGROUND_FEATURES, type BackgroundFeature, type BackgroundFeatureState } from '../../../ai/backgroundFeatures';
import { fetchBackgroundFeatures, saveBackgroundFeature, saveBudgetMode } from '../api';

interface Props {
  onToast: (message: string, severity: 'success' | 'error') => void;
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
    } catch {
      setError('Не удалось загрузить режим бюджета. Нажмите «Обновить».');
    } finally {
      setLoading(false);
    }
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
    } catch {
      setError('Не удалось сохранить режим. Проверьте соединение и повторите попытку.');
    } finally {
      setSaving(false);
    }
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
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Не удалось сохранить функцию.');
    } finally { setSaving(false); }
  }

  return (
    <Card id="budget-settings" sx={{ mb: 2 }}>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <Typography variant="subtitle1" component="h2" fontWeight={600}>Экономия и фоновые функции</Typography>
            <Button size="small" sx={{ '&:not(.Mui-disabled)': { color: 'primary.light' } }} startIcon={<RefreshIcon />} onClick={() => void load()} disabled={loading || saving}>
              Обновить
            </Button>
          </Stack>
          <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1}>
            <FormControlLabel
              sx={{ m: 0 }}
              label="Максимальная экономия"
              control={(
                <Switch
                  checked={mode === 'maximum'}
                  disabled={loading || saving || mode === null}
                  onChange={(_event, enabled) => void changeMode(enabled)}
                />
              )}
            />
            {loading || saving ? <CircularProgress size={18} aria-label={saving ? 'Сохранение режима' : 'Загрузка режима'} /> : mode && (
              <Chip size="small" variant="outlined" color={mode === 'maximum' ? 'success' : 'default'} label={BUDGET_MODES[mode].title} />
            )}
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
          <Typography variant="body2">
            Выберите, что Кира может делать самостоятельно. Переключатели сохраняют ваш выбор даже при максимальной экономии.
          </Typography>
          {mode === 'maximum' && <Alert severity="info">AI-фон сейчас приостановлен. Можно настроить список заранее: после отключения экономии заработают только выбранные функции. Напоминания о непрочитанных и обычный дайджест работают без AI.</Alert>}
          {[...new Set(features.map(feature => feature.group))].map(group => (
            <Stack spacing={1} key={group}>
              <Typography variant="subtitle2" fontWeight={700}>{group}</Typography>
              {features.filter(feature => feature.group === group).map(feature => (
                <Stack key={feature.key} direction="row" alignItems="flex-start" spacing={1} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                  <Switch
                    checked={feature.enabled}
                    disabled={loading || saving}
                    inputProps={{ 'aria-label': feature.title }}
                    onChange={(_event, enabled) => void changeFeature(feature.key, enabled)}
                  />
                  <Stack spacing={0.5} sx={{ flex: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                      <Typography variant="body2" fontWeight={600}>{feature.title}</Typography>
                      <Chip size="small" variant="outlined" color={feature.effective ? 'success' : 'default'} label={
                        feature.effective ? 'Включено' : !feature.enabled ? 'Выключено'
                          : feature.blockedBy === 'budget' ? 'Пауза: экономия'
                            : feature.blockedBy === 'telegram' ? 'Нужна личная Telegram-сессия'
                            : `Пауза: ${feature.blockedBy ? BACKGROUND_FEATURES[feature.blockedBy].title : 'настройки'}`
                      } />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">{feature.description}</Typography>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          ))}
          <Typography variant="body2">{BUDGET_MODE_COPY.activeSummary}</Typography>
          <Typography variant="body2" color="text.secondary">{BUDGET_MODE_COPY.notice} Та же настройка доступна в боте: /budget.</Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
