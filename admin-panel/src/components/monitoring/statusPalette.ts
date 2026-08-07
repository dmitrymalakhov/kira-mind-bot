export type MonitoringPaletteStatus =
  | 'ok' | 'warn' | 'down' | 'disabled' | 'degraded'
  | 'running' | 'paused' | 'exited' | 'stopped' | 'restarting' | 'created' | 'removing' | string;

export function getStatusAppearance(status: MonitoringPaletteStatus) {
  if (status === 'ok' || status === 'running') {
    return { dot: '#67e8b2', bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(110, 231, 183, 0.26)', text: '#b8f7d8', label: status === 'running' ? 'РАБОТАЕТ' : 'ИСПРАВНО' };
  }
  if (status === 'warn' || status === 'degraded' || status === 'paused' || status === 'exited' || status === 'stopped') {
    return { dot: '#fbbf24', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(253, 224, 71, 0.26)', text: '#ffe0a3', label: status === 'degraded' ? 'СНИЖЕННАЯ РАБОТОСПОСОБНОСТЬ' : status === 'warn' ? 'ПРЕДУПРЕЖДЕНИЕ' : 'ОСТАНОВЛЕНО' };
  }
  if (status === 'disabled') {
    return { dot: '#cbd5e1', bg: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.24)', text: '#dbe4ef', label: 'ОТКЛЮЧЕНО' };
  }
  if (status === 'restarting' || status === 'created' || status === 'removing') {
    const labels = { restarting: 'ПЕРЕЗАПУСК', created: 'СОЗДАНО', removing: 'УДАЛЕНИЕ' } as const;
    return { dot: '#93c5fd', bg: 'rgba(96, 165, 250, 0.12)', border: 'rgba(147, 197, 253, 0.24)', text: '#dbeafe', label: labels[status as keyof typeof labels] };
  }
  return { dot: '#fca5a5', bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(252, 165, 165, 0.26)', text: '#ffd1d1', label: 'ОШИБКА' };
}
