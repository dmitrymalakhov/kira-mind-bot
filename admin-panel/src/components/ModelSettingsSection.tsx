import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card,
  CardContent, Chip, CircularProgress, MenuItem, Stack, TextField, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SaveIcon from '@mui/icons-material/Save';
import { fetchAiPreset, saveAiPreset } from '../api';
import type { AiModelRef, AiPresetName, AiPresetResponse, ConfigResponse } from '../types';
import type { ConfigSectionHandle } from './ConfigSection';
import { BudgetSettingsSection } from './BudgetSettingsSection';
import { getAiProviderDescriptor } from '../../../ai/providerMetadata';
import { LocalModelSettings } from './LocalModelSettings';
import { ImageGenerationSettings } from './ImageGenerationSettings';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}

const TASK_LABELS: Record<string, string> = {
  conversation: 'Обычный диалог', complexReasoning: 'Сложные ответы',
  defaultText: 'Повседневный текст', lightweightText: 'Короткие проверки',
  intentClassification: 'Понимание запроса', intentDedup: 'Проверка повторов',
  memoryExtraction: 'Извлечение фактов', memoryConsolidation: 'Упорядочивание памяти',
  messageAnalysis: 'Анализ сообщений', webSearchReasoning: 'Веб-поиск',
  browserPlanning: 'Планирование в браузере', browserVision: 'Распознавание экрана',
  embedding: 'Векторы памяти', transcription: 'Распознавание голоса',
};
function modelLabel(ref?: AiModelRef) {
  return ref ? `${getAiProviderDescriptor(ref.provider).label} · ${ref.model}` : 'Не определена';
}

export const ModelSettingsSection = forwardRef<ConfigSectionHandle, Props>(
  function ModelSettingsSection({ onToast }, ref) {
    const [data, setData] = useState<AiPresetResponse | null>(null);
    const [selected, setSelected] = useState<AiPresetName>('gpt-balanced');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showLocalModels, setShowLocalModels] = useState(false);
    useImperativeHandle(ref, () => ({ getUpdates: () => ({}) }));

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

    async function save() {
      setSaving(true);
      try {
        const result = await saveAiPreset(selected);
        if (!result.success) throw new Error(result.error || 'Не удалось сохранить модель');
        await load();
        onToast('Модель сохранена. Кира подхватит выбор в течение 5 секунд.', 'success');
      } catch (error) {
        onToast(error instanceof Error ? error.message : 'Ошибка соединения', 'error');
      } finally { setSaving(false); }
    }

    return (
      <>
        <Card id="model-presets" sx={{ mb: 2 }}>
          <CardContent>
            <Stack spacing={2}>
              <Typography variant="subtitle1" component="h2" fontWeight={600}>Модель общения Киры</Typography>
              {active && (
                <Alert severity="success">
                  <Typography variant="body2">Сейчас Кира отвечает: <b>{modelLabel(active.models.conversation)}</b></Typography>
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
                  disabled={loading || saving || !changed || !preview?.enabled}
                  startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
                >Применить</Button>
              </Stack>
              {preview && (
                <>
                  <Stack direction="row" spacing={1} flexWrap="wrap">
                    <Chip size="small" color={changed ? 'warning' : 'success'} label={changed ? 'Предпросмотр — нажмите «Применить»' : 'Этот профиль сохранён'} />
                  </Stack>
                  <Stack direction={{ xs: 'column', md: 'row' }} spacing={1}>
                    {(['conversation', 'complexReasoning'] as const).map(task => (
                      <Box key={task} sx={{ flex: 1, p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                        <Typography variant="caption" color="text.secondary">{TASK_LABELS[task]}</Typography>
                        <Typography variant="body2" fontWeight={600}>{modelLabel(preview.models[task])}</Typography>
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
              {(selected === 'lmstudio-local' || selected === 'hybrid-lmstudio-gpt')
                ? <LocalModelSettings onToast={onToast} onSaved={() => void load()} />
                : <Accordion expanded={showLocalModels} onChange={(_, expanded) => setShowLocalModels(expanded)}>
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}><Typography variant="body2">Настроить локальные модели LM Studio</Typography></AccordionSummary>
                    <AccordionDetails>{showLocalModels && <LocalModelSettings onToast={onToast} onSaved={() => void load()} />}</AccordionDetails>
                  </Accordion>}
            </Stack>
          </CardContent>
        </Card>
        <ImageGenerationSettings onToast={onToast} />
        <BudgetSettingsSection onToast={onToast} />
      </>
    );
  }
);
