import type { AiModelRef, AiPresetName, AiTaskKey } from './modelPresets';
import type { LocalModelRoutes } from './localModelRouting';
export interface ModelPreferences { quality: 'standard' | 'high' | 'maximum'; provider?: 'auto' | 'openai' | 'gemini' | 'zai' | 'openrouter' }
export interface ModelPolicy { version: 1 | 2 | 3; preferences: ModelPreferences; presetName: AiPresetName;
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

export interface CustomRoute { provider: AiModelRef['provider']; model: string; maxTokens: number; reasoningEffort: 'none'|'low'|'medium'|'high' }
export interface CustomStrategy { mode: 'custom'; quality: ModelPreferences['quality']; presetName: AiPresetName; routes: Record<string, CustomRoute> }
export type StrategyRequest = ModelPreferences | CustomStrategy;
export const API_PROVIDERS: Array<{id: NonNullable<ModelPreferences['provider']>; title: string; description: string}>;
export function parseStrategyRequest(value: unknown): StrategyRequest;
export function getStrategyCatalog(context: ModelResources): Array<Pick<AiModelRef, 'provider'|'model'>>;
export function buildCustomPlan(value: unknown, context: ModelResources): ModelPolicy;
