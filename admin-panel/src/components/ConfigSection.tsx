import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import {
  Card,
  CardContent,
  CardHeader,
  Button,
  Box,
  CircularProgress,
  Divider,
  FormControlLabel,
  Checkbox,
  Tooltip,
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
  getUpdates: () => Record<string, string | null>;
}

function getEntryValue(entry?: ConfigResponse[string]): string {
  if (!entry) return '';
  if (entry.rawValue !== undefined) return entry.rawValue ?? '';
  return entry.value ?? '';
}

export const ConfigSection = forwardRef<ConfigSectionHandle, Props>(
  function ConfigSection({ section, config, onUpdate, onToast }, ref) {
    const [localValues, setLocalValues] = useState<Record<string, string>>(() =>
      Object.fromEntries(section.fields.map((field) => [field.key, getEntryValue(config[field.key])]))
    );
    const [saving, setSaving] = useState(false);
    const [autoRestart, setAutoRestart] = useState(false);

    useEffect(() => {
      setLocalValues(
        Object.fromEntries(section.fields.map((field) => [field.key, getEntryValue(config[field.key])]))
      );
    }, [config, section.fields]);

    useImperativeHandle(ref, () => ({
      getUpdates() {
        const updates: Record<string, string | null> = {};
        for (const field of section.fields) {
          const value = localValues[field.key] ?? '';
          if (value.includes('••••')) continue;
          if (value === getEntryValue(config[field.key])) continue;
          updates[field.key] = value;
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
        const updates: Record<string, string | null> = {};
        for (const field of section.fields) {
          const value = localValues[field.key] ?? '';
          if (value.includes('••••')) continue;
          if (value === getEntryValue(config[field.key])) continue;
          updates[field.key] = value;
        }

        const result = await saveConfig(updates);
        if (result.success) {
          if (autoRestart) {
            onToast('💾 Сохранено. Перезапускаю бота...', 'success');
            await restartService('kira-mind-bot');
            onToast('✅ Сохранено и бот перезапущен', 'success');
          } else {
            onToast(result.message || '✅ Сохранено', 'success');
          }
          const newCfg = await fetchConfig();
          onUpdate(newCfg);
          setLocalValues(
            Object.fromEntries(section.fields.map((field) => [field.key, getEntryValue(newCfg[field.key])]))
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

    const toggleFields = section.fields.filter((field) => field.type === 'toggle');
    const regularFields = section.fields.filter((field) => field.type !== 'toggle');

    return (
      <Card id={section.id} sx={{ mb: 2 }}>
        <CardHeader
          title={`${section.icon} ${section.title}`}
          titleTypographyProps={{ variant: 'subtitle1', fontWeight: 600, color: 'secondary.main' }}
          action={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tooltip title="Автоматически перезапустить бота после сохранения">
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
          {regularFields.length > 0 && (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(12, minmax(0, 1fr))' },
                columnGap: 2,
                rowGap: 2,
                alignItems: 'start',
                mb: toggleFields.length > 0 ? 0 : undefined,
              }}
            >
              {regularFields.map((field) => (
                <Box
                  key={field.key}
                  sx={{
                    minWidth: 0,
                    gridColumn: {
                      xs: '1 / -1',
                      sm: `span ${field.sm ?? (field.type === 'textarea' ? 12 : 6)}`,
                      md: `span ${field.md ?? (field.type === 'textarea' ? 12 : 6)}`,
                    },
                  }}
                >
                  <FieldInput
                    field={field}
                    value={localValues[field.key] ?? ''}
                    onChange={handleChange}
                  />
                </Box>
              ))}
            </Box>
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
