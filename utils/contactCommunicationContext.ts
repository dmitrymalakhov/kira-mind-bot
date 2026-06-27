import { transliterate as toLatin } from 'transliteration';
import type { BotContext } from '../types';
import type { Contact } from '../stores/ContactsStore';

const MAX_CONTACT_FACTS = 6;
const FACT_SEARCH_LIMIT = 16;

export interface ContactCommunicationContext {
    contactName: string;
    portrait?: string;
    facts: string[];
    promptBlock: string;
}

export interface RefineMessageForRecipientParams {
    ctx: BotContext;
    recipientName: string;
    draftText: string;
    userRequest: string;
    taskContext?: string;
    communicationContext?: ContactCommunicationContext | string | null;
}

function cleanFactContent(content: string): string {
    return content
        .replace(/^\[[^\]]+\]\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function devLogSafe(...args: unknown[]): void {
    import('../utils')
        .then(({ devLog }) => devLog(...args))
        .catch(() => {});
}

function normalizeContactLookupValueLocal(s: string): string {
    return toLatin(s)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
        .replace(/^@/, '')
        .replace(/\s+/g, ' ');
}

function contactDisplayNameLocal(contact: Contact): string {
    const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
    return fullName || (contact.username ? `@${contact.username}` : `contact-${contact.id}`);
}

function contactIdentityTagsLocal(contactName: string, contact?: Contact): string[] {
    const display = contact ? contactDisplayNameLocal(contact) : contactName.trim();
    const tags = [
        `contact:${display}`,
        `contact_name:${display}`,
        `contact_alias:${contactName.trim()}`,
    ];
    if (contact) {
        tags.push(`contact_id:${contact.id}`);
        if (contact.username) tags.push(`contact_username:@${String(contact.username).replace(/^@/, '')}`);
    } else {
        tags.push(`contact_key:${normalizeContactLookupValueLocal(display).replace(/\s+/g, '_')}`);
    }
    return [...new Set(tags.filter(Boolean))];
}

function storedContactPrefix(content: string): string | null {
    return content.match(/^\[([^\]]+)\]\s+/)?.[1] ?? null;
}

function isPortraitLike(content: string, tags: string[] | undefined): boolean {
    return content.startsWith('[ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ:') ||
        (tags ?? []).some(tag => String(tag).startsWith('portrait:'));
}

function contactFactMatches(content: string, tags: string[] | undefined, contactName: string, contact?: Contact): boolean {
    if (isPortraitLike(content, tags)) return false;

    const expectedNames = contactIdentityTagsLocal(contactName, contact)
        .filter(tag => tag.startsWith('contact:') || tag.startsWith('contact_name:') || tag.startsWith('contact_alias:'))
        .map(tag => normalizeContactLookupValueLocal(tag.replace(/^contact(_name|_alias)?:/, '')));
    if (contact) expectedNames.push(normalizeContactLookupValueLocal(contactDisplayNameLocal(contact)));

    const expectedIds = new Set(
        contactIdentityTagsLocal(contactName, contact)
            .filter(tag => tag.startsWith('contact_id:'))
            .map(tag => tag.replace('contact_id:', '').trim())
    );
    const expectedUsernames = new Set(
        contactIdentityTagsLocal(contactName, contact)
            .filter(tag => tag.startsWith('contact_username:'))
            .map(tag => normalizeContactLookupValueLocal(tag.replace('contact_username:', '').trim()))
    );

    for (const tag of tags ?? []) {
        const value = String(tag);
        if (value.startsWith('contact_id:') && expectedIds.has(value.replace('contact_id:', '').trim())) {
            return true;
        }
        if (value.startsWith('contact_username:') && expectedUsernames.has(normalizeContactLookupValueLocal(value.replace('contact_username:', '').trim()))) {
            return true;
        }
        if (value.startsWith('contact:') || value.startsWith('contact_name:') || value.startsWith('contact_alias:')) {
            const normalizedTag = normalizeContactLookupValueLocal(value.replace(/^contact(_name|_alias)?:/, ''));
            if (expectedNames.includes(normalizedTag)) return true;
        }
    }

    const prefix = storedContactPrefix(content);
    if (prefix && expectedNames.includes(normalizeContactLookupValueLocal(prefix))) return true;

    return false;
}

function uniqueFacts(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const cleaned = cleanFactContent(value);
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) continue;
        seen.add(key);
        result.push(cleaned);
        if (result.length >= MAX_CONTACT_FACTS) break;
    }
    return result;
}

