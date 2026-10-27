import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Button,
  Box,
  CircularProgress,
  Divider,
  FormControlLabel,
  Checkbox,
  Stack,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import { FieldInput } from './FieldInput';
import { saveConfig, fetchConfig, restartService } from '../api';
import type { SectionDef, ConfigResponse } from '../types';

interface Props {
  section: SectionDef;
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  open: boolean;
  onClose: () => void;
}

export interface ConfigSectionHandle {
  getUpdates: () => Record<string, string | null>;
  acceptSaved: (config: ConfigResponse, submitted: Record<string, string | null>) => void;
}

function getEntryValue(entry?: ConfigResponse[string]): string {
  if (!entry) return '';
  if (entry.rawValue !== undefined) return entry.rawValue ?? '';
  return entry.value ?? '';
}

export const ConfigSection = forwardRef<ConfigSectionHandle, Props>(
  function ConfigSection({ section, config, onUpdate, onToast, onDirtyChange, open, onClose }, ref) {
    const [localValues, setLocalValues] = useState<Record<string, string>>(() =>
      Object.fromEntries(section.fields.map((field) => [field.key, getEntryValue(config[field.key])]))
    );
    const [saving, setSaving] = useState(false);
    const [autoRestart, setAutoRestart] = useState(false);
    const previousConfig = useRef(config);

    useEffect(() => {
      const previous = previousConfig.current;
      previousConfig.current = config;
      setLocalValues(values => Object.fromEntries(section.fields.map(field => [
        field.key,
        values[field.key] !== getEntryValue(previous[field.key])
          ? values[field.key]
          : getEntryValue(config[field.key]),
      ])));
    }, [config, section.fields]);

    const dirty = section.fields.some(field => {
      const value = localValues[field.key] ?? '';
      return !value.includes('••••') && value !== getEntryValue(config[field.key]);
    });
    useEffect(() => { onDirtyChange?.(section.id, dirty); }, [section.id, dirty, onDirtyChange]);

    const acceptSaved = (saved: ConfigResponse, submitted: Record<string, string | null>) => {
      setLocalValues(values => Object.fromEntries(section.fields.map(field => [
        field.key,
        Object.prototype.hasOwnProperty.call(submitted, field.key) && values[field.key] === submitted[field.key]
          ? getEntryValue(saved[field.key])
          : values[field.key],
      ])));
    };

    useImperativeHandle(ref, () => ({
      acceptSaved,
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
          acceptSaved(newCfg, updates);
          onUpdate(newCfg);
          onClose();
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
      <Dialog open={open} onClose={() => { if (!saving) onClose(); }} keepMounted fullWidth maxWidth="md" scroll="paper" aria-labelledby={`config-dialog-title-${section.id}`}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <DialogTitle id={`config-dialog-title-${section.id}`} sx={{ py: 1.5 }}>{section.title}</DialogTitle>
          <IconButton aria-label="Закрыть настройки" disabled={saving} onClick={onClose} sx={{ mr: 1.5 }}><CloseIcon /></IconButton>
        </Box>
        <DialogContent dividers sx={{ pt: 3 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 3 }}>Параметры окружения применяются после пересоздания контейнеров.</Typography>
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
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2, gap: 1, flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <FormControlLabel
            control={<Checkbox size="small" checked={autoRestart} disabled={saving} onChange={event => setAutoRestart(event.target.checked)} />}
            label={<Typography variant="body2" color="text.secondary">Перезапустить бота после сохранения</Typography>}
            sx={{ ml: -1 }}
          />
          <Stack direction="row" spacing={1} sx={{ ml: 'auto !important' }}>
            <Button disabled={saving} onClick={onClose}>Закрыть</Button>
            <Button variant="contained" disabled={saving || !dirty} onClick={() => void handleSave()} startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}>Сохранить</Button>
          </Stack>
        </DialogActions>
      </Dialog>
    );
  }
);
