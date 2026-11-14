import type {
  ConfigResponse,
  AiUsageQuery,
  AiUsageSummaryResponse,
  AiUsageTraceChain,
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
import type { ActivityMode, ActivityModeDescriptor, ActivityPreset } from '../../ai/activityModes';
import type { BackgroundFeature, BackgroundFeatureState } from '../../ai/backgroundFeatures';
import { globalAdminRoute } from '../accountRoutes';

export const AUTH_REQUIRED_EVENT = 'kira:auth-required';
export const ACCOUNT_REQUESTS_EVENT = 'kira:account-requests';
let selectedAdminAccount: string | undefined;
let accountGeneration = 0, pendingMutations = 0;
let accountAbort = new AbortController();
export function activeAdminAccount() { return selectedAdminAccount; }
export function adminMutationPending() { return pendingMutations > 0; }
export function setAdminAccount(id: string | undefined, force = false) {
  if (selectedAdminAccount === id) return;
  if (pendingMutations && !force) throw new Error('Дождитесь завершения сохранения перед переключением аккаунта.');
  if (id !== undefined && id !== 'instance' && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Некорректный аккаунт.');
  accountAbort.abort(); accountAbort = new AbortController(); accountGeneration++; selectedAdminAccount = id;
}
export function adminResourceUrl(path: string, account = selectedAdminAccount) {
  return operatorBase + (account && !globalAdminRoute(path) ? `/api/account-scopes/${account}/${path.slice('/api/'.length)}` : path);
}
function operationKey() { return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join(''); }
export function configRevision(config: ConfigResponse) { return Object.values(config).find(entry=>entry.revision)?.revision; }
export class AdminApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export type McpEffect = 'read' | 'external';
export interface McpServerSettings {
  description: string; transport: 'http' | 'jsonrpc' | 'stdio'; url?: string;
  headers?: Record<string, string | null>; command?: string; args?: string[]; env?: Record<string, string | null>;
  oauth?: { tokenUrl: string; clientId: string; clientSecret: string | null; scope?: string; audience?: string };
  tools: Record<string, McpEffect>; fixedArguments?: Record<string, unknown>; timeoutMs: number;
}
export interface McpConnection { id: string; config: McpServerSettings }
export interface McpConnectionSettings {
  revision: string; servers: McpConnection[]; templates: Array<McpConnection & { name: string }>;
}
export interface McpConnectionDraft { revision: string; config: McpServerSettings }
export interface McpProbeResult { success: boolean; toolCount: number; tools: Array<{ name: string; description: string }>; truncated: boolean; resources: boolean }
async function mcpApi(method = 'GET', data?: McpConnectionDraft | { revision: string }, suffix = '') {
  const response = await apiFetch(`/api/mcp/servers${suffix}`, { method,
    ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось настроить MCP');
  return body;
}
export function fetchMcpConnections(): Promise<McpConnectionSettings> { return mcpApi(); }
export function saveMcpConnection(id: string, data: McpConnectionDraft, create = false): Promise<McpConnectionSettings> { return mcpApi(create ? 'POST' : 'PUT', data, `/${encodeURIComponent(id)}`); }
export function deleteMcpConnection(id: string, revision: string): Promise<McpConnectionSettings> { return mcpApi('DELETE', { revision }, `/${encodeURIComponent(id)}`); }
export function checkMcpConnection(id: string, data: McpConnectionDraft): Promise<McpProbeResult> { return mcpApi('POST', data, `/${encodeURIComponent(id)}/check`); }

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

export interface ImageRecognitionConfig {
  settings: import('../../ai/imageRecognition').ImageRecognitionSettings;
  models: Array<{ id: string; label: string; loaded: boolean; loadedIds: string[] }>;
  connectionError: string | null;
}
export async function fetchImageRecognition(): Promise<ImageRecognitionConfig> {
  const response = await apiFetch('/api/image-recognition');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось загрузить настройки распознавания');
  return data;
}
export async function saveImageRecognition(settings: ImageRecognitionConfig['settings']): Promise<{ settings: ImageRecognitionConfig['settings'] }> {
  const response = await apiFetch('/api/image-recognition', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Не удалось сохранить настройки распознавания');
  return data;
}

const operatorBase = typeof window !== 'undefined' && window.location.pathname.startsWith('/operator/') ? '/operator' : '';
export interface OperatorAuthContext {
  csrfToken: string; csrfEnabled: boolean; accountLoginEnabled: boolean;
  accountAuthorized: boolean; legacyAuthenticated: boolean; accountConsoleUrl: string;
}
export async function fetchOperatorAuthContext(): Promise<OperatorAuthContext> {
  const response = await fetch(operatorBase + '/api/auth/context', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('Не удалось проверить вход');
  return response.json();
}
let refreshingAccount: Promise<boolean> | undefined;
function refreshAccountSession(): Promise<boolean> {
  if (refreshingAccount) return refreshingAccount;
  refreshingAccount = (async () => {
    try {
      const context = await fetchOperatorAuthContext();
      if (!context.accountLoginEnabled) return false;
      const configResponse = await fetch('/api/v1/web/config', { credentials: 'same-origin', cache: 'no-store' });
      if (!configResponse.ok) return false;
      const config = await configResponse.json();
      const result = await fetch('/api/v1/web/auth/refresh', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': config.csrfToken }, body: JSON.stringify({ version: 1 }) });
      return result.ok;
    } catch { return false; }
  })().finally(() => { refreshingAccount = undefined; });
  return refreshingAccount;
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const ownApi = typeof input === 'string' && input.startsWith('/api/');
  const scoped = ownApi && !globalAdminRoute(input);
  const account = selectedAdminAccount, generation = accountGeneration, controller = accountAbort;
  const target = ownApi ? adminResourceUrl(input,account) : input;
  const method = (init?.method || 'GET').toUpperCase();
  const headers = new Headers(init?.headers);
  const mutation = ownApi && !['GET','HEAD','OPTIONS'].includes(method);
  if(scoped && account)headers.set('x-kira-account-id',account);
  const signal=scoped ? AbortSignal.any([controller.signal,...(init?.signal?[init.signal]:[])]) : init?.signal;
  if(mutation){pendingMutations++;window.dispatchEvent(new Event(ACCOUNT_REQUESTS_EVENT));if(!headers.has('idempotency-key'))headers.set('idempotency-key',operationKey());}
  try {
  if (mutation) {
    const context = await fetchOperatorAuthContext();
    if (context.csrfEnabled) headers.set('x-csrf-token', context.csrfToken);
  }
  if(scoped && generation!==accountGeneration)throw new DOMException('Аккаунт изменился','AbortError');
  const options = { ...init, headers,signal };
  let response = await fetch(target, options);
  // A 401 is an authorization refusal before the handler. Keep the original
  // action/body/idempotency key when retrying after canonical account refresh.
  if (response.status === 401 && ownApi && input !== '/api/login' && !String(input).includes('/operator/link-account')
    && !String(input).includes('/operator/unlink-account') && await refreshAccountSession()) response = await fetch(target, options);
  if (response.status === 401) window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if(scoped){
    if(generation!==accountGeneration)throw new DOMException('Аккаунт изменился','AbortError');
    if(response.ok && account && response.headers.get('x-kira-account-id')!==account)throw new Error('Сервер не подтвердил область выбранной Киры. Обновите админку.');
  }
  if(mutation)await response.clone().arrayBuffer();
  return response;
  } finally { if(mutation){pendingMutations--;window.dispatchEvent(new Event(ACCOUNT_REQUESTS_EVENT));} }
}

export async function login(username: string, password: string) {
  const response = await apiFetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return response.json() as Promise<{ success: boolean; error?: string }>;
}
export async function loginWithAccount() {
  const response = await apiFetch('/api/operator/login-account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return response.json() as Promise<{ success: boolean; error?: string }>;
}
export async function logout() { await apiFetch('/api/logout', { method: 'POST' }); }

export async function fetchConfig(): Promise<ConfigResponse> {
  const r = await apiFetch('/api/config');
  const data=await r.json();
  if (!r.ok) throw new AdminApiError(data.error || 'Не удалось загрузить настройки',r.status);
  return data;
}

export async function saveConfig(data: Record<string, string | null>, revision?: string) {
  const r = await apiFetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',...(revision?{'If-Match':revision}:{}) },
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

export async function fetchAccountQuota(): Promise<{ available: boolean; quota?: import('../../platform/publicAccounts/contracts').QuotaView }> {
  const response = await apiFetch('/api/account-quota');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить квоты');
  return body;
}

export interface ManagedAccount {
  displayName?: string; revision?: string; canDelete?: boolean; canReplaceBot?: boolean;
  id: string; username: string; accountState: string; runtimeMode: 'telegram' | 'api_only'; status: string;
  bot: { username: string; connected: boolean } | null; canConnectBot: boolean;
}
export interface AccountPairing { pairingUrl: string; expiresAt: string }
export interface ManagedAccountsResponse { version: 1; available: boolean; capacity?: number; accounts: ManagedAccount[] }
async function accountsApi(path: string, init?: RequestInit) {
  const response = await apiFetch('/api/accounts' + path, init);
  const body = await response.json();
  if (!response.ok) throw new AdminApiError(body.error || 'Не удалось выполнить действие с аккаунтом',response.status);
  return body;
}
export function fetchManagedAccounts(signal?: AbortSignal): Promise<ManagedAccountsResponse> { return accountsApi('', { signal }); }
export function createManagedAccount(username: string, password: string, requestKey: string): Promise<{ account: ManagedAccount }> {
  return accountsApi('', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey }, body: JSON.stringify({ username, password }) });
}
export function connectManagedBot(id: string, botToken: string, requestKey: string): Promise<{ account: ManagedAccount; pairing: AccountPairing | null }> {
  return accountsApi(`/${encodeURIComponent(id)}/bot`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestKey }, body: JSON.stringify({ botToken }) });
}
export function fetchManagedPairing(id: string): Promise<{ account: ManagedAccount; pairing: AccountPairing | null }> {
  return accountsApi(`/${encodeURIComponent(id)}/pairing`);
}
function managedMutation(id:string,method:string,body:object,requestKey:string,suffix='') {
  return accountsApi(`/${encodeURIComponent(id)}${suffix}`,{method,headers:{'Content-Type':'application/json','Idempotency-Key':requestKey},body:JSON.stringify(body)});
}
export function renameManagedAccount(id:string,displayName:string,revision:string,requestKey:string):Promise<{account:ManagedAccount}> {
  return managedMutation(id,'PATCH',{displayName,revision},requestKey);
}
export function deleteManagedAccount(id:string,confirmation:string,revision:string,requestKey:string):Promise<{status:'deleting';deletionId:string;requestedAt:string}> {
  return managedMutation(id,'DELETE',{confirmation,revision},requestKey);
}
export function replaceManagedBot(id:string,botToken:string,confirmation:string,revision:string,requestKey:string):Promise<{account:ManagedAccount}> {
  return managedMutation(id,'POST',{botToken,confirmation,revision},requestKey,'/bot/replacement');
}

export async function fetchBackgroundFeatures(): Promise<{ mode: BudgetMode; features: BackgroundFeatureState[]; activityMode: ActivityMode; activityModes: ActivityModeDescriptor[] }> {
  const response = await apiFetch('/api/background-features');
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить фоновые функции');
  return body;
}

export async function saveActivityMode(activityMode: ActivityPreset): Promise<{ message: string }> {
  const response = await apiFetch('/api/background-features', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activityMode }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Не удалось сохранить режим активности');
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

export async function fetchAiUsageTraces(query: AiUsageQuery, quickFilter: string, limit: number, offset: number): Promise<{ total: number; chains: AiUsageTraceChain[] }> {
  const params = toSearchParams({ ...query, quickFilter, limit, offset });
  const r = await apiFetch(`/api/ai-usage/traces?${params}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || 'Не удалось загрузить цепочки');
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
  return adminResourceUrl(`/api/health/export?${params}`);
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
