import { InlineKeyboard } from 'grammy';
import { get as levenshtein } from 'fast-levenshtein';
import { transliterate as toLatin } from 'transliteration';
import { BotContext } from '../types';
import { Contact, ContactsStore } from '../stores/ContactsStore';
import { MemorySaveMetadata, saveMemory } from './enhancedDomainMemory';
import { rememberFact } from './domainMemory';
import { devLog } from '../utils';

const PENDING_CONTACT_MEMORY_TTL_MS = 10 * 60 * 1000;
const RECENT_FACT_TTL_MS = 10 * 60 * 1000;

export interface ContactMemoryFact {
    contactName: string;
    content: string;
    domain: string;
    importance: number;
    tags?: string[];
    isAnchor?: boolean;
    memoryMetadata?: MemorySaveMetadata;
}

export interface ContactMemorySaveResult {
    status: 'saved' | 'pending' | 'skipped';
    content?: string;
}

export interface ContactMemorySaveOptions {
    askOnAmbiguous?: boolean;
}

export interface ContactIdentityScope {
    status: 'resolved' | 'ambiguous';
    queryName: string;
    displayName?: string;
    contact?: Contact;
    candidateNames?: string[];
}

const NON_CONTACT_LEADING_WORDS_SOURCE = [
    'я', 'мне', 'меня', 'мы', 'нам', 'нас', 'мой', 'моя', 'моё',
    'ты', 'тебе', 'тебя', 'он', 'она', 'они', 'оно',
    'сегодня', 'завтра', 'послезавтра', 'утром', 'вечером',
    'напомни', 'напоминай', 'создай', 'поставь', 'добавь',
    'могу', 'нужно', 'надо', 'хочу', 'пора', 'если',
];

export function normalizeContactLookupValue(s: string): string {
    return toLatin(s)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/\s+/g, ' ');
}

const NON_CONTACT_LEADING_WORDS = new Set(
    NON_CONTACT_LEADING_WORDS_SOURCE.map(normalizeContactLookupValue)
);

export function contactDisplayName(contact: Contact): string {
    const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
    return fullName || (contact.username ? `@${contact.username}` : `contact-${contact.id}`);
}

export function contactOptionLabel(contact: Contact): string {
    const display = contactDisplayName(contact);
    return contact.username ? `${display} (@${contact.username})` : display;
}

export function contactIdentityTags(contactName: string, contact?: Contact): string[] {
    const display = contact ? contactDisplayName(contact) : contactName.trim();
    const tags = [
        `contact:${display}`,
        `contact_name:${display}`,
        `contact_alias:${contactName.trim()}`,
    ];
    if (contact) {
        tags.push(`contact_id:${contact.id}`);
        if (contact.username) tags.push(`contact_username:@${String(contact.username).replace(/^@/, '')}`);
    } else {
        tags.push(`contact_key:${normalizeContactLookupValue(display).replace(/\s+/g, '_')}`);
    }
    return [...new Set(tags.filter(Boolean))];
}

