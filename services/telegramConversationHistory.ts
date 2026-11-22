import { initTelegramClient } from './telegram';
import { USER_TIMEZONE } from '../constants';
import { getZonedDateTimeParts, zonedDateTimeToDate } from '../utils/time';
import { getGramJsForwardSource } from '../utils/forwardedMessage';

export interface ConversationRange { since: string; until: string }
type ConversationItem = { chatId: string; title: string; chatType: string; latestAt: string; username?: string };
interface ConversationCatalogue extends ConversationRange {
    timeZone: string;
    items: ConversationItem[];
    cursor: string | null;
    complete: boolean;
    nextCursor?: string;
    scanLimitReached?: boolean;
    resolvedChatId?: string;
    ambiguousTitle?: boolean;
}
const CATALOG_LIMIT = 1000;

export function normalizeTelegramChatTitle(value: string): string {
    return value.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}
type Cursor = ConversationRange & { kind: 'dialogs' | 'history'; peer: string; messageId: number; date: number; offset?: number; query?: string; chatType?: string };

function encode(cursor: Cursor): string { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
function decode(value: unknown, kind: Cursor['kind']): Cursor | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 2000) throw Error('Некорректный курсор');
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (cursor.kind !== kind || !/^-?\d{1,16}$/.test(cursor.peer) || !Number.isSafeInteger(cursor.messageId) || cursor.messageId <= 0 ||
        !Number.isSafeInteger(cursor.date) || cursor.date <= 0) throw Error('Некорректный курсор');
    if (kind === 'dialogs' && (!Number.isInteger(cursor.offset) || cursor.offset! < 0 || cursor.offset! >= CATALOG_LIMIT)) throw Error('Некорректное смещение');
    return cursor;
}

/** Half-open calendar range in the account timezone; never a rolling 24-hour cache. */
export function conversationRange(args: { since?: unknown; until?: unknown }, now = new Date(), timeZone = USER_TIMEZONE): ConversationRange {
    if ((args.since === undefined) !== (args.until === undefined)) throw Error('Укажи обе границы периода');
    if (args.since === undefined) {
        const p = getZonedDateTimeParts(now, timeZone);
        return { since: zonedDateTimeToDate(p.year, p.month, p.day, 0, 0, timeZone).toISOString(), until: now.toISOString() };
    }
    const parse = (value: unknown) => {
        if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw Error('Нужен ISO-период с часовым поясом');
        return new Date(value);
    };
    const since = parse(args.since), until = parse(args.until);
    if (since >= until || until.getTime() - since.getTime() > 366 * 86400000) throw Error('Недопустимый период');
    return { since: since.toISOString(), until: until.toISOString() };
}

function rangeWithCursor(args: Record<string, unknown>, cursor?: Cursor): ConversationRange {
    const range = conversationRange(cursor ?? args);
    if (cursor && (args.since !== undefined || args.until !== undefined) && JSON.stringify(conversationRange(args)) !== JSON.stringify(range)) throw Error('Курсор другого периода');
    return range;
}

function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw Error('Чтение отменено'); }

