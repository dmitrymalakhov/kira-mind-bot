export type KiraResidenceSource = "default" | "conversation" | "admin";

export interface KiraResidence {
  city: string;
  previousCity?: string;
  movedAt?: string;
  source: KiraResidenceSource;
}

export const DEFAULT_KIRA_CURRENT_CITY = "Санкт-Петербург";
export const KIRA_RESIDENCE_SETTING_KEY = "KIRA_RESIDENCE";

const DIRECT_RELOCATION_RE =
  /(?:(?:^|[\s,.!?;:])(?:переезжай|переедь|перебирайся|поселись|переехать\s+тебе|тебе\s+переехать)(?=$|[\s,.!?;:])|(?:^|[\s,.!?;:])(?:ты|кира)(?=$|[\s,.!?;:])[^.!?]{0,90}(?:^|[\s,.!?;:])(?:переехала|переехал|переедешь|перебер[её]шься|поселишься|живи|жив[её]шь)(?=$|[\s,.!?;:])|(?:^|[\s,.!?;:])хочу\s*,?\s*чтобы\s+ты(?=$|[\s,.!?;:])[^.!?]{0,70}(?:^|[\s,.!?;:])(?:переехала|переехал|жила|жил)(?=$|[\s,.!?;:]))/iu;
const DESTINATION_RE = /(?:^|[\s,.!?;:])(?:в|во)\s+[\p{L}]/iu;
const NEGATED_RELOCATION_RE =
  /(?:^|[\s,.!?;:])(?:не|не\s+надо|не\s+нужно)\s+(?:переезжай|переезжать|переедь|перебирайся|поселяйся|живи)(?=$|[\s,.!?;:])/iu;

export function normalizeKiraResidenceCity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .replace(/^[«"'`]+|[»"'`]+$/gu, "")
    .replace(/^(?:город(?:е|ом|а|у)?\s+|г\.\s*)/iu, "")
    .replace(/\s+/gu, " ");

  if (!normalized || normalized.length > 80 || !/\p{L}/u.test(normalized)) return null;
  if (!/^[\p{L}\p{M}][\p{L}\p{M}\s.'’()\-]{0,79}$/u.test(normalized)) return null;
  return normalized;
}

export function looksLikeKiraRelocationRequest(message: string): boolean {
  const normalized = message.trim();
  if (!normalized || NEGATED_RELOCATION_RE.test(normalized)) return false;
  return DIRECT_RELOCATION_RE.test(normalized) && DESTINATION_RE.test(normalized);
}

function canonicalizeCommonRussianCity(value: string): string {
  const normalized = value.toLocaleLowerCase("ru-RU");
  const aliases: Array<[RegExp, string]> = [
    [/^москв(?:а|у|е|ой|ы)$/iu, "Москва"],
    [/^(?:санкт[- ]петербург(?:а|е|ом|у)?|петербург(?:а|е|ом|у)?|питер(?:а|е|ом|у)?|спб)$/iu, "Санкт-Петербург"],
    [/^казан(?:ь|и|ью)$/iu, "Казань"],
    [/^калининград(?:а|е|ом|у)?$/iu, "Калининград"],
    [/^екатеринбург(?:а|е|ом|у)?$/iu, "Екатеринбург"],
    [/^новосибирск(?:а|е|ом|у)?$/iu, "Новосибирск"],
    [/^нижн(?:ий|его|ем|ему)\s+новгород(?:а|е|ом|у)?$/iu, "Нижний Новгород"],
    [/^ростов(?:а|е|ом|у)?[- ]на[- ]дону$/iu, "Ростов-на-Дону"],
    [/^сочи$/iu, "Сочи"],
  ];
  return aliases.find(([pattern]) => pattern.test(normalized))?.[1] || value;
}

/** Резерв только для уже распознанной прямой просьбы, если JSON-анализатор недоступен. */
export function extractDirectKiraRelocationCity(message: string): string | null {
  if (!looksLikeKiraRelocationRequest(message)) return null;
  const match = message.match(/(?:^|[\s,.!?;:])(?:в|во)\s+([^,.!?;:\n]{1,80})/iu);
  if (!match?.[1]) return null;
  const withoutTail = match[1]
    .split(/\s+(?:и|а|но|чтобы|потому|там|пожалуйста|насовсем|теперь)(?=\s|$)/iu)[0]
    .trim();
  const city = normalizeKiraResidenceCity(withoutTail);
  return city ? canonicalizeCommonRussianCity(city) : null;
}

export function parseKiraResidenceSetting(raw: string | null | undefined, fallbackCity: string): KiraResidence {
  const normalizedFallback = normalizeKiraResidenceCity(fallbackCity) || DEFAULT_KIRA_CURRENT_CITY;
  if (!raw?.trim()) {
    return { city: normalizedFallback, source: "default" };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<KiraResidence>;
    const city = normalizeKiraResidenceCity(parsed.city);
    if (!city) return { city: normalizedFallback, source: "default" };
    const previousCity = normalizeKiraResidenceCity(parsed.previousCity);
    const source: KiraResidenceSource = parsed.source === "conversation" || parsed.source === "admin"
      ? parsed.source
      : "default";
    const movedAt = typeof parsed.movedAt === "string" && Number.isFinite(new Date(parsed.movedAt).getTime())
      ? parsed.movedAt
      : undefined;
    return {
      city,
      previousCity: previousCity && previousCity.toLocaleLowerCase("ru-RU") !== city.toLocaleLowerCase("ru-RU")
        ? previousCity
        : undefined,
      movedAt,
      source,
    };
  } catch {
    const legacyCity = normalizeKiraResidenceCity(raw);
    return legacyCity
      ? { city: legacyCity, source: "default" }
      : { city: normalizedFallback, source: "default" };
  }
}

export function buildKiraResidenceUpdate(
  current: KiraResidence,
  nextCityInput: string,
  source: Exclude<KiraResidenceSource, "default">,
  movedAt = new Date().toISOString(),
): { residence: KiraResidence; changed: boolean } {
  const nextCity = normalizeKiraResidenceCity(nextCityInput);
  if (!nextCity) {
    throw new Error("Некорректный город проживания");
  }

  const changed = nextCity.toLocaleLowerCase("ru-RU") !== current.city.toLocaleLowerCase("ru-RU");
  if (!changed) {
    return { residence: current, changed: false };
  }

  return {
    residence: {
      city: nextCity,
      previousCity: current.city,
      movedAt,
      source,
    },
    changed: true,
  };
}
