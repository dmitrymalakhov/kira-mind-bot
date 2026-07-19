const INDEPENDENT_VERB_RE = /(?:^|[\s,;—-])(?:работает|дружит|познаком[а-яё]*|женат|замужем|является|любит|жив[её]т|смотрит|планирует|учится|занимается|принимает|болеет)(?=$|[\s,;.!?—-])/giu;
const NOMINAL_PREDICATE_RE = /(?:^|[;,.]|\s+[—-]\s+|\s+(?:и|а\s+также)\s+)(?:близк[а-яё]*\s+)?(?:друг|подруга|жена|муж|коллега|родственник|знакомый|знакомая)(?=$|[\s,;.!?—-])/giu;
const EXPLICIT_COMPOSITE_RE = /[;•]|(?:^|[^\p{L}\p{N}])(?:а\s+также|и\s+(?:ещ[её]|потом|при\s+этом)|но\s+также|кроме\s+того)(?=$|[^\p{L}\p{N}])/iu;
const CLAUSE_VERB_RE = /(?:^|\s)(?:работает|дружит|познаком[а-яё]*|женат|замужем|является|любит|жив[её]т|смотрит|планирует|учится|занимается|принимает|болеет|вед[её]т|воспитывает|руководит|помогает|общается|сотрудничает|встречается|использует|созда[её]т)(?=$|[\s,.!?—-])/iu;
const NOMINAL_CLAUSE_RE = /(?:^|\s+[—-]\s+)(?:близк[а-яё]*\s+)?(?:друг|подруга|жена|муж|коллега|родственник|знакомый|знакомая)(?=$|[\s,.!?—-])/iu;

/** Консервативно выявляет legacy-строки, содержащие более одного утверждения. */
export function containsMultipleAssertions(content: string): boolean {
    if (EXPLICIT_COMPOSITE_RE.test(content)) return true;
    const verbCount = (content.match(INDEPENDENT_VERB_RE) ?? []).length;
    const nominalCount = (content.match(NOMINAL_PREDICATE_RE) ?? []).length;
    if (verbCount > 1 || nominalCount > 1 || (verbCount > 0 && nominalCount > 0)) return true;

    const predicateClauses = content
        .split(/[,\n]/u)
        .map(clause => clause.trim())
        .filter(Boolean)
        .filter(clause => CLAUSE_VERB_RE.test(clause) || NOMINAL_CLAUSE_RE.test(clause));
    return predicateClauses.length > 1;
}
