export function mergeEditableDefaults(fileValues: Record<string, string>, inherited: Record<string, string | undefined>, editableKeys: Iterable<string>): Record<string, string>;
export function isValidProxyUrl(value: unknown): boolean;

export function maskConfigValues(values: Record<string, string>, sensitiveKeys?: Set<string>): Record<string, {value: string; masked: boolean}>;
