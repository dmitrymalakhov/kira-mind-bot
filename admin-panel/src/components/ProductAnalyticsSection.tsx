import { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress,
  MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography } from '@mui/material';
import { apiFetch } from '../api';

type Rate = { value: number | null; numerator: number; denominator: number };
type Targets = Record<'weeklyValueUsers' | 'activation' | 'retentionW4' | 'success', number | null>;
type TargetComparison = {
  value: number | null; target: number | null; unit: 'users' | 'percentage_points'; delta: number | null; attainment: number | null;
  status: 'unset' | 'incomplete' | 'filtered' | 'no_data' | 'collecting' | 'met' | 'below'; reason: string;
  sample: number | null; minimumSample: number | null;
};
type Task = { id: string; source: string; channel: string; kind: string; scenario: string; startedAt: string;
  deliveredAt: string | null; status: string; technicalOk: boolean | null; ratings: Array<{ source: string; rating: string }> };
type Summary = {
  generatedAt: string; startedAt: string | null; sources: number; complete: boolean; targets: Targets;
  starterTargets: Targets; targetComparisons: Record<keyof Targets, TargetComparison>;
  weeklyValueUsers: number; activation: Rate; retentionW4: Rate; pendingActivation: number; pendingRetention: number;
  observedUsers: number; cohortUsers: number; success: Rate; assessedSuccess: Rate; coverage: Rate;
  csat: Rate; correction: Rate; memory: Rate; proactive: Rate; proactiveCoverage: Rate; trustIncidents: number;
  optOutUsers: number;
  timing: { p50: number | null; p90: number | null; samples: number; firstValueP50: number | null; firstValueP90: number | null;
    firstValueSamples: number; withoutFirstValue: number };
  totals: { tasks: number; delivered: number; assessed: number; technicalOk: number; failed: number; unresolved: number; feedbackOffered: number };
  scenarios: Array<{ scenario: string; tasks: number; success: Rate; assessed: number }>;
  daily: Array<{ date: string; tasks: number; valueUsers: number; successful: number }>; recent: Task[];
};
const SCENARIOS: Record<string, string> = { conversation: 'Разговор', memory: 'Память', reminder: 'Напоминания', search: 'Поиск', action: 'Действия', other: 'Другие обращения' };
const RATINGS: Record<string, string> = { helpful: 'Помогло', unhelpful: 'Не помогло', corrected: 'Пришлось исправлять', memory_correct: 'Память: ответ верный', memory_wrong: 'Ошибка памяти', trust: 'Ошибка доверия' };
const STATUSES: Record<string, string> = { running: 'В работе / исход не зафиксирован', waiting: 'Ожидает продолжения', delivered: 'Доставлен', failed: 'Ошибка', unknown: 'Исход неизвестен', cancelled: 'Отменён' };
const TARGET_LABELS = { weeklyValueUsers: 'Пользователи с пользой за 7 дней', activation: 'Активация за 24 часа, %', retentionW4: 'Удержание W4, %', success: 'Подтверждённый успех, %' };
const pct = (rate: Rate) => rate.value === null ? '—' : `${rate.value.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
const sample = (rate: Rate) => `${rate.numerator} из ${rate.denominator}`;
const duration = (ms: number | null) => ms === null ? '—' : ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} ч` : ms >= 60000 ? `${(ms / 60000).toFixed(1)} мин` : `${(ms / 1000).toFixed(1)} с`;
async function analyticsApi(path: string, init?: RequestInit) {
  const response = await apiFetch(`/api/product-analytics${path}`, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить аналитику');
  return body;
}
function Metric({ label, value, detail, target, comparison }: { label: string; value: string | number; detail: string;
  target?: number | null; comparison?: TargetComparison }) {
  const color = comparison?.status === 'met' ? 'success' : comparison?.status === 'below' ? 'error' : 'default';
  const format = (number: number, signed = false) => number.toLocaleString('ru-RU', { maximumFractionDigits: 1, signDisplay: signed ? 'exceptZero' : 'auto' });
  const unit = comparison?.unit === 'percentage_points' ? '%' : ' польз.';
  const delta = comparison?.delta;
  const change = delta != null && delta !== 0 && Math.abs(delta) < .05 ? `${delta > 0 ? '+' : '−'}<0,1` : delta != null ? format(delta, true) : '—';
  return <Paper variant="outlined" sx={{ p: 2.25, minWidth: 0 }}>
    <Typography variant="body2" color="text.secondary">{label}</Typography>
    <Typography variant="h4" sx={{ my: 1, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
    <Typography variant="caption" color="text.secondary" display="block">{detail}</Typography>
    {target !== undefined && <Stack spacing={1} sx={{ mt: 1.5 }}>
      <Chip size="small" sx={{ alignSelf: 'flex-start' }} variant="outlined" color={color}
        label={target === null ? 'Цель не задана' : `Цель ≥ ${format(target)}${unit}`} />
      {target !== null && comparison && <>
        <Typography variant="body2" sx={{ color: color === 'default' ? 'text.secondary' : `${color}.main`, fontWeight: 600 }}>
          Отклонение: {change}{delta == null ? '' : comparison.unit === 'users' ? ' польз.' : ' п.п.'}
        </Typography>
        {comparison.attainment !== null && <>
          <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, comparison.attainment))}
            color={color === 'default' ? 'inherit' : color} aria-label={`${label}: выполнение цели`} sx={{ height: 5, borderRadius: 1 }} />
          <Typography variant="caption" color="text.secondary">Выполнение цели: {format(comparison.attainment)}%</Typography>
        </>}
        <Typography variant="caption" color="text.secondary">{comparison.reason}</Typography>
      </>}
    </Stack>}
  </Paper>;
}

