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

export type FieldType = 'text' | 'password' | 'number' | 'toggle' | 'textarea' | 'duration' | 'select';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  placeholder?: string;
  options?: FieldOption[];
  sm?: number;
  md?: number;
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
  | 'gemini-full'
  | 'glm-full'
  | 'glm-balanced';

export interface AiModelRef {
  provider: AiProvider;
  model: string;
}

export interface AiPresetConfig {
  name: AiPresetName;
  title: string;
  description: string;
  characteristics?: {
    quality: string;
    cost: string;
    stability: string;
    gptDependency: string;
  };
  models: Record<string, AiModelRef>;
  enabled?: boolean;
  unavailableReason?: string;
}

export interface MemoryEmbeddingProfileCompatibilityMismatch {
  collection: string;
  actualSize: number;
  actualDistance: string;
}

export interface MemoryEmbeddingProfileCompatibility {
  status: 'compatible' | 'mismatch' | 'not_initialized' | 'unavailable';
  summary: string;
  checkedCollections: number;
  mismatches: MemoryEmbeddingProfileCompatibilityMismatch[];
}

export interface MemoryEmbeddingProfileStatus {
  name: string;
  title: string;
  description: string;
  provider: AiProvider;
  model: string;
  outputDimension: number;
  distance: string;
  storedProfileName?: string | null;
  envDefaultProfileName: string;
  hasRuntimeOverride: boolean;
  activeSourceSummary: string;
  activeSourceTechnicalPath: string;
  source: ConfigSourceInfo;
  providerKeyConfigured: boolean;
  providerAvailabilitySummary: string;
  compatibility: MemoryEmbeddingProfileCompatibility;
}

