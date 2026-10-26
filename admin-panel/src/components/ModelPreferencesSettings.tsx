import { useEffect, useState } from 'react';
import { Accordion, AccordionSummary, AccordionDetails, Alert, Box, Button, Card, CardContent,
  Chip, CircularProgress, Stack, ButtonBase, Typography } from '@mui/material';
import { QUALITY_LEVELS } from '../../../ai/modelPreferences';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { fetchModelPreferences, saveModelPreferences } from '../api';
import type { ModelPreferences, ModelPreferencesResponse } from '../types';

const equal = (a: ModelPreferences, b: ModelPreferences) => a.quality === b.quality;
export function ModelPreferencesSettings({ onToast, onSaved, refreshToken }: {
  onToast: (message: string, severity: 'success'|'error') => void; onSaved: () => void; refreshToken: number;
}) {
  const [data, setData] = useState<ModelPreferencesResponse | null>(null);
  const [preferences, setPreferences] = useState<ModelPreferences>({ quality: 'high' });
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
      <Typography variant="body2" color="text.secondary">Выберите качество ответов — Кира сама распределит общение и сложные задачи между доступными моделями.</Typography></Box>
    {error && <Alert severity="error" action={<Button onClick={() => void load()}>Повторить</Button>}>{error}</Alert>}
    {!data && !error && <CircularProgress size={22} aria-label="Загрузка настроек моделей" />}
    {data && <>
      <Box role="radiogroup" aria-label="Качество ответов" sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
        {QUALITY_LEVELS.map(level => <ButtonBase key={level.id} role="radio" aria-checked={preferences.quality === level.id}
          aria-label={level.title} disabled={busy} tabIndex={preferences.quality === level.id ? 0 : -1}
          onKeyDown={event => {
            const key = event.key; if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) return;
            event.preventDefault();
            const index = QUALITY_LEVELS.findIndex(item => item.id === level.id);
            const next = key === 'Home' ? 0 : key === 'End' ? 2 : (index + (['ArrowLeft', 'ArrowUp'].includes(key) ? 2 : 1)) % 3;
            setPreferences({ quality: QUALITY_LEVELS[next].id });
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
          }} onClick={() => setPreferences({ quality: level.id })}
          sx={{ display: 'block', textAlign: 'left', p: 2, height: '100%', borderRadius: 2, border: '1px solid',
            borderColor: preferences.quality === level.id ? 'primary.main' : 'divider', bgcolor: preferences.quality === level.id ? 'action.selected' : 'transparent',
            '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: 2 } }}>
          <Typography fontWeight={700} sx={{ mb: 1 }}>{level.title}</Typography>
          <Typography variant="body2" color="text.secondary">{level.description}</Typography>
          <Typography variant="body2" color={level.id === 'standard' ? 'success.light' : 'warning.light'} sx={{ mt: 1.5 }}>{level.costNote}</Typography>
        </ButtonBase>)}
      </Box>
      <Typography variant="caption" color="text.secondary">Уровень меняет модели, глубину рассуждения и лимиты ответа. Итоговый расход зависит от длины диалога и инструментов; фоновые функции настраиваются отдельно.</Typography>
      {data.activePlan?.version === 1 && <Alert severity="info">Сохранён прежний план моделей. Он продолжает работать без изменений; новый уровень включится после нажатия «Применить».</Alert>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip size="small" label={data.serviceConnected ? 'API сервиса подключён' : 'API сервиса не настроен'} />
        <Chip size="small" label={data.localConnected ? 'Локальные модели доступны' : 'Локальная модель не подключена'} />
      </Stack>
      {data.mode === 'manual' && <Alert severity="info">Сейчас действует ручной профиль. Нажмите «Применить», чтобы включить автоматический выбор по этим настройкам.</Alert>}
      {preview?.available && preview.presetName !== QUALITY_LEVELS.find(level => level.id === preferences.quality)?.preset &&
        <Alert severity="info">Используется доступный провайдер. Его модели могут совпадать на разных уровнях; уровень меняет лимиты ответа в пределах доступного каталога.</Alert>}
      {!preview?.available && <Alert severity="warning">{preview?.unavailableReason || 'Не удалось подобрать модели.'}</Alert>}
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