export function extractContactReferenceFromText(message: string): string | null {
    const username = message.match(/@[a-zA-Z0-9_]{3,32}/)?.[0];
    if (username) return username;

    const patterns = [
        /^([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+){0,2})(?=\s+(?:опять|снова|молчит|пропал|прислал|написал|ответил|говорил|сказал|просил|попросил|попросила|хочет|жд[её]т|болеет|занят|занята|вернул(?:ся|ась)|улетает|прилетел|прилетела|не\b|у\b|со\b|с\b))/u,
        /(?:о|об|про|для|к|ко|с|со|у|от|по)\s+([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+){0,2})/u,
        /(?:написать|позвонить|подарить|купить|встретиться|поговорить|обсудить)\s+с?\s*([А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+(?:\s+[А-ЯЁA-Z][А-ЯЁA-Zа-яёa-z-]+){0,2})/u,
    ];

    for (const pattern of patterns) {
        const match = message.match(pattern);
        const candidate = match?.[1]?.trim();
        if (!candidate) continue;

        const firstToken = normalizeContactLookupValue(candidate).split(/\s+/)[0] ?? '';
        if (NON_CONTACT_LEADING_WORDS.has(firstToken)) continue;

        return candidate;
    }

    return null;
}

export function resolveContactIdentityScope(message: string): ContactIdentityScope | null {
    const contactName = extractContactReferenceFromText(message);
    if (!contactName) return null;

    const resolution = resolveContactIdentity(contactName);
    if (resolution.status === 'resolved') {
        return {
            status: 'resolved',
            queryName: contactName,
            displayName: resolution.displayName,
            contact: resolution.contact,
        };
    }

    if (resolution.status === 'ambiguous') {
        return {
            status: 'ambiguous',
            queryName: contactName,
            candidateNames: resolution.candidates.map(contactDisplayName),
        };
    }

    return null;
}

export function contactIdFromTags(tags: string[] | undefined): string | null {
    const tag = (tags ?? []).find(value => String(value).startsWith('contact_id:'));
    return tag ? String(tag).replace('contact_id:', '').trim() : null;
}

export function contactUsernameFromTags(tags: string[] | undefined): string | null {
    const tag = (tags ?? []).find(value => String(value).startsWith('contact_username:'));
    if (!tag) return null;
    return normalizeContactLookupValue(String(tag).replace('contact_username:', '').trim());
}

export function contactKeyFromTags(tags: string[] | undefined): string | null {
    const tag = (tags ?? []).find(value => String(value).startsWith('contact_key:'));
    return tag ? String(tag).replace('contact_key:', '').trim() : null;
}

export function contactNamesFromTags(tags: string[] | undefined): Set<string> {
    const names = new Set<string>();
    for (const tag of tags ?? []) {
        const value = String(tag);
        if (value.startsWith('contact:') || value.startsWith('contact_name:') || value.startsWith('contact_alias:')) {
            names.add(normalizeContactLookupValue(value.replace(/^contact(_name|_alias)?:/, '')));
        }
    }
    return names;
}

export function hasContactMemoryTags(tags: string[] | undefined): boolean {
    return (tags ?? []).some(tag =>
        String(tag).startsWith('contact:') ||
        String(tag).startsWith('contact_name:') ||
        String(tag).startsWith('contact_alias:') ||
        String(tag).startsWith('contact_id:') ||
        String(tag).startsWith('contact_username:') ||
        String(tag).startsWith('contact_key:')
    );
}

export function storedContactPrefix(content: string): string | null {
    return content.match(/^\[([^\]]+)\]\s+/u)?.[1]?.trim() ?? null;
}

export function isContactMemoryEntry(memory: { content: string; tags?: string[] | undefined }): boolean {
    return hasContactMemoryTags(memory.tags) || Boolean(storedContactPrefix(memory.content));
}

export function isMemoryEntryAllowedForContactScope(
    memory: { content: string; tags?: string[] | undefined },
    scope: ContactIdentityScope | null
): boolean {
    if (!isContactMemoryEntry(memory)) return true;
    if (!scope) return false;
    if (scope.status === 'ambiguous') return false;

    const candidateContactId = contactIdFromTags(memory.tags);
    if (candidateContactId) {
        return scope.contact ? candidateContactId === String(scope.contact.id) : false;
    }

    const allowedUsernames = new Set(
        contactIdentityTags(scope.queryName, scope.contact)
            .filter(tag => tag.startsWith('contact_username:'))
            .map(tag => normalizeContactLookupValue(tag.replace('contact_username:', '')))
    );
    if (scope.contact?.username) {
        allowedUsernames.add(normalizeContactLookupValue(scope.contact.username));
    }

    const candidateUsername = contactUsernameFromTags(memory.tags);
    if (candidateUsername) {
        return allowedUsernames.size > 0 && allowedUsernames.has(candidateUsername);
    }

    const candidateContactKey = contactKeyFromTags(memory.tags);
    if (candidateContactKey) {
        const allowedContactKeys = new Set(
            contactIdentityTags(scope.queryName, scope.contact)
                .filter(tag => tag.startsWith('contact_key:'))
                .map(tag => String(tag).replace('contact_key:', '').trim())
        );
        if (!scope.contact) {
            allowedContactKeys.add(normalizeContactLookupValue(scope.displayName ?? scope.queryName).replace(/\s+/g, '_'));
        }
        return allowedContactKeys.size > 0 && allowedContactKeys.has(candidateContactKey);
    }

    const allowedNames = new Set(
        contactIdentityTags(scope.queryName, scope.contact)
            .filter(tag => tag.startsWith('contact:') || tag.startsWith('contact_name:') || tag.startsWith('contact_alias:'))
            .map(tag => normalizeContactLookupValue(tag.replace(/^contact(_name|_alias)?:/, '')))
    );
    if (scope.displayName) allowedNames.add(normalizeContactLookupValue(scope.displayName));

    const prefix = storedContactPrefix(memory.content);
    if (prefix) {
        const normalizedPrefix = normalizeContactLookupValue(prefix);
        if (allowedNames.has(normalizedPrefix)) return true;
        for (const allowedName of allowedNames) {
            if (contactNamesLikelyMatch(normalizedPrefix, allowedName)) return true;
        }
    }

    for (const name of contactNamesFromTags(memory.tags)) {
        if (allowedNames.has(name)) return true;
        for (const allowedName of allowedNames) {
            if (contactNamesLikelyMatch(name, allowedName)) return true;
        }
    }

    return false;
}

