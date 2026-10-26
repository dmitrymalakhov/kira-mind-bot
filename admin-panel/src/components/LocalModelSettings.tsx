import { useEffect, useState } from 'react';
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { LocalModelRole, LocalModelRoutes } from '../../../ai/localModelRouting';
import roles from '../../../ai/local-model-roles.json';

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
      const response = await fetch('/api/local-models');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSettings(data.settings); setSaved(JSON.stringify(data.settings));
      setModels(data.models); setError(data.connectionError);
    } catch { setError('Не удалось загрузить локальные модели'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  async function save() {
    setSaving(true);
    try {
      const response = await fetch('/api/local-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setSettings(result.settings);
      setSaved(JSON.stringify(result.settings));
      onToast('Модели по задачам сохранены. Применятся в течение 5 секунд.', 'success');
      onSaved();
    } catch (e) { onToast(e instanceof Error ? e.message : 'Не удалось сохранить модели', 'error'); }
    finally { setSaving(false); }
  }
  return <Stack spacing={2} data-testid="local-model-settings">
    <Typography fontWeight={600}>Локальные модели по задачам</Typography>
    <Typography variant="body2" color="text.secondary">
      Эти настройки действуют в профилях LM Studio и гибриде. В гибриде глубокий анализ выполняет GPT через lmrouter.
      Для скорости можно выбрать одну модель для нескольких ролей и оставить рассуждения выключенными в быстрых ролях.
    </Typography>
    {error && <Alert severity="warning">{error}</Alert>}
    {(Object.keys(roles) as LocalModelRole[]).map(role => {
      const route = settings[role];
      const choices = [...models];
      if (route.model && !choices.some(m => m.id === route.model)) choices.push({ id: route.model, label: route.model, loaded: models.some(m => m.loadedIds.includes(route.model)), loadedIds: [], uncensored: false });
      const update = (patch: Partial<typeof route>) => setSettings(current => ({ ...current, [role]: { ...current[role], ...patch } }));
      return <Box key={role} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
        <Stack spacing={1.5}>
          <Typography variant="body2" fontWeight={600}>{roles[role].label}</Typography>
          <Typography variant="caption" color="text.secondary">{roles[role].description}</Typography>
          <TextField select fullWidth label={`Модель: ${roles[role].label}`} value={route.model} disabled={loading || saving} onChange={e => update({ model: e.target.value, freeDialogue: false })}>
            {!route.model && <MenuItem value="">Выберите модель</MenuItem>}
            {choices.map(m => <MenuItem key={m.id} value={m.id}>{m.label}{m.uncensored ? ' · Uncensored' : ''}{m.loaded ? ' · загружена' : ''}</MenuItem>)}
          </TextField>
          <FormControlLabel control={<Checkbox checked={route.freeDialogue === true} disabled={loading || saving}
            onChange={(_, freeDialogue) => update({ freeDialogue })} />} label="Использовать эту модель для свободного диалога" />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
            <TextField select fullWidth label={`Рассуждения: ${roles[role].label}`} value={route.reasoningEffort} onChange={e => update({ reasoningEffort: e.target.value as typeof route.reasoningEffort })} disabled={loading || saving}>
              <MenuItem value="none">Выключены — быстрый ответ</MenuItem><MenuItem value="low">Низкий уровень</MenuItem><MenuItem value="medium">Средний уровень</MenuItem><MenuItem value="high">Высокий уровень</MenuItem>
            </TextField>
            <TextField type="number" fullWidth label={`Лимит токенов: ${roles[role].label}`} value={route.maxTokens} onChange={e => update({ maxTokens: Number(e.target.value) })} inputProps={{ min: 32, max: 8192 }} disabled={loading || saving} />
          </Stack>
        </Stack>
      </Box>;
    })}
    <Typography variant="caption" color="text.secondary">Токены включают скрытые рассуждения. Некоторые модели поддерживают только «вкл./выкл.»; уровни не гарантируют одинаковую скорость. Первый запрос к незагруженной модели включает её загрузку.</Typography>
    <Stack direction="row" spacing={1}>
      <Button variant="contained" onClick={() => void save()} disabled={loading || saving || Boolean(error) || JSON.stringify(settings) === saved}>{saving ? <CircularProgress size={16} /> : 'Сохранить модели по задачам'}</Button>
      <Button onClick={() => void load()} disabled={loading || saving}>Обновить список</Button>
    </Stack>
  </Stack>;
}
