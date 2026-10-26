import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  Card,
  CardContent,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Button,
  Box,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import { isValidProxyUrl } from '../../configValues';
import { FieldInput } from './FieldInput';
import { saveConfig, fetchConfig } from '../api';
import type { SectionDef, ConfigResponse } from '../types';

interface Props {
  section: SectionDef;
  config: ConfigResponse;
  onUpdate: (cfg: ConfigResponse) => void;
  onToast: (message: string, severity: 'success' | 'error') => void;
  onDirtyChange?: (id: string, dirty: boolean) => void;
  inline?: boolean;
  saveLabel?: string;
  open?: boolean;
  onClose?: () => void;
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
  function ConfigSection({ section, config, onUpdate, onToast, onDirtyChange, open = false, onClose, inline = false, saveLabel = 'Сохранить' }, ref) {
    const [localValues, setLocalValues] = useState<Record<string, string>>(() =>
      Object.fromEntries(section.fields.map((field) => [field.key, getEntryValue(config[field.key])]))
    );
    const [saving, setSaving] = useState(false);
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

    const invalid = section.fields.some(field => field.type === 'proxy' && !isValidProxyUrl(localValues[field.key] ?? ''));

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
          onToast('Сохранено. Для применения параметров подключения пересоздайте контейнеры.', 'success');
          const newCfg = await fetchConfig();
          acceptSaved(newCfg, updates);
          onUpdate(newCfg);
          onClose?.();
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

    const content = <>
      {inline && <Typography variant="subtitle1" component="h2" fontWeight={600} sx={{ mb: 2 }}>{section.title}</Typography>}
        <Box sx={{ pt: inline ? 0 : 1 }}>
          {!inline && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 3 }}>Параметры окружения применяются после пересоздания контейнеров.</Typography>}
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
                      sm: `span ${field.sm ?? (['textarea', 'proxy'].includes(field.type) ? 12 : 6)}`,
                      md: `span ${field.md ?? (['textarea', 'proxy'].includes(field.type) ? 12 : 6)}`,
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
        </Box>
        <DialogActions sx={{ px: 0, pt: 2, gap: 1, flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <Stack direction="row" spacing={1} sx={{ ml: 'auto !important' }}>

            <Button variant="contained" disabled={saving || !dirty || invalid} onClick={() => void handleSave()} startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}>{saveLabel}</Button>
          </Stack>
        </DialogActions>
    </>;
    if (inline) return <Card id={section.id}><CardContent>{content}</CardContent></Card>;
    return <Dialog open={open} onClose={() => { if (!saving) onClose?.(); }} keepMounted fullWidth maxWidth="md" scroll="paper" aria-labelledby={`config-dialog-title-${section.id}`}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <DialogTitle id={`config-dialog-title-${section.id}`}>{section.title}</DialogTitle>
        <IconButton aria-label="Закрыть настройки" disabled={saving} onClick={onClose} sx={{ mr: 1.5 }}><CloseIcon /></IconButton>
      </Box>
      <DialogContent dividers>{content}</DialogContent>
    </Dialog>;
  }
);
