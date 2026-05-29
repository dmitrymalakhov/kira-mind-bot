const DIGIT_WORDS = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
const MONTHS_GENITIVE = [
    "",
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
];

const ORDINAL_NEUTER: Record<number, string> = {
    1: "первое",
    2: "второе",
    3: "третье",
    4: "четвертое",
    5: "пятое",
    6: "шестое",
    7: "седьмое",
    8: "восьмое",
    9: "девятое",
    10: "десятое",
    11: "одиннадцатое",
    12: "двенадцатое",
    13: "тринадцатое",
    14: "четырнадцатое",
    15: "пятнадцатое",
    16: "шестнадцатое",
    17: "семнадцатое",
    18: "восемнадцатое",
    19: "девятнадцатое",
    20: "двадцатое",
    30: "тридцатое",
};

const ORDINAL_GENITIVE: Record<number, string> = {
    1: "первого",
    2: "второго",
    3: "третьего",
    4: "четвертого",
    5: "пятого",
    6: "шестого",
    7: "седьмого",
    8: "восьмого",
    9: "девятого",
    10: "десятого",
    11: "одиннадцатого",
    12: "двенадцатого",
    13: "тринадцатого",
    14: "четырнадцатого",
    15: "пятнадцатого",
    16: "шестнадцатого",
    17: "семнадцатого",
    18: "восемнадцатого",
    19: "девятнадцатого",
    20: "двадцатого",
    30: "тридцатого",
};

const ORDINAL_MASCULINE: Record<number, string> = {
    1: "первый",
    2: "второй",
    3: "третий",
    4: "четвертый",
    5: "пятый",
    6: "шестой",
    7: "седьмой",
    8: "восьмой",
    9: "девятый",
    10: "десятый",
    11: "одиннадцатый",
    12: "двенадцатый",
    13: "тринадцатый",
    14: "четырнадцатый",
    15: "пятнадцатый",
    16: "шестнадцатый",
    17: "семнадцатый",
    18: "восемнадцатый",
    19: "девятнадцатый",
    20: "двадцатый",
    30: "тридцатый",
};

const ORDINAL_FEMININE: Record<number, string> = {
    1: "первая",
    2: "вторая",
    3: "третья",
    4: "четвертая",
    5: "пятая",
    6: "шестая",
    7: "седьмая",
    8: "восьмая",
    9: "девятая",
    10: "десятая",
    11: "одиннадцатая",
    12: "двенадцатая",
    13: "тринадцатая",
    14: "четырнадцатая",
    15: "пятнадцатая",
    16: "шестнадцатая",
    17: "семнадцатая",
    18: "восемнадцатая",
    19: "девятнадцатая",
    20: "двадцатая",
    30: "тридцатая",
};

const ORDINAL_FEMININE_ACCUSATIVE: Record<number, string> = {
    1: "первую",
    2: "вторую",
    3: "третью",
    4: "четвертую",
    5: "пятую",
    6: "шестую",
    7: "седьмую",
    8: "восьмую",
    9: "девятую",
    10: "десятую",
    11: "одиннадцатую",
    12: "двенадцатую",
    13: "тринадцатую",
    14: "четырнадцатую",
    15: "пятнадцатую",
    16: "шестнадцатую",
    17: "семнадцатую",
    18: "восемнадцатую",
    19: "девятнадцатую",
    20: "двадцатую",
    30: "тридцатую",
};

type Gender = "masculine" | "feminine";
type OrdinalForm = "neuter" | "genitive" | "masculine" | "feminine" | "feminineAccusative";

function pluralRu(value: number, one: string, few: string, many: string): string {
    const mod10 = Math.abs(value) % 10;
    const mod100 = Math.abs(value) % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
}

function cardinalBelowThousand(value: number, gender: Gender = "masculine"): string {
    if (value === 0) return "";
    const words: string[] = [];
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    if (hundreds > 0) words.push(HUNDREDS[hundreds]);
    if (rest >= 10 && rest < 20) {
        words.push(TEENS[rest - 10]);
    } else {
        const tens = Math.floor(rest / 10);
        const ones = rest % 10;
        if (tens > 0) words.push(TENS[tens]);
        if (ones > 0) words.push((gender === "feminine" ? ONES_F : ONES_M)[ones]);
    }
    return words.join(" ");
}

function speakDigits(value: string): string {
    return value.split("").map((digit) => DIGIT_WORDS[Number(digit)] ?? digit).join(" ");
}

function cardinalInteger(value: number): string {
    if (!Number.isFinite(value)) return "";
    if (value === 0) return "ноль";
    if (value < 0) return `минус ${cardinalInteger(Math.abs(value))}`;
    if (value > 999999) return speakDigits(String(Math.trunc(value)));

    const thousands = Math.floor(value / 1000);
    const rest = value % 1000;
    const words: string[] = [];
    if (thousands > 0) {
        words.push(cardinalBelowThousand(thousands, "feminine"));
        words.push(pluralRu(thousands, "тысяча", "тысячи", "тысяч"));
    }
    if (rest > 0) words.push(cardinalBelowThousand(rest));
    return words.join(" ");
}