async function getRelevantContactFacts(
    ctx: BotContext,
    contactName: string,
    contact?: Contact,
    query?: string
): Promise<string[]> {
    const userId = String(ctx.from?.id || '');
    if (!userId) return [];

    const { getVectorService } = await import('../services/VectorServiceFactory');
    const svc = getVectorService();
    if (!svc) return [];

    const displayName = contact ? contactDisplayNameLocal(contact) : contactName.trim();
    const seen = new Map<string, { content: string; tags?: string[]; importance?: number; timestamp?: Date }>();
    const tags = contactIdentityTagsLocal(contactName, contact);

    for (const tag of tags) {
        const matches = await svc.getMemoriesByTag(userId, tag).catch(() => []);
        for (const match of matches) {
            if (!contactFactMatches(match.content, match.tags, contactName, contact)) continue;
            seen.set(match.id, match);
        }
    }

    const queries = [...new Set([query, contactName, displayName].filter(Boolean).map(String))];
    for (const searchQuery of queries) {
        const matches = await svc.searchAllDomains(searchQuery, userId, FACT_SEARCH_LIMIT).catch(() => []);
        for (const match of matches) {
            if (seen.has(match.id)) continue;
            if (!contactFactMatches(match.content, match.tags, contactName, contact)) continue;
            seen.set(match.id, match);
        }
    }

    const ranked = Array.from(seen.values())
        .sort((a, b) => {
            const ai = a.importance ?? 0.5;
            const bi = b.importance ?? 0.5;
            if (bi !== ai) return bi - ai;
            return new Date(b.timestamp ?? 0).getTime() - new Date(a.timestamp ?? 0).getTime();
        })
        .map(item => item.content);

    return uniqueFacts(ranked);
}

export function formatContactCommunicationContext(input: {
    contactName: string;
    portrait?: string | null;
    facts?: string[];
}): ContactCommunicationContext {
    const contactName = input.contactName.trim();
    const portrait = input.portrait?.trim() || undefined;
    const facts = uniqueFacts(input.facts ?? []);

    if (!portrait && facts.length === 0) {
        return { contactName, facts: [], promptBlock: '' };
    }

    const parts = [
        `Адаптация сообщения под собеседника: ${contactName}`,
        portrait ? `Психологический портрет / стиль общения:\n${portrait}` : '',
        facts.length ? `Релевантные факты о собеседнике:\n${facts.map((fact, index) => `${index + 1}. ${fact}`).join('\n')}` : '',
        [
            'Правила использования:',
            '- Используй это только для выбора тона, структуры, понятности и аргументов.',
            '- Не раскрывай, что используешь память, портрет или сохраненные факты.',
            '- Не добавляй новые факты и обещания, которых нет в исходной задаче.',
            '- Не используй чувствительные сведения без прямой необходимости.',
            '- Если факт не нужен для текущей цели, не упоминай его явно.',
        ].join('\n'),
    ].filter(Boolean);

    return {
        contactName,
        portrait,
        facts,
        promptBlock: parts.join('\n\n'),
    };
}

export async function buildContactCommunicationContext(
    ctx: BotContext,
    contactName: string,
    contact?: Contact,
    query?: string
): Promise<ContactCommunicationContext> {
    const displayName = contact ? contactDisplayNameLocal(contact) : contactName.trim();
    const { getContactPortrait } = await import('../services/PsychologicalPortraitService');
    const [portrait, facts] = await Promise.all([
        getContactPortrait(ctx, displayName, contact).catch((error) => {
            devLogSafe('contactCommunicationContext: portrait lookup failed', error);
            return null;
        }),
        getRelevantContactFacts(ctx, displayName, contact, query).catch((error) => {
            devLogSafe('contactCommunicationContext: facts lookup failed', error);
            return [];
        }),
    ]);

    return formatContactCommunicationContext({
        contactName: displayName,
        portrait,
        facts,
    });
}

function promptBlockFromContext(context: ContactCommunicationContext | string | null | undefined): string {
    if (!context) return '';
    return typeof context === 'string' ? context.trim() : context.promptBlock.trim();
}

export async function refineMessageForRecipient(params: RefineMessageForRecipientParams): Promise<string> {
    const draftText = params.draftText.trim();
    const contactContext = promptBlockFromContext(params.communicationContext);
    if (!draftText || !contactContext) return params.draftText;

    const prompt = `
Запрос владельца:
"${params.userRequest}"

Получатель: ${params.recipientName}

${params.taskContext ? `Контекст задачи:\n${params.taskContext}\n` : ''}

Исходный черновик:
"${draftText}"

${contactContext}

Задача: аккуратно отредактируй черновик для этого получателя.

Требования:
- Сохрани смысл, намерение, фактическое содержание и длину примерно как в исходном черновике.
- Сделай формулировку проще и понятнее именно этому человеку.
- Не добавляй новых фактов, сроков, обещаний, условий или решений от имени владельца.
- Не пиши и не намекай, что ты что-то знаешь из памяти, профиля или анализа.
- Верни только готовый текст сообщения получателю, без кавычек и пояснений.
`;

    try {
        const [
            { createChatCompletionForTask },
            { getBotPersona, getCommunicationStyle },
            { config },
        ] = await Promise.all([
            import('../ai/chatCompletion'),
            import('../persona'),
            import('../config'),
        ]);
        const response = await createChatCompletionForTask('conversation', {
            messages: [
                {
                    role: 'system',
                    content: `${getBotPersona()} Стиль: ${getCommunicationStyle()}. Ты редактируешь сообщения от имени ${config.ownerName}, не меняя их смысл. Отвечай только текстом сообщения.`,
                },
                { role: 'user', content: prompt },
            ],
            temperature: 0.4,
        });
        const refined = response.choices[0]?.message?.content?.trim();
        return refined || params.draftText;
    } catch (error) {
        devLogSafe('contactCommunicationContext: refine failed', error);
        return params.draftText;
    }
}
