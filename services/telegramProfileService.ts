import { Api } from 'telegram';
import bigInt from 'big-integer';
import { initTelegramClient } from './telegram';
import type { Contact } from '../stores/ContactsStore';
import { contactDisplayName, contactOptionLabel, resolveContactIdentityForRead } from '../utils/contactMemory';

const DIALOG_SCAN_LIMIT = 300;
export const TELEGRAM_PROFILE_FIELDS = ['phone', 'username', 'bio'] as const;
export type TelegramProfileField = typeof TELEGRAM_PROFILE_FIELDS[number];
export type ProfileCandidate = Pick<Contact, 'id' | 'firstName' | 'lastName' | 'username'>;
export interface TelegramProfileLookup {
    state: 'found' | 'ambiguous' | 'not_found' | 'incomplete' | 'unavailable';
    source: 'telegram_profile';
    summary: string;
    checkedAt?: string;
    profile?: ProfileCandidate & { phone?: string; phoneStatus?: 'available' | 'not_visible'; bio?: string };
    candidates?: ProfileCandidate[];
}

function candidate(user: Api.User): ProfileCandidate {
    return { id: Number(user.id), firstName: user.firstName || '', lastName: user.lastName, username: user.username };
}

export function telegramProfileCandidates(previous: unknown): ProfileCandidate[] {
    const data = previous as Partial<TelegramProfileLookup> | null;
    return data?.source === 'telegram_profile' && ['ambiguous', 'incomplete'].includes(String(data.state)) && Array.isArray(data.candidates)
        ? data.candidates.filter(item => item && Number.isSafeInteger(item.id) && item.id > 0 && typeof item.firstName === 'string') : [];
}

/** Only a persisted tool result can bind a short confirmation to a Telegram ID.
 * Unknown natural language goes to the existing intent pass, never to a name scan. */
export function continueTelegramProfileLookup(previous: unknown, answer: string): { query: string; expectedId?: number } | { clarification: TelegramProfileLookup } | undefined {
    const text = answer.trim();
    const candidates = telegramProfileCandidates(previous);
    const normalized = text.toLocaleLowerCase('ru').replace(/[.,!?;:]/gu, '').replace(/\s+/gu, ' ').trim();
    const positive = /^(?:да(?: это (?:он|она|тот|та|нужный человек))?|это (?:он|она)|верно|правильно|ага|угу|тот самый|та самая|yes)$/u.test(normalized);
    const negative = /^(?:нет|не (?:он|она)|нет это не (?:он|она)|не тот|не та|no)$/u.test(normalized);
    const selected = (item: ProfileCandidate) => ({ query: item.username && /^[a-zA-Z0-9_]{3,32}$/.test(item.username) ? `@${item.username}` : String(item.id), expectedId: item.id });
    if (positive && candidates.length === 1) return selected(candidates[0]);
    if (negative || positive) {
        const summary = positive && candidates.length > 1
            ? `Найдено несколько людей: ${candidates.map(contactOptionLabel).join('; ')}. Укажи имя или @username нужного человека.`
            : 'Укажи имя или @username нужного человека.';
        return { clarification: { state: negative ? 'not_found' : 'ambiguous', source: 'telegram_profile', summary, candidates: negative ? [] : candidates } };
    }
    // A full name or username may select one of the shown candidates. Fuzzy
    // similarity alone still cannot select a person, even when there is only one.
    const identity = resolveContactIdentityForRead(text, candidates);
    if (identity.status === 'resolved' && identity.contact) return selected(identity.contact);
    const byId = candidates.find(item => String(item.id) === text);
    if (byId) return selected(byId);
    if (/^@[a-zA-Z0-9_]{3,32}$/.test(text) || /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text))) return { query: text };
    return undefined;
}