function stripContactLead(content: string, contactName: string): string {
    let cleaned = content.trim();
    if (!cleaned) return cleaned;

    const escaped = contactName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const leadPatterns = [
        new RegExp(`^(?:эти\\s+)?(?:факты?|данные|сведения|информацию?|инфу)\\s+(?:об?\\s+|про\\s+)${escaped}\\s*[:,-]?\\s*`, 'i'),
        new RegExp(`^(?:об?\\s+|про\\s+)${escaped}\\s*[:,-]?\\s*`, 'i'),
        new RegExp(`^${escaped}\\s*[:,-]?\\s*`, 'i'),
    ];
    for (const pattern of leadPatterns) {
        cleaned = cleaned.replace(pattern, '').trim();
    }
    return cleaned || content.trim();
}

function pushRecentFact(ctx: BotContext, content: string): void {
    if (!ctx.session.recentlySavedFacts) ctx.session.recentlySavedFacts = [];
    const now = Date.now();
    ctx.session.recentlySavedFacts = ctx.session.recentlySavedFacts.filter(
        f => now - f.savedAt < RECENT_FACT_TTL_MS
    );
    ctx.session.recentlySavedFacts.push({ content, savedAt: now });
    if (ctx.session.recentlySavedFacts.length > 20) {
        ctx.session.recentlySavedFacts = ctx.session.recentlySavedFacts.slice(-15);
    }
}

function exactContactMatches(query: string, contacts: Contact[]): Contact[] {
    const q = normalizeContactLookupValue(query);
    const tokens = q.split(/\s+/).filter(Boolean);

    return contacts.filter((contact) => {
        const first = normalizeContactLookupValue(contact.firstName || '');
        const last = normalizeContactLookupValue(contact.lastName || '');
        const username = normalizeContactLookupValue(contact.username || '');
        const display = normalizeContactLookupValue(contactDisplayName(contact));

        if (tokens.length >= 2) {
            return display === q ||
                (first === tokens[0] && last === tokens[1]) ||
                (last === tokens[0] && first === tokens[1]);
        }

        return first === q || last === q || username === q;
    });
}

function isCloseToken(query: string, value: string): boolean {
    if (!query || !value) return false;
    if (query === value) return true;
    if (query.length >= 3 && value.length >= 3 && (query.startsWith(value) || value.startsWith(query))) {
        return true;
    }
    const maxDistance = Math.min(query.length, value.length) <= 4 ? 1 : 2;
    return levenshtein(query, value) <= maxDistance;
}

