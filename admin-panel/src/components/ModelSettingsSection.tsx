import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Divider,
  Grid,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import { formatGenerativeUsageSummary, formatServiceSummary } from '../../../ai/presetSummary';
import { fetchAiPreset, saveAiPreset } from '../api';
import type { AiModelRef, AiPresetConfig, AiPresetName, AiPresetResponse, ConfigResponse } from '../types';
import type { ConfigSectionHandle } from './ConfigSection';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}

const CRITICAL_TASK_KEYS = new Set([
  'intentClassification',
  'memoryExtraction',
  'browserPlanning',
  'webSearchReasoning',
]);

function getProviderLabel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'GPT';
    case 'openrouter':
      return 'OpenRouter Auto';
    case 'gemini':
      return 'Gemini';
    case 'zai':
      return 'GLM';
    default:
      return provider;
  }
}

function getPresetTitle(data: AiPresetResponse | null, presetName: AiPresetName | null | undefined): string {
  if (!data || !presetName) return 'Не определён';
  return data.availablePresets.find((preset) => preset.name === presetName)?.title ?? presetName;
}

function ActivePresetStatus({ data }: { data: AiPresetResponse | null }) {
  if (!data) return null;

  const configuredPresetTitle = getPresetTitle(data, data.configuredPresetName);
  const basePresetTitle = getPresetTitle(data, data.envDefaultPreset);

  return (
    <Alert
      severity={data.hasRuntimeOverride ? 'info' : 'success'}
      variant="outlined"
      sx={{
        alignItems: 'flex-start',
        '& .MuiAlert-message': { width: '100%' },
      }}
    >
      <Stack spacing={0.75}>
        <Typography variant="body2">
          Сохранённый preset: <b>{configuredPresetTitle}</b>
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Базовое значение: <b>{basePresetTitle}</b>
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {data.activeSourceSummary}
        </Typography>
        <Typography variant="caption" color="text.disabled">
          Технический источник: {data.activeSourceTechnicalPath}
        </Typography>
      </Stack>
    </Alert>
  );
}

function compareModels(left: AiModelRef, right: AiModelRef): boolean {
  return left.provider === right.provider && left.model === right.model;
}