export interface AiPresetResponse {
  configuredPresetName: AiPresetName;
  storedPresetName?: AiPresetName | null;
  envDefaultPreset: AiPresetName;
  hasRuntimeOverride: boolean;
  activeSourceSummary: string;
  activeSourceTechnicalPath: string;
  availablePresets: AiPresetConfig[];
  memoryEmbeddingProfile: MemoryEmbeddingProfileStatus;
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

export type AiUsageOperation = 'chat' | 'response' | 'embedding' | 'transcription' | 'unknown';

export interface AiUsageQuery {
  days?: string;
  from?: string;
  to?: string;
  provider?: string;
  model?: string;
  taskKey?: string;
  preset?: string;
  operation?: AiUsageOperation | '';
  success?: boolean;
  fallbackUsed?: boolean;
}

export interface AiUsageTotals {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  fallbackCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
  errorRate: number;
  fallbackRate: number;
}

export interface AiUsageCoverage {
  callsWithUsage: number;
  callsWithoutUsage: number;
  usageCoverageRate: number;
}

export interface AiUsageTimeseriesPoint {
  bucketStart: string;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  fallbackCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiUsageBreakdownRow {
  key: string;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  fallbackCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  avgLatencyMs: number;
}

export interface AiUsageFailureRecord {
  createdAt: string;
  traceId?: string | null;
  attempt?: number | null;
  stage?: 'primary' | 'retry' | 'fallback' | null;
  provider: string;
  model: string;
  taskKey: string;
  preset: string;
  operation: AiUsageOperation;
  fallbackUsed: boolean;
  errorStatus?: number | null;
  errorCode?: string | null;
  errorType?: string | null;
  errorCategory?: string | null;
  providerRequestId?: string | null;
  retryable?: boolean | null;
  errorMessage: string;
}

export interface AiUsageTraceAttempt {
  id: string;
  createdAt: string;
  traceId: string | null;
  taskKey: string;
  preset: string;
  provider: string;
  model: string;
  operation: AiUsageOperation;
  success: boolean;
  fallbackUsed: boolean;
  attempt: number | null;
  stage: 'primary' | 'retry' | 'fallback' | null;
  errorStatus?: number | null;
  errorCode?: string | null;
  errorType?: string | null;
  errorCategory?: string | null;
  providerRequestId?: string | null;
  retryable?: boolean | null;
  errorMessage: string;
  latencyMs?: number | null;
}

export interface AiUsageTraceChain {
  traceKey: string;
  traceId: string | null;
  createdAt: string;
  taskKey: string;
  preset: string;
  primaryProvider: string;
  primaryModel: string;
  primaryStage: 'success' | 'failed';
  primaryError?: string;
  primaryErrorStatus?: number | null;
  primaryErrorCategory?: string | null;
  retryCount: number;
  retryStage: 'none' | 'success' | 'failed';
  fallbackStage: 'none' | 'success' | 'failed';
  fallbackProvider?: string;
  fallbackModel?: string;
  outcome: 'success' | 'recovered_fallback' | 'failed';
  totalLatencyMs: number;
  providerRequestIds: string[];
  attempts: AiUsageTraceAttempt[];
}

export interface AiUsageSummaryResponse {
  generatedAt: string;
  filters: {
    days?: number;
    from?: string;
    to?: string;
    provider?: string;
    model?: string;
    taskKey?: string;
    preset?: string;
    operation?: AiUsageOperation;
    success?: boolean;
    fallbackUsed?: boolean;
  };
  totals: AiUsageTotals;
  coverage: AiUsageCoverage;
  timeseries: {
    bucket: 'hour' | 'day';
    points: AiUsageTimeseriesPoint[];
  };
  breakdowns: {
    providers: AiUsageBreakdownRow[];
    models: AiUsageBreakdownRow[];
    tasks: AiUsageBreakdownRow[];
    presets: AiUsageBreakdownRow[];
    operations: AiUsageBreakdownRow[];
  };
  leaders: {
    modelsByTokens: AiUsageBreakdownRow[];
    modelsByCalls: AiUsageBreakdownRow[];
    tasksByTokens: AiUsageBreakdownRow[];
    tasksByCalls: AiUsageBreakdownRow[];
  };
  traceChains: AiUsageTraceChain[];
  recentFailures: AiUsageFailureRecord[];
}

export interface PersonalityProfile {
  characterName: string;
  characterGender: 'женский' | 'мужской';
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

export type RecurringTaskStatus = 'active' | 'paused';

export interface RecurringTaskSchedule {
  type: 'interval' | 'daily' | 'weekly' | 'monthly';
  intervalMinutes?: number;
  interval?: number;
  hour?: number;
  minute?: number;
  daysOfWeek?: number[];
  dayOfMonth?: number;
  anchorDate: string;
}

export interface RecurringTaskRecord {
  id: string;
  chatId: string;
  chatType: 'private' | 'group' | 'supergroup';
  chatTitle?: string | null;
  userId: string;
  title: string;
  prompt: string;
  schedule: RecurringTaskSchedule;
  timezone: string;
  status: RecurringTaskStatus;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastCompletedAt?: string | null;
  lockedAt?: string | null;
  lastResult?: string | null;
  lastError?: string | null;
  consecutiveFailures: number;
  runCount: number;
  createdAt: string;
  updatedAt: string;
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
  strength: number;
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
  relatedIds: Array<{
    id: string;
    domain: string;
    type: string;
    weight: number;
    cue?: string;
  }>;
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

export type MemoryGraphNodeType = 'memory' | 'person';
export type MemoryGraphEdgeKind = 'relation' | 'derived_from' | 'episode' | 'identity' | 'person_relation';

export interface MemoryGraphNode {
  id: string;
  nodeType: MemoryGraphNodeType;
  memoryId?: string;
  personId?: string;
  label: string;
  content: string;
  domain: string;
  memoryKind: string;
  status: string;
  subject?: string;
  predicate?: string;
  object?: string;
  confidence: number;
  importance: number;
  strength: number;
  isAnchor: boolean;
  synthetic: boolean;
  timestamp: string | null;
  sourceEpisodeId?: string;
  tags: string[];
  flags: string[];
  degree: number;
}

export interface MemoryGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: MemoryGraphEdgeKind;
  relationType: string;
  weight: number;
  cue?: string;
  directed: boolean;
}

export interface MemoryGraphStats {
  memoryNodes: number;
  virtualNodes: number;
  totalNodes: number;
  totalEdges: number;
  isolatedMemoryNodes: number;
  unresolvedRelations: number;
  unresolvedSources: number;
  edgeCounts: Partial<Record<MemoryGraphEdgeKind, number>>;
  truncated: boolean;
  availableMemoryNodes: number;
  scannedMemoryNodes: number;
  matchedMemoryNodes: number;
}

export interface MemoryGraphQuery extends Omit<MemoryQuery, 'limit' | 'offset'> {
  limit?: number;
  includeIdentityNodes?: boolean;
}

export interface MemoryGraphResponse {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  stats: MemoryGraphStats;
  filters: MemoryGraphQuery;
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
