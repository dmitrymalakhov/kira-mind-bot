import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CircularProgress, FormControlLabel, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import { apiFetch, checkImageConnection, fetchImageGeneration, removeCharacterReference, saveImageGeneration, uploadCharacterReference, type ImageGenerationConfig } from '../api';

export function ImageGenerationSettings({ onToast }: { onToast: (message: string, severity: 'success' | 'error') => void }) {
  const [data, setData] = useState<ImageGenerationConfig | null>(null);
  const [settings, setSettings] = useState<ImageGenerationConfig['settings'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');
  const [connection, setConnection] = useState('');
  async function load() {
    const next = await fetchImageGeneration();
    setData(next); setSettings(next.settings);
  }
  useEffect(() => { void load().catch(() => setError('Не удалось загрузить настройки изображений')); }, []);
  useEffect(() => {
    if (!data?.reference.present) { setPreview(''); return; }
    const controller = new AbortController();
    let objectUrl = '';
    (async () => {
      const response = await apiFetch('/api/image-generation/reference', { signal: controller.signal });
      if (!response.ok) throw new Error('Референс недоступен');
      const blob = await response.blob();
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setPreview(objectUrl); }
    })().catch(() => { if (!controller.signal.aborted) setError('Не удалось показать референс'); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [data?.reference.present, data?.reference.sha256]);
  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true); setError('');
    try { await action(); await load(); onToast(success, 'success'); }
    catch (e) { const message = e instanceof Error ? e.message : 'Не удалось выполнить действие'; setError(message); onToast(message, 'error'); }
    finally { setBusy(false); }
  }
  return <Card id="image-generation" sx={{ mb: 2 }}><CardContent><Stack spacing={2}>
    <Typography variant="subtitle1" component="h2" fontWeight={600}>Генерация изображений</Typography>
    <Typography variant="body2" color="text.secondary">Изображения создаёт OpenAI GPT Image через настроенный lmrouter. Выбор текстовой модели LM Studio на это не влияет.</Typography>
    {error && <Alert severity="error">{error}</Alert>}
    {!settings || !data ? <CircularProgress size={20} /> : <>
      <FormControlLabel control={<Switch checked={settings.enabled} disabled={busy} onChange={(_, enabled) => setSettings({ ...settings, enabled })} />} label="Разрешить генерацию изображений" />
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
        <TextField select fullWidth label="Модель изображений" value={settings.model} disabled={busy} onChange={e => setSettings({ ...settings, model: e.target.value })}>
          {data.models.map(model => <MenuItem key={model} value={model}>{model}</MenuItem>)}
        </TextField>
        <TextField select fullWidth label="Размер" value={settings.size} disabled={busy} onChange={e => setSettings({ ...settings, size: e.target.value })}>
          {data.sizes.map(size => <MenuItem key={size} value={size}>{({ '1024x1024': 'Квадрат', '1024x1536': 'Портрет', '1536x1024': 'Альбом' } as Record<string, string>)[size]} · {size}</MenuItem>)}
        </TextField>
        <TextField select fullWidth label="Качество" value={settings.quality} disabled={busy} onChange={e => setSettings({ ...settings, quality: e.target.value })}>
          {data.qualities.map(quality => <MenuItem key={quality} value={quality}>{({ low: 'Быстрое', medium: 'Среднее', high: 'Высокое' } as Record<string, string>)[quality]}</MenuItem>)}
        </TextField>
      </Stack>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Button variant="contained" disabled={busy || JSON.stringify(settings) === JSON.stringify(data.settings)} onClick={() => void act(() => saveImageGeneration(settings), 'Настройки изображений сохранены и применятся в течение 5 секунд')}>Сохранить изображения</Button>
        <Button disabled={busy} onClick={() => { setBusy(true); setConnection(''); void checkImageConnection().then(result => setConnection(result.models.includes(settings.model) ? 'Gateway доступен, выбранная модель есть в каталоге. Проверка без генерации.' : 'Gateway доступен, выбранной модели нет в каталоге. Выберите другую модель.')).catch(e => setConnection(e.message)).finally(() => setBusy(false)); }}>Проверить подключение</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary">Подключение: {data.connection.baseUrlSource}; ключ: {data.connection.keySource}. Отдельные ключ и адрес при необходимости задаются в разделе «API Ключи».</Typography>
      {!data.connection.configured && <Alert severity="warning">Укажите ключ OpenAI и адрес lmrouter в разделе «API Ключи».</Alert>}
      {connection && <Alert severity="info">{connection}</Alert>}
      <Typography variant="subtitle2">Референс Киры</Typography>
      <Typography variant="body2" color="text.secondary">Единый эталон лица, возраста и пропорций тела. Он автоматически передаётся модели, когда Кира присутствует в сцене: селфи, портрет или фото с другими людьми. Для остальных картинок референс не используется. Один и тот же эталон улучшает постоянство внешности, хотя небольшие отличия между генерациями возможны.</Typography>
      {preview && <Box component="img" src={preview} alt="Текущий эталон внешности Киры" sx={{ maxHeight: 400, maxWidth: '100%', alignSelf: 'flex-start', objectFit: 'contain', borderRadius: 1 }} />}
      {!data.reference.present && <Alert severity="warning">Эталон ещё не задан. Добавьте изображение, чтобы Кира могла присылать свои фото с постоянной внешностью.</Alert>}
      <Typography variant="caption" color="text.secondary">Лучше использовать чёткий портрет вместе с видом в полный рост в одном изображении. PNG, JPEG или WebP, до 10 MiB. Хранится в приватных runtime-данных, вне Git и Docker-образа.</Typography>
      <Stack direction="row" spacing={1}>
        <Button component="label" variant="outlined" disabled={busy}>{data.reference.present ? 'Заменить референс' : 'Загрузить референс'}<input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; if (file.size > 10 * 1024 * 1024) { setError('Файл должен быть не больше 10 MiB'); return; } void act(() => uploadCharacterReference(file), 'Эталон внешности сохранён'); }} /></Button>
        {data.reference.present && <Button color="error" disabled={busy} onClick={() => void act(removeCharacterReference, 'Эталон удалён')}>Удалить референс</Button>}
      </Stack>
    </>}
  </Stack></CardContent></Card>;
}
