import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import EditIcon from '@mui/icons-material/Edit';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import {
  deleteRecurringTask,
  fetchRecurringTasks,
  runRecurringTask,
  updateRecurringTask,
} from '../api';
import type { RecurringTaskRecord, RecurringTaskSchedule } from '../types';

const WEEKDAYS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 7, label: 'Вс' },
];

function scheduleLabel(schedule: RecurringTaskSchedule): string {
  if (schedule.type === 'interval') {
    const minutes = schedule.intervalMinutes ?? 60;
    return minutes % 60 === 0 ? `Каждые ${minutes / 60} ч` : `Каждые ${minutes} мин`;
  }
  const time = `${String(schedule.hour ?? 9).padStart(2, '0')}:${String(schedule.minute ?? 0).padStart(2, '0')}`;
  if (schedule.type === 'daily') return `${schedule.interval === 1 ? 'Каждый день' : `Каждые ${schedule.interval} дн.`} в ${time}`;
  if (schedule.type === 'weekly') {
    const days = (schedule.daysOfWeek ?? []).map((day) => WEEKDAYS.find((item) => item.value === day)?.label).join(', ');
    return `${schedule.interval === 1 ? 'Каждую неделю' : `Каждые ${schedule.interval} нед.`}: ${days}, ${time}`;
  }
  return `${schedule.interval === 1 ? 'Каждый месяц' : `Каждые ${schedule.interval} мес.`}, ${schedule.dayOfMonth}-го в ${time}`;
}

