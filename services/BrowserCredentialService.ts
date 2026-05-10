import * as fs from 'fs';
import * as path from 'path';

interface SiteCredentials {
    login: string;
    password: string;
    updatedAt: string;
}

type CredStore = Record<string, SiteCredentials>; // ключ: `${userId}_${domain}`

const CREDS_FILE = path.join(__dirname, '..', 'data', 'browser-credentials.json');
const SECOND_LEVEL_PUBLIC_SUFFIXES = new Set([
    'co.uk', 'com.au', 'com.br', 'com.tr', 'com.ua', 'com.cn', 'com.hk',
    'co.jp', 'co.kr', 'co.nz', 'co.za', 'com.mx', 'com.sg', 'com.tw',
    'net.au', 'org.uk', 'org.au',
]);

function readStore(): CredStore {
    if (!fs.existsSync(CREDS_FILE)) return {};
    try {
        return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function writeStore(store: CredStore): void {
    fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
    fs.writeFileSync(CREDS_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function storeKey(userId: number, domain: string): string {
    return `${userId}_${normalizeDomain(domain)}`;
}

function normalizeDomain(domain: string): string {
    return domain
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        .split(':')[0];
}

function candidateDomains(domain: string): string[] {
    const normalized = normalizeDomain(domain);
    const parts = normalized.split('.').filter(Boolean);
    if (parts.length <= 2) return [normalized];

    const suffix2 = parts.slice(-2).join('.');
    const root = SECOND_LEVEL_PUBLIC_SUFFIXES.has(suffix2) && parts.length >= 3
        ? parts.slice(-3).join('.')
        : parts.slice(-2).join('.');

    return [...new Set([normalized, root])];
}

export class BrowserCredentialService {
    static save(userId: number, domain: string, login: string, password: string): void {
        const store = readStore();
        const record = { login, password, updatedAt: new Date().toISOString() };
        for (const candidate of candidateDomains(domain)) {
            store[storeKey(userId, candidate)] = record;
        }
        writeStore(store);
    }

    static get(userId: number, domain: string): SiteCredentials | null {
        const store = readStore();
        for (const candidate of candidateDomains(domain)) {
            const creds = store[storeKey(userId, candidate)];
            if (creds) return creds;
        }
        return null;
    }

    static delete(userId: number, domain: string): void {
        const store = readStore();
        for (const candidate of candidateDomains(domain)) {
            delete store[storeKey(userId, candidate)];
        }
        writeStore(store);
    }

    static listForUser(userId: number): Array<{ domain: string } & SiteCredentials> {
        const store = readStore();
        const prefix = `${userId}_`;
        const seen = new Set<string>();
        return Object.entries(store)
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => ({ domain: k.slice(prefix.length), ...v }))
            .filter((entry) => {
                const key = `${entry.domain}:${entry.login}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
    }

    /**
     * Пытается распознать сохранение учётных данных в тексте сообщения.
     * Пример: «запомни мои данные для sport.ru: логин vasya@mail.ru, пароль qwerty123»
     * Если распознано — сохраняет и возвращает { domain, login }; иначе null.
     */
    static parseAndSave(userId: number, text: string): { domain: string; login: string } | null {
        const domainRe = /(?:для|на сайте?|site|сайт[еa]?):?\s+(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,})/i;
        const loginRe = /(?:логин|login|email|почта|e-mail)[:\s=]+([^\s,;|"']+)/i;
        const passRe = /(?:пароль|password|pass|пасс)[:\s=]+([^\s,;|"']+)/i;

        // Первая быстрая проверка — есть ли ключевые слова
        if (!/(запомни|сохрани|добавь).{0,30}(данны|учётн|логин|кред)/i.test(text)) return null;

        const domainMatch = text.match(domainRe);
        const loginMatch = text.match(loginRe);
        const passMatch = text.match(passRe);
        if (!domainMatch || !loginMatch || !passMatch) return null;

        const domain = domainMatch[1].toLowerCase().replace(/^www\./, '');
        const login = loginMatch[1];
        const password = passMatch[1];
        this.save(userId, domain, login, password);
        return { domain, login };
    }
}
