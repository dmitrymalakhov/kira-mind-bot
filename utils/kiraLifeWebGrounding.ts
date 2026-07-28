export interface KiraLifeWebGroundingQueryInput {
  characterName: string;
  currentDateTime: string;
  timezone: string;
  biography: string;
  personalitySnapshot: string;
  recentTopics: string;
}

export interface KiraLifeWebGrounding {
  summary: string;
  sources: string[];
  researchedAt: string;
}

const NO_GROUNDING_RE = /(?:^|\n)\s*(?:NO_GROUNDING|НЕТ_ОПОРЫ)\b/iu;
const URL_RE = /https?:\/\/[^\s<>{}\[\]()"']+/giu;
const MAX_QUERY_CONTEXT_CHARS = 7_000;
const MAX_GROUNDING_SUMMARY_CHARS = 10_000;
const MAX_GROUNDING_SOURCES = 6;
const WEB_RELEVANT_SELF_CONTEXT_PREFIXES = [
  "Самовосприятие:",
  "Образ себя:",
  "Происхождение:",
  "Жизнь до владельца:",
  "Среда до владельца:",
  "Учёба:",
  "Работа до владельца:",
  "Формирующий опыт:",
  "Устойчивые факты биографии:",
  "Жизненная цель:",
  "Внутренний фокус:",
  "Желания:",
  "Ценности:",
  "Предпочтения:",
  "Привычки:",
  "Долгие линии жизни:",
  "Желания роста:",
];

function compactContext(value: string, maxChars = MAX_QUERY_CONTEXT_CHARS): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function normalizeSourceUrl(rawUrl: string): string | undefined {
  const withoutTrailingPunctuation = rawUrl.replace(/[.,;:!?]+$/gu, "");
  try {
    const url = new URL(withoutTrailingPunctuation);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|gclid|fbclid|yclid)$/iu.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Не отправляет в поисковый запрос отношение к владельцу и следы личных разговоров. */
export function selectKiraLifeWebProfileContext(personalitySnapshot: string): string {
  return personalitySnapshot
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => WEB_RELEVANT_SELF_CONTEXT_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join("\n");
}

export function extractKiraLifeWebSources(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const normalized = matches
    .map(normalizeSourceUrl)
    .filter((value): value is string => Boolean(value));
  return [...new Set(normalized)].slice(0, MAX_GROUNDING_SOURCES);
}

export function buildKiraLifeWebGroundingQuery(input: KiraLifeWebGroundingQueryInput): string {
  const webProfileContext = selectKiraLifeWebProfileContext(input.personalitySnapshot);
  return [
    `Найди ОДНУ свежую реальную опору для сегодняшнего бытового события персонажа ${input.characterName}.`,
    `Текущие дата и время: ${input.currentDateTime}. Часовой пояс: ${input.timezone}.`,
    "",
    `Биография персонажа: ${compactContext(input.biography) || "не задана"}`,
    `Самомодель, интересы и текущие линии: ${compactContext(webProfileContext) || "нет данных"}`,
    `Недавние темы, которые не надо повторять: ${compactContext(input.recentTopics, 1_000) || "нет"}`,
    "",
    "Сначала выведи из жизненного контекста, чем персонаж естественно мог бы заинтересоваться, заняться или о чём задуматься именно сейчас. Затем сам определи тип внешней опоры и найди один конкретный реальный факт.",
    "Это открытый выбор, НЕ закрытый список категорий. Опорой может быть любой существующий объект, место, услуга, маршрут, товар, природное явление, публикация, исследование, профессиональная тема, локальное изменение, событие или другая деталь реального мира, если она органично продолжает текущую жизнь персонажа.",
    "Кино, еда, книги, городские новости, тренировки, хобби, быт, обучение, работа, поездки, погода и природа — лишь возможные примеры, а не предпочтительные или обязательные категории.",
    "",
    "Ограничения:",
    "- если опора локальная, используй город только когда текущее место жизни явно следует из биографии или самомодели; не выбирай произвольный город и не делай каждую опору локальной;",
    "- для изменчивого факта проверь актуальность на текущую дату; устойчивый внешний факт не обязан быть опубликован сегодня, но должен подтверждаться источником;",
    "- предпочитай первичный или профильный источник; второй независимый источник нужен, когда сообщается оценка, отзыв, репутация или спорный вывод;",
    "- отделяй проверенный факт от чужой оценки и не придумывай консенсус, если подходящих отзывов или обсуждений нет;",
    "- не выбирай криминальную хронику, трагедию, рекламу или тему, слабо связанную с интересами персонажа;",
    "- не утверждай, что персонаж уже купил билет, забронировал стол или посетил место: это решит следующий этап генерации.",
    "",
    "Верни компактный обычный текст на русском со строками:",
    "ОПОРА: точный реальный объект, факт или явление",
    "МЕСТО/ВРЕМЯ: только если релевантно и подтверждено, иначе «не требуется»",
    "ПОЧЕМУ ПОДХОДИТ: связь с конкретными интересами или линиями персонажа",
    "РЕАЛЬНАЯ ДЕТАЛЬ: проверяемый факт, который можно естественно вплести в бытовое сообщение",
    "КОНТЕКСТ ИЗ ИСТОЧНИКОВ: подтверждённая оценка, отзыв или полезное пояснение, если уместно; иначе «не требуется»",
    "ИСТОЧНИКИ: прямые URL и даты публикации/обновления, когда доступны",
    "",
    "Если нельзя найти достаточно свежую и релевантную опору хотя бы с одним прямым URL, верни ровно NO_GROUNDING.",
  ].join("\n");
}

export function parseKiraLifeWebGrounding(
  searchText: string | null | undefined,
  researchedAt = new Date().toISOString(),
): KiraLifeWebGrounding | undefined {
  const summary = searchText?.trim();
  if (!summary || summary.length < 120 || NO_GROUNDING_RE.test(summary)) {
    return undefined;
  }

  const sources = extractKiraLifeWebSources(summary);
  if (sources.length === 0) {
    return undefined;
  }

  return {
    summary: summary.slice(0, MAX_GROUNDING_SUMMARY_CHARS),
    sources,
    researchedAt,
  };
}
