import { InlineKeyboard } from 'grammy';
import { BotContext } from '../types';
import { Contact, ContactsStore } from '../stores/ContactsStore';
import { getVectorService } from '../services/VectorServiceFactory';
import {
    contactDisplayName,
    contactIdentityTags,
    contactOptionLabel,
    normalizeContactLookupValue,
    resolveContactIdentity,
} from './contactMemory';
import { devLog } from '../utils';

const PENDING_CONTACT_LOOKUP_TTL_MS = 10 * 60 * 1000;
const MAX_CONTACT_FACTS_IN_ANSWER = 18;
const TELEGRAM_TEXT_LIMIT = 3900;
const FALLBACK_CONTACT_SEARCH_LIMIT = 20;

export interface ContactLookupResponse {
    responseText: string;
    keyboard?: InlineKeyboard;
}

function isSelfReference(value: string): boolean {
    return /^(меня|мне|обо мне|про меня|мой профиль|мою память)$/i.test(value.trim());
}

function isAssistantSelfReference(value: string): boolean {
    return /^(себя|себе|о себе|обо себе|про себя|тебя|тебе|о тебе|про тебя|твою память|твою биографию|твою жизнь)$/i.test(value.trim());
}

function isAssistantSelfClarification(value: string): boolean {
    return /^(?:я\s+)?(?:имею\s+в\s*виду|имел(?:а)?\s+в\s*виду|говорю\s+про|про|о|об)\s+(?:тебя|тебе|себя|себе)|^(?:тебя|тебе|себя|себе)$/iu.test(value.trim());
}

function cleanLookupTarget(raw: string): string {
    return raw
        .replace(/[?.!]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractContactLookupName(message: string): string | null {
    const text = message.trim();
    const patterns = [
        /^(?:что\s+(?:ты\s+)?(?:знаешь|помнишь|помнила)|что\s+известно)\s+(?:о|об|про)\s+(.+)$/i,
        /^расскажи\s+(?:мне\s+)?(?:что\s+(?:ты\s+)?(?:знаешь|помнишь)\s+)?(?:о|об|про)\s+(.+)$/i,
        /^покажи\s+(?:память|факты)\s+(?:о|об|про)\s+(.+)$/i,
        /^какие\s+факты\s+(?:есть\s+)?(?:о|об|про)\s+(.+)$/i,
        /^кто\s+(?:такой|такая)\s+(.+)$/i,
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match?.[1]) continue;
        const target = cleanLookupTarget(match[1]);
        if (!target || isSelfReference(target) || isAssistantSelfReference(target)) return null;
        return target;
    }

    return null;
}

function lookupKeyboard(candidates: Contact[]): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const candidate of candidates.slice(0, 6)) {
        keyboard.text(contactOptionLabel(candidate), `clook:${candidate.id}`).row();
    }
    keyboard.text('Отмена', 'clook:cancel');
    return keyboard;
}

function setPendingLookup(ctx: BotContext, contactName: string, originalMessage: string, candidates: Contact[]): void {
    ctx.session.pendingContactLookup = {
        contactName,
        originalMessage,
        candidateIds: candidates.map(c => c.id),
        createdAt: Date.now(),
    };
}

function truncateTelegramText(text: string): string {
    if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
    return `${text.slice(0, TELEGRAM_TEXT_LIMIT - 40).trim()}\n\n...`;
}

function stripStoredContactPrefix(content: string): string {
    return content.replace(/^\[[^\]]+\]\s*/, '').trim();
}

function storedContactPrefix(content: string): string | null {
    return content.match(/^\[([^\]]+)\]\s+/)?.[1] ?? null;
}

