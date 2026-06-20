export interface ConfigEntry {
  value: string;
  masked: boolean;
  rawValue?: string | null;
  rawState?: 'missing' | 'empty' | 'value';
  source?: 'env_file' | 'inherited_default_text' | 'system_default' | 'bot_settings';
  configPath?: string;
  sourceInfo?: ConfigSourceInfo;
}

export interface ConfigResponse {
  [key: string]: ConfigEntry;
}

export type FieldType = 'text' | 'password' | 'number' | 'toggle' | 'textarea' | 'duration';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  placeholder?: string;
}

export interface SectionDef {
  id: string;
  title: string;
  icon: string;
  fields: FieldDef[];
}

export interface Toast {
  message: string;
  severity: 'success' | 'error' | 'info';
}

export interface ConfigSourceInfo {
  kind: 'env_file' | 'database' | 'env_fallback' | 'system_default' | 'runtime_setting';
  label: string;
  description?: string;
  technicalPath?: string;
  appliesImmediately?: boolean;
}

export type AiProvider = 'openai' | 'openrouter' | 'gemini' | 'zai';
export type AiPresetName =
  | 'gpt-max'
  | 'gpt-balanced'
  | 'gpt-lean'
  | 'hybrid-openrouter-gpt'
  | 'hybrid-gemini-gpt'
  | 'gemini-direct-balanced'
  | 'glm-balanced';

export interface AiModelRef {
  provider: AiProvider;
  model: string;
}

export interface AiPresetConfig {
  name: AiPresetName;
  title: string;
  description: string;
  models: Record<string, AiModelRef>;
  enabled?: boolean;
  unavailableReason?: string;
}

export interface AiPresetResponse {
  activePresetName: AiPresetName;
  storedPresetName?: AiPresetName | null;
  envDefaultPreset: AiPresetName;
  hasRuntimeOverride: boolean;
  activeSourceSummary: string;
  activeSourceTechnicalPath: string;
  availablePresets: AiPresetConfig[];
  source: ConfigSourceInfo;
}

export type MonitoringCheckStatus = 'ok' | 'warn' | 'down' | 'disabled';
export type MonitoringCheckCategory = 'runtime' | 'storage' | 'telegram' | 'ai';

export interface MonitoringCheck {
  key: string;
  label: string;
  category: MonitoringCheckCategory;
  status: MonitoringCheckStatus;
  summary: string;
  details: string;
  latencyMs?: number;
  checkedAt: string;
  meta?: Record<string, string | number | boolean | null | undefined>;
}

export interface MonitoringHealthResponse {
  generatedAt: string;
  overallStatus: 'ok' | 'degraded' | 'down';
  checks: MonitoringCheck[];
}

export interface PersonalityProfile {
  characterName: string;
  persona: string;
  communicationStyle: string;
  biography: string;
  ownerName: string;
  ownerUsername: string;
  userName: string;
  userBirthDate: string;
  moodVariants: string; // one per line
  defaultMood: string;  // empty = random from moodVariants
  proactiveMessageHint: string;
}

export interface PersonalityConfig {
  KiraMindBot: PersonalityProfile;
}

