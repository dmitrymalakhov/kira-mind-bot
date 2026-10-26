export type MonitoringPaletteStatus =
  | 'ok' | 'warn' | 'down' | 'disabled' | 'degraded'
  | 'running' | 'paused' | 'exited' | 'stopped' | 'restarting' | 'created' | 'removing' | string;

export function getStatusAppearance(status: MonitoringPaletteStatus) {
  if (status === 'ok' || status === 'running') {
    return { dot: '#29735B', bg: 'rgba(16, 185, 129, 0.12)', border: 'rgba(110, 231, 183, 0.26)', text: '#246348', label: status === 'running' ? 'РАБОТАЕТ' : 'ИСПРАВНО' };
  }
  if (status === 'warn' || status === 'degraded' || status === 'paused' || status === 'exited' || status === 'stopped') {
    return { dot: '#A26C23', bg: 'rgba(245, 158, 11, 0.12)', border: 'rgba(253, 224, 71, 0.26)', text: '#80551A', label: status === 'degraded' ? 'СНИЖЕННАЯ РАБОТОСПОСОБНОСТЬ' : status === 'warn' ? 'ПРЕДУПРЕЖДЕНИЕ' : 'ОСТАНОВЛЕНО' };
  }
  if (status === 'disabled') {
    return { dot: '#7A857C', bg: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.24)', text: '#58655D', label: 'ОТКЛЮЧЕНО' };
  }
  if (status === 'restarting' || status === 'created' || status === 'removing') {
    const labels = { restarting: 'ПЕРЕЗАПУСК', created: 'СОЗДАНО', removing: 'УДАЛЕНИЕ' } as const;
    return { dot: '#457698', bg: 'rgba(96, 165, 250, 0.12)', border: 'rgba(147, 197, 253, 0.24)', text: '#355F80', label: labels[status as keyof typeof labels] };
  }
  return { dot: '#B14D4D', bg: 'rgba(239, 68, 68, 0.12)', border: 'rgba(252, 165, 165, 0.26)', text: '#9C4545', label: 'ОШИБКА' };
}