function contactFactMatchesName(content: string, tags: string[] | undefined, names: string[]): boolean {
    const normalizedNames = names
        .map(name => normalizeContactLookupValue(name))
        .filter(Boolean);
    if (normalizedNames.length === 0) return false;

    const prefix = storedContactPrefix(content);
    if (prefix) {
        const normalizedPrefix = normalizeContactLookupValue(prefix);
        if (normalizedNames.some(name => normalizedPrefix === name)) return true;
    }

    for (const tag of tags ?? []) {
        const value = String(tag);
        if (!value.startsWith('contact:') &&
            !value.startsWith('contact_name:') &&
            !value.startsWith('contact_alias:') &&
            !value.startsWith('contact_username:')) {
            continue;
        }
        const normalizedTag = normalizeContactLookupValue(
            value.replace(/^contact(_name|_alias)?:/, '').replace(/^contact_username:/, '')
        );
        if (normalizedNames.some(name => normalizedTag === name)) return true;
    }

    return false;
}

async function getContactFacts(ctx: BotContext, contactName: string, contact?: Contact) {
    const svc = getVectorService();
    if (!svc) return [];

    const userId = String(ctx.from?.id);
    const displayName = contact ? contactDisplayName(contact) : contactName.trim();
    const tags = contactIdentityTags(contactName, contact);
    if (!contact && contactName.trim()) {
        tags.push(`contact_key:${normalizeContactLookupValue(contactName).replace(/\s+/g, '_')}`);
    }

    const seen = new Map<string, Awaited<ReturnType<typeof svc.getMemoriesByTag>>[number]>();
    for (const tag of [...new Set(tags)]) {
        const matches = await svc.getMemoriesByTag(userId, tag).catch(() => []);
        for (const match of matches) {
            seen.set(match.id, match);
        }
    }

    const fallbackQueries = [...new Set([contactName, displayName, contact?.username ? `@${String(contact.username).replace(/^@/, '')}` : ''].filter(Boolean))];
    for (const query of fallbackQueries) {
        const matches = await svc.searchAllDomains(query, userId, FALLBACK_CONTACT_SEARCH_LIMIT).catch(() => []);
        for (const match of matches) {
            if (seen.has(match.id)) continue;
            if (!contactFactMatchesName(
                match.content,
                match.tags,
                [contactName, displayName, contact?.username ? `@${String(contact.username).replace(/^@/, '')}` : ''].filter(Boolean)
            )) continue;
            seen.set(match.id, match);
        }
    }

    return Array.from(seen.values())
        .sort((a, b) => {
            const ai = (a.importance ?? 0.5) + (a.isAnchor ? 0.2 : 0);
            const bi = (b.importance ?? 0.5) + (b.isAnchor ? 0.2 : 0);
            if (bi !== ai) return bi - ai;
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });
}

async function buildContactFactsAnswer(
    ctx: BotContext,
    contactName: string,
    contact?: Contact
): Promise<string> {
    const displayName = contact ? contactDisplayName(contact) : contactName.trim();
    const facts = await getContactFacts(ctx, contactName, contact);

    if (facts.length === 0) {
        return `Не нашла сохранённых фактов о ${displayName}.`;
    }

    const lines = [`Вот что я помню о ${displayName}:`, ''];
    for (const fact of facts.slice(0, MAX_CONTACT_FACTS_IN_ANSWER)) {
        const confidencePrefix =
            (fact.confidence ?? 0.6) < 0.35 ? '[не уверена] ' :
                (fact.confidence ?? 0.6) < 0.65 ? '[возможно] ' : '';
        lines.push(`• ${confidencePrefix}${stripStoredContactPrefix(fact.content)}`);
    }

    if (facts.length > MAX_CONTACT_FACTS_IN_ANSWER) {
        lines.push('', `Ещё ${facts.length - MAX_CONTACT_FACTS_IN_ANSWER} фактов не показываю, чтобы не перегружать ответ.`);
    }

    return truncateTelegramText(lines.join('\n'));
}

