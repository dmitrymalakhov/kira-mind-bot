import assert from 'node:assert/strict';
import {
    arePersonRelationTagScopesCompatible,
    buildPersonRelationTags,
    normalizePersonRelationDescriptor,
} from '../utils/personRelation';

const namedRelation = normalizePersonRelationDescriptor({
    type: 'friend_of',
    targetRole: 'third_party',
    targetName: 'Марина Орлова',
}, {
    subject: 'contact',
    contactName: 'Алиса',
    ownerName: 'Владелец',
    evidence: '[01.08.2026] Алиса: Марина Орлова — моя давняя подруга.',
});

assert.deepEqual(namedRelation, {
    type: 'friend_of',
    targetRole: 'third_party',
    targetName: 'Марина Орлова',
});

assert.equal(normalizePersonRelationDescriptor({
    type: 'friend_of',
    targetRole: 'third_party',
    targetName: 'Другой человек',
}, {
    subject: 'contact',
    evidence: '[01.08.2026] Алиса: Марина Орлова — моя давняя подруга.',
}), undefined, 'имя второго человека нельзя придумывать вне evidence');

assert.equal(normalizePersonRelationDescriptor({
    type: 'friend_of',
    targetRole: 'contact',
}, {
    subject: 'user',
    contactName: 'Алиса',
    evidence: '[01.08.2026] Владелец: Алиса предпочитает чай.',
}), undefined, 'обычное совместное упоминание не должно становиться отношением');

assert.equal(normalizePersonRelationDescriptor({
    type: 'friend_of',
    targetRole: 'contact',
}, {
    subject: 'contact',
    evidence: '[01.08.2026] Алиса: Я давно дружу с владельцем.',
}), undefined, 'self-loop между контактом и тем же контактом запрещён');

const ownerRelation = normalizePersonRelationDescriptor({
    type: 'coworker_of',
    targetRole: 'contact',
}, {
    subject: 'user',
    contactName: 'Алиса',
    evidence: '[01.08.2026] Алиса: Ты мой коллега.',
});
assert.ok(ownerRelation);

assert.deepEqual(buildPersonRelationTags(ownerRelation!, {
    subject: 'user',
    targetPersonId: 'person-alice',
    targetName: 'Алиса',
}), [
    'person_relation',
    'relation_type:coworker_of',
    'relation_subject:user',
    'relation_object_person_id:person-alice',
    'relation_object_name:Алиса',
    'relation_direction:symmetric',
]);

assert.deepEqual(buildPersonRelationTags(namedRelation!, {
    subject: 'contact',
    subjectPersonId: 'person-alice',
}), [], 'связь без разрешённого второго person_id не должна попадать в граф');

assert.equal(arePersonRelationTagScopesCompatible([
    'person_relation',
    'relation_type:friend_of',
    'relation_subject_person_id:person-alice',
    'relation_object_person_id:person-marina',
], [
    'person_relation',
    'relation_type:friend_of',
    'relation_subject_person_id:person-alice',
    'relation_object_person_id:person-marina',
]), true);
assert.equal(arePersonRelationTagScopesCompatible([
    'person_relation',
    'relation_type:friend_of',
    'relation_subject_person_id:person-alice',
    'relation_object_person_id:person-marina',
], [
    'person_relation',
    'relation_type:friend_of',
    'relation_subject_person_id:person-alice',
    'relation_object_person_id:person-olga',
]), false, 'vector dedup не должен смешивать одинаковые связи с разными людьми');

console.log('Person relation tests passed');
