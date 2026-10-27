import type {
  ConfigResponse,
  AiUsageQuery,
  AiUsageSummaryResponse,
  HealthExportFormat,
  HealthLogQuery,
  HealthLogsResponse,
  AiPresetName,
  AiPresetResponse,
  ModelPreferencesResponse,
  MemoryFormPayload,
  MemoryGraphQuery,
  MemoryGraphResponse,
  MemoryQuery,
  MemoryRecord,
  MemoryResponse,
  MonitoringHealthResponse,
  PersonalityConfig,
  RecurringTaskRecord,
  RecurringTaskSchedule,
  RecurringTaskStatus,
} from './types';
import type { BudgetMode } from '../../ai/budgetMode';
import type { BackgroundFeature, BackgroundFeatureState } from '../../ai/backgroundFeatures';

export const AUTH_REQUIRED_EVENT = 'kira:auth-required';

export interface McpConnectionSettings { revision: string; configured: boolean; url: string; tokenConfigured: boolean; toolCount: number }
export interface McpConnectionDraft { revision: string; url: string; token?: string }
async function mcpApi(method = 'GET', data?: McpConnectionDraft | { revision: string }, suffix = '') {
  const response = await apiFetch(`/api/mcp/money-maker${suffix}`, { method,
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось настроить MCP');
  return body;
}
export function fetchMcpConnection(): Promise<McpConnectionSettings> { return mcpApi(); }
export function saveMcpConnection(data: McpConnectionDraft): Promise<McpConnectionSettings> { return mcpApi('PUT', data); }
export function deleteMcpConnection(revision: string): Promise<McpConnectionSettings> { return mcpApi('DELETE', { revision }); }
export function checkMcpConnection(data: McpConnectionDraft): Promise<{ success: boolean; toolCount: number }> { return mcpApi('POST', data, '/check'); }

export interface ImageGenerationConfig {
  settings: { enabled: boolean; model: string; size: string; quality: string };
  models: string[]; sizes: string[]; qualities: string[];
  connection: { configured: boolean; baseUrlSource: string; keySource: string };
  reference: { present: boolean; sha256?: string; source?: 'default' | 'custom' };
}
async function imageApi(path: string, init?: RequestInit) {
  const response = await apiFetch(`/api/image-generation${path}`, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Ошибка настройки изображений');
  return data;
}
export function fetchImageGeneration(): Promise<ImageGenerationConfig> { return imageApi(''); }
export function saveImageGeneration(settings: ImageGenerationConfig['settings']) {
  return imageApi('', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
}
export function uploadCharacterReference(file: File) {
  return imageApi('/reference', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
}
export function removeCharacterReference() { return imageApi('/reference', { method: 'DELETE' }); }
export function checkImageConnection(): Promise<{ success: boolean; models: string[] }> { return imageApi('/connection'); }

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  }
  return response;
}

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
  const r = await apiFetch('/api/config');
  if (!r.ok) throw new Error('Unauthorized');
  return r.json();
}

export async function saveConfig(data: Record<string, string | null>) {
  const r = await apiFetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json() as Promise<{ success: boolean; message?: string; error?: string }>;
}

export async function fetchAiPreset(): Promise<AiPresetResponse> {
  const r = await apiFetch('/api/ai-preset');
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load AI preset');
  }
  return r.json();
}

export async function fetchModelPreferences(): Promise<ModelPreferencesResponse> {
  const r = await apiFetch('/api/model-preferences');
  if (!r.ok) throw new Error('Не удалось загрузить настройки моделей');
  return r.json();
}
export async function saveModelPreferences(preferences: import('../../ai/modelPreferences').StrategyRequest) {
  const r = await apiFetch('/api/model-preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preferences) });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

export async function fetchBudgetMode(): Promise<{ mode: BudgetMode }> {
  const response = await apiFetch('/api/budget-mode');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить режим бюджета');
  return body;
}

export async function fetchBackgroundFeatures(): Promise<{ mode: BudgetMode; features: BackgroundFeatureState[] }> {
  const response = await apiFetch('/api/background-features');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить фоновые функции');
  return body;
}

export async function saveBackgroundFeature(feature: BackgroundFeature, enabled: boolean): Promise<{ message: string }> {
  const response = await apiFetch('/api/background-features', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feature, enabled }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось сохранить функцию');
  return body;
}

export async function saveBudgetMode(mode: BudgetMode): Promise<{ mode: BudgetMode; message: string }> {
  const response = await apiFetch('/api/budget-mode', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось сохранить режим бюджета');
  return body;
}

export async function fetchMonitoringHealth(): Promise<MonitoringHealthResponse> {
  const r = await apiFetch('/api/monitoring/health');
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load monitoring health');
  }
  return r.json();
}

export async function fetchAiUsageSummary(query: AiUsageQuery = {}): Promise<AiUsageSummaryResponse> {
  const params = toSearchParams(query);
  const url = params.toString() ? `/api/ai-usage/summary?${params}` : '/api/ai-usage/summary';
  const r = await apiFetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load AI usage summary');
  }
  return r.json();
}

export async function saveAiPreset(preset: AiPresetName) {
  const r = await apiFetch('/api/ai-preset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset }),
  });
  return r.json() as Promise<{ success: boolean; configuredPresetName?: AiPresetName; message?: string; error?: string }>;
}

export async function fetchPersonality(): Promise<PersonalityConfig> {
  const r = await apiFetch('/api/personality');
  if (!r.ok) throw new Error('Failed to load personality');
  return r.json();
}

export async function savePersonality(data: PersonalityConfig) {
  const r = await apiFetch('/api/personality', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return r.json() as Promise<{ success: boolean; message?: string; error?: string }>;
}

export async function restartService(service: string) {
  const r = await apiFetch(`/api/restart/${service}`, { method: 'POST' });
  return r.json() as Promise<{ success: boolean; message?: string; error?: string }>;
}

export async function fetchChats() {
  const r = await apiFetch('/api/chats');
  if (!r.ok) throw new Error('Failed to load chats');
  return r.json() as Promise<import('./types').ChatInfo[]>;
}

export async function setChatPublicMode(chatId: string, profile: string, enabled: boolean) {
  const r = await apiFetch(`/api/chats/${chatId}/public-mode`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, enabled }),
  });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

