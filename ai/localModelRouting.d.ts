export type LocalModelRole = 'fast' | 'analysis' | 'deep';
export interface LocalModelRoute { model: string; maxTokens: number; reasoningEffort: 'none' | 'low' | 'medium' | 'high'; }
export type LocalModelRoutes = Record<LocalModelRole, LocalModelRoute>;
export const SETTING_KEY: string;
export const roles: Record<LocalModelRole, { label: string; description: string; maxTokens: number; reasoningEffort: string; temperature: number }>;
export function parseLocalRoutes(raw: unknown): LocalModelRoutes;
export function defaultLocalRoutes(model?: string): LocalModelRoutes;
