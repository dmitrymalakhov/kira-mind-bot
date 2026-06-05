export interface ConfigEntry {
  value: string;
  masked: boolean;
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

export interface PersonalityProfile {
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