export function contactNamesLikelyMatch(left: string, right: string): boolean {
    const normalizedLeft = normalizeContactLookupValue(left);
    const normalizedRight = normalizeContactLookupValue(right);
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight) return true;

    const leftTokens = normalizedLeft
        .split(/\s+/)
        .filter(Boolean);
    const rightTokens = normalizedRight
        .split(/\s+/)
        .filter(Boolean);
    if (leftTokens.length === 0 || rightTokens.length === 0) return false;

    if (leftTokens.length === rightTokens.length) {
        const sameOrder = leftTokens.every((token, index) => isCloseToken(token, rightTokens[index] ?? ''));
        if (sameOrder) return true;
        const swappedOrder = leftTokens.every((token, index) =>
            isCloseToken(token, rightTokens[rightTokens.length - 1 - index] ?? '')
        );
        if (swappedOrder) return true;
    }

    let matchedTokens = 0;
    const unmatchedRight = [...rightTokens];
    for (const leftToken of leftTokens) {
        const matchIndex = unmatchedRight.findIndex((rightToken) => isCloseToken(leftToken, rightToken));
        if (matchIndex >= 0) {
            matchedTokens++;
            unmatchedRight.splice(matchIndex, 1);
        }
    }

    const minimumTokenCount = Math.min(leftTokens.length, rightTokens.length);
    if (minimumTokenCount <= 1) {
        return leftTokens.length === rightTokens.length && matchedTokens >= 1;
    }
    return matchedTokens >= 2;
}

function plausibleContactMatches(query: string, contacts: Contact[]): Contact[] {
    const q = normalizeContactLookupValue(query);
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    return contacts.filter((contact) => {
        const first = normalizeContactLookupValue(contact.firstName || '');
        const last = normalizeContactLookupValue(contact.lastName || '');
        const username = normalizeContactLookupValue(contact.username || '');

        if (tokens.length >= 2) {
            const [a, b] = tokens;
            return (isCloseToken(a, first) && isCloseToken(b, last)) ||
                (isCloseToken(a, last) && isCloseToken(b, first));
        }

        return isCloseToken(tokens[0], first) ||
            isCloseToken(tokens[0], last) ||
            isCloseToken(tokens[0], username);
    });
}

export function resolveContactIdentity(contactName: string): { status: 'resolved'; contact?: Contact; displayName: string } | { status: 'ambiguous'; candidates: Contact[] } | { status: 'needs_name' } {
    const store = ContactsStore.getInstance();
    const allContacts = store.getAllContacts();
    const name = contactName.trim();
    const hasFullName = name.split(/\s+/).filter(Boolean).length >= 2;

    if (allContacts.length === 0) {
        return hasFullName
            ? { status: 'resolved', displayName: name }
            : { status: 'needs_name' };
    }

    const exact = exactContactMatches(name, allContacts);
    if (exact.length === 1) {
        return { status: 'resolved', contact: exact[0], displayName: contactDisplayName(exact[0]) };
    }
    if (exact.length > 1) {
        return { status: 'ambiguous', candidates: exact.slice(0, 6) };
    }

    const plausible = plausibleContactMatches(name, allContacts).slice(0, 6);
    if (plausible.length === 1) {
        return { status: 'resolved', contact: plausible[0], displayName: contactDisplayName(plausible[0]) };
    }
    if (plausible.length > 1) {
        return { status: 'ambiguous', candidates: plausible };
    }

    return hasFullName
        ? { status: 'resolved', displayName: name }
        : { status: 'needs_name' };
}

async function persistContactFact(ctx: BotContext, fact: ContactMemoryFact, contact?: Contact): Promise<string | null> {
    const displayName = contact ? contactDisplayName(contact) : fact.contactName.trim();
    const cleanContent = stripContactLead(fact.content, fact.contactName);
    const memoryContent = `[${displayName}] ${cleanContent}`;
    const tags = [
        ...(fact.tags ?? []),
        ...contactIdentityTags(fact.contactName, contact),
    ];

    const saved = await saveMemory(ctx, fact.domain, memoryContent, fact.importance, [...new Set(tags)], fact.isAnchor, {
        ...fact.memoryMetadata,
        subject: 'contact',
        sourceContext: fact.memoryMetadata?.sourceContext ?? fact.content,
    });
    if (!saved) return null;
    rememberFact(ctx, fact.domain, memoryContent);
    pushRecentFact(ctx, memoryContent);
    return memoryContent;
}

function setPendingContactMemory(ctx: BotContext, fact: ContactMemoryFact, candidates: Contact[]): void {
    ctx.session.pendingContactMemory = {
        contactName: fact.contactName,
        content: fact.content,
        domain: fact.domain,
        importance: fact.importance,
        tags: fact.tags ?? [],
        isAnchor: fact.isAnchor,
        memoryMetadata: fact.memoryMetadata,
        candidateIds: candidates.map(c => c.id),
        createdAt: Date.now(),
    };
}