export async function setChatForbiddenTopics(chatId: string, profile: string, topics: string) {
  const r = await apiFetch(`/api/chats/${chatId}/forbidden-topics`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, topics }),
  });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

export async function setChatAllowedDomains(chatId: string, profile: string, domains: string[]) {
  const r = await apiFetch(`/api/chats/${chatId}/allowed-domains`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile, domains }),
  });
  return r.json() as Promise<{ success: boolean; error?: string }>;
}

function toSearchParams<T extends object>(query: T = {} as T) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  return params;
}

export async function fetchHealthLogs(query: HealthLogQuery = {}): Promise<HealthLogsResponse> {
  const params = toSearchParams(query);
  const url = params.toString() ? `/api/health/logs?${params}` : '/api/health/logs';
  const r = await apiFetch(url);
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

export async function fetchMemories(query: MemoryQuery = {}, signal?: AbortSignal): Promise<MemoryResponse> {
  const params = toSearchParams(query);
  const url = params.toString() ? `/api/memory?${params}` : '/api/memory';
  const r = await apiFetch(url, { signal });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load memories');
  }
  return r.json();
}

export async function fetchMemoryRecord(domain: string, id: string, scope: Pick<MemoryQuery, 'profile' | 'userId'>, signal?: AbortSignal): Promise<MemoryRecord> {
  const params = toSearchParams(scope);
  const response = await apiFetch(`/api/memory/${encodeURIComponent(domain)}/${encodeURIComponent(id)}?${params}`, { signal });
  if (!response.ok) throw new Error('Не удалось загрузить полный текст воспоминания');
  return (await response.json()).record;
}

export async function fetchMemoryGraph(query: MemoryGraphQuery = {}, signal?: AbortSignal): Promise<MemoryGraphResponse> {
  const params = toSearchParams(query);
  const url = params.toString() ? `/api/memory/graph?${params}` : '/api/memory/graph';
  const r = await apiFetch(url, { signal });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Failed to load memory graph');
  }
  return r.json();
}

export async function createMemory(payload: MemoryFormPayload) {
  const r = await apiFetch('/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Failed to create memory');
  return body as { success: boolean; record?: import('./types').MemoryRecord };
}

export async function updateMemory(domain: string, id: string, payload: MemoryFormPayload) {
  const r = await apiFetch(`/api/memory/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Failed to update memory');
  return body as { success: boolean; record?: import('./types').MemoryRecord };
}

export async function deleteMemory(domain: string, id: string, query: Partial<Pick<MemoryQuery, 'profile' | 'userId'>> = {}) {
  const params = toSearchParams(query);
  const url = `/api/memory/${encodeURIComponent(domain)}/${encodeURIComponent(id)}${params.toString() ? `?${params}` : ''}`;
  const r = await apiFetch(url, { method: 'DELETE' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Failed to delete memory');
  return body as { success: boolean };
}

export async function fetchRecurringTasks(): Promise<RecurringTaskRecord[]> {
  const r = await apiFetch('/api/recurring-tasks');
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Failed to load recurring tasks');
  return body as RecurringTaskRecord[];
}

export async function updateRecurringTask(
  id: string,
  patch: Partial<{
    title: string;
    prompt: string;
    schedule: RecurringTaskSchedule;
    timezone: string;
    status: RecurringTaskStatus;
  }>,
): Promise<RecurringTaskRecord> {
  const r = await apiFetch(`/api/recurring-tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Failed to update recurring task');
  return body.task as RecurringTaskRecord;
}

export async function runRecurringTask(id: string): Promise<void> {
  const r = await apiFetch(`/api/recurring-tasks/${encodeURIComponent(id)}/run`, { method: 'POST' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Failed to run recurring task');
}

export async function deleteRecurringTask(id: string): Promise<void> {
  const r = await apiFetch(`/api/recurring-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || 'Failed to delete recurring task');
}
