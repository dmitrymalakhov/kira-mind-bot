import { useEffect, useState } from 'react';
import { Accordion, AccordionSummary, AccordionDetails, Alert, Box, Button, Card, CardContent,
  Chip, CircularProgress, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { fetchModelPreferences, saveModelPreferences } from '../api';
import type { ModelPreferences, ModelPreferencesResponse } from '../types';

const equal = (a: ModelPreferences, b: ModelPreferences) => a.cost === b.cost && a.quality === b.quality;
export function ModelPreferencesSettings({ onToast, onSaved, refreshToken }: {
  onToast: (message: string, severity: 'success'|'error') => void; onSaved: () => void; refreshToken: number;
}) {
  const [data, setData] = useState<ModelPreferencesResponse | null>(null);
  const [preferences, setPreferences] = useState<ModelPreferences>({ cost: 'medium', quality: 'high' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    try { const next = await fetchModelPreferences(); setData(next); setPreferences(next.preferences); setError(''); }
    catch { setError('Не удалось загрузить настройки. Попробуйте обновить страницу.'); }
  }
  useEffect(() => { void load(); }, [refreshToken]);
  const preview = data?.plans.find(plan => equal(plan.preferences, preferences));
  const changed = data?.mode !== 'automatic' || !equal(preferences, data.preferences)
    || Boolean(preview?.available && data.activePlan && JSON.stringify(preview.models) !== JSON.stringify(data.activePlan.models));
  async function save() {
    setBusy(true);
    try { const result = await saveModelPreferences(preferences); if (!result.success) throw new Error(result.error || 'Не удалось сохранить настройки');
      await load(); onSaved(); onToast('Настройки сохранены. Кира применит их в течение 5 секунд.', 'success'); }
    catch (error) { onToast(error instanceof Error ? error.message : 'Не удалось сохранить настройки', 'error'); }
    finally { setBusy(false); }
  }
  return <Card id="model-presets" sx={{ mb: 2 }}><CardContent><Stack spacing={2.5}>
    <Box><Typography variant="h6" component="h2">Как Кира выбирает модели</Typography>
      <Typography variant="body2" color="text.secondary">Задайте предпочтения — Кира сама распределит общение и сложные задачи между доступными моделями.</Typography></Box>
    {error && <Alert severity="error" action={<Button onClick={() => void load()}>Повторить</Button>}>{error}</Alert>}
    {!data && !error && <CircularProgress size={22} aria-label="Загрузка настроек моделей" />}
    {data && <>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <Box sx={{ flex: 1 }}><Typography fontWeight={600} sx={{ mb: 1 }}>Стоимость</Typography>
          <ToggleButtonGroup exclusive fullWidth size="small" value={preferences.cost} disabled={busy} aria-label="Стоимость"
            onChange={(_, cost) => cost && setPreferences({ ...preferences, cost })}>
            <ToggleButton value="low">Низкая</ToggleButton><ToggleButton value="medium">Средняя</ToggleButton><ToggleButton value="high">Высокая</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Определяет класс моделей и предел одного ответа. Платный фон настраивается отдельно.</Typography>
        </Box>
        <Box sx={{ flex: 1 }}><Typography fontWeight={600} sx={{ mb: 1 }}>Качество</Typography>
          <ToggleButtonGroup exclusive fullWidth size="small" value={preferences.quality} disabled={busy} aria-label="Качество"
            onChange={(_, quality) => quality && setPreferences({ ...preferences, quality })}>
            <ToggleButton value="standard">Обычное</ToggleButton><ToggleButton value="high">Высокое</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>Больше внимания сложным вопросам в пределах выбранной стоимости. Короткие реплики остаются короткими.</Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip size="small" label={data.serviceConnected ? 'API сервиса подключён' : 'API сервиса не настроен'} />
        <Chip size="small" label={data.localConnected ? 'Локальные модели доступны' : 'Локальная модель не подключена'} />
      </Stack>
      {data.mode === 'manual' && <Alert severity="info">Сейчас действует ручной профиль. Нажмите «Применить», чтобы включить автоматический выбор по этим настройкам.</Alert>}
      {preview?.available ? <Alert severity={changed ? 'info' : 'success'}>{preview.summary}</Alert>
        : <Alert severity="warning">{preview?.unavailableReason || 'Не удалось подобрать модели.'}</Alert>}
      <Stack direction="row" spacing={2} alignItems="center">
        <Button variant="contained" disabled={!changed || busy || !preview?.available} onClick={() => void save()}>
          {busy ? 'Сохраняем…' : 'Применить'}</Button>
        <Typography variant="body2" color="text.secondary">{!changed ? 'Настройки применены' : 'Изменения ещё не применены'}</Typography>
      </Stack>
      {preview?.available && preview.models && <Accordion disableGutters sx={{ '&:before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography variant="body2">Какие модели будут работать</Typography></AccordionSummary>
        <AccordionDetails><Stack spacing={1}>{[
          ['Первый ответ', preview.models.fastDialogue], ['Диалог', preview.models.conversation],
          ['Выбор инструментов', preview.models.runtimePlanning], ['Сложный анализ', preview.models.complexReasoning],
        ].map(([label, ref]) => { const model = ref as typeof preview.models.conversation;
          return <Typography variant="body2" key={String(label)}><b>{String(label)}:</b> {model.provider === 'lmstudio' ? 'На вашем компьютере' : 'API'} · {model.model}</Typography>;
        })}</Stack></AccordionDetails>
      </Accordion>}
      <Typography variant="caption" color="text.secondary">Собственные подключения не обязательны: при доступном API сервиса Кира работает через него. Свою локальную модель можно подключить в блоке ниже.</Typography>
    </>}
  </Stack></CardContent></Card>;
}
