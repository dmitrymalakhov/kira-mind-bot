import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardContent, CircularProgress, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { checkImageConnection, fetchImageGeneration, saveImageGeneration, type ImageGenerationConfig } from '../api';

export function ImageGenerationSettings({ onToast }: { onToast: (message: string, severity: 'success' | 'error') => void }) {
  const [data, setData] = useState<ImageGenerationConfig | null>(null);
  const [settings, setSettings] = useState<ImageGenerationConfig['settings'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  async function load() {
    const next = await fetchImageGeneration();
    setData(next);
    setSettings(next.settings);
  }
  useEffect(() => { void load().catch(() => setError('Не удалось загрузить настройки изображений')); }, []);
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError('');
    try { await saveImageGeneration(settings); await load(); onToast('Настройки изображений сохранены', 'success'); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Не удалось сохранить настройки'); }
    finally { setBusy(false); }
  }
  async function checkConnection() {
    if (!settings) return;
    setBusy(true);
    setConnection('');
    try {
      const result = await checkImageConnection();
      setConnection(result.models.includes(settings.model) ? 'Подключение работает, выбранная модель доступна.' : 'Подключение работает, но выбранной модели нет в каталоге.');
    } catch (failure) { setConnection(failure instanceof Error ? failure.message : 'Ошибка подключения'); }
    finally { setBusy(false); }
  }
  return <Card id="image-generation"><CardContent><Stack spacing={2}>
    <Typography variant="subtitle1" component="h2" fontWeight={600}>Генерация изображений</Typography>
    {error && <Alert severity="error">{error}</Alert>}
    {!settings || !data ? !error && <CircularProgress size={20} aria-label="Загрузка настроек изображений" /> : <>
      <FormControlLabel control={<Switch checked={settings.enabled} disabled={busy} onChange={(_, enabled) => setSettings({ ...settings, enabled })} />} label="Разрешить генерацию изображений" />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField select size="small" fullWidth label="Модель изображений" value={settings.model} disabled={busy} onChange={event => setSettings({ ...settings, model: event.target.value })}>
          {data.models.map(model => <MenuItem key={model} value={model}>{model}</MenuItem>)}
        </TextField>
        <TextField select size="small" fullWidth label="Размер" value={settings.size} disabled={busy} onChange={event => setSettings({ ...settings, size: event.target.value })}>
          {data.sizes.map(size => <MenuItem key={size} value={size}>{({ '1024x1024': 'Квадрат', '1024x1536': 'Портрет', '1536x1024': 'Альбом' } as Record<string, string>)[size]} · {size}</MenuItem>)}
        </TextField>
        <TextField select size="small" fullWidth label="Качество" value={settings.quality} disabled={busy} onChange={event => setSettings({ ...settings, quality: event.target.value })}>
          {data.qualities.map(quality => <MenuItem key={quality} value={quality}>{({ low: 'Быстрое', medium: 'Среднее', high: 'Высокое' } as Record<string, string>)[quality]}</MenuItem>)}
        </TextField>
      </Stack>
      {!data.connection.configured && <Alert severity="warning">Укажите ключ OpenAI и адрес API в разделе «Подключения → API Ключи».</Alert>}
      {connection && <Alert severity="info">{connection}</Alert>}
      <Stack direction="row" flexWrap="wrap" useFlexGap gap={1}>
        <Button variant="contained" disabled={busy || JSON.stringify(settings) === JSON.stringify(data.settings)} onClick={() => void save()}>Сохранить</Button>
        <Button disabled={busy} onClick={() => void checkConnection()}>Проверить подключение</Button>
      </Stack>
    </>}
  </Stack></CardContent></Card>;
}
