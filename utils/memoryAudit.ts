import type { MemoryEntry, MemorySubject } from '../types';
import { containsMultipleAssertions } from './atomicAssertion';

export type MemoryAuditCode =
    | 'composite_assertion'
    | 'content_object_mismatch'
    | 'subject_tag_mismatch'
    | 'contact_without_identity_evidence'
    | 'name_only_when_contact_id_exists'
    | 'unsupported_summary_inference'
    | 'fragmentary_assertion'
    | 'negation_mismatch';

export interface MemoryAuditIssue {
    code: MemoryAuditCode;
    memoryId: string;
    severity: 'warning' | 'error';
    message: string;
}

function tagValue(tags: string[] | undefined, prefix: string): string | undefined {
    return tags?.find(tag => tag.startsWith(prefix))?.slice(prefix.length);
}

function normalized(value: string | undefined): string {
    return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function looksComposite(content: string): boolean {
    return containsMultipleAssertions(content);
}

function looksFragmentary(content: string): boolean {
    const clean = content
        .replace(/^\[[^\]]+\]\s*/u, '')
        .replace(/[.!?]+$/u, '')
        .trim();
    if (!clean) return true;
    if (/[:—-]$/u.test(clean)) return true;
    return /^(?:жена|муж|мама|папа|друг|подруга|коллега|контакт|работа|здоровье|операция|семья)$/iu.test(clean);
}

function assertedSubjectFromTags(tags: string[] | undefined): MemorySubject | undefined {
    const value = tagValue(tags, 'subject:');
    return ['user', 'contact', 'third_party', 'unknown', 'bot', 'system'].includes(value || '')
        ? value as MemorySubject
        : undefined;
}

export function auditMemoryEntries(entries: MemoryEntry[]): MemoryAuditIssue[] {
    const issues: MemoryAuditIssue[] = [];
    const namesWithStrongIds = new Set(entries
        .filter(entry => tagValue(entry.tags, 'contact_id:'))
        .flatMap(entry => [tagValue(entry.tags, 'contact_name:'), tagValue(entry.tags, 'contact:')])
        .filter(Boolean)
        .map(value => normalized(value)));

    for (const entry of entries) {
        const id = entry.id;
        if (looksComposite(entry.content)) {
            issues.push({ code: 'composite_assertion', memoryId: id, severity: 'warning', message: 'Одна запись содержит несколько независимых предикатов.' });
        }
        if (looksFragmentary(entry.content)) {
            issues.push({ code: 'fragmentary_assertion', memoryId: id, severity: 'warning', message: 'Запись не содержит самостоятельного проверяемого утверждения.' });
        }
        if (entry.object && entry.predicate && normalized(entry.object) !== normalized(entry.content)) {
            const objectWords = normalized(entry.object).split(' ').filter(Boolean);
            const content = normalized(entry.content);
            if (objectWords.length > 1 && !content.includes(normalized(entry.object))) {
                issues.push({ code: 'content_object_mismatch', memoryId: id, severity: 'error', message: 'object не согласован с каноническим content.' });
            }
        }
        const contentHasNegation = /(?:^|[^\p{L}\p{N}])(?:не|без|никогда|нет|отсутств\p{L}*)(?=$|[^\p{L}\p{N}])/iu.test(entry.content);
        if (typeof entry.negated === 'boolean' && entry.negated !== contentHasNegation) {
            issues.push({ code: 'negation_mismatch', memoryId: id, severity: 'error', message: 'Флаг negated расходится с каноническим content.' });
        }
        const taggedSubject = assertedSubjectFromTags(entry.tags);
        if (taggedSubject && entry.subject && taggedSubject !== entry.subject) {
            issues.push({ code: 'subject_tag_mismatch', memoryId: id, severity: 'error', message: `subject=${entry.subject}, но тег указывает ${taggedSubject}.` });
        }
        if (entry.subject === 'contact' && !tagValue(entry.tags, 'contact_id:') && !tagValue(entry.tags, 'person_id:')) {
            issues.push({ code: 'contact_without_identity_evidence', memoryId: id, severity: 'warning', message: 'Contact-факт не имеет сильного contact_id/person_id.' });
        }
        const contactName = tagValue(entry.tags, 'contact_name:') ?? tagValue(entry.tags, 'contact:');
        if (contactName && !tagValue(entry.tags, 'contact_id:') && namesWithStrongIds.has(normalized(contactName))) {
            issues.push({ code: 'name_only_when_contact_id_exists', memoryId: id, severity: 'warning', message: 'Факт привязан только по имени, хотя для этого имени есть сильный contact_id.' });
        }
        const isSummary = entry.tags?.some(tag => /summary|dialogue-summary/iu.test(tag)) || entry.predicate === 'dialogue_summary';
        if (isSummary && /(?:поэтому|из-за\s+этого|потому\s+что|пережива\w*[,—-]?\s*(?:и|поэтому)|тревож\w*)/iu.test(entry.content)) {
            issues.push({ code: 'unsupported_summary_inference', memoryId: id, severity: 'warning', message: 'Summary содержит возможную неподтверждённую причинность или эмоцию.' });
        }
    }
    return issues;
}

export interface MemoryRepairDryRun {
    backup: MemoryEntry[];
    proposed: Array<{ action: 'split' | 'supersede' | 'retag' | 'rewrite'; memoryId: string; reason: string }>;
}

/** Формирует только отчёт. Функция принципиально ничего не записывает. */
export function buildProductionRepairDryRun(entries: MemoryEntry[]): MemoryRepairDryRun {
    const issues = auditMemoryEntries(entries);
    const byMemory = new Map<string, Set<MemoryAuditCode>>();
    for (const issue of issues) {
        const codes = byMemory.get(issue.memoryId) ?? new Set<MemoryAuditCode>();
        codes.add(issue.code);
        byMemory.set(issue.memoryId, codes);
    }
    const proposed: MemoryRepairDryRun['proposed'] = [];
    for (const [memoryId, codes] of byMemory) {
        if (codes.has('composite_assertion')) {
            proposed.push({ action: 'split', memoryId, reason: 'Разделить независимые предикаты на атомарные утверждения без смысловых добавлений.' });
        }
        if (codes.has('fragmentary_assertion')) {
            proposed.push({ action: 'supersede', memoryId, reason: 'Фрагмент не содержит самостоятельного проверяемого утверждения.' });
        }
        if (codes.has('content_object_mismatch') || codes.has('unsupported_summary_inference') || codes.has('negation_mismatch')) {
            proposed.push({ action: 'rewrite', memoryId, reason: 'Синхронизировать каноническое содержание с object и убрать неподтверждённые выводы.' });
        }
        if (codes.has('subject_tag_mismatch') || codes.has('contact_without_identity_evidence') || codes.has('name_only_when_contact_id_exists')) {
            proposed.push({ action: 'retag', memoryId, reason: 'Повторно доказать субъект и синхронизировать person/contact identity tags.' });
        }
    }
    const affectedIds = new Set(proposed.map(item => item.memoryId));
    return { backup: entries.filter(entry => affectedIds.has(entry.id)), proposed };
}
