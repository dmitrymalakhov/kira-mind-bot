import { useEffect, useState } from 'react';
import {
  Alert, Button, Card, CardContent, Chip, CircularProgress,
  FormControlLabel, Stack, Switch, Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { BUDGET_MODE_COPY, BUDGET_MODES, type BudgetMode } from '../../../ai/budgetMode';
import { fetchBudgetMode, saveBudgetMode } from '../api';

interface Props {
  onToast: (message: string, severity: 'success' | 'error') => void;
}

export function BudgetSettingsSection({ onToast }: Props) {
  const [mode, setMode] = useState<BudgetMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setMode((await fetchBudgetMode()).mode);
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
      onToast(result.message, 'success');
    } catch {
      setError('Не удалось сохранить режим. Проверьте соединение и повторите попытку.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="budget-settings" sx={{ mb: 2 }}>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
            <Typography variant="subtitle1" component="h2" fontWeight={600}>Бюджет AI</Typography>
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
          <Typography variant="body2" color="text.secondary">{BUDGET_MODE_COPY.pausedSummary}</Typography>
          <Typography variant="body2">{BUDGET_MODE_COPY.activeSummary}</Typography>
          <Typography variant="body2" color="text.secondary">{BUDGET_MODE_COPY.notice} Та же настройка доступна в боте: /budget.</Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}
