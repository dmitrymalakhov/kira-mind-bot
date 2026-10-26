import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card,
  CardContent, Chip, CircularProgress, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SaveIcon from '@mui/icons-material/Save';
import { fetchAiPreset, saveAiPreset } from '../api';
import type { AiModelRef, AiPresetName, AiPresetResponse, ConfigResponse } from '../types';
import { ConfigSection, type ConfigSectionHandle } from './ConfigSection';
import { LOCAL_MODEL_CONNECTION_SECTION } from '../schema';
import { BudgetSettingsSection } from './BudgetSettingsSection';
import { getAiProviderDescriptor } from '../../../ai/providerMetadata';
import { LocalModelSettings } from './LocalModelSettings';
import { ImageGenerationSettings } from './ImageGenerationSettings';
import { ModelPreferencesSettings } from './ModelPreferencesSettings';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}

const TASK_LABELS: Record<string, string> = {
  fastDialogue: 'Быстрый первый ответ', conversation: 'Разговор с контекстом', complexReasoning: 'Сложные ответы', runtimePlanning: 'Выбор инструментов',
  defaultText: 'Повседневный текст', lightweightText: 'Короткие проверки',
  intentClassification: 'Понимание запроса', intentDedup: 'Проверка повторов',
  memoryExtraction: 'Извлечение фактов', memoryConsolidation: 'Упорядочивание памяти',
  messageAnalysis: 'Анализ сообщений', webSearchReasoning: 'Веб-поиск',
  browserPlanning: 'Планирование в браузере', browserVision: 'Распознавание экрана',
  embedding: 'Векторы памяти', transcription: 'Распознавание голоса',
};
function modelLabel(ref?: AiModelRef) {
  if (!ref) return 'Не определена';
  const efforts = { none: 'без рассуждения', low: 'низкое рассуждение', medium: 'среднее рассуждение', high: 'высокое рассуждение' };
  const effort = ref.generation?.reasoningEffort;
  return `${getAiProviderDescriptor(ref.provider).label} · ${ref.model}${effort ? ` · ${efforts[effort]}` : ''}`;
}

