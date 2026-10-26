import { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, CircularProgress, Stack, Typography } from '@mui/material';
import { apiFetch, fetchImageGeneration, removeCharacterReference, uploadCharacterReference, type ImageGenerationConfig } from '../api';

interface Props {
  onToast: (message: string, severity: 'success' | 'error') => void;
}

export function CharacterReferenceSection({ onToast }: Props) {
  const [reference, setReference] = useState<ImageGenerationConfig['reference'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try { setReference((await fetchImageGeneration()).reference); }
    catch { setError('Не удалось загрузить образ Киры.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    setPreview('');
    if (!reference?.present) return;
    const controller = new AbortController();
    let objectUrl = '';
    void (async () => {
      const response = await apiFetch('/api/image-generation/reference', { signal: controller.signal });
      if (!response.ok) throw new Error('Референс недоступен');
      const blob = await response.blob();
      if (!controller.signal.aborted) {
        objectUrl = URL.createObjectURL(blob);
        setPreview(objectUrl);
      }
    })().catch(() => { if (!controller.signal.aborted) setError('Не удалось показать референс.'); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [reference]);

  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      setReference((await fetchImageGeneration()).reference);
      onToast(message, 'success');
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : 'Не удалось изменить образ Киры.';
      setError(message);
      onToast(message, 'error');
    } finally { setBusy(false); }
  }

  return <Card id="character-reference"><CardContent>
    <Stack spacing={2}>
      <Typography variant="subtitle1" component="h2" fontWeight={600}>Образ Киры</Typography>
      {error && <Alert severity="error" action={<Button color="inherit" size="small" disabled={busy || loading} onClick={() => void load()}>Повторить</Button>}>{error}</Alert>}
      {loading ? <CircularProgress size={20} aria-label="Загрузка образа Киры" /> : reference && (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 320px) minmax(0, 1fr)' }, gap: 3, alignItems: 'start' }}>
          <Box sx={{ minHeight: 180, display: 'grid', placeItems: 'center', bgcolor: 'background.default', borderRadius: 1, overflow: 'hidden' }}>
            {preview ? <Box component="img" src={preview} alt="Текущий эталон внешности Киры" sx={{ display: 'block', maxHeight: 360, maxWidth: '100%', objectFit: 'contain' }} />
              : <Typography variant="body2" color="text.secondary">{reference.present ? 'Загрузка изображения…' : 'Референс не выбран'}</Typography>}
          </Box>
          <Stack spacing={2} alignItems="flex-start">
            <Typography variant="body2" fontWeight={600}>{!reference.present ? 'Добавьте референс' : reference.source === 'custom' ? 'Ваш референс' : 'Стандартный образ'}</Typography>
            <Typography variant="body2" color="text.secondary">Эталон внешности для селфи и других изображений с Кирой. Для обычных картинок он не используется.</Typography>
            <Stack direction="row" flexWrap="wrap" useFlexGap gap={1}>
              <Button component="label" variant="outlined" disabled={busy}>
                {reference.present ? 'Заменить референс' : 'Загрузить референс'}
                <input hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  if (file.size > 10 * 1024 * 1024) { setError('Файл должен быть не больше 10 MiB'); return; }
                  void act(() => uploadCharacterReference(file), 'Образ Киры сохранён');
                }} />
              </Button>
              {reference.source === 'custom' && <Button disabled={busy} onClick={() => void act(removeCharacterReference, 'Восстановлен стандартный образ Киры')}>Вернуть стандартный образ</Button>}
              {busy && <CircularProgress size={20} aria-label="Сохранение образа Киры" />}
            </Stack>
            <Typography variant="caption" color="text.secondary">PNG, JPEG или WebP, до 10 MiB. Лучше использовать чёткий портрет и вид в полный рост в одном изображении. Личная замена хранится приватно.</Typography>
          </Stack>
        </Box>
      )}
    </Stack>
  </CardContent></Card>;
}