/** Pages retain Telegram order, including outgoing-only conversations. No mark-as-read calls. */
export async function listTelegramConversations(args: Record<string, unknown>, signal?: AbortSignal, namedTarget?: string): Promise<ConversationCatalogue> {
    const cursor = decode(args.cursor, 'dialogs');
    const range = rangeWithCursor(args, cursor);
    const query = String(args.query ?? cursor?.query ?? '').trim().toLocaleLowerCase();
    const chatType = String(args.chatType ?? cursor?.chatType ?? 'conversations');
    if (!['conversations', 'private', 'group', 'channel', 'all'].includes(chatType) || query.length > 200 ||
        cursor && (query !== cursor.query || chatType !== cursor.chatType)) throw Error('Курсор другого фильтра');
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('Недопустимый размер страницы');
    checkSignal(signal);
    const client = await initTelegramClient();
    if (!client) throw Error('Telegram недоступен');
    checkSignal(signal);
    // GramJS ignorePinned excludes those conversations entirely. Keep them and
    // paginate the bounded catalogue before filtering, as with other resource lists.
    const offset = cursor?.offset ?? 0;
    // A named search can have hundreds of nonmatching dialogs before its first hit.
    // Read the bounded catalogue once inside the tool, independently of planner rounds.
    const addressed = Boolean(query) && !cursor;
    const end = addressed ? CATALOG_LIMIT : Math.min(CATALOG_LIMIT, offset + limit);
    const dialogs = await client.getDialogs({ limit: end + 1, ignorePinned: false });
    checkSignal(signal);
    const items: ConversationItem[] = [];
    const exact = new Map<string, ConversationItem>();
    const search = normalizeTelegramChatTitle(query);
    const named = normalizeTelegramChatTitle(namedTarget ?? '');
    const since = Date.parse(range.since);
    let last: any; let reachedStart = false;
    for (const dialog of Array.from(dialogs).slice(offset, end)) {
        const d = dialog as any;
        last = d;
        if (!d.message?.date || d.id == null) continue;
        const date = d.message.date * 1000;
        if (date < since) {
            if (d.pinned) continue;
            reachedStart = true; break;
        }
        const type = d.isUser ? 'private' : d.isGroup ? 'group' : d.isChannel ? 'channel' : 'unknown';
        if (d.entity?.bot || type === 'unknown' || chatType === 'conversations' && type === 'channel' ||
            !['all', 'conversations', type].includes(chatType)) continue;
        const title = String(d.title || d.name || d.entity?.title || [d.entity?.firstName, d.entity?.lastName].filter(Boolean).join(' ') || 'Без названия').slice(0, 200);
        const username = d.entity?.username ? String(d.entity.username).slice(0, 100) : undefined;
        const normalizedTitle = normalizeTelegramChatTitle(title);
        if (search && !`${normalizedTitle} ${username ? '@' + username.toLocaleLowerCase() : ''}`.includes(search)) continue;
        const item = { chatId: String(d.id), title, chatType: type, latestAt: new Date(date).toISOString(), ...(username ? { username } : {}) };
        items.push(item);
        if (named && normalizedTitle === named) exact.set(item.chatId, item);
    }
    const more = !reachedStart && dialogs.length > end;
    const scanLimitReached = more && end >= CATALOG_LIMIT;
    if (addressed) {
        const matches = exact.size ? [...exact.values()] : items;
        const capped = scanLimitReached || matches.length > limit;
        const complete = !capped;
        return { ...range, timeZone: USER_TIMEZONE, items: matches.slice(0, limit), cursor: null, complete,
            ...(capped ? { scanLimitReached: true } : {}),
            ...(complete && exact.size === 1 ? { resolvedChatId: matches[0].chatId } : {}),
            ...(exact.size > 1 ? { ambiguousTitle: true } : {}) };
    }
    const nextCursor = more && !scanLimitReached && last?.message?.id && last?.message?.date && last.id != null
        ? encode({ ...range, kind: 'dialogs', peer: String(last.id), messageId: last.message.id, date: last.message.date, offset: end, query, chatType }) : undefined;
    if (more && !scanLimitReached && !nextCursor) throw Error('Не удалось продолжить каталог');
    return { ...range, timeZone: USER_TIMEZONE, items, cursor: typeof args.cursor === 'string' ? args.cursor : null, complete: !more, ...(nextCursor ? { nextCursor } : {}), ...(scanLimitReached ? { scanLimitReached } : {}) };
}

export async function readTelegramConversation(args: Record<string, unknown>, signal?: AbortSignal) {
    const cursor = decode(args.cursor, 'history');
    const range = rangeWithCursor(args, cursor);
    const chatId = String(args.chatId);
    if (!/^-?\d{1,16}$/.test(chatId) || cursor && cursor.peer !== chatId) throw Error('Курсор другого чата');
    const limit = Number(args.limit ?? 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw Error('Недопустимый размер страницы');
    checkSignal(signal);
    const client = await initTelegramClient();
    if (!client) throw Error('Telegram недоступен');
    checkSignal(signal);
    const messages = await client.getMessages(chatId, { limit: limit + 1,
        ...(cursor ? { offsetId: cursor.messageId } : { offsetDate: Math.ceil(Date.parse(range.until) / 1000) }) });
    checkSignal(signal);
    const items: Array<Record<string, unknown>> = [];
    let last: any; let reachedStart = false; let chars = 0; let consumed = 0;
    for (const message of Array.from(messages).slice(0, limit)) {
        const m = message as any;
        const ms = (m.date || 0) * 1000;
        if (ms < Date.parse(range.since)) { reachedStart = true; break; }
        if (!Number.isSafeInteger(m.id) || m.id <= 0) throw Error('Некорректный ID сообщения');
        if (ms >= Date.parse(range.until)) { last = m; consumed++; continue; }
        const original = String(m.message ?? '');
        const item = { messageId: m.id, at: new Date(ms).toISOString(), isOwn: Boolean(m.out),
            senderId: m.fromId?.userId != null ? String(m.fromId.userId) : undefined,
            isForwarded: Boolean(m.fwdFrom), ...(m.fwdFrom ? { forwardSource: getGramJsForwardSource(m.fwdFrom) } : {}),
            text: original.slice(0, 1000), ...(original.length > 1000 ? { textTruncated: true } : {}),
            ...(m.media ? { mediaType: String(m.media.className ?? 'media').slice(0, 80) } : {}),
            ...(m.replyTo?.replyToMsgId ? { replyToMessageId: m.replyTo.replyToMsgId } : {}) };
        const size = JSON.stringify(item).length;
        if (items.length && chars + size > 7000) break;
        items.push(item); chars += size; last = m; consumed++;
    }
    const more = !reachedStart && (messages.length > consumed);
    const nextCursor = more && last ? encode({ ...range, kind: 'history', peer: chatId, messageId: last.id, date: last.date }) : undefined;
    return { ...range, chatId, items, cursor: args.cursor ?? null, complete: !more, ...(nextCursor ? { nextCursor } : {}) };
}
