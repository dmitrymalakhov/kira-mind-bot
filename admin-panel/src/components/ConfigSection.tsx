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

export const ConfigSection = forwardRef<ConfigSectionHandle, Props>(
  function ConfigSection({ section, config, onUpdate, onToast }, ref) {
    const [localValues, setLocalValues] = useState<Record<string, string>>(() =>
      Object.fromEntries(section.fields.map((f) => [f.key, config[f.key]?.value ?? '']))
    );
    const [saving, setSaving] = useState(false);
  const [autoRestart, setAutoRestart] = useState(false);

    // Re-sync when parent config changes (e.g. after Save All refreshes config)
    useEffect(() => {
      setLocalValues(
        Object.fromEntries(section.fields.map((f) => [f.key, config[f.key]?.value ?? '']))
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
            Object.fromEntries(section.fields.map((f) => [f.key, newCfg[f.key]?.value ?? '']))
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
          {regularFields.length > 0 && (
            <Grid container spacing={2} sx={{ mb: toggleFields.length > 0 ? 0 : undefined }}>
              {regularFields.map((field) => (
                <Grid
                  item
                  key={field.key}
                  xs={12}
                  sm={field.type === 'textarea' ? 12 : 6}
                >
                  <FieldInput
                    field={field}
                    value={localValues[field.key] ?? ''}
                    onChange={handleChange}
                  />
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
