import type { PersonRelationType } from './personRelation';

/** Linguistic reference only; it grants no evidence or authorization for actions. */
export function hasOwnerSelfReference(text: string): boolean {
    return /(?<![\p{L}\p{N}])(?:я|меня|мне|мной|мною|мой|моя|мо[её]|мои|моего|моей|моих|моим|моими|моему|мою|мо[её]м|i|me|my|mine|myself)(?![\p{L}\p{N}])/iu.test(text);
}

const ROLE_GROUPS: Array<{ pattern: RegExp; type: PersonRelationType; role: string }> = [
    { pattern: /^(?:жена|жену|жены|жене|женой|супруга|супругу|супруги|супруге|супругой)$/u, type: 'spouse_of', role: 'жена' },
    { pattern: /^(?:муж|мужа|мужу|мужем|муже|супруг|супруга|супругу|супругом|супруге)$/u, type: 'spouse_of', role: 'муж' },
    { pattern: /^(?:партнер|партнера|партнеру|партнерша|партнершу|партнерши)$/u, type: 'partner_of', role: 'партнёр' },
    { pattern: /^(?:брат|брата|брату|брате|братом|сестра|сестру|сестры|сестре|сестрой)$/u, type: 'sibling_of', role: 'брат или сестра' },
    { pattern: /^(?:друг|друга|другу|друге|другом|подруга|подругу|подруги|подруге|подругой)$/u, type: 'friend_of', role: 'друг' },
    { pattern: /^(?:коллега|коллегу|коллеги|коллеге|коллегой)$/u, type: 'coworker_of', role: 'коллега' },
];

export interface OwnerRelationshipIntent { type: PersonRelationType; role: string; word: string }

/** A role becomes an identity scope only through an explicit owner reference. */
export function ownerRelationshipIntent(message: string): OwnerRelationshipIntent | null {
    const text = message.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
    if (/(?:жена|жену|жены|муж|мужа|супруга|супруги)\s+(?:моего|моей|его|ее|их)(?![\p{L}])/u.test(text)) return null;
    const matches = [...text.matchAll(/(?<![\p{L}])мо(?:я|й|ю|ей|его|ему|им|их|ими)\s+([\p{L}]+)(?![\p{L}])/gu)];
    const roles = matches.flatMap(match => {
        const group = ROLE_GROUPS.find(item => item.pattern.test(match[1]));
        return group ? [{ type: group.type, role: group.role, word: match[1] }] : [];
    });
    return roles.length === 1 ? roles[0] : null;
}

export function isOwnerEmploymentRecall(message: string): boolean {
    return /(?:где|кем|на\s+кого|в\s+какой\s+(?:компании|организации))\s+(?:сейчас\s+)?я\s+работаю|мо(?:е|ё)\s+место\s+работы|мо(?:й|его)\s+работодатель/iu.test(message);
}

export function isFocusedPersonalRecall(message: string): boolean {
    if (message.length > 180 || /[;\n]|\sи\s|(?:напомни|напиши|отправь|сохрани|удали|сравни|почему|представь|допустим|переведи|цитат|как\s+(?:мне|лучше))/iu.test(message)) return false;
    return isOwnerEmploymentRecall(message) || Boolean(ownerRelationshipIntent(message) && /(?<![\p{L}])(?:кто|как\s+зовут|имя)(?![\p{L}])/iu.test(message));
}

export function personalRecallQueries(message: string): string[] {
    const relation = ownerRelationshipIntent(message);
    if (relation) return relation.type === 'spouse_of' ? ['моя жена супруг супруга', 'жена', 'супруга', 'муж'] : [relation.word, relation.role];
    return isOwnerEmploymentRecall(message) ? ['работаю', 'работает', 'работодатель место работы', 'компания должность'] : [];
}
