import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext, Cookie } from 'playwright';

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'browser-sessions');
const SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
    'co.uk', 'com.au', 'com.br', 'com.tr', 'com.ua', 'com.cn', 'com.hk',
    'co.jp', 'co.kr', 'co.nz', 'co.za', 'com.mx', 'com.sg', 'com.tw',
    'net.au', 'org.uk', 'org.au',
]);

interface BrowserStorageState {
    cookies?: Cookie[];
    origins?: Array<{
        origin: string;
        localStorage?: Array<{ name: string; value: string }>;
    }>;
}

function sessionPath(userId: number, domain: string): string {
    const key = `${userId}_${domain}`.replace(/[^a-z0-9._-]/gi, '_').slice(0, 120);
    return path.join(SESSIONS_DIR, `${key}.json`);
}

function normalizeDomain(domain: string): string {
    return domain
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        .split(':')[0];
}

function rootDomain(domain: string): string {
    const normalized = normalizeDomain(domain);
    const parts = normalized.split('.').filter(Boolean);
    if (parts.length <= 2) return normalized;

    const suffix2 = parts.slice(-2).join('.');
    if (SECOND_LEVEL_PUBLIC_SUFFIXES.has(suffix2) && parts.length >= 3) {
        return parts.slice(-3).join('.');
    }

    return parts.slice(-2).join('.');
}

function candidateDomains(domain: string): string[] {
    const normalized = normalizeDomain(domain);
    const root = rootDomain(normalized);
    return [...new Set([normalized, root])];
}

export class BrowserSessionStore {
    /** Загружает сохранённое состояние браузера в контекст. Поддерживает старый формат cookies[]. */
    static async load(context: BrowserContext, userId: number, domain: string): Promise<boolean> {
        let loadedAny = false;
        for (const candidate of candidateDomains(domain)) {
            const file = sessionPath(userId, candidate);
            if (!fs.existsSync(file)) continue;

            try {
                const state = JSON.parse(fs.readFileSync(file, 'utf8')) as BrowserStorageState | Cookie[];

                if (Array.isArray(state)) {
                    if (state.length > 0) {
                        await context.addCookies(state);
                        loadedAny = true;
                    }
                    continue;
                }

                if (Array.isArray(state.cookies) && state.cookies.length > 0) {
                    await context.addCookies(state.cookies);
                    loadedAny = true;
                }

                if (Array.isArray(state.origins) && state.origins.length > 0) {
                    await restoreLocalStorage(context, state.origins);
                    loadedAny = true;
                }

            } catch (e) {
                console.warn('[BrowserSession] Failed to load browser state:', e);
            }
        }
        return loadedAny;
    }

    /** Сохраняет cookies и localStorage origins браузерного контекста. */
    static async save(context: BrowserContext, userId: number, domain: string): Promise<void> {
        try {
            const state = await context.storageState();
            if (!state.cookies.length && !state.origins.length) return;
            fs.mkdirSync(SESSIONS_DIR, { recursive: true });
            const serialized = JSON.stringify(state, null, 2);
            for (const candidate of candidateDomains(domain)) {
                fs.writeFileSync(sessionPath(userId, candidate), serialized);
            }
        } catch (e) {
            console.warn('[BrowserSession] Failed to save browser state:', e);
        }
    }

    /** Удаляет сохранённую сессию (например, при выходе из аккаунта). */
    static clear(userId: number, domain: string): void {
        for (const candidate of candidateDomains(domain)) {
            const file = sessionPath(userId, candidate);
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
    }
}

async function restoreLocalStorage(
    context: BrowserContext,
    origins: NonNullable<BrowserStorageState['origins']>
): Promise<void> {
    for (const originState of origins) {
        if (!originState.origin || !originState.localStorage?.length) continue;

        const page = await context.newPage();
        try {
            await page.goto(originState.origin, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
            await page.evaluate((entries) => {
                for (const entry of entries) {
                    localStorage.setItem(entry.name, entry.value);
                }
            }, originState.localStorage);
        } catch (e) {
            console.warn('[BrowserSession] Failed to restore localStorage:', originState.origin, e);
        } finally {
            await page.close().catch(() => {});
        }
    }
}
