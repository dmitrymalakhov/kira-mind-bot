import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Chip,
  CircularProgress,
  Grid,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import { fetchAiPreset, saveAiPreset } from '../api';
import type { AiModelRef, AiPresetConfig, AiPresetName, AiPresetResponse, ConfigResponse, ConfigSourceInfo } from '../types';
import type { ConfigSectionHandle } from './ConfigSection';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}

function getProviderLabel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'openrouter':
      return 'OpenRouter';
    case 'gemini':
      return 'Gemini';
    case 'zai':
      return 'Z.ai';
    default:
      return provider;
  }
}

function SourceInfo({ source }: { source?: ConfigSourceInfo }) {
  if (!source) return null;

  return (
    <Box sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 1, bgcolor: 'rgba(15, 23, 42, 0.35)' }}>
      <Typography variant="caption" color="text.secondary" component="div">
        Источник: <b>{source.label}</b>
        {source.appliesImmediately != null ? ` · ${source.appliesImmediately ? 'применяется сразу' : 'может потребоваться рестарт'}` : ''}
      </Typography>
      {source.description && (
        <Typography variant="caption" color="text.secondary" component="div">
          {source.description}
        </Typography>
      )}
      {source.technicalPath && (
        <Typography variant="caption" color="text.disabled" component="details" sx={{ mt: 0.5 }}>
          <summary>Технические детали</summary>
          {source.technicalPath}
        </Typography>
      )}
    </Box>
  );
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
        setSelectedAiPreset(response.activePresetName);
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

    const providerCounts = useMemo(() => {
      const counts: Record<string, number> = {};
      if (!activeAiPreset) return counts;
      for (const modelRef of Object.values(activeAiPreset.models) as AiModelRef[]) {
        counts[modelRef.provider] = (counts[modelRef.provider] ?? 0) + 1;
      }
      return counts;
    }, [activeAiPreset]);

    const handleAiPresetSave = async () => {
      setSavingAiPreset(true);
      try {
        const result = await saveAiPreset(selectedAiPreset);
        if (!result.success) {
          onToast(result.error || 'Ошибка сохранения AI preset', 'error');
          return;
        }
        await loadAiPreset();
        onToast(result.message || '✅ AI preset сохранён', 'success');
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
                    helperText="Единая runtime-настройка всех AI-моделей. Хранится в БД и применяется без перезапуска."
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
                    disabled={loading || savingAiPreset || !aiPresetData || selectedAiPreset === aiPresetData.activePresetName || activeAiPreset?.enabled === false}
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
                      <Chip size="small" color={selectedAiPreset === aiPresetData?.activePresetName ? 'success' : 'warning'} label={selectedAiPreset === aiPresetData?.activePresetName ? 'Активен' : 'Есть несохранённое изменение'} />
                      {activeAiPreset.enabled === false && (
                        <Chip size="small" color="error" variant="outlined" label="Недоступен без API ключей" />
                      )}
                      {Object.entries(providerCounts).map(([provider, count]) => (
                        <Chip key={provider} size="small" variant="outlined" label={`${getProviderLabel(provider)}: ${count}`} />
                      ))}
                    </Stack>
                    <Grid container spacing={1}>
                      {Object.entries(activeAiPreset.models).map(([taskKey, modelRef]) => (
                        <Grid item xs={12} sm={6} md={4} key={taskKey}>
                          <Typography variant="caption" color="text.secondary" component="div">
                            {taskKey}: <b>{getProviderLabel(modelRef.provider)}</b> · {modelRef.model}
                          </Typography>
                        </Grid>
                      ))}
                    </Grid>
                  </>
                )}
                <SourceInfo source={aiPresetData?.source} />
              </Stack>
            </Box>
          </Stack>
        </CardContent>
      </Card>
    );
  }
);
