import { BotContext } from '../types';
import { MemorySaveMetadata, saveMemory } from '../utils/enhancedDomainMemory';
import { devLog } from '../utils';
import type { ExtractedFactAboutUser } from '../utils/studyChatFlow';
import { saveContactMemoryFactOrAsk } from '../utils/contactMemory';
import { resolveOrCreatePersonIdentity } from '../services/PersonIdentityService';
import { buildPersonRelationTags } from '../utils/personRelation';

const MIN_IMPORTANCE_TO_SAVE = 0.3;
/**
 * Сохранение памяти должно идти последовательно: дедупликация и проверка
 * противоречий зависят от того, что предыдущий факт уже виден в векторной базе.
 */
const SAVE_CONCURRENCY = 1;

export interface MemoryUpdateOptions {
    source?: string;
    sourceContactName?: string;
    sourceContactId?: number;
    sourceContactUsername?: string;
    sourceContext?: string;
    sourceMessageIds?: string[];
    sourceMemoryIds?: string[];
    sourceEpisodeId?: string;
    askOnAmbiguous?: boolean;
}

export interface MemoryUpdateDetailedResult {
    totalCount: number;
    eligibleCount: number;
    savedCount: number;
    savedFacts: ExtractedFactAboutUser[];
    pendingFacts: ExtractedFactAboutUser[];
    skippedFacts: ExtractedFactAboutUser[];
    errors: string[];
}

function isContactScopeTag(tag: string): boolean {
    return tag.startsWith('contact:') ||
        tag.startsWith('contact_name:') ||
        tag.startsWith('contact_alias:') ||
        tag.startsWith('contact_id:') ||
        tag.startsWith('contact_key:');
}

function isPersonRelationSystemTag(tag: string): boolean {
    return tag === 'person_relation' ||
        tag.startsWith('relation_type:') ||
        tag.startsWith('relation_subject:') ||
        tag.startsWith('relation_subject_person_id:') ||
        tag.startsWith('relation_object:') ||
        tag.startsWith('relation_object_person_id:') ||
        tag.startsWith('relation_object_name:') ||
        tag.startsWith('relation_direction:');
}

function buildFactTags(
    fact: ExtractedFactAboutUser,
    subject: 'user' | 'contact',
    options: MemoryUpdateOptions = {}
): string[] {
    const cleaned = (fact.tags ?? [])
        .map(tag => String(tag).trim())
        .filter(Boolean)
        .filter(tag => !tag.startsWith('subject:'))
        .filter(tag => !isContactScopeTag(tag))
        .filter(tag => !isPersonRelationSystemTag(tag));

    const systemTags = [`subject:${subject}`];
    if (options.source) systemTags.push(`source:${options.source}`);
    if (typeof fact.confidence === 'number') {
        if (fact.confidence < 0.55) systemTags.push('weak-evidence');
        if (fact.confidence >= 0.78) systemTags.push('supported');
    }
    if (fact.evidence) systemTags.push('evidence-backed');
    if (fact.inferenceLevel) {
        systemTags.push(`inference:${fact.inferenceLevel}`);
        if (fact.inferenceLevel === 'inferred' || fact.inferenceLevel === 'ambiguous') {
            systemTags.push('needs-caution');
        }
    }
    if (fact.temporalScope) systemTags.push(`temporal_scope:${fact.temporalScope}`);
    if (fact.status && fact.status !== 'active') systemTags.push(`status:${fact.status}`);
    if (options.sourceContactName) {
        systemTags.push(`source_contact:${options.sourceContactName}`);
    }
    if (subject === 'contact' && options.sourceContactName) {
        systemTags.push(`contact:${options.sourceContactName}`);
        systemTags.push(`contact_name:${options.sourceContactName}`);
    }
    if (subject === 'contact' && options.sourceContactId) {
        systemTags.push(`contact_id:${options.sourceContactId}`);
        systemTags.push(`contact_key:${options.sourceContactId}`);
    }
    if (subject === 'contact' && options.sourceContactUsername) {
        systemTags.push(`contact_username:${options.sourceContactUsername}`);
        systemTags.push(`contact_alias:@${options.sourceContactUsername}`);
    }

    return [...new Set([...cleaned, ...systemTags])];
}

function directContactMemoryContent(contactName: string, content: string): string {
    const clean = content.trim().replace(/^\[[^\]]+\]\s*/, '');
    return `[${contactName.trim() || 'Собеседник'}] ${clean}`;
}

