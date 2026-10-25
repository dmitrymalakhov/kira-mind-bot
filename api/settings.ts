import type { BackgroundFeature, BackgroundFeatureState } from '../ai/backgroundFeatures';
import { BACKGROUND_FEATURES } from '../ai/backgroundFeatures';
import { parseBudgetMode, type BudgetMode } from '../ai/budgetMode';
import { ApiError } from './contracts';

export interface ApiSettings {
    budgetMode: BudgetMode;
    budgetModes: { key: BudgetMode; title: string }[];
    telegram: { personalSessionConfigured: boolean };
    features: BackgroundFeatureState[];
}

export interface ApiSettingsPatch {
    budgetMode?: BudgetMode;
    background?: Partial<Record<BackgroundFeature, boolean>>;
}

/** Strict allowlist: client input never becomes an arbitrary bot_settings key or credential. */
export function parseSettingsPatch(body: Record<string, unknown>): ApiSettingsPatch {
    const invalid = () => new ApiError(400, 'invalid_settings', 'Передай budgetMode (normal или maximum) и/или background с булевыми переключателями из списка функций.');
    if (Object.keys(body).some(key => key !== 'budgetMode' && key !== 'background')) throw invalid();
    const patch: ApiSettingsPatch = {};
    if ('budgetMode' in body) {
        const mode = parseBudgetMode(body.budgetMode);
        if (!mode) throw invalid();
        patch.budgetMode = mode;
    }
    if ('background' in body) {
        const values = body.background;
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid();
        const entries = Object.entries(values);
        if (entries.some(([key, value]) => !Object.prototype.hasOwnProperty.call(BACKGROUND_FEATURES, key) || typeof value !== 'boolean')) throw invalid();
        patch.background = Object.fromEntries(entries);
    }
    if (!patch.budgetMode && !Object.keys(patch.background || {}).length) throw invalid();
    return patch;
}
