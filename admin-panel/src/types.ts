export interface ConfigEntry {
  value: string;
  masked: boolean;
  rawValue?: string | null;
  rawState?: 'missing' | 'empty' | 'value';
  source?: 'env_file' | 'inherited_default_text' | 'system_default' | 'bot_settings';
  configPath?: string;
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

export interface ModelPreset {
  id: string;
  title: string;
  description: string;
  riskLabel: string;
  costLabel: string;
  qualityLabel: string;
  values: Record<string, string | null>;
}

export interface ModelPresetResponse {
  presets: ModelPreset[];
  activePresetId: string | null;
  configPath: string;
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
  SergeyBrainBot: PersonalityProfile;
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

export type MemoryProfile = 'KiraMindBot' | 'SergeyBrainBot';

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
