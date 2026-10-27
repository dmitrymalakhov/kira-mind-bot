import { useEffect, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Card,
  CardContent, CircularProgress, MenuItem, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { fetchAiPreset, saveAiPreset } from '../api';
import type { AiModelRef, AiPresetName, AiPresetResponse } from '../types';
import { getAiProviderDescriptor } from '../../../ai/providerMetadata';
import { LocalModelSettings } from './LocalModelSettings';

interface Props {
  onToast: (message: string, severity: 'success' | 'error') => void;
}

const TASK_LABELS: Record<string, string> = {
  conversation: 'Диалог', complexReasoning: 'Сложные запросы',
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

export function ModelSettingsSection({ onToast }: Props) {
  const [data, setData] = useState<AiPresetResponse | null>(null);
  const [selected, setSelected] = useState<AiPresetName>('gpt-balanced');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const result = await fetchAiPreset();
      setData(result);
      setSelected(result.configuredPresetName);
    } catch { setError('Не удалось загрузить профиль ответов.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  const preview = data?.availablePresets.find(preset => preset.name === selected);
  const changed = Boolean(data && selected !== data.configuredPresetName);
  const sameModel = preview?.models.conversation?.provider === preview?.models.complexReasoning?.provider
    && preview?.models.conversation?.model === preview?.models.complexReasoning?.model;

  async function save() {
    setSaving(true);
    setError('');
    try {
      const result = await saveAiPreset(selected);
      if (!result.success) throw new Error(result.error || 'Не удалось сохранить профиль');
      const next = await fetchAiPreset();
      setData(next);
      setSelected(next.configuredPresetName);
      onToast('Профиль ответов сохранён', 'success');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Ошибка соединения'); }
    finally { setSaving(false); }
  }

  return (
    <Stack spacing={2} sx={{ height: '100%' }}>
      <Card id="model-presets" sx={{ flex: 1 }}>
        <CardContent>
          <Stack spacing={2}>
            <Typography variant="subtitle1" component="h2" fontWeight={600}>Ответы Киры</Typography>
            {error && <Alert severity="error" action={<Button color="inherit" size="small" disabled={loading || saving} onClick={() => void load()}>Повторить</Button>}>{error}</Alert>}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems="stretch">
              <TextField select size="small" fullWidth label="Профиль ответов" value={data ? selected : ''}
                onChange={event => setSelected(event.target.value as AiPresetName)} disabled={loading || saving || !data}>
                {(data?.availablePresets ?? []).map(preset => (
                  <MenuItem key={preset.name} value={preset.name} disabled={!preset.enabled}>{preset.title}{!preset.enabled ? ' · не настроен' : ''}</MenuItem>
                ))}
              </TextField>
              {changed && <Button variant="contained" onClick={() => void save()} disabled={saving || !preview?.enabled}
                startIcon={saving ? <CircularProgress size={14} color="inherit" /> : undefined}>Применить</Button>}
            </Stack>
            {changed && <Typography variant="caption" color="warning.main">Выбран новый профиль. Примените, чтобы сохранить.</Typography>}
            {loading && <CircularProgress size={18} aria-label="Загрузка профиля" />}
            {preview && <>
              <Stack spacing={1}>
                {(sameModel ? ['conversation'] as const : ['conversation', 'complexReasoning'] as const).map(task => (
                  <Stack direction="row" alignItems="baseline" spacing={2} key={task} sx={{ minWidth: 0 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0, minWidth: 106 }}>{sameModel ? 'Модель' : TASK_LABELS[task]}</Typography>
                    <Tooltip title={modelLabel(preview.models[task])}>
                      <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>{preview.models[task]?.model || 'Не определена'}</Typography>
                    </Tooltip>
                  </Stack>
                ))}
              </Stack>
              {!preview.enabled && <Alert severity="warning">{preview.unavailableReason}</Alert>}
            </>}
            {data?.memoryEmbeddingProfile.compatibility.status === 'mismatch' && <Alert severity="error">{data.memoryEmbeddingProfile.compatibility.summary}</Alert>}
          </Stack>
        </CardContent>
      </Card>
      <Box>
        <Card sx={{ mb: 2 }}><CardContent><LocalModelSettings onToast={onToast} onSaved={() => void load()} /></CardContent></Card>
        {preview && <Accordion disableGutters>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} id="model-routing-summary" aria-controls="model-routing-details">
            <Typography variant="body2">Технические маршруты и память</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>{preview.description}</Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1.5 }}>
              {Object.entries(preview.models).map(([task, model]) => <Box key={task} sx={{ minWidth: 0 }}>
                <Typography variant="caption" color="text.secondary">{TASK_LABELS[task] || task}</Typography>
                <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>{modelLabel(model)}</Typography>
              </Box>)}
            </Box>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>Память: {data?.memoryEmbeddingProfile.title} · {data?.memoryEmbeddingProfile.model}. {data?.memoryEmbeddingProfile.compatibility.summary}</Typography>
          </AccordionDetails>
        </Accordion>}
      </Box>
    </Stack>
  );
}
