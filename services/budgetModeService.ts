import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { BUDGET_MODE_SETTING_KEY, resolveBudgetMode, type BudgetMode } from '../ai/budgetMode';

const CACHE_TTL_MS = 5000;
let cached: { mode: BudgetMode; expiresAt: number } | undefined;
let pendingRead: Promise<BudgetMode> | undefined;
let revision = 0;

export async function getBudgetMode(forceRefresh = false): Promise<BudgetMode> {
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.mode;
    if (!AppDataSource.isInitialized) return 'maximum';
    if (pendingRead) return pendingRead;

    const readRevision = revision;
    const read = (async (): Promise<BudgetMode> => {
        let mode: BudgetMode;
        try {
            const entry = await AppDataSource.getRepository(BotSettingEntity)
                .findOneBy({ key: BUDGET_MODE_SETTING_KEY });
            mode = resolveBudgetMode(entry?.value);
        } catch {
            console.warn('[budget-mode] Настройка недоступна: платный фон временно приостановлен');
            mode = 'maximum';
        }
        // Старое чтение не должно отменить только что сохранённый выбор владельца.
        if (revision !== readRevision && cached) return cached.mode;
        cached = { mode, expiresAt: Date.now() + CACHE_TTL_MS };
        return mode;
    })();
    pendingRead = read;
    try {
        return await read;
    } finally {
        if (pendingRead === read) pendingRead = undefined;
    }
}

export async function isMaximumSavingsEnabled(): Promise<boolean> {
    return (await getBudgetMode()) === 'maximum';
}

export async function setBudgetMode(mode: BudgetMode): Promise<void> {
    // Успех показывается только после записи в БД; общая настройка доступна админке.
    await AppDataSource.getRepository(BotSettingEntity)
        .upsert({ key: BUDGET_MODE_SETTING_KEY, value: mode }, ['key']);
    revision += 1;
    cached = { mode, expiresAt: Date.now() + CACHE_TTL_MS };
}