export interface ChatInfo {
  chatId: string;
  title: string;
  chatType: string;
  username?: string;
  profile: string;
  publicMode: boolean;
  allowedDomains: string[];
  forbiddenTopics?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type HealthLogKind =
  | 'food'
  | 'drink'
  | 'symptom'
  | 'medication'
  | 'activity'
  | 'skin'
  | 'blood_pressure'
  | 'note';

export interface HealthLogRecord {
  id: string;
  profile: string | null;
  userId: string | null;
  chatId: string | null;
  kind: HealthLogKind;
  rawText: string;
  summary: string | null;
  severity: number | null;
  occurredAt: string;
  timeOfDay: string | null;
  structured: Record<string, unknown> | null;
  tags: string[];
  photoFileId: string | null;
  createdAt: string;
}

export interface HealthLogKindStat {
  kind: HealthLogKind;
  count: number;
}

export interface HealthLogStats {
  total: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  avgSeverity: number | null;
  byKind: HealthLogKindStat[];
}

export interface HealthLogsResponse {
  records: HealthLogRecord[];
  total: number;
  limit: number;
  offset: number;
  filters: {
    profile?: string;
    userId?: string;
    kind?: HealthLogKind;
    from?: string;
    to?: string;
    days?: number;
    q?: string;
  };
  stats: HealthLogStats;
}

export interface HealthLogQuery {
  profile?: string;
  userId?: string;
  kind?: HealthLogKind | '';
  from?: string;
  to?: string;
  days?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export type HealthExportFormat = 'txt' | 'csv' | 'json';

export type MemoryProfile = 'KiraMindBot';

export type MemoryStatus = 'active' | 'planned' | 'done' | 'superseded' | 'expired' | 'unknown';

export type MemoryFocus =
  | 'open_loops'
  | 'stale'
  | 'low_confidence'
  | 'weak_evidence'
  | 'no_source'
  | 'anchors'
  | 'synthetic'
  | 'contacts';

export type MemoryKind =
  | 'fact'
  | 'episode'
  | 'chapter'
  | 'trait'
  | 'preference'
  | 'goal'
  | 'open_loop'
  | 'relationship'
  | 'routine'
  | 'boundary'
  | 'promise'
  | 'prospective'
  | 'portrait'
  | 'event'
  | 'state'
  | 'unknown';

export interface MemoryRecord {
  id: string;
  content: string;
  domain: string;
  botId: string;
  userId: string;
  timestamp: string | null;
  importance: number;
  tags: string[];
  confidence: number;
  isAnchor: boolean;
  memoryKind: MemoryKind | string;
  status: MemoryStatus | string;
  subject?: string;
  predicate?: string;
  object?: string;
  extractionMethod?: string;
  sourceContext?: string;
  sourceEpisodeId?: string;
  sourceMemoryIds: string[];
  sourceMessageIds: string[];
  previousVersions: Array<{
    content: string;
    timestamp: string;
    confidence: number;
  }>;
  validFrom: string | null;
  validTo: string | null;
  expiresAt: string | null;
  lastAccessedAt: string | null;
  lastRetrievedAt: string | null;
  retrievalCount: number;
  confirmationCount: number;
  lastConfirmedAt: string | null;
  synthetic: boolean;
}

export interface MemoryCountStat {
  domain?: string;
  kind?: string;
  status?: string;
  count: number;
}

export interface MemoryStats {
  total: number;
  avgConfidence: number | null;
  lowConfidence: number;
  stale: number;
  openLoops: number;
  weakEvidence: number;
  noSource: number;
  contacts: number;
  synthetic: number;
  anchors: number;
  lastUpdatedAt: string | null;
  byDomain: Array<{ domain: string; count: number }>;
  byKind: Array<{ kind: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
  dreaming: {
    openLoopIndex: MemoryRecord | null;
    uncertaintyIndex: MemoryRecord | null;
  };
}

export interface MemoryQuery {
  profile?: MemoryProfile;
  userId?: string;
  domain?: string;
  kind?: MemoryKind | '';
  status?: MemoryStatus | '';
  focus?: MemoryFocus | '';
  q?: string;
  includeSynthetic?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryResponse {
  records: MemoryRecord[];
  total: number;
  limit: number;
  offset: number;
  filters: MemoryQuery;
  stats: MemoryStats;
  domains: string[];
  kinds: string[];
  statuses: string[];
  focuses: string[];
}

export interface MemoryFormPayload {
  profile: MemoryProfile;
  userId?: string;
  domain: string;
  content: string;
  importance: number;
  confidence: number;
  tags: string[];
  memoryKind: MemoryKind | string;
  status: MemoryStatus | string;
  isAnchor: boolean;
  subject?: string;
  predicate?: string;
  object?: string;
  sourceContext?: string;
}