function formatDate(value: string | null | undefined, timezone?: string): string {
  if (!value) return 'ещё не было';
  return new Date(value).toLocaleString('ru-RU', {
    timeZone: timezone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isTaskRunning(task: RecurringTaskRecord): boolean {
  if (!task.lockedAt) return false;
  return Date.now() - new Date(task.lockedAt).getTime() < 30 * 60 * 1000;
}

interface EditState {
  task: RecurringTaskRecord;
  title: string;
  prompt: string;
  schedule: RecurringTaskSchedule;
}

export function RecurringTasksSection() {
  const [tasks, setTasks] = useState<RecurringTaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);

  const activeCount = useMemo(() => tasks.filter((task) => task.status === 'active').length, [tasks]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await fetchRecurringTasks());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить задачи');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const mutate = async (id: string, action: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Операция не выполнена');
    } finally {
      setBusyId(null);
    }
  };

  const updateSchedule = (patch: Partial<RecurringTaskSchedule>) => {
    setEditing((current) => current ? {
      ...current,
      schedule: { ...current.schedule, ...patch },
    } : current);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const { task, title, prompt, schedule } = editing;
    setBusyId(task.id);
    try {
      await updateRecurringTask(task.id, { title, prompt, schedule });
      setEditing(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить задачу');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, mb: 2.5 }}>
        <Box>
          <Typography variant="h5" fontWeight={800}>Регулярные задачи</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            Повторный запуск сохранённых запросов и доставка свежего результата в Telegram.
          </Typography>
        </Box>
        <Tooltip title="Обновить">
          <IconButton onClick={() => void load()} disabled={loading}><RefreshIcon /></IconButton>
        </Tooltip>
      </Box>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Chip icon={<EventRepeatIcon />} label={`Всего: ${tasks.length}`} />
        <Chip color="success" variant="outlined" label={`Активно: ${activeCount}`} />
        <Chip variant="outlined" label={`На паузе: ${tasks.length - activeCount}`} />
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && tasks.length === 0 ? (
        <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 220 }}><CircularProgress /></Box>
      ) : tasks.length === 0 ? (
        <Alert severity="info">
          Регулярных задач пока нет. В Telegram отправьте запрос, дождитесь ответа и напишите: «Теперь присылай это каждое утро».
        </Alert>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'repeat(2, minmax(0, 1fr))' }, gap: 2 }}>
          {tasks.map((task) => (
            <Card key={task.id} variant="outlined" sx={{ borderRadius: 3, display: 'flex', flexDirection: 'column' }}>
              <CardContent sx={{ flexGrow: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1, mb: 1.5 }}>
                  <Typography variant="h6" fontWeight={750} sx={{ overflowWrap: 'anywhere' }}>{task.title}</Typography>
                  <FormControlLabel
                    label={task.status === 'active' ? 'Активна' : 'Пауза'}
                    labelPlacement="start"
                    control={
                      <Switch
                        checked={task.status === 'active'}
                        disabled={busyId === task.id || isTaskRunning(task)}
                        onChange={(_, checked) => void mutate(task.id, async () => {
                          await updateRecurringTask(task.id, { status: checked ? 'active' : 'paused' });
                        })}
                      />
                    }
                    sx={{ m: 0, flexShrink: 0 }}
                  />
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {task.prompt}
                </Typography>
                <Divider sx={{ my: 1.75 }} />
                <Stack spacing={0.75}>
                  {isTaskRunning(task) && <Chip color="info" size="small" label="Выполняется сейчас" sx={{ alignSelf: 'flex-start' }} />}
                  <Typography variant="body2">
                    <b>Чат:</b> {task.chatType === 'private' ? 'личный' : task.chatTitle || task.chatId}
                  </Typography>
                  <Typography variant="body2"><b>Расписание:</b> {scheduleLabel(task.schedule)}</Typography>
                  <Typography variant="body2"><b>Следующий запуск:</b> {formatDate(task.nextRunAt, task.timezone)}</Typography>
                  <Typography variant="body2"><b>Последний запуск:</b> {formatDate(task.lastCompletedAt, task.timezone)}</Typography>
                  <Typography variant="caption" color="text.secondary">Запусков: {task.runCount}</Typography>
                  {task.lastError && <Alert severity="warning" sx={{ mt: 1 }}>{task.lastError}</Alert>}
                </Stack>
              </CardContent>
              <CardActions sx={{ px: 2, pb: 2 }}>
                <Button
                  size="small"
                  startIcon={busyId === task.id ? <CircularProgress size={14} /> : <PlayArrowIcon />}
                  disabled={busyId === task.id || isTaskRunning(task)}
                  onClick={() => void mutate(task.id, () => runRecurringTask(task.id))}
                >
                  Запустить
                </Button>
                <Button
                  size="small"
                  startIcon={<EditIcon />}
                  disabled={busyId === task.id || isTaskRunning(task)}
                  onClick={() => setEditing({
                    task,
                    title: task.title,
                    prompt: task.prompt,
                    schedule: { ...task.schedule, daysOfWeek: [...(task.schedule.daysOfWeek ?? [])] },
                  })}
                >
                  Изменить
                </Button>
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  disabled={busyId === task.id || isTaskRunning(task)}
                  onClick={() => {
                    if (window.confirm(`Удалить регулярную задачу «${task.title}»?`)) {
                      void mutate(task.id, () => deleteRecurringTask(task.id));
                    }
                  }}
                >
                  Удалить
                </Button>
              </CardActions>
            </Card>
          ))}
        </Box>
      )}

      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} fullWidth maxWidth="md">
        <DialogTitle>Изменить регулярную задачу</DialogTitle>
        {editing && (
          <DialogContent>
            <Stack spacing={2} sx={{ pt: 1 }}>
              <TextField label="Название" value={editing.title} onChange={(event) => setEditing({ ...editing, title: event.target.value })} />
              <TextField label="Запрос" multiline minRows={4} value={editing.prompt} onChange={(event) => setEditing({ ...editing, prompt: event.target.value })} />
              <TextField
                select
                label="Тип расписания"
                value={editing.schedule.type}
                onChange={(event) => updateSchedule({ type: event.target.value as RecurringTaskSchedule['type'] })}
              >
                <MenuItem value="interval">Через равные интервалы</MenuItem>
                <MenuItem value="daily">По дням</MenuItem>
                <MenuItem value="weekly">По дням недели</MenuItem>
                <MenuItem value="monthly">По числам месяца</MenuItem>
              </TextField>

              {editing.schedule.type === 'interval' ? (
                <TextField
                  type="number"
                  label="Интервал, минут"
                  inputProps={{ min: 1 }}
                  value={editing.schedule.intervalMinutes ?? 60}
                  onChange={(event) => updateSchedule({ intervalMinutes: Number(event.target.value) })}
                />
              ) : (
                <>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, 1fr)' }, gap: 1.5 }}>
                    <TextField
                      type="number"
                      label={editing.schedule.type === 'daily' ? 'Каждые N дней' : editing.schedule.type === 'weekly' ? 'Каждые N недель' : 'Каждые N месяцев'}
                      inputProps={{ min: 1 }}
                      value={editing.schedule.interval ?? 1}
                      onChange={(event) => updateSchedule({ interval: Number(event.target.value) })}
                    />
                    <TextField type="number" label="Час" inputProps={{ min: 0, max: 23 }} value={editing.schedule.hour ?? 9} onChange={(event) => updateSchedule({ hour: Number(event.target.value) })} />
                    <TextField type="number" label="Минута" inputProps={{ min: 0, max: 59 }} value={editing.schedule.minute ?? 0} onChange={(event) => updateSchedule({ minute: Number(event.target.value) })} />
                  </Box>
                  {editing.schedule.type === 'weekly' && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">Дни недели</Typography>
                      <Stack direction="row" flexWrap="wrap">
                        {WEEKDAYS.map((day) => (
                          <FormControlLabel
                            key={day.value}
                            label={day.label}
                            control={
                              <Checkbox
                                checked={(editing.schedule.daysOfWeek ?? []).includes(day.value)}
                                onChange={(_, checked) => {
                                  const current = editing.schedule.daysOfWeek ?? [];
                                  updateSchedule({
                                    daysOfWeek: checked
                                      ? [...new Set([...current, day.value])].sort()
                                      : current.filter((value) => value !== day.value),
                                  });
                                }}
                              />
                            }
                          />
                        ))}
                      </Stack>
                    </Box>
                  )}
                  {editing.schedule.type === 'monthly' && (
                    <TextField
                      type="number"
                      label="Число месяца"
                      inputProps={{ min: 1, max: 31 }}
                      value={editing.schedule.dayOfMonth ?? 1}
                      onChange={(event) => updateSchedule({ dayOfMonth: Number(event.target.value) })}
                    />
                  )}
                </>
              )}
            </Stack>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setEditing(null)}>Отмена</Button>
          <Button variant="contained" onClick={() => void saveEdit()} disabled={!editing?.title.trim() || !editing?.prompt.trim() || busyId === editing?.task.id}>
            Сохранить
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
