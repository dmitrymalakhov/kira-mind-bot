/** Canonical mobile/backend wire contract: kira.workouts-health.v1. All times are RFC3339 UTC. */
export const WORKOUT_CONTRACT = 'kira.workouts-health.v1';
export const WORKOUT_VERSION = 1;
export type WorkoutFeature = 'records' | 'localSync' | 'deviceCommands' | 'appleHealthSync' | 'plans' | 'analysis';
export interface WorkoutsCapability {
    version: 1;
    contract: 'kira.workouts-health.v1';
    features: WorkoutFeature[];
    limits: { maxBatchItems: 100; maxBodyBytes: 65536; pollIntervalMs: 5000; commandTtlMs: 30000 };
}
export type ActivityType = 'running' | 'walking' | 'cycling' | 'strength' | 'other';
export type WorkoutState = 'requested' | 'running' | 'paused' | 'finished' | 'cancelled';
export type WorkoutAction = 'start' | 'pause' | 'resume' | 'finish' | 'record_set' | 'set_rest' | 'add_note';
export interface WorkoutMetrics {
    /** Last observed elapsed time, including pauses; terminal sessions freeze at their terminal event. */
    totalDurationMs: number | null;
    activeDurationMs: number | null;
    pausedDurationMs: number | null;
    distanceM: number | null;
    meanHeartRateBpm: number | null;
    maxHeartRateBpm: number | null;
    activeEnergyKcal: number | null;
    meanPaceSecPerKm: number | null;
    strengthVolumeKg: number | null;
    completedSets: number;
}
export interface WorkoutSet {
    id: string;
    exercise: string;
    repetitions: number;
    weightKg: number | null;
}
export interface WorkoutEvent {
    eventId: string;
    seq: number;
    type: 'started' | 'paused' | 'resumed' | 'finished' | 'cancelled' | 'set_upserted' | 'set_deleted' | 'rest_started' | 'note_added' | 'metrics_updated';
    occurredAt: string;
    /** Monotonic elapsed time since session start, including pauses; never a wall-clock subtraction. */
    elapsedMs: number;
    commandId?: string;
    data?: Record<string, unknown>;
}
export interface Workout {
    id: string;
    activityType: ActivityType;
    location: 'indoor' | 'outdoor' | 'unspecified';
    mode: 'manual' | 'healthkit' | 'imported';
    state: WorkoutState;
    recorderDeviceId: string | null;
    recorderBindingId: string | null;
    recordingId: string;
    seq: number;
    revision: number;
    startedAt: string | null;
    endedAt: string | null;
    timeZone: string;
    events: WorkoutEvent[];
    sets: WorkoutSet[];
    notes: string[];
    metrics: WorkoutMetrics;
    source: { kind: 'kira' | 'apple_health'; healthKitId?: string; sourceBundleId?: string; syncIdentifier?: string; syncVersion?: number; sourceKey?: string };
    healthKitSave: 'not_requested' | 'pending' | 'saved' | 'failed';
    updatedAt: string;
}
export interface WorkoutDevice {
    id: string;
    installationId: string;
    bindingId: string;
    platform: 'ios' | 'watchos';
    enabled: boolean;
    lastSeenAt: string;
}
export interface WorkoutCommand {
    id: string;
    workoutId: string;
    recordingId: string;
    deviceId: string;
    bindingId: string;
    expectedSeq: number;
    action: WorkoutAction;
    args: Record<string, unknown>;
    status: 'queued' | 'claimed' | 'applied' | 'rejected' | 'failed' | 'expired' | 'unknown';
    createdAt: string;
    expiresAt: string;
    result?: { status: 'applied' | 'rejected' | 'failed'; eventId?: string; seq?: number; code?: string };
}
export interface WorkoutPlan {
    id: string;
    revision: number;
    title: string;
    activityType: ActivityType;
    kind: 'plan' | 'template';
    steps: Array<{ title: string; durationMs?: number; distanceM?: number; sets?: number; repetitions?: number; weightKg?: number; restMs?: number }>;
    updatedAt: string;
}
export interface HealthSyncState {
    enabled: boolean;
    consentVersion: 1;
    generation: string;
    deviceId: string | null;
    bindingId: string | null;
    lastSeq: number;
    lastSyncedAt: string | null;
}
export interface HealthChange {
    changeId: string;
    seq: number;
    sourceKey: string;
    type: 'workout_upsert' | 'workout_delete' | 'daily_steps_upsert' | 'daily_steps_delete';
    data?: Record<string, unknown>;
}
export interface WorkoutSyncInput {
    deviceId: string;
    bindingId: string;
    workoutId: string;
    recordingId: string;
    activityType: ActivityType;
    location: Workout['location'];
    mode: 'manual' | 'healthkit';
    timeZone: string;
    events: WorkoutEvent[];
    healthKitSave?: Workout['healthKitSave'];
    healthKitId?: string;
    healthSyncGeneration?: string;
    /** Explicit recovery on the same installation after logout/revocation; both fields required together. */
    previousBindingId?: string;
    expectedSeq?: number;
}
export type WorkoutSummary = Omit<Workout, 'events' | 'notes' | 'sets'>;
export interface WorkoutListResponse { workouts: WorkoutSummary[]; nextCursor: string | null }
export interface WorkoutDetailResponse { workout: Workout }
export interface WorkoutActiveResponse { workout: Workout | null }
export interface WorkoutCommandResponse { command: WorkoutCommand }
export interface WorkoutCommandListResponse { commands: WorkoutCommand[]; serverTime: string }
export interface MeasuredTotal { value: number | null; measured: number; missing: number }
export interface WorkoutAnalysis {
    groups: Array<{ group: string; count: number; workouts: WorkoutSummary[]; totals: { activeDurationMs: MeasuredTotal; distanceM: MeasuredTotal; strengthVolumeKg: MeasuredTotal } }>;
}
export interface DailyStepsSummary {
    localDate: string; timeZone: string; intervalStart: string; intervalEnd: string; steps: number | null; updatedAt: string;
}
export interface HealthSyncStatusResponse { sync: HealthSyncState; dailySteps: DailyStepsSummary[] }
export interface HealthSyncBatchInput { deviceId: string; bindingId: string; generation: string; changes: HealthChange[] }
export interface HealthSyncBatchResponse { sync: HealthSyncState; accepted: number }
/** start: omit workoutId/expectedSeq; args require activityType, location, mode and timeZone. */
export interface WorkoutStartCommandInput {
    deviceId: string; bindingId: string; action: 'start';
    args: { activityType: Exclude<ActivityType, 'other'>; location: Workout['location']; mode: 'manual' | 'healthkit'; timeZone: string };
}
export interface WorkoutExistingCommandInput {
    workoutId: string; deviceId: string; bindingId: string; expectedSeq: number;
    action: Exclude<WorkoutAction, 'start'>; args: Record<string, unknown>;
}
export interface WorkoutScope { profile: string; ownerId: number }
export const EMPTY_METRICS: WorkoutMetrics = {
    totalDurationMs: null, activeDurationMs: null, pausedDurationMs: null, distanceM: null, meanHeartRateBpm: null, maxHeartRateBpm: null,
    activeEnergyKcal: null, meanPaceSecPerKm: null, strengthVolumeKg: null, completedSets: 0,
};
