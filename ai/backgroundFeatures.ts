import registry from './background-features.json';

export type BackgroundFeature = keyof typeof registry;
export const BACKGROUND_FEATURES = registry;
export const BACKGROUND_FEATURE_KEYS = Object.keys(registry) as BackgroundFeature[];
export interface BackgroundFeatureState {
    key: BackgroundFeature;
    title: string;
    description: string;
    group: string;
    enabled: boolean;
    effective: boolean;
    blockedBy: BackgroundFeature | 'budget' | null;
}
export function backgroundFeatureSettingKey(feature: BackgroundFeature): string {
    return `background:${feature}`;
}
export function defaultBackgroundFeatureEnabled(feature: BackgroundFeature, env: Record<string, string | undefined> = {}): boolean {
    const value = env[registry[feature].envKey];
    return value == null || value === '' ? true : ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}
