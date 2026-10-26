import { useEffect, useState, type ReactNode } from 'react';
import { Accordion, AccordionSummary, AccordionDetails, Alert, Box, Button, Card, CardContent,
  Chip, CircularProgress, Stack, ButtonBase, Typography, TextField, MenuItem, Dialog, DialogTitle,
  DialogContent, DialogActions, FormControlLabel, Switch } from '@mui/material';
import { QUALITY_LEVELS, TEXT_TASKS, type CustomStrategy, type StrategyRequest, type CustomRoute } from '../../../ai/modelPreferences';
import rawRegistry from '../ai-model-presets.json';
import type { AiModelRef, AiPresetConfig } from '../../../ai/modelPresets';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { fetchModelPreferences, saveModelPreferences } from '../api';
import { getAiProviderDescriptor } from '../../../ai/providerMetadata';
import type { AiPresetName, ModelPreferences, ModelPreferencesResponse } from '../types';

const registry = rawRegistry as unknown as { presets: Record<AiPresetName, AiPresetConfig>; presetNames: AiPresetName[] };
const labels: Record<string, string> = {
  fastDialogue: 'Первый ответ', conversation: 'Диалог', runtimePlanning: 'Выбор инструментов', complexReasoning: 'Сложный анализ',
  defaultText: 'Повседневный текст', lightweightText: 'Короткие проверки', intentClassification: 'Понимание запроса',
  intentDedup: 'Проверка повторов', memoryExtraction: 'Извлечение фактов', memoryConsolidation: 'Обобщение памяти',
  messageAnalysis: 'Анализ сообщений', browserPlanning: 'Планирование браузера',
};
const equal = (a: ModelPreferences, b: ModelPreferences) => a.quality === b.quality && (a.provider || 'auto') === (b.provider || 'auto');
const local = (models?: Record<string, AiModelRef>) => Object.values(models || {}).some(ref => ref.provider === 'lmstudio');

