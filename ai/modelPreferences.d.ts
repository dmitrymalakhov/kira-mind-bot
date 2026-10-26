import type { AiModelRef, AiPresetName, AiTaskKey } from './modelPresets';
import type { LocalModelRoutes } from './localModelRouting';
export interface ModelPreferences { quality: 'standard' | 'high' | 'maximum' }
export interface ModelPolicy { version: 1 | 2; preferences: ModelPreferences; presetName: AiPresetName;
  models: Record<AiTaskKey, AiModelRef>; outputTokenLimits: Partial<Record<AiTaskKey, number>>; source: string; summary: string }
export interface ModelResources { vars: NodeJS.ProcessEnv; localRoutes: LocalModelRoutes;
  localModels?: Array<{id: string; loadedIds?: string[]; uncensored?: boolean}>; memoryProfileName: string }
export const SETTING_KEY: string;
export const DEFAULT_PREFERENCES: ModelPreferences;
export const QUALITY_LEVELS: Array<{ id: ModelPreferences['quality']; title: string; preset: AiPresetName; description: string; costNote: string }>;
export const TEXT_TASKS: AiTaskKey[];
export function parsePreferences(value: unknown): ModelPreferences;
export function buildModelPlan(value: unknown, context: ModelResources): ModelPolicy;
export function parseModelPolicy(value: unknown): ModelPolicy | null;
