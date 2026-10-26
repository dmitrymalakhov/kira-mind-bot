import { useEffect, useState, type ReactNode } from 'react';
import { Accordion, AccordionSummary, AccordionDetails, Alert, Box, Button, Card, CardContent,
  Chip, CircularProgress, Stack, ButtonBase, Typography, TextField, MenuItem, Dialog, DialogTitle,
  DialogContent, DialogActions, FormControlLabel, Switch } from '@mui/material';
import { QUALITY_LEVELS, TEXT_TASKS, getCustomPresetName, type CustomStrategy, type StrategyRequest, type CustomRoute } from '../../../ai/modelPreferences';
import rawRegistry from '../ai-model-presets.json';
import type { AiModelRef, AiPresetConfig, AiProvider, AiTaskKey } from '../../../ai/modelPresets';
import { customDraftFromModels, customDraftForProvider, inferCustomProvider } from '../modelStrategyEditor';
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    try {
      const next = await fetchModelPreferences(); setData(next); setPreferences(next.preferences); setError('');
      const models = next.activePlan?.models || registry.presets[next.manualPreset].models;
      setMode(next.mode === 'automatic' && !local(models) ? 'automatic' : 'custom');
      setDraft(customDraftFromModels(models, next.preferences.quality, next.localRoutes,
        next.activePlan?.outputTokenLimits || registry.presets[next.manualPreset].outputTokenLimits));
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
  function openCustom(withLocal?: boolean) {
    if (!data) return;
    const plan = mode === 'automatic' && preview?.models ? preview : data.activePlan;
    const models = plan?.models || registry.presets[data.manualPreset].models;
    let next = customDraftFromModels(models, preferences.quality, data.localRoutes,
      plan?.outputTokenLimits || registry.presets[data.manualPreset].outputTokenLimits);
    if (withLocal === true) next = next?.provider === 'lmstudio' ? next
      : customDraftForProvider('lmstudio', preferences.quality, data.catalog, data.localRoutes);
    if (withLocal === false) {
      const cloud = data.plans.find(plan => plan.preferences.quality === preferences.quality && plan.available);
      next = cloud?.models ? customDraftFromModels(cloud.models, preferences.quality, data.localRoutes, cloud.outputTokenLimits) : null;
    }
    setDraft(next); setDialog(true);
  }
  function selectProvider(provider: AiProvider) {
    if (!data || provider === draft?.provider) return;
    setDraft(customDraftForProvider(provider, preferences.quality, data.catalog, data.localRoutes));
  }
  const localEnabled = draft?.provider === 'lmstudio';
  const choices = (data?.catalog || []).filter(ref => ref.provider === draft?.provider);
  const draftInvalid = !draft || TEXT_TASKS.some(task => {
    const route = draft.routes[task];
    return !choices.some(ref => ref.model === route.model) || !Number.isInteger(route.maxTokens) || route.maxTokens < 32 || route.maxTokens > 16384;
  });
  const activeModels = data ? data.activePlan?.models || registry.presets[data.manualPreset].models : null;
  const activeLocal = activeModels ? local(activeModels) : false;
  const activeMode = data?.mode === 'automatic' && !activeLocal ? 'automatic' : 'custom';
  const activeProvider = activeModels ? inferCustomProvider(activeModels) : null;
  const selectedMode = dialog ? 'custom' : mode;
  const customProviders = (['openai', 'gemini', 'zai', 'openrouter', 'lmstudio'] as const);
  const serviceModels = draft ? registry.presets[getCustomPresetName(draft.provider, draft.quality)].models : null;
  function taskFields(task: AiTaskKey) {
    if (!draft) return null;
    const route = draft.routes[task];
    const unavailable = !choices.some(ref => ref.model === route.model);
    const update = (patch: Partial<CustomRoute>) => setDraft(current => current && ({ ...current,
      routes: { ...current.routes, [task]: { ...current.routes[task], ...patch } } }));
    return <Stack key={task} spacing={1.5} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, minWidth: 0 }}>
      <Typography fontWeight={600}>{labels[task]}</Typography>
      <TextField select size="small" label={`Модель: ${labels[task]}`} value={route.model} disabled={busy}
        error={unavailable} helperText={unavailable ? 'Выберите доступную модель этого провайдера.' : undefined}
        onChange={event => update({ model: event.target.value })}>
        {unavailable && <MenuItem value={route.model} disabled>{route.model || 'Выберите модель'} · недоступна</MenuItem>}
        {choices.map(ref => <MenuItem key={ref.model} value={ref.model}>{ref.model}</MenuItem>)}
      </TextField>
      <Stack direction="row" spacing={1}><TextField select size="small" fullWidth label={`Рассуждения: ${labels[task]}`}
        value={route.reasoningEffort} disabled={busy} onChange={event => update({ reasoningEffort: event.target.value as CustomRoute['reasoningEffort'] })}>
        <MenuItem value="none">Выключены</MenuItem><MenuItem value="low">Низкие</MenuItem><MenuItem value="medium">Средние</MenuItem><MenuItem value="high">Высокие</MenuItem>
      </TextField><TextField size="small" type="number" fullWidth label={`Лимит: ${labels[task]}`} value={route.maxTokens}
        disabled={busy} inputProps={{ min: 32, max: 16384 }} onChange={event => update({ maxTokens: Number(event.target.value) })} /></Stack>
    </Stack>;
  }
  return <Card id="model-presets" sx={{ mb: 2 }}><CardContent><Stack spacing={2.5}>
    <Box><Typography variant="h6" component="h2">Как Кира выбирает модели</Typography>
      <Typography variant="body2" color="text.secondary">Доверьте распределение задач Кире или настройте свою стратегию.</Typography></Box>
    {error && <Alert severity="error" action={<Button onClick={() => void load()}>Повторить</Button>}>{error}</Alert>}
    {!data && !error && <CircularProgress size={22} aria-label="Загрузка настроек моделей" />}
    {data && <>
      <Box role="status" aria-label="Действующая стратегия" sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 2 }}>
        <Typography variant="body2" fontWeight={700}>Сейчас работает: {activeMode === 'automatic' ? 'Автоматически · API' : 'Custom'} · {activeProvider ? getAiProviderDescriptor(activeProvider).label : 'несколько провайдеров'}</Typography>
        <Typography variant="body2" color="text.secondary">{activeLocal
          ? activeProvider === 'lmstudio' ? 'Текстовые задачи выполняются на вашем компьютере. Поиск, голос и другие сервисы используют отдельные API.' : 'Часть текстовых задач выполняется локально, часть — через API.'
          : 'Текстовые задачи выполняются через API. Локальные модели не используются.'}</Typography>
      </Box>
      <TextField select label="Стратегия" value={selectedMode} disabled={busy} onChange={event => {
        if (event.target.value === 'custom') openCustom(); else setMode('automatic');
      }}>
        <MenuItem value="automatic">Автоматически · API</MenuItem>
        <MenuItem value="custom">Custom · моя стратегия</MenuItem>
      </TextField>
      {selectedMode === 'custom' ? <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">Вы задаёте провайдера и модели вручную. Локальные модели включаются в редакторе Custom и применяются после сохранения.</Typography>
        <Button variant="outlined" onClick={() => openCustom()}>Редактировать стратегию Custom</Button>
      </Stack> : <>
        <Alert severity="info">В автоматической стратегии модели подбираются через API по уровню качества. Локальные модели в этом режиме не используются.
          {activeLocal && <Typography variant="body2" sx={{ mt: 1 }}>Сейчас ещё работает сохранённая локальная стратегия. Нажмите «Применить», чтобы перейти на API.</Typography>}
        </Alert>
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
      {selectedMode === 'automatic' && <Box>
        <Button variant="outlined" disabled={busy} onClick={() => openCustom(true)}>Настроить локальные модели в Custom</Button>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>Откроется редактор Custom. Текущая стратегия изменится только после сохранения.</Typography>
      </Box>}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap><Chip size="small" label={data.serviceConnected ? 'API подключён' : 'Подключите API'} />
        <Chip size="small" label={data.localConnected ? 'Сервер LM Studio доступен' : 'Сервер LM Studio не подключён'} /></Stack>
    </>}
  </Stack></CardContent>
    <Dialog open={dialog} keepMounted fullWidth maxWidth="lg" onClose={() => { if (!busy) setDialog(false); }}>
      <DialogTitle>Custom · своя стратегия</DialogTitle>
      <DialogContent dividers><Stack spacing={2.5}>
        <Alert severity="info">Редактируется стратегия Custom. Она начнёт работать после «Сохранить стратегию Custom»; «Отмена» оставит действующие настройки.</Alert>
        <Typography color="text.secondary">Сначала выберите провайдера. Затем назначьте его модели для диалога, анализа и выбора инструментов.</Typography>
        <TextField select label="Провайдер нейросетей" value={draft?.provider || ''} disabled={busy}
          helperText="Все текстовые задачи используют модели выбранного провайдера."
          onChange={event => selectProvider(event.target.value as AiProvider)}>
          {!draft && <MenuItem value="" disabled>Выберите провайдера</MenuItem>}
          {customProviders.map(provider => <MenuItem key={provider} value={provider}
            disabled={provider !== 'lmstudio' && !data?.catalog.some(ref => ref.provider === provider)}>
            {getAiProviderDescriptor(provider).label}{provider !== 'lmstudio' && !data?.catalog.some(ref => ref.provider === provider) ? ' · подключите API' : ''}
          </MenuItem>)}
        </TextField>
        {!draft && <Alert severity="info">В сохранённой стратегии несколько провайдеров. Она продолжает работать. Выберите одного провайдера для нового распределения моделей; изменения применятся после сохранения.</Alert>}
        <FormControlLabel label="Использовать локальные модели" control={<Switch checked={localEnabled} disabled={busy}
          onChange={(_, enabled) => enabled ? selectProvider('lmstudio') : openCustom(false)} />} />
        <Box sx={{ display: localEnabled ? 'block' : 'none' }}>{localConnection}
          <Alert severity="info">Для Docker Desktop: host.docker.internal. Изменение URL и ключа требует пересоздания контейнеров. Нажмите «Сохранить» в блоке подключения, затем обновите каталог.</Alert>
          <Button disabled={busy} onClick={async () => {
            try { const next = await fetchModelPreferences(); setData(next); } catch { onToast('Не удалось обновить каталог', 'error'); }
          }}>Обновить каталог моделей</Button>
          {data?.localError && <Alert severity="warning">{data.localError}</Alert>}
        </Box>
        {draftInvalid && <Alert severity="warning">Для сохранения выберите доступные модели во всех задачах и лимиты от 32 до 16384 токенов.</Alert>}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
          {(['fastDialogue', 'conversation', 'runtimePlanning', 'complexReasoning'] as const).map(taskFields)}
        </Box>
        {draft && <Accordion disableGutters><AccordionSummary expandIcon={<ExpandMoreIcon />}>Модели для памяти и служебных задач</AccordionSummary>
          <AccordionDetails><Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
            {TEXT_TASKS.filter(task => !['fastDialogue', 'conversation', 'runtimePlanning', 'complexReasoning'].includes(task)).map(taskFields)}
          </Box></AccordionDetails></Accordion>}
        {serviceModels && <Alert severity="info">Поиск: {getAiProviderDescriptor(serviceModels.webSearchReasoning.provider).label} · зрение: {getAiProviderDescriptor(serviceModels.browserVision.provider).label} · голос: {getAiProviderDescriptor(serviceModels.transcription.provider).label}. Профиль векторов памяти сохраняется. Рассуждения применяются в пределах возможностей модели.</Alert>}
        {localEnabled && <Typography variant="body2" color="warning.main">При недоступности локальной модели задача завершится ошибкой; облачная замена отключена.</Typography>}
      </Stack></DialogContent>
      <DialogActions><Button disabled={busy} onClick={() => setDialog(false)}>Отмена</Button>
        <Button variant="contained" disabled={busy || draftInvalid} onClick={() => draft && void save(draft)}>{busy ? 'Сохраняем…' : 'Сохранить стратегию Custom'}</Button></DialogActions>
    </Dialog>
  </Card>;
}