export function ModelPreferencesSettings({ onToast, localConnection }: {
  onToast: (message: string, severity: 'success'|'error') => void; localConnection: ReactNode;
}) {
  const [data, setData] = useState<ModelPreferencesResponse | null>(null);
  const [preferences, setPreferences] = useState<ModelPreferences>({ quality: 'high' });
  const [mode, setMode] = useState<'automatic'|'custom'>('automatic');
  const [draft, setDraft] = useState<CustomStrategy | null>(null);
  const [dialog, setDialog] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function fromModels(presetName: AiPresetName, models: Record<string, AiModelRef>, quality: ModelPreferences['quality']): CustomStrategy {
    return { mode: 'custom', quality, presetName, routes: Object.fromEntries(TEXT_TASKS.map(task => {
      const ref = models[task];
      const route = ref.localRole && data?.localRoutes[ref.localRole];
      return [task, { provider: ref.provider, model: ref.allowFallback === false ? ref.model : route ? route.model : ref.model,
        maxTokens: ref.generation?.maxTokens || (route && route.maxTokens) || registry.presets[presetName].outputTokenLimits?.[task] || 2048,
        reasoningEffort: ref.generation?.reasoningEffort || (route && route.reasoningEffort) || 'none' }];
    })) };
  }
  async function load() {
    try {
      const next = await fetchModelPreferences(); setData(next); setPreferences(next.preferences); setError('');
      const models = next.activePlan?.models || registry.presets[next.manualPreset].models;
      setMode(next.mode === 'automatic' && !local(models) ? 'automatic' : 'custom');
      setLocalEnabled(local(models));
      // Resolve legacy local roles only for the editable draft; the saved runtime is untouched.
      setDraft({ mode: 'custom', quality: next.preferences.quality, presetName: next.activePlan?.presetName || next.manualPreset,
        routes: Object.fromEntries(TEXT_TASKS.map(task => {
          const ref = models[task]; const route = ref.localRole && next.localRoutes[ref.localRole];
          return [task, { provider: ref.provider, model: ref.allowFallback === false ? ref.model : route ? route.model : ref.model,
            maxTokens: ref.generation?.maxTokens || (route && route.maxTokens) || registry.presets[next.manualPreset].outputTokenLimits?.[task] || 2048,
            reasoningEffort: ref.generation?.reasoningEffort || (route && route.reasoningEffort) || 'none' }];
        })) });
    } catch { setError('Не удалось загрузить настройки моделей.'); }
  }
  useEffect(() => { void load(); }, []);
  const preview = [...(data?.plans || []), ...(data?.providerPlans || [])].find(plan => equal(plan.preferences, preferences));
  const changed = data?.mode !== 'automatic' || !equal(preferences, data.preferences)
    || Boolean(preview?.available && data.activePlan && JSON.stringify(preview.models) !== JSON.stringify(data.activePlan.models));
  async function save(request: StrategyRequest) {
    setBusy(true);
    try {
      const result = await saveModelPreferences(request);
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить стратегию');
      await load(); setDialog(false); onToast('Стратегия сохранена. Кира применит её в течение 5 секунд.', 'success');
    } catch (failure) { onToast(failure instanceof Error ? failure.message : 'Не удалось сохранить стратегию', 'error'); }
    finally { setBusy(false); }
  }
  function openCustom(withLocal = mode === 'custom' && local(data?.activePlan?.models || registry.presets[data?.manualPreset || 'gpt-balanced'].models)) {
    if (mode === 'custom' && data) {
      const models = data.activePlan?.models || registry.presets[data.manualPreset].models;
      setDraft(fromModels(data.activePlan?.presetName || data.manualPreset, models, preferences.quality));
    }
    if (mode === 'automatic' && preview?.models && preview.presetName) setDraft(fromModels(preview.presetName, preview.models, preferences.quality));
    if (withLocal && !local(data?.activePlan?.models || registry.presets[data?.manualPreset || 'gpt-balanced'].models)) {
      const base = registry.presets['lmstudio-local'];
      setDraft(fromModels('lmstudio-local', base.models, preferences.quality));
    }
    if (!withLocal && data) {
      const cloud = data.plans.find(plan => plan.preferences.quality === preferences.quality && plan.available);
      const savedModels = data.activePlan?.models || registry.presets[data.manualPreset].models;
      if (local(savedModels) && cloud?.models && cloud.presetName) {
        const current = fromModels(data.activePlan?.presetName || data.manualPreset, savedModels, preferences.quality);
        const replacement = fromModels(cloud.presetName, cloud.models, preferences.quality);
        setDraft({ ...current, presetName: cloud.presetName, routes: Object.fromEntries(Object.entries(current.routes)
          .map(([task, route]) => [task, route.provider === 'lmstudio' ? replacement.routes[task] : route])) });
      }
    }
    setLocalEnabled(withLocal); setDialog(true);
  }
  function toggleLocal(enabled: boolean) {
    setLocalEnabled(enabled);
    if (!enabled && draft) {
      const cloud = data?.plans.find(plan => plan.preferences.quality === draft.quality && plan.available);
      if (cloud?.models && cloud.presetName) setDraft(current => current && ({ ...current, presetName: cloud.presetName!,
        routes: Object.fromEntries(Object.entries(current.routes).map(([task, route]) => [task, route.provider === 'lmstudio'
          ? fromModels(cloud.presetName!, cloud.models!, draft.quality).routes[task] : route])) }));
    }
  }
  const draftHasLocal = Object.values(draft?.routes || {}).some(route => route.provider === 'lmstudio');
  const draftInvalid = !draft || !localEnabled && draftHasLocal || Object.values(draft.routes).some(route => !data?.catalog.some(ref => ref.provider === route.provider && ref.model === route.model)
    || !Number.isInteger(route.maxTokens) || route.maxTokens < 32 || route.maxTokens > 16384);
  return <Card id="model-presets" sx={{ mb: 2 }}><CardContent><Stack spacing={2.5}>
    <Box><Typography variant="h6" component="h2">Как Кира выбирает модели</Typography>
      <Typography variant="body2" color="text.secondary">Доверьте распределение задач Кире или настройте свою стратегию.</Typography></Box>
    {error && <Alert severity="error" action={<Button onClick={() => void load()}>Повторить</Button>}>{error}</Alert>}
    {!data && !error && <CircularProgress size={22} aria-label="Загрузка настроек моделей" />}
    {data && <>
      <TextField select label="Стратегия" value={mode} disabled={busy} onChange={event => {
        if (event.target.value === 'custom') openCustom(); else setMode('automatic');
      }}>
        <MenuItem value="automatic">Автоматически</MenuItem>
        <MenuItem value="custom">Custom · моя стратегия</MenuItem>
      </TextField>
      {mode === 'custom' ? <Stack spacing={2}>
        <Alert severity="info">Действует своя стратегия: {data.activePlan?.source === 'custom' ? 'модели и параметры заданы вручную' : registry.presets[data.manualPreset].title}. Автоматический режим включится только после «Применить».</Alert>
        <Button variant="outlined" onClick={() => openCustom()}>Редактировать стратегию Custom</Button>
      </Stack> : <>
        <TextField select label="Провайдер API" value={preferences.provider || 'auto'} disabled={busy}
          onChange={event => setPreferences(current => ({ ...current, provider: event.target.value as ModelPreferences['provider'] }))}
          helperText={data.providers.find(item => item.id === (preferences.provider || 'auto'))?.description}>
          {data.providers.map(provider => {
            const available = provider.id === 'auto' || data.providerPlans.some(plan => plan.preferences.provider === provider.id && plan.available);
            return <MenuItem key={provider.id} value={provider.id} disabled={!available}>{provider.title}{available ? '' : ' · подключите API'}</MenuItem>;
          })}
        </TextField>
        <Box role="radiogroup" aria-label="Качество ответов" sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
          {QUALITY_LEVELS.map(level => <ButtonBase key={level.id} role="radio" aria-checked={preferences.quality === level.id}
            aria-label={level.title} disabled={busy} tabIndex={preferences.quality === level.id ? 0 : -1}
            onKeyDown={event => {
              if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault(); const index = QUALITY_LEVELS.findIndex(item => item.id === level.id);
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? 2 : 1)) % 3;
              setPreferences(current => ({ ...current, quality: QUALITY_LEVELS[next].id }));
              event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
            }} onClick={() => setPreferences(current => ({ ...current, quality: level.id }))}
            sx={{ display: 'block', textAlign: 'left', p: 2, height: '100%', borderRadius: 2, border: '1px solid',
              borderColor: preferences.quality === level.id ? 'primary.main' : 'divider', bgcolor: preferences.quality === level.id ? 'action.selected' : 'transparent',
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.light', outlineOffset: 2 } }}>
            <Typography fontWeight={700} sx={{ mb: 1 }}>{level.title}</Typography>
            <Typography variant="body2" color="text.secondary">{level.description}</Typography>
            <Typography variant="body2" color={level.id === 'standard' ? 'success.light' : 'warning.light'} sx={{ mt: 1.5 }}>{level.costNote}</Typography>
          </ButtonBase>)}
        </Box>
        <Typography variant="caption" color="text.secondary">Стоимость сравнивается между уровнями одного провайдера. Это относительная оценка: точный счёт зависит от тарифов API, контекста и инструментов. Фоновые функции настраиваются отдельно.</Typography>
        {!preview?.available && <Alert severity="warning">{preview?.unavailableReason || 'Не удалось подобрать модели.'}</Alert>}
        <Stack direction="row" spacing={2} alignItems="center">
          <Button variant="contained" disabled={!changed || busy || !preview?.available} onClick={() => void save(preferences)}>{busy ? 'Сохраняем…' : 'Применить'}</Button>
          <Typography variant="body2" color="text.secondary">{changed ? 'Изменения ещё не применены' : 'Настройки применены'}</Typography>
        </Stack>
        {preview?.models && <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon />}>Какие модели будут работать</AccordionSummary>
          <AccordionDetails><Stack spacing={1}>{['fastDialogue', 'conversation', 'runtimePlanning', 'complexReasoning'].map(task => {
            const ref = preview.models![task as keyof typeof preview.models];
            return <Typography variant="body2" key={task}><b>{labels[task]}:</b> {getAiProviderDescriptor(ref.provider).label} · {ref.model}</Typography>;
          })}</Stack></AccordionDetails></Accordion>}
      </>}
      <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 1 }}>
        <FormControlLabel label="Использовать локальные модели · Custom" control={<Switch checked={local(data.activePlan?.models || registry.presets[data.manualPreset].models)}
          disabled={busy} onChange={(_, enabled) => enabled ? openCustom(true) : openCustom(false)} />} />
        <Typography variant="body2" color="text.secondary">Тумблер открывает настройку Custom. Включение или отключение применяется после сохранения стратегии. По умолчанию используются API, выбранные системой.</Typography>
      </Box>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap><Chip size="small" label={data.serviceConnected ? 'API подключён' : 'Подключите API'} />
        <Chip size="small" label={data.localConnected ? 'Локальный сервер доступен' : 'Локальный сервер не подключён'} /></Stack>
    </>}
  </Stack></CardContent>
    <Dialog open={dialog} keepMounted fullWidth maxWidth="lg" onClose={() => { if (!busy) { setDialog(false); setLocalEnabled(local(data?.activePlan?.models || registry.presets[data?.manualPreset || 'gpt-balanced'].models)); } }}>
      <DialogTitle>Custom · своя стратегия</DialogTitle>
      <DialogContent dividers><Stack spacing={2.5}>
        <Typography color="text.secondary">Выберите основу, затем задайте модели, лимиты и рассуждения для задач. Текстовые маршруты закрепляются без автоматической замены.</Typography>
        <TextField select label="Основа стратегии" value={draft?.presetName || 'gpt-balanced'} disabled={busy} onChange={event => {
          const name = event.target.value as AiPresetName; const models = registry.presets[name].models;
          setDraft(fromModels(name, models, preferences.quality)); setLocalEnabled(local(models));
        }}>{registry.presetNames.map(name => <MenuItem key={name} value={name}>{registry.presets[name as AiPresetName].title}</MenuItem>)}</TextField>
        <FormControlLabel label="Подключить локальные модели" control={<Switch checked={localEnabled} disabled={busy} onChange={(_, enabled) => toggleLocal(enabled)} />} />
        <Box sx={{ display: localEnabled ? 'block' : 'none' }}>{localConnection}
          <Alert severity="info">Для Docker Desktop: host.docker.internal. Изменение URL и ключа требует пересоздания контейнеров. Нажмите «Сохранить» в блоке подключения, затем обновите каталог.</Alert>
          <Button disabled={busy} onClick={async () => {
            try { const next = await fetchModelPreferences(); setData(next); } catch { onToast('Не удалось обновить каталог', 'error'); }
          }}>Обновить каталог моделей</Button>
          {data?.localError && <Alert severity="warning">{data.localError}</Alert>}
        </Box>
        {draftInvalid && <Alert severity="warning">Для сохранения выберите доступные модели во всех задачах и лимиты от 32 до 16384 токенов.</Alert>}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          {draft && TEXT_TASKS.map(task => {
            const route = draft.routes[task];
            const choices = (data?.catalog || []).filter(ref => localEnabled || ref.provider !== 'lmstudio');
            if (!choices.some(ref => ref.provider === route.provider && ref.model === route.model)) choices.push({ provider: route.provider, model: route.model });
            const update = (patch: Partial<CustomRoute>) => setDraft(current => current && ({ ...current, routes: { ...current.routes, [task]: { ...current.routes[task], ...patch } } }));
            return <Stack key={task} spacing={1.5} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, minWidth: 0 }}>
              <Typography fontWeight={600}>{labels[task]}</Typography>
              <TextField select size="small" label={`Модель: ${labels[task]}`} value={`${route.provider}:${route.model}`} disabled={busy}
                onChange={event => { const ref = choices.find(ref => `${ref.provider}:${ref.model}` === event.target.value); if (ref) { update(ref); if (ref.provider === 'lmstudio') setLocalEnabled(true); } }}>
                {choices.map(ref => <MenuItem key={`${ref.provider}:${ref.model}`} value={`${ref.provider}:${ref.model}`}>{getAiProviderDescriptor(ref.provider).label} · {ref.model}</MenuItem>)}
              </TextField>
              <Stack direction="row" spacing={1}><TextField select size="small" fullWidth label={`Рассуждения: ${labels[task]}`} value={route.reasoningEffort} disabled={busy}
                onChange={event => update({ reasoningEffort: event.target.value as CustomRoute['reasoningEffort'] })}>
                <MenuItem value="none">Выключены</MenuItem><MenuItem value="low">Низкие</MenuItem><MenuItem value="medium">Средние</MenuItem><MenuItem value="high">Высокие</MenuItem>
              </TextField><TextField size="small" type="number" fullWidth label={`Лимит: ${labels[task]}`} value={route.maxTokens} disabled={busy}
                inputProps={{ min: 32, max: 16384 }} onChange={event => update({ maxTokens: Number(event.target.value) })} /></Stack>
            </Stack>;
          })}
        </Box>
        <Alert severity="info">Поиск, зрение и голос используют подключения основы стратегии. Векторы памяти остаются в действующем профиле. Параметры рассуждений применяются, если модель их поддерживает.</Alert>
        {draftHasLocal && <Typography variant="body2" color="warning.main">При недоступности локальной модели задача завершится ошибкой; облачная замена отключена.</Typography>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setDialog(false)}>Отмена</Button>
        <Button variant="contained" disabled={busy || draftInvalid} onClick={() => draft && void save(draft)}>{busy ? 'Сохраняем…' : 'Сохранить стратегию Custom'}</Button></DialogActions>
    </Dialog>
  </Card>;
}
