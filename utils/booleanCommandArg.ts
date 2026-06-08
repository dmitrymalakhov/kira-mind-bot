export function isStatusCommandArg(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    return !normalized || ['status', 'статус'].includes(normalized);
}

export function parseBooleanCommandArg(value: string): boolean | undefined {
    const normalized = value.trim().toLowerCase();
    if (isStatusCommandArg(normalized)) return undefined;
    if (['on', 'true', '1', 'yes', 'enable', 'enabled', 'вкл', 'да', 'включить'].includes(normalized)) return true;
    if (['off', 'false', '0', 'no', 'disable', 'disabled', 'выкл', 'нет', 'выключить'].includes(normalized)) return false;
    return undefined;
}
