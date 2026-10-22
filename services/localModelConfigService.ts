import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { defaultLocalRoutes, parseLocalRoutes, SETTING_KEY, type LocalModelRoutes } from '../ai/localModelRouting';

let cached: LocalModelRoutes | undefined;
let refreshedAt = 0;
let pending: Promise<LocalModelRoutes> | undefined;
export async function getLocalModelRoutes(fresh = false): Promise<LocalModelRoutes> {
    if (!AppDataSource.isInitialized) return defaultLocalRoutes(process.env.LM_STUDIO_MODEL);
    if (!fresh && cached && Date.now() - refreshedAt < 5000) return cached;
    if (pending) return pending;
    pending = (async () => {
        const row = await AppDataSource.getRepository(BotSettingEntity).findOneBy({ key: SETTING_KEY });
        const routes = row ? parseLocalRoutes(row.value) : defaultLocalRoutes(process.env.LM_STUDIO_MODEL);
        cached = routes;
        refreshedAt = Date.now();
        return routes;
    })();
    try { return await pending; }
    catch (error) {
        if (cached && !fresh) return cached;
        throw error;
    } finally { pending = undefined; }
}