function normalizedContentKey(content: string): string {
    return content.trim().replace(/\s+/g, ' ').toLowerCase();
}

function mergeSourceMessageIds(
    existing?: string[],
    incoming?: string[]
): string[] | undefined {
    const merged = [...(existing ?? []), ...(incoming ?? [])].filter(Boolean);
    return merged.length > 0 ? [...new Set(merged)] : undefined;
}

function mergePendingContactMemory(ctx: BotContext, fact: ContactMemoryFact, candidates: Contact[]): boolean {
    const pending = ctx.session.pendingContactMemory;
    if (!pending) return false;

    if (Date.now() - pending.createdAt > PENDING_CONTACT_MEMORY_TTL_MS) {
        ctx.session.pendingContactMemory = undefined;
        return false;
    }

    if (normalizeContactLookupValue(pending.contactName) !== normalizeContactLookupValue(fact.contactName)) {
        return false;
    }

    const incomingContent = stripContactLead(fact.content, fact.contactName);
    const existingKey = normalizedContentKey(pending.content);
    const incomingKey = normalizedContentKey(incomingContent);

    if (incomingKey && !existingKey.includes(incomingKey) && !incomingKey.includes(existingKey)) {
        pending.content = `${pending.content.trim()}\n${incomingContent}`;
    }

    pending.tags = [...new Set([...(pending.tags ?? []), ...(fact.tags ?? [])])];
    if (candidates.length > 0) {
        pending.candidateIds = [...new Set([...(pending.candidateIds ?? []), ...candidates.map(c => c.id)])];
    }
    pending.memoryMetadata = {
        ...pending.memoryMetadata,
        ...fact.memoryMetadata,
        sourceContext: [pending.memoryMetadata?.sourceContext, fact.memoryMetadata?.sourceContext]
            .filter(Boolean)
            .join('\n') || pending.memoryMetadata?.sourceContext,
        sourceMessageIds: mergeSourceMessageIds(
            pending.memoryMetadata?.sourceMessageIds,
            fact.memoryMetadata?.sourceMessageIds
        ),
    };
    pending.createdAt = Date.now();
    devLog('Contact memory clarification already pending, merged duplicate prompt:', fact.contactName);
    return true;
}

async function askContactClarification(ctx: BotContext, fact: ContactMemoryFact, candidates: Contact[]): Promise<void> {
    setPendingContactMemory(ctx, fact, candidates);

    const keyboard = new InlineKeyboard();
    for (const candidate of candidates.slice(0, 6)) {
        keyboard.text(contactOptionLabel(candidate), `cmem:${candidate.id}`).row();
    }
    keyboard.text('Не сохранять', 'cmem:cancel');

    await ctx.reply(
        `У меня несколько контактов по имени «${fact.contactName}». К кому сохранить этот факт?\n\n«${stripContactLead(fact.content, fact.contactName)}»`,
        { reply_markup: keyboard }
    );
}

export async function saveContactMemoryFactOrAsk(
    ctx: BotContext,
    fact: ContactMemoryFact,
    options: ContactMemorySaveOptions = {}
): Promise<ContactMemorySaveResult> {
    const askOnAmbiguous = options.askOnAmbiguous ?? true;
    const contactName = fact.contactName.trim();
    if (!contactName || !fact.content.trim()) return { status: 'skipped' };

    const resolution = resolveContactIdentity(contactName);
    if (resolution.status === 'resolved') {
        const content = await persistContactFact(ctx, fact, resolution.contact);
        if (!content) return { status: 'skipped' };
        ctx.session.pendingContactMemory = undefined;
        return { status: 'saved', content };
    }

    if (resolution.status === 'ambiguous') {
        if (!askOnAmbiguous) return { status: 'skipped' };
        if (mergePendingContactMemory(ctx, fact, resolution.candidates)) return { status: 'pending' };
        await askContactClarification(ctx, fact, resolution.candidates);
        return { status: 'pending' };
    }

    if (!askOnAmbiguous) return { status: 'skipped' };
    if (mergePendingContactMemory(ctx, fact, [])) return { status: 'pending' };

    ctx.session.pendingContactMemory = {
        contactName,
        content: fact.content,
        domain: fact.domain,
        importance: fact.importance,
        tags: fact.tags ?? [],
        isAnchor: fact.isAnchor,
        memoryMetadata: fact.memoryMetadata,
        candidateIds: [],
        createdAt: Date.now(),
    };
    await ctx.reply(
        `Не буду сохранять факт про «${contactName}» без уточнения: укажи фамилию или username, чтобы я не смешала разных людей.`
    );
    return { status: 'pending' };
}

