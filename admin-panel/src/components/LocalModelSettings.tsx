import { useEffect, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, CircularProgress,
  MenuItem, Stack, TextField, Tooltip, Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { LocalModelRole, LocalModelRoutes } from '../../../ai/localModelRouting';
import roles from '../../../ai/local-model-roles.json';
import { apiFetch } from '../api';

interface Model { id: string; label: string; loaded: boolean; uncensored: boolean; loadedIds: string[]; }
interface Props { onToast: (message: string, severity: 'success' | 'error') => void; onSaved: () => void; }

export function LocalModelSettings({ onToast, onSaved }: Props) {
  const [settings, setSettings] = useState<LocalModelRoutes>(() => Object.fromEntries(Object.entries(roles).map(([key, role]) => [key, { model: '', maxTokens: role.maxTokens, reasoningEffort: role.reasoningEffort }])) as LocalModelRoutes);
  const [saved, setSaved] = useState('');
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function load() {
    setLoading(true);
    try {
      const response = await apiFetch('/api/local-models');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSettings(data.settings);
      setSaved(JSON.stringify(data.settings));
      setModels(data.models);
      setError(data.connectionError);
    } catch { setError('Не удалось загрузить локальные модели'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    setSaving(true);
    try {
      const response = await apiFetch('/api/local-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setSettings(result.settings);
      setSaved(JSON.stringify(result.settings));
      onToast('Модели по задачам сохранены', 'success');
      onSaved();
    } catch (failure) { onToast(failure instanceof Error ? failure.message : 'Не удалось сохранить модели', 'error'); }
    finally { setSaving(false); }
  }

  return <Stack spacing={2} data-testid="local-model-settings">
    <Typography variant="subtitle1" component="h2" fontWeight={600}>Локальные модели LM Studio</Typography>
    {error && <Alert severity="warning">{error}</Alert>}
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(3, minmax(0, 1fr))' }, gap: 2 }}>
      {(Object.keys(roles) as LocalModelRole[]).map(role => {
        const route = settings[role];
        const choices = [...models];
        if (route.model && !choices.some(model => model.id === route.model)) choices.push({ id: route.model, label: route.model, loaded: models.some(model => model.loadedIds.includes(route.model)), loadedIds: [], uncensored: false });
        const update = (patch: Partial<typeof route>) => setSettings(current => ({ ...current, [role]: { ...current[role], ...patch } }));
        return <Box key={role} sx={{ minWidth: 0, p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
          <Stack spacing={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography variant="body2" fontWeight={600}>{roles[role].label}</Typography>
              <Tooltip title={roles[role].description}><InfoOutlinedIcon tabIndex={0} aria-label={`О роли: ${roles[role].label}`} sx={{ fontSize: 16, color: 'text.secondary' }} /></Tooltip>
            </Stack>
            <TextField select size="small" fullWidth label={`Модель: ${roles[role].label}`} value={route.model} disabled={loading || saving} onChange={event => update({ model: event.target.value })}>
              {!route.model && <MenuItem value="">Выберите модель</MenuItem>}
              {choices.map(model => <MenuItem key={model.id} value={model.id}>{model.label}{model.uncensored ? ' · Uncensored' : ''}{model.loaded ? ' · загружена' : ''}</MenuItem>)}
            </TextField>
            <Accordion disableGutters sx={{ bgcolor: 'transparent', border: 0, mb: '0 !important' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />} id={`local-parameters-${role}`} aria-controls={`local-parameters-details-${role}`} sx={{ px: 0, minHeight: '40px !important', '& .MuiAccordionSummary-content': { my: '8px !important' } }}>
                <Typography variant="caption" color="text.secondary">Лимит и рассуждения</Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ px: 0 }}><Stack spacing={2}>
                <TextField select size="small" fullWidth label={`Рассуждения: ${roles[role].label}`} value={route.reasoningEffort} disabled={loading || saving} onChange={event => update({ reasoningEffort: event.target.value as typeof route.reasoningEffort })}>
                  <MenuItem value="none">Выключены</MenuItem><MenuItem value="low">Низкий уровень</MenuItem><MenuItem value="medium">Средний уровень</MenuItem><MenuItem value="high">Высокий уровень</MenuItem>
                </TextField>
                <TextField size="small" type="number" fullWidth label={`Лимит токенов: ${roles[role].label}`} value={route.maxTokens} disabled={loading || saving} inputProps={{ min: 32, max: 8192 }} onChange={event => update({ maxTokens: Number(event.target.value) })} />
                <Typography variant="caption" color="text.secondary">Лимит включает скрытые рассуждения.</Typography>
              </Stack></AccordionDetails>
            </Accordion>
          </Stack>
        </Box>;
      })}
    </Box>
    <Stack direction="row" spacing={1} alignItems="center">
      {JSON.stringify(settings) !== saved && !loading && <Button variant="contained" onClick={() => void save()} disabled={saving || Boolean(error)}>{saving ? <CircularProgress size={16} color="inherit" /> : 'Сохранить модели'}</Button>}
      <Button size="small" onClick={() => void load()} disabled={loading || saving}>Обновить список</Button>
      {loading && <CircularProgress size={18} aria-label="Загрузка локальных моделей" />}
    </Stack>
  </Stack>;
}