export async function maybeStartContactMemoryLookup(
    ctx: BotContext,
    message: string
): Promise<ContactLookupResponse | null> {
    if (ctx.chat?.type !== 'private') return null;

    const contactName = extractContactLookupName(message);
    if (!contactName) return null;

    const resolution = resolveContactIdentity(contactName);
    if (resolution.status === 'resolved') {
        ctx.session.pendingContactLookup = undefined;
        return {
            responseText: await buildContactFactsAnswer(ctx, contactName, resolution.contact),
        };
    }

    if (resolution.status === 'ambiguous') {
        setPendingLookup(ctx, contactName, message, resolution.candidates);
        return {
            responseText: `У меня несколько контактов по имени «${contactName}». О ком именно посмотреть память?`,
            keyboard: lookupKeyboard(resolution.candidates),
        };
    }

    ctx.session.pendingContactLookup = {
        contactName,
        originalMessage: message,
        candidateIds: [],
        createdAt: Date.now(),
    };
    return {
        responseText: `Уточни, пожалуйста, кого ты имеешь в виду под «${contactName}»: напиши фамилию или username.`,
    };
}

export async function handlePendingContactLookupText(
    ctx: BotContext,
    message: string
): Promise<ContactLookupResponse | null> {
    const pending = ctx.session.pendingContactLookup;
    if (!pending) return null;

    if (Date.now() - pending.createdAt > PENDING_CONTACT_LOOKUP_TTL_MS) {
        ctx.session.pendingContactLookup = undefined;
        return null;
    }

    const text = message.trim();
    if (!text || text.startsWith('/')) return null;
    if (/^(отмена|cancel|стоп)$/i.test(text)) {
        ctx.session.pendingContactLookup = undefined;
        return { responseText: 'Ок, не смотрю память по контакту.' };
    }
    if (isAssistantSelfClarification(text)) {
        ctx.session.pendingContactLookup = undefined;
        return null;
    }

    const resolution = resolveContactIdentity(text);
    if (resolution.status === 'resolved') {
        ctx.session.pendingContactLookup = undefined;
        return {
            responseText: await buildContactFactsAnswer(ctx, text, resolution.contact),
        };
    }

    if (resolution.status === 'ambiguous') {
        setPendingLookup(ctx, text, pending.originalMessage, resolution.candidates);
        return {
            responseText: `Нашла несколько вариантов для «${text}». Выбери нужный контакт.`,
            keyboard: lookupKeyboard(resolution.candidates),
        };
    }

    return {
        responseText: `Не смогла однозначно найти «${text}». Напиши имя с фамилией или username.`,
    };
}

export async function handleContactMemoryLookupCallback(ctx: BotContext, callbackData: string): Promise<boolean> {
    if (!callbackData.startsWith('clook:')) return false;

    const pending = ctx.session.pendingContactLookup;
    if (!pending || Date.now() - pending.createdAt > PENDING_CONTACT_LOOKUP_TTL_MS) {
        ctx.session.pendingContactLookup = undefined;
        await ctx.answerCallbackQuery({ text: 'Уточнение устарело. Спроси ещё раз.' });
        return true;
    }

    if (callbackData === 'clook:cancel') {
        ctx.session.pendingContactLookup = undefined;
        await ctx.answerCallbackQuery({ text: 'Отменено' });
        await ctx.editMessageText('Ок, не смотрю память по контакту.');
        return true;
    }

    const contactId = Number(callbackData.replace('clook:', ''));
    if (!Number.isFinite(contactId) || !pending.candidateIds.includes(contactId)) {
        await ctx.answerCallbackQuery({ text: 'Этот вариант уже недоступен.' });
        return true;
    }

    const contact = ContactsStore.getInstance().getContact(contactId);
    if (!contact) {
        await ctx.answerCallbackQuery({ text: 'Контакт не найден.' });
        return true;
    }

    const answer = await buildContactFactsAnswer(ctx, pending.contactName, contact);
    ctx.session.pendingContactLookup = undefined;
    await ctx.answerCallbackQuery({ text: 'Нашла память' });
    await ctx.editMessageText(answer);
    devLog('Contact memory lookup answered via callback:', contactDisplayName(contact));
    return true;
}
