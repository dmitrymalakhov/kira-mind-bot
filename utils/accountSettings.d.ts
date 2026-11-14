export const ACCOUNT_SETTING_KEYS: string[];
export const INSTANCE_SETTING_KEYS: string[];
export function parseAccountSettings(raw: unknown, patch?: false): Record<string, string>;
export function parseAccountSettings(raw: unknown, patch: true): Record<string, string | null>;
