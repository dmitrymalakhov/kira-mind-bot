import type {
  ConfigResponse,
  HealthExportFormat,
  HealthLogQuery,
  HealthLogsResponse,
  PersonalityConfig,
} from './types';

export async function login(username: string, password: string) {
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST' });
}

export async function fetchConfig(): Promise<ConfigResponse> {
  const r = await fetch('/api/config');
  if (!r.ok) throw new Error('Unauthorized');
  return r.json();
}

export async function saveConfig(data: Record<string, string>) {
  const r = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json() as Promise<{ success: boolean; message?: string; error?: string }>;
}

export async function fetchPersonality(): Promise<PersonalityConfig> {
  const r = await fetch('/api/personality');
  if (!r.ok) throw new Error('Failed to load personality');
  return r.json();
}

export async function savePersonality(data: PersonalityConfig) {
  const r = await fetch('/api/personality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json() as Promise<{ success: boolean; message?: string; error?: string }>;
}

export async function restartService(service: string) {
  const r = await fetch(`/api/restart/${service}`, { method: 'POST' });
  return r.json() as Promise<{ success: boolean; message?: string; error?: string }>;
}

export async function fetchChats() {
  const r = await fetch('/api/chats');
  if (!r.ok) throw new Error('Failed to load chats');
  return r.json() as Promise<import('./types').ChatInfo[]>;
}

export async function setChatPublicMode(chatId: string, profile: string, enabled: boolean) {
  const r = await fetch(`/api/chats/${chatId}/public-mode`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, enabled }),
  });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

export async function setChatForbiddenTopics(chatId: string, profile: string, topics: string) {
  const r = await fetch(`/api/chats/${chatId}/forbidden-topics`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, topics }),
  });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

export async function setChatAllowedDomains(chatId: string, profile: string, domains: string[]) {
  const r = await fetch(`/api/chats/${chatId}/allowed-domains`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, domains }),
  });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

function toSearchParams(query: HealthLogQuery = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  return params;
}

export async function fetchHealthLogs(query: HealthLogQuery = {}): Promise<HealthLogsResponse> {
  const params = toSearchParams(query);
  const url = params.toString() ? `/api/health/logs?${params}` : '/api/health/logs';
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load health logs');
  }
  return r.json();
}

export function buildHealthExportUrl(format: HealthExportFormat, query: HealthLogQuery = {}) {
  const params = toSearchParams({ ...query, offset: undefined });
  params.set('format', format);
  return `/api/health/export?${params}`;
}
