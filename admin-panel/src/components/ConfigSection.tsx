import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  Button,
  Grid,
  CircularProgress,
  Divider,
  FormControlLabel,
  Checkbox,
  Tooltip,
  Box,
  Typography,
  Chip,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { FieldInput } from './FieldInput';
import { saveConfig, fetchConfig, restartService } from '../api';
import type { SectionDef, ConfigResponse } from '../types';

interface Props {
  section: SectionDef;
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
}

export interface ConfigSectionHandle {
  /** Collect all changed (non-masked) values from this section */
  getUpdates: () => Record<string, string>;
}

const OPENAI_SECTION_ID = 'openai-models';

function getEntryRawValue(entry?: ConfigResponse[string]): string {
  if (!entry) return '';
  if (entry.rawValue !== undefined) return entry.rawValue;
  return entry.value ?? '';
}

function getSourceLabel(source?: ConfigResponse[string]['source']): string | null {
  switch (source) {
    case 'env_file':
      return 'Из env-файла';
    case 'inherited_default_text':
      return 'Наследуется от Default Text Model';
    case 'system_default':
      return 'Системный дефолт';
    default:
      return null;
  }
}

export const ConfigSection = forwardRef<ConfigSectionHandle, Props>(
  function ConfigSection({ section, config, onUpdate, onToast }, ref) {
    const isOpenAIModelsSection = section.id === OPENAI_SECTION_ID;
    const [localValues, setLocalValues] = useState<Record<string, string>>(() =>
      Object.fromEntries(section.fields.map((f) => [f.key, getEntryRawValue(config[f.key])]))
    );
    const [saving, setSaving] = useState(false);
    const [autoRestart, setAutoRestart] = useState(false);
    const configPath = isOpenAIModelsSection
      ? section.fields.map((f) => config[f.key]?.configPath).find(Boolean)
      : undefined;

    // Re-sync when parent config changes (e.g. after Save All refreshes config)
    useEffect(() => {
      setLocalValues(
        Object.fromEntries(section.fields.map((f) => [f.key, getEntryRawValue(config[f.key])]))
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config]);

    // Expose getUpdates() so Dashboard's Save All can collect values
    useImperativeHandle(ref, () => ({
      getUpdates() {
        const updates: Record<string, string> = {};
        for (const field of section.fields) {
          const val = localValues[field.key] ?? '';
          if (val.includes('••••')) continue; // unchanged masked — skip
          const initialValue = getEntryRawValue(config[field.key]);
          if (val === initialValue) continue;
          updates[field.key] = val;
        }
        return updates;
      },
    }));

    const handleChange = (key: string, value: string) => {
      setLocalValues((prev) => ({ ...prev, [key]: value }));
    };

    const handleSave = async () => {
      setSaving(true);
      try {
        const updates: Record<string, string> = {};
        for (const field of section.fields) {
          const val = localValues[field.key] ?? '';
          if (val.includes('••••')) continue;
          const initialValue = getEntryRawValue(config[field.key]);
          if (val === initialValue) continue;
          updates[field.key] = val;
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
          setLocalValues(
            Object.fromEntries(section.fields.map((f) => [f.key, getEntryRawValue(newCfg[f.key])]))
          );
        } else {
          onToast(result.error || 'Ошибка сохранения', 'error');
        }
      } catch {
        onToast('Ошибка соединения', 'error');
      } finally {
        setSaving(false);
      }
    };

    const toggleFields = section.fields.filter((f) => f.type === 'toggle');
    const regularFields = section.fields.filter((f) => f.type !== 'toggle');

    return (
      <Card id={section.id} sx={{ mb: 2 }}>
        <CardHeader
          title={`${section.icon} ${section.title}`}
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
          {isOpenAIModelsSection && configPath && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
              Источник настроек: {configPath}
            </Typography>
          )}

          {regularFields.length > 0 && (
            <Grid container spacing={2} sx={{ mb: toggleFields.length > 0 ? 0 : undefined }}>
              {regularFields.map((field) => (
                <Grid
                  item
                  key={field.key}
                  xs={12}
                  sm={field.type === 'textarea' ? 12 : 6}
                >
                  <Box>
                    <FieldInput
                      field={field}
                      value={localValues[field.key] ?? ''}
                      displayValue={isOpenAIModelsSection ? config[field.key]?.value : undefined}
                      onChange={handleChange}
                    />
                    {isOpenAIModelsSection && getSourceLabel(config[field.key]?.source) && (
                      <Chip
                        size="small"
                        label={getSourceLabel(config[field.key]?.source)}
                        variant="outlined"
                        sx={{ mt: 1, height: 22, fontSize: '11px' }}
                      />
                    )}
                  </Box>
                </Grid>
              ))}
            </Grid>
          )}

          {toggleFields.length > 0 && regularFields.length > 0 && (
            <Divider sx={{ my: 2, borderColor: 'divider' }} />
          )}

          {toggleFields.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={localValues[field.key] ?? ''}
              onChange={handleChange}
            />
          ))}
        </CardContent>
      </Card>
    );
  }
);
