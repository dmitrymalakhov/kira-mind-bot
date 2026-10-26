import { AppDataSource } from '../data-source';
import { In } from 'typeorm';
import { PersonIdentityEntity } from '../entity/PersonIdentityEntity';
import type { Contact } from '../stores/ContactsStore';
import { config } from '../config';

/** Read-only lookup; an old edge cannot authorize reading a different owner's identity. */
export async function readPersonIdentities(ownerUserId: string, ids: string[]): Promise<PersonIdentityEntity[]> {
    const valid = [...new Set(ids)].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).slice(0, 24);
    if (!AppDataSource.isInitialized || !valid.length) return [];
    return AppDataSource.getRepository(PersonIdentityEntity).find({ where: {
        id: In(valid), profile: config.botUsername.toLowerCase(), ownerUserId,
    } });
}

/** Candidate lookup only; no aliases, mention times or identities are written. */
export async function findPersonIdentitiesForRecall(ownerUserId: string, name: string, contactId?: string): Promise<PersonIdentityEntity[]> {
    if (!AppDataSource.isInitialized || name.length > 120) return [];
    const query = AppDataSource.getRepository(PersonIdentityEntity).createQueryBuilder('person')
        .where('person.profile = :profile AND person.ownerUserId = :ownerUserId', { profile: config.botUsername.toLowerCase(), ownerUserId });
    if (contactId) return query.andWhere('person.telegramContactId = :contactId', { contactId }).take(12).getMany();
    const exact = await query.clone().andWhere(`(lower(person.displayName) = lower(:name) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(person.aliases) alias(value) WHERE lower(alias.value) = lower(:name)
    ))`, { name }).take(12).getMany();
    if (exact.length) return exact;
    const words = name.replace(/^@/, '').split(/\s+/).filter(Boolean);
    if (words.length < 2) return [];
    // Fuzzy full-name candidates remain candidates; the caller checks all parts
    // with the shared contact matcher and rejects ambiguity.
    for (const [index, word] of words.slice(0, 3).entries()) {
        const prefix = word.toLocaleLowerCase('ru-RU').replace(/[^\p{L}]/gu, '').slice(0, Math.max(3, word.length - 3));
        if (prefix.length < 3) return [];
        query.andWhere(`lower(person.displayName) LIKE :part${index}`, { [`part${index}`]: `%${prefix}%` });
    }
    return query.take(12).getMany();
}

/** Full stored names in bounded dialogue context are search cues, never new facts. */
export async function findMentionedPeopleForRecall(ownerUserId: string, text: string): Promise<PersonIdentityEntity[]> {
    if (!AppDataSource.isInitialized || !text.trim()) return [];
    const context = ` ${text.slice(0, 1000).normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[^\p{L}\p{N}@_-]+/gu, ' ').trim()} `;
    return AppDataSource.getRepository(PersonIdentityEntity).createQueryBuilder('person')
        .where('person.profile = :profile AND person.ownerUserId = :ownerUserId', { profile: config.botUsername.toLowerCase(), ownerUserId })
        .andWhere(`((position(' ' || lower(person.displayName) || ' ' in :context) > 0 AND person.displayName LIKE '% %') OR EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(person.aliases) alias(value)
            WHERE position(' ' || lower(alias.value) || ' ' in :context) > 0 AND (alias.value LIKE '% %' OR alias.value LIKE '@%')
        ))`, { context }).take(12).getMany();
}

