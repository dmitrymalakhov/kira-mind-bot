import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Grid,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SaveIcon from '@mui/icons-material/Save';
import { FieldInput } from './FieldInput';
import { fetchConfig, fetchModelPresets, restartService, saveConfig } from '../api';
import {
  OPENAI_MODEL_FIELDS,
  OPENAI_MODEL_PRESETS,
  matchModelPreset,
  rawModelValueEquals,
  resolveOpenAIFieldDraftState,
} from '../openaiModelRegistry';
import type { ConfigResponse, ModelPreset, ModelPresetResponse } from '../types';
import type { ConfigSectionHandle } from './ConfigSection';

interface Props {
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}

function getEntryRawModelValue(entry?: ConfigResponse[string]): string | null {
  if (!entry) return null;
  if (entry.rawValue !== undefined) return entry.rawValue ?? null;
  return entry.value ?? '';
}

function getSourceLabel(source: 'env_file' | 'inherited_default_text' | 'system_default'): string {
  switch (source) {
    case 'env_file':
      return 'Из env-файла';
    case 'inherited_default_text':
      return 'Наследуется от Default Text Model';
    case 'system_default':
      return 'Системный дефолт';
  }
}

function getPresetById(presetId: string | null): ModelPreset | null {
  if (!presetId) return null;
  return OPENAI_MODEL_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

export const ModelSettingsSection = forwardRef<ConfigSectionHandle, Props>(
  function ModelSettingsSection({ config, onUpdate, onToast }, ref) {
    const [localValues, setLocalValues] = useState<Record<string, string | null>>(() =>
      Object.fromEntries(OPENAI_MODEL_FIELDS.map((field) => [field.envKey, getEntryRawModelValue(config[field.envKey])]))
    );
    const [saving, setSaving] = useState(false);
    const [autoRestart, setAutoRestart] = useState(false);
    const [modelPresetData, setModelPresetData] = useState<ModelPresetResponse | null>(null);
    const [selectedPresetId, setSelectedPresetId] = useState<string>('');

    useEffect(() => {
      let cancelled = false;

      fetchModelPresets()
        .then((response) => {
          if (cancelled) return;
          setModelPresetData(response);
          setSelectedPresetId(response.activePresetId ?? '');
        })
        .catch(() => {
          if (cancelled) return;
          setModelPresetData(null);
          setSelectedPresetId('');
        });

      return () => {
        cancelled = true;
      };
    }, [config]);

    useEffect(() => {
      setLocalValues(
        Object.fromEntries(OPENAI_MODEL_FIELDS.map((field) => [field.envKey, getEntryRawModelValue(config[field.envKey])]))
      );
    }, [config]);

    const currentPreset = useMemo(
      () => getPresetById(selectedPresetId || modelPresetData?.activePresetId || null),
      [modelPresetData?.activePresetId, selectedPresetId]
    );
    const localMatchedPresetId = useMemo(() => matchModelPreset(localValues), [localValues]);
    const hasUnsavedChanges = useMemo(
      () =>
        OPENAI_MODEL_FIELDS.some((field) =>
          !rawModelValueEquals(localValues[field.envKey], getEntryRawModelValue(config[field.envKey]))
        ),
      [config, localValues]
    );
    const statusLabel = hasUnsavedChanges
      ? localMatchedPresetId
        ? 'Черновик, не сохранён'
        : 'Custom'
      : modelPresetData?.activePresetId
        ? 'Активен'
        : 'Custom';

    useImperativeHandle(ref, () => ({
      getUpdates() {
        const updates: Record<string, string | null> = {};
        for (const field of OPENAI_MODEL_FIELDS) {
          const value = localValues[field.envKey] ?? null;
          const initialValue = getEntryRawModelValue(config[field.envKey]);
          if (rawModelValueEquals(value, initialValue)) continue;
          updates[field.envKey] = value;
        }
        return updates;
      },
    }));

    const handleChange = (key: string, value: string) => {
      setLocalValues((prev) => ({ ...prev, [key]: value }));
    };

    const handlePresetChange = (presetId: string) => {
      setSelectedPresetId(presetId);
      const preset = getPresetById(presetId);
      if (!preset) return;

      setLocalValues((prev) => ({
        ...prev,
        ...preset.values,
      }));
    };

    const handleSave = async () => {
      setSaving(true);
      try {
        const updates: Record<string, string | null> = {};
        for (const field of OPENAI_MODEL_FIELDS) {
          const value = localValues[field.envKey] ?? null;
          const initialValue = getEntryRawModelValue(config[field.envKey]);
          if (rawModelValueEquals(value, initialValue)) continue;
          updates[field.envKey] = value;
        }

        const result = await saveConfig(updates);
        if (result.success) {
          if (autoRestart) {
            onToast('💾 Сохранено. Перезапускаю ботов...', 'success');
            await Promise.all([
              restartService('kira-mind-bot'),
              restartService('sergey-brain-bot'),
            ]);
            onToast('✅ Сохранено и боты перезапущены', 'success');
          } else {
            onToast(result.message || '✅ Сохранено', 'success');
          }

          const newCfg = await fetchConfig();
          onUpdate(newCfg);
        } else {
          onToast(result.error || 'Ошибка сохранения', 'error');
        }
      } catch {
        onToast('Ошибка соединения', 'error');
      } finally {
        setSaving(false);
      }
    };

    return (
      <Card id="model-presets" sx={{ mb: 2 }}>
        <CardHeader
          title="🧩 Model Presets"
          titleTypographyProps={{ variant: 'subtitle1', fontWeight: 600, color: 'secondary.main' }}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tooltip title="Автоматически перезапустить ботов после сохранения">
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={autoRestart}
                      onChange={(e) => setAutoRestart(e.target.checked)}
                      sx={{ color: 'text.disabled', '&.Mui-checked': { color: 'primary.light' } }}
                    />
                  }
                  label={<span style={{ fontSize: 11, color: '#64748b' }}>рестарт</span>}
                  sx={{ mr: 0 }}
                />
              </Tooltip>
              <Button
                variant="outlined"
                size="small"
                startIcon={
                  saving ? (
                    <CircularProgress size={14} color="inherit" />
                  ) : autoRestart ? (
                    <RestartAltIcon fontSize="small" />
                  ) : (
                    <SaveIcon fontSize="small" />
                  )
                }
                onClick={handleSave}
                disabled={saving}
                sx={{
                  borderColor: 'divider',
                  color: 'text.secondary',
                  '&:hover': { borderColor: 'primary.main', color: 'primary.light' },
                }}
              >
                Сохранить
              </Button>
            </div>
          }
          sx={{ pb: 0 }}
        />
        <CardContent>
          <Stack spacing={2}>
            <TextField
              select
              label="Preset"
              value={selectedPresetId}
              onChange={(event) => handlePresetChange(event.target.value)}
              SelectProps={{ displayEmpty: true }}
              helperText="Выбор пресета меняет только черновик формы до сохранения."
            >
              {!selectedPresetId && (
                <MenuItem value="" disabled>
                  Custom
                </MenuItem>
              )}
              {OPENAI_MODEL_PRESETS.map((preset) => (
                <MenuItem key={preset.id} value={preset.id}>
                  {preset.title}
                </MenuItem>
              ))}
            </TextField>

            <Stack direction="row" spacing={1} flexWrap="wrap">
              <Chip size="small" label={statusLabel} color={statusLabel === 'Активен' ? 'success' : 'default'} />
              {currentPreset && (
                <>
                  <Chip size="small" label={currentPreset.qualityLabel} variant="outlined" />
                  <Chip size="small" label={currentPreset.costLabel} variant="outlined" />
                  <Chip size="small" label={currentPreset.riskLabel} variant="outlined" />
                </>
              )}
            </Stack>

            {currentPreset && (
              <Typography variant="caption" color="text.secondary">
                {currentPreset.description}
              </Typography>
            )}

            {modelPresetData?.configPath && (
              <Typography variant="caption" color="text.secondary">
                Источник настроек: {modelPresetData.configPath}
              </Typography>
            )}

            <Divider sx={{ borderColor: 'divider' }} />

            <Accordion disableGutters sx={{ bgcolor: 'transparent', boxShadow: 'none' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="body2" fontWeight={600}>
                  Расширенные настройки моделей
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0 }}>
                <Grid container spacing={2}>
                  {OPENAI_MODEL_FIELDS.map((field) => {
                    const draftState = resolveOpenAIFieldDraftState(field, localValues);
                    const fieldValue = localValues[field.envKey];
                    const isChangedFromPreset = currentPreset
                      ? !rawModelValueEquals(fieldValue, currentPreset.values[field.envKey] ?? null)
                      : false;

                    return (
                      <Grid item key={field.envKey} xs={12} sm={6}>
                        <Box>
                          <FieldInput
                            field={{
                              key: field.envKey,
                              label: field.label,
                              type: 'text',
                              hint: field.hint,
                              placeholder: field.placeholder,
                            }}
                            value={fieldValue ?? ''}
                            displayValue={draftState.value}
                            onChange={handleChange}
                          />
                          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1 }}>
                            <Chip
                              size="small"
                              label={getSourceLabel(draftState.source)}
                              variant="outlined"
                              sx={{ height: 22, fontSize: '11px' }}
                            />
                            {isChangedFromPreset && (
                              <Chip
                                size="small"
                                label="Изменено вручную"
                                color="warning"
                                variant="outlined"
                                sx={{ height: 22, fontSize: '11px' }}
                              />
                            )}
                          </Stack>
                        </Box>
                      </Grid>
                    );
                  })}
                </Grid>
              </AccordionDetails>
            </Accordion>
          </Stack>
        </CardContent>
      </Card>
    );
  }
);