export const ModelSettingsSection = forwardRef<ConfigSectionHandle, Props>(
  function ModelSettingsSection({ onToast }, ref) {
    const [aiPresetData, setAiPresetData] = useState<AiPresetResponse | null>(null);
    const [selectedAiPreset, setSelectedAiPreset] = useState<AiPresetName>('gpt-balanced');
    const [savingAiPreset, setSavingAiPreset] = useState(false);
    const [loading, setLoading] = useState(true);

    useImperativeHandle(ref, () => ({
      getUpdates() {
        return {};
      },
    }));

    const loadAiPreset = async () => {
      setLoading(true);
      try {
        const response = await fetchAiPreset();
        setAiPresetData(response);
        setSelectedAiPreset(response.configuredPresetName);
      } catch {
        setAiPresetData(null);
        onToast('Не удалось загрузить AI preset', 'error');
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      void loadAiPreset();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const activeAiPreset = useMemo(
      () => aiPresetData?.availablePresets.find((preset) => preset.name === selectedAiPreset) ?? null,
      [aiPresetData, selectedAiPreset]
    );

    const configuredAiPreset = useMemo(
      () => aiPresetData?.availablePresets.find((preset) => preset.name === aiPresetData.configuredPresetName) ?? null,
      [aiPresetData]
    );

    const presetDiff = useMemo(() => {
      if (!activeAiPreset || !configuredAiPreset) return [];

      return Object.entries(activeAiPreset.models)
        .filter(([taskKey, modelRef]) => {
          const previousModel = configuredAiPreset.models[taskKey];
          return previousModel ? !compareModels(previousModel, modelRef) : true;
        })
        .map(([taskKey, modelRef]) => ({
          taskKey,
          next: modelRef,
          previous: configuredAiPreset.models[taskKey],
          critical: CRITICAL_TASK_KEYS.has(taskKey),
        }));
    }, [activeAiPreset, configuredAiPreset]);

    const criticalDiffs = useMemo(
      () => presetDiff.filter((item) => item.critical),
      [presetDiff]
    );

    const handleAiPresetSave = async () => {
      if (criticalDiffs.length > 0) {
        const confirmationText = [
          'Изменяются критичные задачи:',
          ...criticalDiffs.map((item) => `${item.taskKey}: ${getProviderLabel(item.previous?.provider || '—')} ${item.previous?.model || '—'} -> ${getProviderLabel(item.next.provider)} ${item.next.model}`),
          '',
          'Подтвердить переключение preset?',
        ].join('\n');

        if (!window.confirm(confirmationText)) {
          return;
        }
      }

      setSavingAiPreset(true);
      try {
        const result = await saveAiPreset(selectedAiPreset);
        if (!result.success) {
          onToast(result.error || 'Ошибка сохранения AI preset', 'error');
          return;
        }
        await loadAiPreset();
        onToast(result.message || 'AI preset сохранён', 'success');
      } catch {
        onToast('Ошибка соединения', 'error');
      } finally {
        setSavingAiPreset(false);
      }
    };

    return (
      <Card id="model-presets" sx={{ mb: 2 }}>
        <CardHeader
          title="🧩 AI Presets"
          titleTypographyProps={{ variant: 'subtitle1', fontWeight: 600, color: 'secondary.main' }}
          sx={{ pb: 0 }}
        />
        <CardContent>
          <Stack spacing={2}>
            <Box sx={{ p: 2, border: '1px solid', borderColor: 'primary.dark', borderRadius: 1.5, bgcolor: 'rgba(37, 99, 235, 0.08)' }}>
              <Stack spacing={1.5}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ xs: 'stretch', sm: 'center' }}>
                  <TextField
                    select
                    label="Активный AI preset"
                    value={selectedAiPreset}
                    onChange={(event) => setSelectedAiPreset(event.target.value as AiPresetName)}
                    helperText="Базовое значение берётся из env/default. Сохранение обновляет runtime-настройку, которую бот подхватывает без перезапуска."
                    sx={{ flex: 1 }}
                    disabled={loading || !aiPresetData}
                  >
                    {(aiPresetData?.availablePresets ?? []).map((preset: AiPresetConfig) => (
                      <MenuItem key={preset.name} value={preset.name} disabled={preset.enabled === false}>
                        {preset.title}{preset.enabled === false ? ' · недоступен' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                  <Button
                    variant="contained"
                    onClick={handleAiPresetSave}
                    disabled={loading || savingAiPreset || !aiPresetData || selectedAiPreset === aiPresetData.configuredPresetName || activeAiPreset?.enabled === false}
                    startIcon={savingAiPreset ? <CircularProgress size={14} color="inherit" /> : <SaveIcon fontSize="small" />}
                  >
                    Применить
                  </Button>
                </Stack>

                {activeAiPreset && (
                  <>
                    <Typography variant="body2" color="text.secondary">
                      {activeAiPreset.description}
                    </Typography>
                    {activeAiPreset.enabled === false && activeAiPreset.unavailableReason && (
                      <Typography variant="body2" color="error.main">
                        {activeAiPreset.unavailableReason}
                      </Typography>
                    )}

                    <Stack direction="row" spacing={1} flexWrap="wrap">
                      <Chip
                        size="small"
                        color={selectedAiPreset === aiPresetData?.configuredPresetName ? 'success' : 'warning'}
                        label={selectedAiPreset === aiPresetData?.configuredPresetName ? 'Совпадает с сохранённым значением' : 'Есть несохранённое изменение'}
                      />
                      <Chip
                        size="small"
                        variant="outlined"
                        label={aiPresetData?.hasRuntimeOverride ? 'Переопределено в админке' : 'Используется базовое значение'}
                      />
                      {activeAiPreset.enabled === false && (
                        <Chip size="small" color="error" variant="outlined" label="Недоступен без API ключей" />
                      )}
                      <Chip size="small" variant="outlined" label={`LLM: ${formatGenerativeUsageSummary(activeAiPreset.models)}`} />
                      <Chip size="small" variant="outlined" label={`Сервисы: ${formatServiceSummary(activeAiPreset.models)}`} />
                    </Stack>

                    {activeAiPreset.characteristics && (
                      <Stack direction="row" spacing={1} flexWrap="wrap">
                        <Chip size="small" color="primary" variant="outlined" label={`Качество: ${activeAiPreset.characteristics.quality}`} />
                        <Chip size="small" color="primary" variant="outlined" label={`Стоимость: ${activeAiPreset.characteristics.cost}`} />
                        <Chip size="small" color="primary" variant="outlined" label={`Стабильность: ${activeAiPreset.characteristics.stability}`} />
                        <Chip size="small" color="primary" variant="outlined" label={`Зависимость от GPT: ${activeAiPreset.characteristics.gptDependency}`} />
                      </Stack>
                    )}

                    <Divider />

                    <Box>
                      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
                        Diff c сохранённым preset
                      </Typography>
                      {presetDiff.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                          Изменений по task mapping нет.
                        </Typography>
                      ) : (
                        <Stack spacing={0.75}>
                          {presetDiff.map((item) => (
                            <Box
                              key={item.taskKey}
                              sx={{
                                p: 1,
                                borderRadius: 1.25,
                                border: '1px solid',
                                borderColor: item.critical ? 'warning.main' : 'divider',
                                bgcolor: item.critical ? 'rgba(245, 158, 11, 0.10)' : 'rgba(15, 23, 42, 0.18)',
                              }}
                            >
                              <Typography variant="caption" color={item.critical ? 'warning.light' : 'text.secondary'}>
                                {item.critical ? 'Критичная задача' : 'Обычная задача'}
                              </Typography>
                              <Typography variant="body2">
                                <b>{item.taskKey}</b>: {getProviderLabel(item.previous?.provider || '—')} · {item.previous?.model || '—'} → {getProviderLabel(item.next.provider)} · {item.next.model}
                              </Typography>
                            </Box>
                          ))}
                        </Stack>
                      )}
                    </Box>

                    <Grid container spacing={1}>
                      {Object.entries(activeAiPreset.models).map(([taskKey, modelRef]) => (
                        <Grid item xs={12} sm={6} md={4} key={taskKey}>
                          <Box
                            sx={{
                              p: 1,
                              height: '100%',
                              borderRadius: 1.25,
                              border: '1px solid',
                              borderColor: CRITICAL_TASK_KEYS.has(taskKey) ? 'warning.main' : 'divider',
                              bgcolor: CRITICAL_TASK_KEYS.has(taskKey) ? 'rgba(245, 158, 11, 0.08)' : 'rgba(15, 23, 42, 0.12)',
                            }}
                          >
                            <Typography variant="caption" color="text.secondary" component="div">
                              {taskKey}
                            </Typography>
                            <Typography variant="body2">
                              <b>{getProviderLabel(modelRef.provider)}</b> · {modelRef.model}
                            </Typography>
                          </Box>
                        </Grid>
                      ))}
                    </Grid>
                  </>
                )}
                <ActivePresetStatus data={aiPresetData} />
              </Stack>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    );
  }
);