function aliasesFor(name: string, contact?: Contact): string[] {
    const normalizedUsername = normalizeTelegramUsername(contact?.username);
    return [...new Set([
        name.trim(),
        contact?.firstName?.trim(),
        [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim(),
        normalizedUsername ? `@${normalizedUsername}` : '',
    ].filter((value): value is string => Boolean(value)))];
}

function normalizeTelegramUsername(username: string | undefined): string | undefined {
    const normalized = String(username ?? '').trim().replace(/^@/, '').toLowerCase();
    return normalized || undefined;
}

export function selectExactIdentityCandidate(
    candidates: PersonIdentityEntity[],
    hasContact: boolean,
): PersonIdentityEntity | undefined {
    if (candidates.length !== 1) return undefined;
    const candidate = candidates[0];
    if (!hasContact) return candidate;
    return candidate.status === 'provisional' &&
        !candidate.telegramContactId &&
        !candidate.detachedFromContacts
        ? candidate
        : undefined;
}

export function selectUsernameIdentityCandidate(
    candidates: PersonIdentityEntity[],
    contactId: string | undefined,
): PersonIdentityEntity | undefined {
    return candidates
        .filter(candidate => !candidate.telegramContactId || candidate.telegramContactId === contactId)
        .sort((left, right) =>
            (right.lastMentionedAt?.getTime() ?? 0) - (left.lastMentionedAt?.getTime() ?? 0)
        )[0];
}

export interface ResolvePersonIdentityOptions {
    /** Создаёт отдельную provisional-личность без alias lookup и автослияния с контактами. */
    forceDetachedNew?: boolean;
}

function identityLockKeys(profile: string, ownerUserId: string, name: string, contact?: Contact): string[] {
    const normalizedUsername = normalizeTelegramUsername(contact?.username);
    return [...new Set([
        ...aliasesFor(name, contact).map(alias =>
            `person:${profile}:${ownerUserId}:alias:${alias.trim().toLocaleLowerCase('ru-RU')}`
        ),
        contact ? `person:${profile}:${ownerUserId}:contact:${contact.id}` : '',
        normalizedUsername ? `person:${profile}:${ownerUserId}:username:${normalizedUsername}` : '',
    ].filter(Boolean))].sort();
}

/** Stable internal identity. Names are aliases, never the primary key. */
export async function resolveOrCreatePersonIdentity(
    ownerUserId: string,
    name: string,
    contact?: Contact,
    options: ResolvePersonIdentityOptions = {},
): Promise<PersonIdentityEntity | undefined> {
    if (!AppDataSource.isInitialized) return undefined;
    const profile = config.botUsername.toLowerCase();
    return AppDataSource.transaction(async manager => {
        const repo = manager.getRepository(PersonIdentityEntity);

        // Atomic facts are persisted concurrently. Transaction-scoped advisory locks
        // serialize both provisional alias creation and promotion to a strong contact ID.
        if (!options.forceDetachedNew) {
            for (const lockKey of identityLockKeys(profile, ownerUserId, name, contact)) {
                await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
            }
        }

        let identity: PersonIdentityEntity | null = null;
        const normalizedUsername = normalizeTelegramUsername(contact?.username);
        if (contact && !options.forceDetachedNew) {
            identity = await repo.findOne({
                where: { profile, ownerUserId, telegramContactId: String(contact.id) },
            });
        }

        if (normalizedUsername && !options.forceDetachedNew) {
            const usernameIdentities = await repo.createQueryBuilder('person')
                .where('person.profile = :profile', { profile })
                .andWhere('person.ownerUserId = :ownerUserId', { ownerUserId })
                .andWhere('lower(person.telegramUsername) = :username', { username: normalizedUsername })
                .getMany();
            const usernameIdentity = selectUsernameIdentityCandidate(usernameIdentities, String(contact?.id));
            if (!identity && usernameIdentity) {
                identity = usernameIdentity;
            }

            // Telegram username может быть передан другому аккаунту; contact ID сильнее.
            // При дублях сохраняем наиболее актуальную допустимую identity, остальные очищаем.
            const staleUsernameIdentities = usernameIdentities.filter(candidate => candidate.id !== identity?.id);
            for (const staleIdentity of staleUsernameIdentities) {
                staleIdentity.telegramUsername = null;
            }
            if (staleUsernameIdentities.length > 0) await repo.save(staleUsernameIdentities);
        }

        // Точное уникальное совпадение alias безопасно переиспользует provisional
        // UUID и позволяет позже повысить его до resolved. Fuzzy-match здесь нет.
        if (!identity && !options.forceDetachedNew) {
            const candidates = await repo.createQueryBuilder('person')
                .where('person.profile = :profile', { profile })
                .andWhere('person.ownerUserId = :ownerUserId', { ownerUserId })
                .andWhere(
                    `EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements_text(person.aliases) AS alias(value)
                        WHERE lower(alias.value) = lower(:alias)
                    )`,
                    { alias: name.trim() },
                )
                .getMany();
            identity = selectExactIdentityCandidate(candidates, Boolean(contact)) ?? null;
            if (!contact && candidates.length > 1) {
                return undefined;
            }
        }

        const aliases = aliasesFor(name, contact);
        if (!identity) {
            identity = repo.create({
                profile,
                ownerUserId,
                displayName: contact
                    ? [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim()
                    : name.trim(),
                aliases,
                status: contact ? 'resolved' : 'provisional',
                telegramContactId: contact ? String(contact.id) : undefined,
                detachedFromContacts: options.forceDetachedNew,
                telegramUsername: normalizedUsername,
                lastMentionedAt: new Date(),
            });
        } else {
            identity.aliases = [...new Set([...(identity.aliases ?? []), ...aliases])];
            identity.lastMentionedAt = new Date();
            if (contact) {
                identity.displayName = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
                identity.status = 'resolved';
                identity.telegramContactId = String(contact.id);
                identity.telegramUsername = normalizedUsername ?? null;
            }
        }
        return repo.save(identity);
    });
}