function extractionMethodFromSource(source?: string): MemorySaveMetadata['extractionMethod'] {
    switch (source) {
        case 'reflection':
            return 'reflection';
        case 'personal_chat_background':
        case 'study_chat':
            return 'study_chat';
        default:
            return 'study_chat';
    }
}

function sourceContextForFact(options: MemoryUpdateOptions, fact: ExtractedFactAboutUser): string | undefined {
    const evidence = fact.evidence?.replace(/\s+/g, ' ').trim();
    const temporal = [
        fact.inferenceLevel ? `inference=${fact.inferenceLevel}` : undefined,
        fact.temporalScope ? `scope=${fact.temporalScope}` : undefined,
        fact.status ? `status=${fact.status}` : undefined,
        fact.validFrom ? `validFrom=${fact.validFrom.toISOString()}` : undefined,
        fact.validTo ? `validTo=${fact.validTo.toISOString()}` : undefined,
    ].filter(Boolean).join(', ');
    return [
        options.sourceContext,
        evidence ? `Опора извлечения: ${evidence}` : undefined,
        temporal ? `Временная привязка: ${temporal}` : undefined,
        fact.qualityWarnings?.length ? `Quality warnings: ${fact.qualityWarnings.slice(0, 4).join('; ')}` : undefined,
    ].filter(Boolean).join('\n') || undefined;
}

async function resolveSourceContactIdentity(
    ctx: BotContext,
    options: MemoryUpdateOptions,
): Promise<{ id: string } | undefined> {
    if (!options.sourceContactName) return undefined;
    const nameParts = options.sourceContactName.trim().split(/\s+/u);
    const contact = options.sourceContactId != null
        ? {
            id: options.sourceContactId,
            firstName: nameParts[0] || options.sourceContactName,
            lastName: nameParts.slice(1).join(' ') || undefined,
            username: options.sourceContactUsername,
        }
        : undefined;
    return resolveOrCreatePersonIdentity(
        String(ctx.from?.id ?? ''),
        options.sourceContactName,
        contact,
    ).catch(() => undefined);
}

async function relationTagsForFact(
    ctx: BotContext,
    fact: ExtractedFactAboutUser,
    sourceContactIdentity: { id: string } | undefined,
    sourceContactName?: string,
): Promise<string[]> {
    const relation = fact.personRelation;
    if (!relation) return [];

    let targetPersonId: string | undefined;
    let targetName: string | undefined;
    if (relation.targetRole === 'contact') {
        targetPersonId = sourceContactIdentity?.id;
        targetName = sourceContactName;
    } else if (relation.targetRole === 'third_party' && relation.targetName) {
        targetName = relation.targetName;
        const identity = await resolveOrCreatePersonIdentity(
            String(ctx.from?.id ?? ''),
            relation.targetName,
        ).catch(() => undefined);
        targetPersonId = identity?.id;
    }

    return buildPersonRelationTags(relation, {
        subject: fact.subject,
        subjectPersonId: fact.subject === 'contact' ? sourceContactIdentity?.id : undefined,
        targetPersonId,
        targetName,
    });
}

/**
 * Агент 3: сохраняет переданные факты в долговременную память (векторная БД).
 *
 * Факты о пользователе (subject='user') сохраняются с явным тегом subject:user.
 * Факты о собеседнике (subject='contact') сохраняются с префиксом "[Имя] ..."
 * и тегами subject:contact/contact:<имя>, чтобы при поиске было понятно, о ком речь.
 *
 * Сохранение идёт последовательно, чтобы не создавать дубли гонкой vector search/upsert.
 */
export async function runUpdateLongTermMemoryAgent(
    ctx: BotContext,
    facts: ExtractedFactAboutUser[],
    options: MemoryUpdateOptions = {}
): Promise<number> {
    const result = await runUpdateLongTermMemoryAgentDetailed(ctx, facts, options);
    return result.savedCount;
}