function ordinalBelowHundred(value: number, form: OrdinalForm): string {
    const map = form === "genitive"
        ? ORDINAL_GENITIVE
        : form === "masculine"
            ? ORDINAL_MASCULINE
            : form === "feminine"
                ? ORDINAL_FEMININE
                : form === "feminineAccusative"
                    ? ORDINAL_FEMININE_ACCUSATIVE
                    : ORDINAL_NEUTER;

    if (map[value]) return map[value];
    const tens = Math.floor(value / 10) * 10;
    const ones = value % 10;
    if (tens > 0 && ones > 0 && map[ones]) {
        return `${TENS[tens / 10]} ${map[ones]}`;
    }
    return cardinalInteger(value);
}

function ordinalInteger(value: number, form: OrdinalForm): string {
    if (!Number.isFinite(value) || value <= 0) return cardinalInteger(value);
    if (value < 100) return ordinalBelowHundred(value, form);

    const rest = value % 1000;
    if (value < 1000 && rest > 0) {
        const hundreds = Math.floor(value / 100) * 100;
        const remainder = value % 100;
        if (remainder === 0) return cardinalInteger(value);
        return `${cardinalInteger(hundreds)} ${ordinalBelowHundred(remainder, form)}`;
    }

    const prefixValue = value - rest;
    if (rest > 0) return `${cardinalInteger(prefixValue)} ${ordinalInteger(rest, form)}`;
    return cardinalInteger(value);
}

function yearToSpeech(rawYear: string): string {
    const parsed = Number(rawYear);
    if (!Number.isFinite(parsed)) return rawYear;
    const year = rawYear.length === 2 ? 2000 + parsed : parsed;
    return `${ordinalInteger(year, "genitive")} года`;
}

function normalizeOrdinalToken(value: number, suffix: string): string {
    if (suffix === "го" || suffix === "ого") return ordinalInteger(value, "genitive");
    if (suffix === "ый" || suffix === "ий" || suffix === "й") return ordinalInteger(value, "masculine");
    if (suffix === "ая" || suffix === "я") return ordinalInteger(value, "feminine");
    if (suffix === "ую") return ordinalInteger(value, "feminineAccusative");
    return ordinalInteger(value, "neuter");
}

function normalizeSegment(segment: string): string {
    return segment
        .replace(/\b(\d{1,2}):(\d{2})\b/g, (match, hourRaw: string, minuteRaw: string) => {
            const hour = Number(hourRaw);
            const minute = Number(minuteRaw);
            if (hour > 23 || minute > 59) return match;
            const hourPart = `${cardinalInteger(hour)} ${pluralRu(hour, "час", "часа", "часов")}`;
            if (minute === 0) return `${hourPart} ровно`;
            return `${hourPart} ${cardinalInteger(minute)} ${pluralRu(minute, "минута", "минуты", "минут")}`;
        })
        .replace(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/g, (match, dayRaw: string, monthRaw: string, yearRaw?: string) => {
            const day = Number(dayRaw);
            const month = Number(monthRaw);
            if (day < 1 || day > 31 || month < 1 || month > 12) return match;
            const parts = [ordinalInteger(day, "neuter"), MONTHS_GENITIVE[month]];
            if (yearRaw) parts.push(yearToSpeech(yearRaw));
            return parts.join(" ");
        })
        .replace(/\b(\d+)([,.])(\d+)\b/g, (_match, integerRaw: string, separator: string, fractionRaw: string) => {
            const integer = Number(integerRaw);
            const separatorWord = separator === "," ? "запятая" : "точка";
            const fraction = speakDigits(fractionRaw);
            return `${cardinalInteger(integer)} ${separatorWord} ${fraction}`;
        })
        .replace(/\b(\d{1,6})\s?%/g, (_match, valueRaw: string) => {
            const value = Number(valueRaw);
            return `${cardinalInteger(value)} ${pluralRu(value, "процент", "процента", "процентов")}`;
        })
        .replace(/(^|[^\p{L}\p{N}_])(\d{1,4})-?(ого|ый|ий|ую|ая|ое|го|й|я|е)(?=$|[^\p{L}\p{N}_])/giu, (_match, prefix: string, valueRaw: string, suffix: string) => {
            return `${prefix}${normalizeOrdinalToken(Number(valueRaw), suffix.toLowerCase())}`;
        })
        .replace(/\b\d+\b/g, (match) => {
            if (match.length > 1 && match.startsWith("0")) return speakDigits(match);
            const value = Number(match);
            return Number.isFinite(value) ? cardinalInteger(value) : match;
        });
}

export function normalizeNumbersForVoiceMessage(text: string): string {
    return text
        .split(/(https?:\/\/\S+)/giu)
        .map((segment) => segment.match(/^https?:\/\//iu) ? segment : normalizeSegment(segment))
        .join("")
        .replace(/\s{2,}/g, " ")
        .trim();
}
