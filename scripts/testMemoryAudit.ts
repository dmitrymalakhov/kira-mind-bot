import assert from 'node:assert/strict';
import type { MemoryEntry } from '../types';
import { auditMemoryEntries, buildProductionRepairDryRun } from '../utils/memoryAudit';

const now = new Date();
const entries: MemoryEntry[] = [
    {
        id: 'synthetic-composite',
        content: 'Тестовый Контакт Альфа дружит с пользователем, работает с ним, а также познакомился через общего знакомого',
        domain: 'social', botId: 'kira', userId: '1', timestamp: now, importance: 0.8,
        subject: 'contact', predicate: 'relationship', object: 'старое значение',
        tags: ['subject:user', 'contact_name:Тестовый Контакт Альфа'],
    },
    {
        id: 'synthetic-strong',
        content: '[Тестовый Контакт Альфа] Контакт работает вместе с пользователем',
        domain: 'work', botId: 'kira', userId: '1', timestamp: now, importance: 0.8,
        subject: 'contact', predicate: 'works_with', object: 'пользователь',
        tags: ['subject:contact', 'contact_name:Тестовый Контакт Альфа', 'contact_id:900000001', 'person_id:synthetic-uuid'],
    },
    {
        id: 'synthetic-composite-nominal',
        content: 'Тестовый Контакт Бета — близкий друг пользователя, работает вместе с ним',
        domain: 'social', botId: 'kira', userId: '1', timestamp: now, importance: 0.7,
        subject: 'contact', predicate: 'relationship', object: 'друг пользователя',
        tags: ['subject:contact', 'contact_name:Тестовый Контакт Бета', 'person_id:synthetic-uuid-beta'],
    },
    {
        id: 'operation',
        content: 'Контакту Альфа назначили медицинскую процедуру',
        domain: 'health', botId: 'kira', userId: '1', timestamp: now, importance: 0.9,
        subject: 'contact', predicate: 'operation', object: 'операция',
        tags: ['subject:contact', 'contact_name:Тестовый Контакт Альфа'],
    },
    {
        id: 'valid-short-negative',
        content: 'Не курит',
        domain: 'health', botId: 'kira', userId: '1', timestamp: now, importance: 0.6,
        subject: 'user', predicate: 'smokes', object: 'нет',
        tags: ['subject:user'],
    },
    {
        id: 'valid-short-preference',
        content: 'Любит футбол',
        domain: 'interests', botId: 'kira', userId: '1', timestamp: now, importance: 0.6,
        subject: 'user', predicate: 'likes', object: 'футбол',
        tags: ['subject:user'],
    },
    {
        id: 'synthetic-negation-mismatch',
        content: 'Не использует тестовый сервис',
        domain: 'general', botId: 'kira', userId: '1', timestamp: now, importance: 0.6,
        subject: 'user', predicate: 'uses', object: 'тестовый сервис', negated: false,
        tags: ['subject:user'],
    },
    {
        id: 'synthetic-fragment',
        content: 'Жена',
        domain: 'social', botId: 'kira', userId: '1', timestamp: now, importance: 0.5,
        subject: 'user', predicate: 'relationship', object: 'Жена',
        tags: ['subject:user'],
    },
    {
        id: 'synthetic-unsupported-summary',
        content: 'Пользователь переживает, поэтому отменил синтетическую встречу',
        domain: 'general', botId: 'kira', userId: '1', timestamp: now, importance: 0.5,
        subject: 'user', predicate: 'dialogue_summary', object: 'отменил синтетическую встречу',
        tags: ['subject:user', 'summary'],
    },
];

const issues = auditMemoryEntries(entries);
assert(issues.some(issue => issue.code === 'composite_assertion' && issue.memoryId === 'synthetic-composite'));
assert(issues.some(issue => issue.code === 'composite_assertion' && issue.memoryId === 'synthetic-composite-nominal'));
assert(issues.some(issue => issue.code === 'subject_tag_mismatch'));
assert(issues.some(issue => issue.code === 'name_only_when_contact_id_exists'));
assert(issues.some(issue => issue.code === 'contact_without_identity_evidence'));
assert(issues.some(issue => issue.code === 'fragmentary_assertion' && issue.memoryId === 'synthetic-fragment'));
assert(!issues.some(issue => issue.code === 'fragmentary_assertion' && issue.memoryId === 'valid-short-negative'));
assert(!issues.some(issue => issue.code === 'fragmentary_assertion' && issue.memoryId === 'valid-short-preference'));
assert(issues.some(issue => issue.code === 'negation_mismatch' && issue.memoryId === 'synthetic-negation-mismatch'));
assert(issues.some(issue =>
    issue.code === 'content_object_mismatch' &&
    issue.memoryId === 'synthetic-composite' &&
    issue.severity === 'error'
));
assert(issues.some(issue =>
    issue.code === 'unsupported_summary_inference' && issue.memoryId === 'synthetic-unsupported-summary'
));

const dryRun = buildProductionRepairDryRun(entries);
assert(dryRun.backup.length > 0);
assert(dryRun.proposed.some(item => item.action === 'split'));
assert(dryRun.proposed.some(item => item.memoryId === 'operation' && item.action === 'retag'));
assert(dryRun.proposed.some(item => item.memoryId === 'synthetic-fragment' && item.action === 'supersede'));
assert(!dryRun.proposed.some(item => item.memoryId === 'valid-short-negative' && item.action === 'supersede'));

console.log('memory audit checks passed');
