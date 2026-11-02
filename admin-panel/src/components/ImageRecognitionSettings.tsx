import { useEffect, useState } from 'react';
import { Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField, Typography } from '@mui/material';
import PhotoCameraOutlinedIcon from '@mui/icons-material/PhotoCameraOutlined';
import { fetchImageRecognition, saveImageRecognition, type ImageRecognitionConfig } from '../api';
import { SettingsTile } from './SettingsTile';

export function ImageRecognitionSettings({ onToast }: { onToast: (message: string, severity: 'success' | 'error') => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ImageRecognitionConfig | null>(null);
  const [settings, setSettings] = useState<ImageRecognitionConfig['settings']>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(reset = false) {
    setBusy(true); setError('');
    try {
      const next = await fetchImageRecognition();
      setData(next);
      if (reset) setSettings(next.settings);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось загрузить настройки'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(true); }, []);
  async function save() {
    setBusy(true); setError('');
    try {
      const result = await saveImageRecognition(settings);
      setSettings(result.settings);
      setData(current => current && ({ ...current, settings: result.settings }));
      onToast('Модель распознавания изображений сохранена', 'success');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить настройки'); }
    finally { setBusy(false); }
  }
  const unavailable = Boolean(settings && !data?.models.some(model => model.id === settings.model));
  const valid = !settings || !unavailable && Number.isInteger(settings.maxTokens) && settings.maxTokens >= 32 && settings.maxTokens <= 8192;
  return <>
    <SettingsTile title="Распознавание изображений" description="Описание фотографий, чтение текста и камера AR." icon={<PhotoCameraOutlinedIcon />} tint="#E7EEF3"
      value={data ? data.settings ? `LM Studio · ${data.settings.model}` : 'По стратегии диалога' : error || 'Загружаем настройки…'} onClick={() => setOpen(true)} />
    <Dialog open={open} keepMounted fullWidth maxWidth="sm" onClose={() => { if (!busy) setOpen(false); }} aria-labelledby="image-recognition-title">
      <DialogTitle id="image-recognition-title">Распознавание изображений</DialogTitle>
      <DialogContent dividers><Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">Отдельная модель для фотографий и альбомов в Telegram и приложении, а также камеры AR. Выбор действует независимо от текстовой стратегии, включая режим приложения.</Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {!data && busy && <CircularProgress size={20} aria-label="Загрузка моделей распознавания" />}
        {data && <>
          <TextField select fullWidth size="small" label="Модель распознавания" value={settings?.model ?? ''} disabled={busy}
            SelectProps={{ displayEmpty: true }} InputLabelProps={{ shrink: true }}
            onChange={event => setSettings(event.target.value ? { provider: 'lmstudio', model: event.target.value,
              maxTokens: settings?.maxTokens ?? 4096, reasoningEffort: settings?.reasoningEffort ?? 'none' } : null)}>
            <MenuItem value="">По стратегии диалога</MenuItem>
            {unavailable && <MenuItem value={settings!.model} disabled>LM Studio · {settings!.model} · недоступна</MenuItem>}
            {data.models.map(model => <MenuItem key={model.id} value={model.id}>LM Studio · {model.label}{model.loaded ? ' · загружена' : ''}</MenuItem>)}
          </TextField>
          {data.connectionError && <Alert severity="warning">{data.connectionError}</Alert>}
          {!data.connectionError && !data.models.length && <Alert severity="info">В каталоге LM Studio нет моделей с поддержкой изображений. Установите vision-модель и обновите каталог. Подключение LM Studio настраивается в Custom.</Alert>}
          {settings && <>
            <TextField size="small" type="number" label="Лимит токенов" value={settings.maxTokens} disabled={busy}
              inputProps={{ min: 32, max: 8192 }} error={!Number.isInteger(settings.maxTokens) || settings.maxTokens < 32 || settings.maxTokens > 8192}
              onChange={event => setSettings({ ...settings, maxTokens: Number(event.target.value) })} />
            <TextField select size="small" label="Рассуждения" value={settings.reasoningEffort} disabled={busy}
              onChange={event => setSettings({ ...settings, reasoningEffort: event.target.value as NonNullable<typeof settings>['reasoningEffort'] })}>
              <MenuItem value="none">Выключены</MenuItem><MenuItem value="low">Низкие</MenuItem><MenuItem value="medium">Средние</MenuItem><MenuItem value="high">Высокие</MenuItem>
            </TextField>
            <Typography variant="caption" color="text.secondary">Лимит включает скрытые рассуждения. При недоступности выбранной модели распознавание завершится ошибкой; облачная замена отключена.</Typography>
          </>}
          <Button variant="contained" disabled={busy || !valid || JSON.stringify(settings) === JSON.stringify(data.settings)} onClick={() => void save()}>Сохранить модель распознавания</Button>
        </>}
        <Button disabled={busy} onClick={() => void load(!data)}>Обновить каталог</Button>
      </Stack></DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setOpen(false)}>Закрыть</Button></DialogActions>
    </Dialog>
  </>;
}