export async function runUpdateLongTermMemoryAgentDetailed(
    ctx: BotContext,
    facts: ExtractedFactAboutUser[],
    options: MemoryUpdateOptions = {}
): Promise<MemoryUpdateDetailedResult> {
    const eligible = facts.filter(f => f.importance >= MIN_IMPORTANCE_TO_SAVE);

    const savedFacts: ExtractedFactAboutUser[] = [];
    const pendingFacts: ExtractedFactAboutUser[] = [];
    const skippedFacts: ExtractedFactAboutUser[] = facts.filter(f => f.importance < MIN_IMPORTANCE_TO_SAVE);
    const errors: string[] = [];

    // Обрабатываем пачками
    for (let i = 0; i < eligible.length; i += SAVE_CONCURRENCY) {
        const batch = eligible.slice(i, i + SAVE_CONCURRENCY);

        const results = await Promise.allSettled(
            batch.map(async (fact) => {
                const isContactFact = fact.subject === 'contact';
                const contactName = fact.contactName ?? 'Собеседник';
                const expectedSubject: 'contact' | 'user' = isContactFact ? 'contact' : 'user';
                const needsSourceContactIdentity = isContactFact || fact.personRelation?.targetRole === 'contact';
                const sourceContactIdentity = needsSourceContactIdentity
                    ? await resolveSourceContactIdentity(ctx, options)
                    : undefined;
                const relationTags = await relationTagsForFact(
                    ctx,
                    fact,
                    sourceContactIdentity,
                    options.sourceContactName,
                );
                const tags = [...new Set([
                    ...buildFactTags(fact, expectedSubject, options),
                    ...(isContactFact && sourceContactIdentity ? [`person_id:${sourceContactIdentity.id}`] : []),
                    ...relationTags,
                ])];
                const memoryMetadata: MemorySaveMetadata = {
                    extractionMethod: extractionMethodFromSource(options.source),
                    subject: expectedSubject,
                    sourceContext: sourceContextForFact(options, fact),
                    sourceMessageIds: options.sourceMessageIds,
                    sourceMemoryIds: options.sourceMemoryIds,
                    sourceEpisodeId: options.sourceEpisodeId,
                    confidence: fact.confidence,
                    validFrom: fact.validFrom,
                    validTo: fact.validTo,
                    status: fact.status,
                    predicate: fact.predicate ?? fact.domain,
                    object: fact.object ?? fact.content,
                    memoryKind: fact.personRelation ? 'relationship' : undefined,
                };

                if (isContactFact) {
                    if ((options.askOnAmbiguous ?? true) === false && options.sourceContactId && options.sourceContactName) {
                        const memoryContent = directContactMemoryContent(options.sourceContactName, fact.content);
                        const directTags = tags;
                        const saved = await saveMemory(ctx, fact.domain, memoryContent, fact.importance, directTags, false, {
                            ...memoryMetadata,
                            subject: 'contact',
                            sourceContext: memoryMetadata.sourceContext ?? fact.content,
                        });
                        if (!saved) return { status: 'skipped' as const, fact };
                        devLog(`UpdateLongTermMemoryAgent: saved [contact:direct]`, memoryContent.slice(0, 60));
                        return { status: 'saved' as const, fact: { ...fact, content: memoryContent, tags: directTags } };
                    }

                    const result = await saveContactMemoryFactOrAsk(ctx, {
                        contactName,
                        content: fact.content,
                        domain: fact.domain,
                        importance: fact.importance,
                        tags,
                        memoryMetadata,
                    }, {
                        askOnAmbiguous: options.askOnAmbiguous ?? true,
                        resolvedContactId: options.sourceContactId,
                    });
                    if (result.status === 'pending') return { status: 'pending' as const, fact };
                    if (result.status !== 'saved') return { status: 'skipped' as const, fact };
                    devLog(`UpdateLongTermMemoryAgent: saved [contact]`, result.content?.slice(0, 60));
                    return { status: 'saved' as const, fact: { ...fact, tags } };
                }

                const saved = await saveMemory(ctx, fact.domain, fact.content, fact.importance, tags, false, memoryMetadata);
                if (!saved) return { status: 'skipped' as const, fact };
                devLog(`UpdateLongTermMemoryAgent: saved [${fact.subject}]`, fact.content.slice(0, 60));
                return { status: 'saved' as const, fact: { ...fact, tags } };
            })
        );

        for (const r of results) {
            if (r.status === 'fulfilled') {
                if (r.value.status === 'saved') savedFacts.push(r.value.fact);
                else if (r.value.status === 'pending') pendingFacts.push(r.value.fact);
                else skippedFacts.push(r.value.fact);
            } else {
                const reason = r.reason?.message || String(r.reason);
                errors.push(reason);
                console.error('UpdateLongTermMemoryAgent: save fact error', r.reason);
            }
        }
    }

    devLog('UpdateLongTermMemoryAgent: total saved', savedFacts.length, 'of', eligible.length);
    return {
        totalCount: facts.length,
        eligibleCount: eligible.length,
        savedCount: savedFacts.length,
        savedFacts,
        pendingFacts,
        skippedFacts,
        errors,
    };
}