export async function handleContactMemoryCallback(ctx: BotContext, callbackData: string): Promise<boolean> {
    if (!callbackData.startsWith('cmem:')) return false;

    const pending = ctx.session.pendingContactMemory;
    if (!pending || Date.now() - pending.createdAt > PENDING_CONTACT_MEMORY_TTL_MS) {
        ctx.session.pendingContactMemory = undefined;
        await ctx.answerCallbackQuery({ text: 'Уточнение устарело. Повтори факт с полным именем.' });
        return true;
    }

    if (callbackData === 'cmem:cancel') {
        ctx.session.pendingContactMemory = undefined;
        await ctx.answerCallbackQuery({ text: 'Не сохраняю' });
        await ctx.editMessageText('Ок, не сохраняю этот факт в память.');
        return true;
    }

    const contactId = Number(callbackData.replace('cmem:', ''));
    if (!Number.isFinite(contactId) || !pending.candidateIds.includes(contactId)) {
        await ctx.answerCallbackQuery({ text: 'Этот вариант уже недоступен.' });
        return true;
    }

    const contact = ContactsStore.getInstance().getContact(contactId);
    if (!contact) {
        await ctx.answerCallbackQuery({ text: 'Контакт не найден.' });
        return true;
    }

    const savedContent = await persistContactFact(ctx, pending, contact);
    if (!savedContent) {
        await ctx.answerCallbackQuery({ text: 'Не удалось сохранить' });
        return true;
    }
    ctx.session.pendingContactMemory = undefined;
    await ctx.answerCallbackQuery({ text: 'Сохранила в память' });
    await ctx.editMessageText(`Сохранила как факт о ${contactDisplayName(contact)}:\n\n${savedContent}`);
    devLog('Contact memory disambiguated via callback:', savedContent);
    return true;
}

export async function handlePendingContactMemoryText(ctx: BotContext, message: string): Promise<string | null> {
    const pending = ctx.session.pendingContactMemory;
    if (!pending || Date.now() - pending.createdAt > PENDING_CONTACT_MEMORY_TTL_MS) {
        if (pending) ctx.session.pendingContactMemory = undefined;
        return null;
    }

    const text = message.trim();
    if (!text || text.startsWith('/')) return null;

    const candidates = pending.candidateIds
        .map(id => ContactsStore.getInstance().getContact(id))
        .filter((c): c is Contact => Boolean(c));
    const narrowed = candidates.length > 0
        ? exactContactMatches(text, candidates)
        : exactContactMatches(text, ContactsStore.getInstance().getAllContacts());

    if (narrowed.length === 1) {
        const savedContent = await persistContactFact(ctx, pending, narrowed[0]);
        if (!savedContent) return 'Не удалось сохранить факт в долговременную память. Попробуй позже.';
        ctx.session.pendingContactMemory = undefined;
        return `Сохранила как факт о ${contactDisplayName(narrowed[0])}:\n${savedContent}`;
    }

    const resolution = resolveContactIdentity(text);
    if (resolution.status === 'resolved') {
        const factForSave = resolution.contact
            ? pending
            : { ...pending, contactName: resolution.displayName };
        const savedContent = await persistContactFact(
            ctx,
            factForSave,
            resolution.contact
        );
        if (!savedContent) return 'Не удалось сохранить факт в долговременную память. Попробуй позже.';
        ctx.session.pendingContactMemory = undefined;
        return `Сохранила как факт о ${resolution.displayName}:\n${savedContent}`;
    }

    if (resolution.status === 'ambiguous') {
        await askContactClarification(ctx, { ...pending, contactName: text }, resolution.candidates);
        return 'Нашла несколько вариантов, выбери нужный контакт кнопкой.';
    }

    return 'Мне всё ещё не хватает идентификатора контакта. Напиши имя с фамилией или username.';
}
