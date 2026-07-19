const PROACTIVE_SOURCE_QUESTION_RE = /(?:откуда\s+ты\s+(?:это\s+)?(?:взял[ао]?|знаешь)|на\s+основе\s+чего\s+ты\s+(?:это\s+)?(?:написал[ао]?|сказал[ао]?|решил[ао]?)|из\s+какой\s+(?:памяти|записи|подсказки)|какой\s+(?:именно\s+)?факт\s+ты\s+использовал[ао]?|о\s+ком\s+(?:была|эта)\s+подсказка|что\s+ты\s+имел[ао]?\s+в\s+виду\s+в\s+(?:этой\s+)?подсказке)/iu;

export function isProactiveSourceQuestion(message: string): boolean {
    return PROACTIVE_SOURCE_QUESTION_RE.test(message);
}
