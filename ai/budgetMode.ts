import registry from './budget-modes.json';

export type BudgetMode = keyof typeof registry.modes;
export const BUDGET_MODE_SETTING_KEY = registry.settingKey;
export const BUDGET_MODES = registry.modes;
export const BUDGET_MODE_COPY = registry;

export function parseBudgetMode(value: unknown): BudgetMode | null {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUDGET_MODES, value)
        ? value as BudgetMode
        : null;
}

export function resolveBudgetMode(value: unknown): BudgetMode {
    if (value == null) return registry.defaultMode as BudgetMode;
    // Повреждённая настройка не должна неожиданно включать платный фон.
    return parseBudgetMode(value) ?? 'maximum';
}