/** Live read only: no cached phone fallback, message reads, imports or memory writes. */
export async function lookupTelegramProfile(query: string, fields: readonly TelegramProfileField[] = TELEGRAM_PROFILE_FIELDS, expectedId?: number): Promise<TelegramProfileLookup> {
    const result = (state: TelegramProfileLookup['state'], summary: string, extra: Partial<TelegramProfileLookup> = {}): TelegramProfileLookup =>
        ({ state, source: 'telegram_profile', summary, ...extra });
    const name = query.trim();
    if (!name) return result('not_found', 'Не указан человек для проверки профиля Telegram.');
    try {
        const client = await initTelegramClient({ preloadContacts: false, silent: true });
        if (!client) return result('unavailable', 'Личный аккаунт Telegram сейчас недоступен; профиль и номер не проверены.');
        let user: Api.User | undefined;
        if (/^@[a-zA-Z0-9_]{3,32}$/.test(name)) {
            const entity = await client.getEntity(name);
            if (entity instanceof Api.User && !entity.deleted) user = entity;
        } else if (/^[1-9]\d*$/.test(name) && Number.isSafeInteger(Number(name))) {
            // A confirmed correspondent can be outside the first dialog page.
            // Resolve the known ID directly before falling back to a bounded scan.
            try {
                const entity = await client.getEntity(Number(name));
                if (entity instanceof Api.User && !entity.deleted && entity.id.toString() === name) user = entity;
            } catch { /* A fresh client may need contacts/dialogs to recover the access hash. */ }
        }
        if (!user && !name.startsWith('@')) {
            const contacts = await client.invoke(new Api.contacts.GetContacts({ hash: bigInt.zero }));
            if (!(contacts instanceof Api.contacts.Contacts)) return result('unavailable', 'Telegram не вернул актуальный список контактов; профиль не проверен.');
            const users = new Map<number, Api.User>();
            const addUser = (entity: unknown) => {
                if (entity instanceof Api.User && !entity.deleted && Number.isSafeInteger(Number(entity.id))) users.set(Number(entity.id), entity);
            };
            contacts.users.forEach(addUser);
            const resolve = () => {
                if (/^[1-9]\d*$/.test(name)) return users.get(Number(name));
                const resolution = resolveContactIdentityForRead(name, [...users.values()].map(candidate));
                return resolution.status === 'resolved' && resolution.contact ? users.get(resolution.contact.id) : undefined;
            };
            user = resolve();
            if (!user) {
                // A correspondent need not be saved in the address book. Groups are never people.
                const dialogs = await client.getDialogs({ limit: DIALOG_SCAN_LIMIT });
                dialogs.forEach(dialog => addUser(dialog.entity));
                const complete = typeof dialogs.total === 'number' && dialogs.total <= dialogs.length;
                const resolution = resolveContactIdentityForRead(name, [...users.values()].map(candidate));
                if (resolution.status === 'ambiguous') return result('ambiguous',
                    resolution.candidates.length === 1 ? `Найден похожий контакт: ${contactOptionLabel(resolution.candidates[0])}. Это нужный человек?`
                        : `Нужно уточнить человека: ${resolution.candidates.map(contactOptionLabel).join('; ')}. Укажи точное имя или @username.`,
                    { candidates: resolution.candidates.map(({ id, firstName, lastName, username }) => ({ id, firstName, lastName, username })) });
                user = resolve();
                // A username/ID establishes identity; a unique name on an incomplete page does not.
                if (!complete && !/^[1-9]\d*$/.test(name)) return result('incomplete', user
                    ? `В просмотренной части диалогов найден ${contactOptionLabel(candidate(user))}. Это нужный человек?`
                    : 'Просмотрена только часть Telegram-диалогов. Укажи @username или Telegram ID человека для точной проверки.',
                    { candidates: user ? [candidate(user)] : [] });
            }
        }
        if (!user) return result('not_found', 'Человек не найден среди доступных контактов и просмотренных личных Telegram-диалогов. Уточни имя или @username.');
        if (expectedId !== undefined && user.id.toString() !== String(expectedId)) return result('unavailable', 'Аккаунт по этому username изменился. Профиль ранее выбранного человека не подтверждён; уточни его аккаунт.');
        const full = await client.invoke(new Api.users.GetFullUser({ id: user }));
        // GetFullUser includes other users too. Only the requested strong ID supplies profile fields.
        const fresh = full.users.find(item => item instanceof Api.User && item.id.toString() === user!.id.toString());
        if (!(fresh instanceof Api.User) || fresh.deleted || fresh.min || full.fullUser.id.toString() !== user.id.toString()) {
            return result('unavailable', 'Telegram не вернул полный профиль выбранного человека; номер не проверен.');
        }
        const profile: NonNullable<TelegramProfileLookup['profile']> = { id: Number(fresh.id), firstName: fresh.firstName || '', lastName: fresh.lastName };
        if (fields.includes('username')) profile.username = fresh.username;
        if (fields.includes('bio')) profile.bio = full.fullUser.about?.slice(0, 4000);
        if (fields.includes('phone')) {
            profile.phone = fresh.phone ? `+${fresh.phone.replace(/^\+/, '')}` : undefined;
            profile.phoneStatus = profile.phone ? 'available' : 'not_visible';
        }
        const summary = [`Профиль ${contactDisplayName(profile)} проверен в Telegram.`,
            fields.includes('phone') ? profile.phone ? `Телефон: ${profile.phone}.` : 'Номер не виден этому Telegram-аккаунту; это не означает, что у человека нет номера.' : '',
            fields.includes('username') ? profile.username ? `Username: @${profile.username}.` : 'Username в профиле не указан.' : '',
        ].filter(Boolean).join(' ');
        return result('found', summary, { profile, checkedAt: new Date().toISOString() });
    } catch (error) {
        const code = (error as { errorMessage?: unknown } | null)?.errorMessage;
        if (code === 'USERNAME_NOT_OCCUPIED' || code === 'USERNAME_INVALID') return result('not_found', 'Такой @username не найден в Telegram. Уточни аккаунт человека.');
        // Do not expose provider errors or silently substitute a phone from an old cache.
        return result('unavailable', 'Не удалось прочитать профиль Telegram; номер и другие поля не проверены.');
    }
}