export const ModelSettingsSection = forwardRef<ConfigSectionHandle, Props>(
  function ModelSettingsSection({ config, onUpdate, onToast }, ref) {
    const [data, setData] = useState<AiPresetResponse | null>(null);
    const [selected, setSelected] = useState<AiPresetName>('gpt-balanced');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const connectionRef = useRef<ConfigSectionHandle>(null);
    const [preferenceRefresh, setPreferenceRefresh] = useState(0);
    const localSaved = () => { void load(); setPreferenceRefresh(value => value + 1); };
    useImperativeHandle(ref, () => ({ getUpdates: () => connectionRef.current?.getUpdates() ?? ({}) }));

    async function load() {
      setLoading(true);
      try {
        const result = await fetchAiPreset();
        setData(result);
        setSelected(result.configuredPresetName);
      } catch {
        onToast('Не удалось загрузить модель Киры', 'error');
      } finally { setLoading(false); }
    }
    useEffect(() => { void load(); }, []);

    const active = data?.availablePresets.find(preset => preset.name === data.configuredPresetName);
    const preview = data?.availablePresets.find(preset => preset.name === selected);
    const changed = selected !== data?.configuredPresetName;

    async function save(preset: AiPresetName = selected) {
      setSaving(true);
      try {
        const result = await saveAiPreset(preset);
        if (!result.success) throw new Error(result.error || 'Не удалось сохранить модель');
        await load();
        setPreferenceRefresh(value => value + 1);
        onToast('Модель сохранена. Кира подхватит выбор в течение 5 секунд.', 'success');
      } catch (error) {
        onToast(error instanceof Error ? error.message : 'Ошибка соединения', 'error');
      } finally { setSaving(false); }
    }

    return (
      <>
        <ModelPreferencesSettings onToast={onToast} onSaved={() => void load()} refreshToken={preferenceRefresh} />
        <Card id="local-models" sx={{ mb: 2 }}><CardContent><Stack spacing={2}>
          <Typography variant="h6" component="h2">Свои локальные модели</Typography>
          <Typography variant="body2" color="text.secondary">Запустите LM Studio на своём компьютере и включите Local Server. Укажите адрес сервера, затем выберите модели и включите нужный режим.</Typography>
          <ConfigSection ref={connectionRef} requiresRecreate config={config} onUpdate={onUpdate} onToast={onToast}
            section={LOCAL_MODEL_CONNECTION_SECTION} />
          <Alert severity="info">Из Docker Desktop используйте host.docker.internal вместо localhost. После изменения подключения пересоздайте контейнеры бота и админки; обычного рестарта недостаточно.</Alert>
          <LocalModelSettings onToast={onToast} onSaved={localSaved} />
          <Typography fontWeight={600}>3. Включите локальные модели</Typography>
          <Typography variant="body2" color="text.secondary">Локальный режим выполняет текстовые задачи в LM Studio. Гибрид оставляет сложный анализ облачной модели. Поиск, голос, изображения и векторы памяти используют отдельные подключения. Включение режима заменит автоматический выбор по стоимости и качеству.</Typography>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            {(['lmstudio-local', 'hybrid-lmstudio-gpt'] as const).map(name => {
              const preset = data?.availablePresets.find(item => item.name === name);
              return <Button key={name} variant="outlined" disabled={loading || saving || !preset?.enabled}
                onClick={() => void save(name)}>{name === 'lmstudio-local' ? 'Включить локальный режим' : 'Включить гибрид'}</Button>;
            })}
          </Stack>
          {active && <Typography variant="body2" color="text.secondary">Сохранённый профиль: {active.title}. Автоматический выбор можно включить кнопкой «Применить» выше.</Typography>}
        </Stack></CardContent></Card>
        <Accordion sx={{ mb: 2 }} slotProps={{ transition: { unmountOnExit: true } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography fontWeight={600}>Дополнительно: ручной выбор профиля</Typography></AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Ручной выбор профиля отключает автоматическое распределение. Настройки локальных моделей и подключений сохраняются отдельно.</Typography>
        <Card id="model-presets-manual" sx={{ mb: 2 }}>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="subtitle1" component="h2" fontWeight={600}>Модель общения Киры</Typography>
              {active && (
                <Alert severity="success">
                  <Typography variant="body2">Быстрый первый ответ: <b>{modelLabel(active.models.fastDialogue)}</b></Typography>
                  <Typography variant="body2">Сложные запросы: <b>{modelLabel(active.models.complexReasoning)}</b></Typography>
                </Alert>
              )}
              <Typography variant="body2" color="text.secondary">
                Выберите профиль и нажмите «Применить». Профиль задаёт модели для общения и служебных задач.
                Самостоятельные фоновые функции включаются отдельно ниже.
              </Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'flex-start' }}>
                <TextField
                  select fullWidth label="Модель и режим работы" value={selected}
                  onChange={event => setSelected(event.target.value as AiPresetName)}
                  disabled={loading || saving || !data}
                  helperText="GPT работает через настроенный lmrouter. LM Studio использует модель на вашем компьютере. Гибрид сочетает оба варианта."
                >
                  {(data?.availablePresets ?? []).map(preset => (
                    <MenuItem key={preset.name} value={preset.name} disabled={!preset.enabled}>
                      {preset.title}{!preset.enabled ? ' · не настроен' : ''}
                    </MenuItem>
                  ))}
                </TextField>
                <Button variant="contained" onClick={() => void save()}
                  disabled={loading || saving || !preview?.enabled}
                  startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
                >Включить ручной профиль</Button>
              </Stack>
              {preview && (
                <>
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    <Chip size="small" color={changed ? 'warning' : 'success'} label={changed ? 'Предпросмотр — нажмите «Применить»' : 'Этот профиль сохранён'} />
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                    {(['fastDialogue', 'conversation', 'runtimePlanning', 'complexReasoning'] as const).map(task => (
                      <Box key={task} sx={{ flex: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                        <Typography variant="caption" color="text.secondary">{TASK_LABELS[task]}</Typography>
                        <Typography variant="body2" fontWeight={600}>{modelLabel(preview.models[task])}</Typography>
                        {preview.outputTokenLimits?.[task] && preview.models[task]?.provider !== 'lmstudio' && (
                          <Typography variant="caption" color="text.secondary">До {preview.outputTokenLimits[task]} выходных токенов за вызов</Typography>
                        )}
                      </Box>
                    ))}
                  </Stack>
                  <Typography variant="body2" color="text.secondary">{preview.description}</Typography>
                  {!preview.enabled && <Alert severity="warning">{preview.unavailableReason}</Alert>}
                  <Accordion disableGutters sx={{ bgcolor: 'transparent', '&:before': { display: 'none' } }}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                      <Typography variant="body2">Модели по задачам и профиль памяти</Typography>
                    </AccordionSummary>
                    <AccordionDetails>
                      <Stack spacing={1}>
                        {data && <Alert severity={data.memoryEmbeddingProfile.compatibility.status === 'mismatch' ? 'error' : 'info'}>
                          Память: {data.memoryEmbeddingProfile.title} · {data.memoryEmbeddingProfile.model}. {data.memoryEmbeddingProfile.compatibility.summary}
                          {' '}Смена профиля общения не меняет сохранённые векторы памяти.
                        </Alert>}
                        {Object.entries(preview.models).map(([task, model]) => (
                          <Typography key={task} variant="body2"><b>{TASK_LABELS[task] || task}:</b> {modelLabel(model)}</Typography>
                        ))}
                      </Stack>
                    </AccordionDetails>
                  </Accordion>
                </>
              )}
              {loading && <CircularProgress size={20} aria-label="Загрузка модели" />}

            </Stack>
          </CardContent>
        </Card>
          </AccordionDetails>
        </Accordion>
        <ImageGenerationSettings onToast={onToast} />
        <BudgetSettingsSection onToast={onToast} />
      </>
    );
  }
);