export function ProductAnalyticsSection() {
  const [days, setDays] = useState(30);
  const [channel, setChannel] = useState('');
  const [scenario, setScenario] = useState('');
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewRating, setReviewRating] = useState('helpful');
  const reload = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null);
    const params = new URLSearchParams({ days: String(days), channel, scenario });
    analyticsApi(`?${params}`, { signal: controller.signal }).then(setData)
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [days, channel, scenario, revision]);
  const saveTargets = async () => {
    setSaving(true); setError('');
    try {
      const body = Object.fromEntries(Object.keys(TARGET_LABELS).map(key => [key, targets[key] === '' ? null : Number(targets[key])]));
      await analyticsApi('/targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      setTargetsOpen(false); reload();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };
  const saveReview = async (task: Task) => {
    setSaving(true); setError('');
    try {
      await analyticsApi('/review', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: task.id, source: task.source, rating: reviewRating }) });
      setReviewing(null); reload();
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  };
  const unavailable = data && !data.complete;
  return <Stack spacing={2.5}>
    <Paper variant="outlined" sx={{ p: 2 }}><Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5} alignItems="center">
      <TextField select size="small" label="Период" value={days} onChange={event => setDays(Number(event.target.value))} sx={{ minWidth: 135 }}>
        {[7, 30, 90].map(value => <MenuItem key={value} value={value}>{value} дней</MenuItem>)}</TextField>
      <TextField select size="small" label="Канал" value={channel} onChange={event => setChannel(event.target.value)} sx={{ minWidth: 140 }}>
        <MenuItem value="">Все каналы</MenuItem><MenuItem value="telegram">Telegram</MenuItem><MenuItem value="api">Приложение / API</MenuItem></TextField>
      <TextField select size="small" label="Сценарий" value={scenario} onChange={event => setScenario(event.target.value)} sx={{ minWidth: 170 }}>
        <MenuItem value="">Все сценарии</MenuItem>{Object.entries(SCENARIOS).map(([key, label]) => <MenuItem key={key} value={key}>{label}</MenuItem>)}</TextField>
      <Button onClick={reload} disabled={loading}>Обновить</Button>
      <Button variant="outlined" disabled={!data || loading} onClick={() => {
        setTargets(Object.fromEntries(Object.entries(data!.targets).map(([key, value]) => [key, value === null ? '' : String(value)]))); setTargetsOpen(true);
      }}>Настроить цели</Button>
    </Stack></Paper>
    {error && <Alert severity="error">{error}</Alert>}
    {loading && <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress aria-label="Загрузка аналитики" /></Box>}
    {data && <>
      <Typography variant="body2" color="text.secondary">Источников: {data.sources}. Наблюдаемых пользователей: {data.observedUsers}.
        {data.startedAt ? ` Сбор данных с ${new Date(data.startedAt).toLocaleString('ru-RU')}.` : ' Сбор данных начнётся после обновления runtime.'}</Typography>
      {unavailable && <Alert severity="warning">Часть источников ещё не обновлена или выборка превысила лимит. Итоговые KPI скрыты до получения полной выборки; таблицы ниже показывают доступные данные.</Alert>}
      {!data.totals.tasks && <Alert severity="info">За выбранный период обращений пока нет. История до подключения аналитики не считается подтверждённой пользой.</Alert>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', xl: 'repeat(4, 1fr)' }, gap: 2 }}>
        <Metric label="Пользователи с пользой за 7 дней" value={unavailable ? '—' : data.weeklyValueUsers} detail="Хотя бы один доставленный результат с положительной оценкой" target={data.targets.weeklyValueUsers} comparison={data.targetComparisons?.weeklyValueUsers} />
        <Metric label="Активация за 24 часа" value={unavailable ? '—' : pct(data.activation)} detail={`${sample(data.activation)} новых пользователей; окно 24 часа завершено`} target={data.targets.activation} comparison={data.targetComparisons?.activation} />
        <Metric label="Удержание по пользе W4" value={unavailable ? '—' : pct(data.retentionW4)} detail={`${sample(data.retentionW4)} пользователей получили пользу на 22–28-й день`} target={data.targets.retentionW4} comparison={data.targetComparisons?.retentionW4} />
        <Metric label="Подтверждённый успех обращений" value={unavailable ? '—' : pct(data.success)} detail={`${sample(data.success)} начатых обращений; неоценённые остаются в знаменателе`} target={data.targets.success} comparison={data.targetComparisons?.success} />
      </Box>
      <Typography variant="caption" color="text.secondary">Отклонение = факт − цель. Для процентов разница показана в процентных пунктах.
        На малой выборке сравнение предварительное: для процентов нужно 20 наблюдений, для успеха — также 20 оценок и покрытие ≥ 80% всех обращений.
        Общие цели сравниваются только со всеми каналами и сценариями. Пороги нужны для чтения дашборда и не доказывают статистическую значимость.</Typography>
      <Alert severity="info">Польза подтверждается оценкой пользователя или ручной проверкой. Доставка ответа и техническое выполнение сами по себе не подтверждают пользу.
        Покрытие оценками: {pct(data.coverage)} ({sample(data.coverage)} доставленных результатов). Успех среди оценённых: {pct(data.assessedSuccess)}.
        Активация и W4 используют регистрацию новых аккаунтов после начала сбора данных. Старые аккаунты и одиночная установка без регистрации в эти когорты не входят.
        Для W4 берутся регистрации за выбранный период со сдвигом на 28 дней; незрелых новых пользователей: {data.pendingRetention}.
        Фильтры канала и сценария применяются к результатам; когорта регистрации остаётся общей.</Alert>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }, gap: 2 }}>
        <Metric label="Время до результата" value={duration(data.timing.p50)} detail={`Медиана; p90 ${duration(data.timing.p90)}; ${data.timing.samples} доставленных результатов. Успешность оценивается отдельно.`} />
        <Metric label="Время до первой пользы" value={duration(data.timing.firstValueP50)} detail={`p90 ${duration(data.timing.firstValueP90)}; ${data.timing.firstValueSamples} получили пользу; ${data.timing.withoutFirstValue} пока без неё`} />
        <Metric label="Удовлетворённость (CSAT)" value={pct(data.csat)} detail={`${sample(data.csat)} оценок пользователей положительные`} />
        <Metric label="Пришлось исправлять" value={pct(data.correction)} detail={`${sample(data.correction)} оценённых обращений. Автоматически по тексту не угадывается.`} />
        <Metric label="Корректность памяти по оценкам" value={pct(data.memory)} detail={`${sample(data.memory)} явно проверенных ответов памяти. Это не автоматическая оценка полноты поиска.`} />
        <Metric label="Полезность проактивности" value={pct(data.proactive)} detail={`${sample(data.proactive)} оценённых сообщений; покрытие ${pct(data.proactiveCoverage)}`} />
        <Metric label="Ошибки доверия" value={data.trustIncidents} detail="Зарегистрированные пользователем или проверяющим случаи; допустимая цель — 0" />
        <Metric label="Ошибки выполнения" value={data.totals.failed} detail={`Исход не завершён / неизвестен: ${data.totals.unresolved}. Технически выполнено: ${data.totals.technicalOk}.`} />
        <Metric label="Отключили проактивные функции" value={data.optOutUsers} detail="Пользователи, явно выключившие сообщения в настройках за период. Повторное сохранение выключенного флага не считается новым отказом. Без фильтра канала и сценария." />
      </Box>
      <Paper variant="outlined" sx={{ p: 2.5 }}><Typography variant="h6" gutterBottom>Польза по дням</Typography>
        <Box sx={{ display: 'flex', alignItems: 'end', gap: .5, height: 160, overflowX: 'auto' }} role="img" aria-label="Число пользователей с подтверждённой пользой по дням">
          {data.daily.map(day => <Box key={day.date} title={`${day.date}: пользователей с пользой ${day.valueUsers}; обращений ${day.tasks}`} sx={{ flex: 1, minWidth: 7, height: '100%', display: 'flex', alignItems: 'end' }}>
            <Box sx={{ width: '100%', height: `${Math.max(2, 100 * day.valueUsers / Math.max(1, ...data.daily.map(item => item.valueUsers)))}%`, bgcolor: day.valueUsers ? 'primary.main' : 'action.hover', borderRadius: '3px 3px 0 0' }} />
          </Box>)}</Box><Stack direction="row" justifyContent="space-between"><Typography variant="caption">{data.daily[0]?.date}</Typography><Typography variant="caption">{data.daily.at(-1)?.date}</Typography></Stack>
      </Paper>
      <Paper variant="outlined"><TableContainer><Table size="small"><TableHead><TableRow><TableCell>Сценарий</TableCell><TableCell>Обращения</TableCell><TableCell>Оценено</TableCell><TableCell>Подтверждённый успех</TableCell></TableRow></TableHead><TableBody>
        {data.scenarios.map(row => <TableRow key={row.scenario}><TableCell>{SCENARIOS[row.scenario]}</TableCell><TableCell>{row.tasks}</TableCell><TableCell>{row.assessed}</TableCell><TableCell>{pct(row.success)} · {sample(row.success)}</TableCell></TableRow>)}
      </TableBody></Table></TableContainer></Paper>
      <Paper variant="outlined" sx={{ p: 2.5 }}><Typography variant="h6">Последние результаты</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>До 50 последних обращений и фоновых доставок. Ручную оценку ставьте после проверки результата в исходном канале. Тексты диалогов сюда не копируются.</Typography>
        <TableContainer><Table size="small"><TableHead><TableRow><TableCell>Время</TableCell><TableCell>Сценарий / канал</TableCell><TableCell>Состояние</TableCell><TableCell>Оценки</TableCell><TableCell>Проверка</TableCell></TableRow></TableHead><TableBody>
          {data.recent.map(task => <TableRow key={`${task.source}:${task.id}`}><TableCell>{new Date(task.startedAt).toLocaleString('ru-RU')}</TableCell>
            <TableCell>{SCENARIOS[task.scenario]}<Typography variant="caption" display="block">{task.channel === 'api' ? 'Приложение / API' : 'Telegram'} · {task.kind === 'interactive' ? 'Обращение' : task.kind === 'proactive' ? 'Проактивность' : 'По расписанию'}</Typography></TableCell>
            <TableCell>{STATUSES[task.status] || task.status}</TableCell><TableCell>{task.ratings.map(rating => `${rating.source === 'user' ? 'Пользователь' : 'Проверка'}: ${RATINGS[rating.rating]}`).join('; ') || 'Не оценён'}</TableCell>
            <TableCell>{reviewing === task.id ? <Stack spacing={1}><TextField select size="small" label="Результат проверки" value={reviewRating} onChange={event => setReviewRating(event.target.value)}>
              {Object.entries(RATINGS).map(([key, label]) => <MenuItem key={key} value={key}>{label}</MenuItem>)}</TextField><Stack direction="row"><Button size="small" disabled={saving} onClick={() => saveReview(task)}>Сохранить</Button><Button size="small" disabled={saving} onClick={() => setReviewing(null)}>Отмена</Button></Stack></Stack>
              : <Button size="small" disabled={!task.deliveredAt || saving} onClick={() => { setReviewing(task.id); setReviewRating('helpful'); }}>Оценить</Button>}</TableCell>
          </TableRow>)}
        </TableBody></Table></TableContainer>
      </Paper>
    </>}
    <Dialog open={targetsOpen} onClose={() => { if (!saving) setTargetsOpen(false); }} maxWidth="sm" fullWidth><DialogTitle>Цели продукта</DialogTitle><DialogContent>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Стартовые ориентиры пилота: 10 пользователей с пользой за неделю, активация 60%, W4 30%, подтверждённый успех 70%.
        Это рабочие гипотезы, которые стоит пересмотреть после накопления данных. Пустое поле отключает цель.</Typography>
      <Button size="small" disabled={saving || !data?.starterTargets} onClick={() => setTargets(Object.fromEntries(
        Object.entries(data!.starterTargets).map(([key, value]) => [key, value === null ? '' : String(value)])))} sx={{ mb: 1 }}>Подставить стартовые значения</Button>
      <Stack spacing={2} sx={{ pt: 1 }}>{Object.entries(TARGET_LABELS).map(([key, label]) => <TextField key={key} type="number" label={label} value={targets[key] ?? ''}
        inputProps={{ min: 0, max: key === 'weeklyValueUsers' ? 1e9 : 100, step: key === 'weeklyValueUsers' ? 1 : .1 }} onChange={event => setTargets(previous => ({ ...previous, [key]: event.target.value }))} />)}</Stack>
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    </DialogContent><DialogActions><Button disabled={saving} onClick={() => setTargetsOpen(false)}>Отмена</Button><Button variant="contained" disabled={saving || Object.values(targets).some(value => value !== '' && !Number.isFinite(Number(value)))} onClick={saveTargets}>Сохранить</Button></DialogActions></Dialog>
  </Stack>;
}
