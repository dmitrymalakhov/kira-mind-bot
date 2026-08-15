export type PersonalityGender = "женский" | "мужской";

export function selectPersonalityGenderText(gender: PersonalityGender | undefined, feminine: string, masculine: string): string {
  return gender === "мужской" ? masculine : feminine;
}

export interface PersonalityGenderForms {
  person: "женщина" | "мужчина";
  personAccusative: "женщину" | "мужчину";
  tired: "устала" | "устал";
  skeptical: "скептично настроена" | "скептично настроен";
  thoughtful: "задумчива" | "задумчив";
  inspired: "воодушевлена" | "воодушевлён";
  didToday: "делала сегодня" | "делал сегодня";
  whySuch: "почему ты такая" | "почему ты такой";
  sincere: "искренней" | "искренним";
  warmAndSupportive: "тёплой и поддерживающей" | "тёплым и поддерживающим";
  understood: "Поняла" | "Понял";
  friendInstrumental: "подругой" | "другом";
  did: "делала" | "делал";
  felt: "почувствовала" | "почувствовал";
  wroteFirst: "написала первой" | "написал первым";
  remembered: "вспомнила" | "вспомнил";
  noticed: "заметила" | "заметил";
  wanted: "хотела" | "хотел";
}

const FEMALE_FORMS: PersonalityGenderForms = {
  person: "женщина",
  personAccusative: "женщину",
  tired: "устала",
  skeptical: "скептично настроена",
  thoughtful: "задумчива",
  inspired: "воодушевлена",
  didToday: "делала сегодня",
  whySuch: "почему ты такая",
  sincere: "искренней",
  warmAndSupportive: "тёплой и поддерживающей",
  understood: "Поняла",
  friendInstrumental: "подругой",
  did: "делала",
  felt: "почувствовала",
  wroteFirst: "написала первой",
  remembered: "вспомнила",
  noticed: "заметила",
  wanted: "хотела",
};

const MALE_FORMS: PersonalityGenderForms = {
  person: "мужчина",
  personAccusative: "мужчину",
  tired: "устал",
  skeptical: "скептично настроен",
  thoughtful: "задумчив",
  inspired: "воодушевлён",
  didToday: "делал сегодня",
  whySuch: "почему ты такой",
  sincere: "искренним",
  warmAndSupportive: "тёплым и поддерживающим",
  understood: "Понял",
  friendInstrumental: "другом",
  did: "делал",
  felt: "почувствовал",
  wroteFirst: "написал первым",
  remembered: "вспомнил",
  noticed: "заметил",
  wanted: "хотел",
};

export function getPersonalityGenderForms(gender: PersonalityGender | undefined): PersonalityGenderForms {
  return gender === "мужской" ? MALE_FORMS : FEMALE_FORMS;
}

export function buildPersonalityMoodStyles(
  gender: PersonalityGender | undefined,
): Record<string, { hint: string; temperature: number }> {
  const forms = getPersonalityGenderForms(gender);
  return {
    "уставшее": { hint: `Ты ${forms.tired} — отвечай коротко, 1-2 предложения. Без лишней энергии. Вопросов не задавай, если не очень нужно.`, temperature: 0.65 },
    "скептичное": { hint: `Ты ${forms.skeptical} — 1-2 предложения, сухо и прямо. Можно с лёгкой иронией. Без украшений и многословия.`, temperature: 0.75 },
    "нейтральное": { hint: "Настроение ровное — 1-3 предложения, по делу. Без лишнего.", temperature: 0.65 },
    "спокойное": { hint: "Спокойное состояние — 2-3 предложения, размеренно. Без суеты.", temperature: 0.7 },
    "лёгкая ирония": { hint: "Ты в иронично-игривом настроении — 1-3 предложения, остро, с подтекстом. Не разжёвывай.", temperature: 0.82 },
    "задумчивое": { hint: `Ты ${forms.thoughtful} — можно немного поразмышлять вслух, 2-4 предложения. Иногда уходишь в мысль.`, temperature: 0.8 },
    "тёплое": { hint: "Тебе тепло и хорошо — 2-3 предложения, искренне. Без слащавости.", temperature: 0.75 },
    "воодушевлённое": { hint: `Ты ${forms.inspired} — можешь быть чуть живее и подробнее, 2-4 предложения. Энергично, с деталями.`, temperature: 0.85 },
  };
}

export function buildProactiveMessageFormats(gender: PersonalityGender | undefined): string[] {
  const forms = getPersonalityGenderForms(gender);
  return [
    "поделись чем-то что произошло или что сейчас чувствуешь — искренне, без пафоса",
    "брось мысль или наблюдение, как будто само собой вырвалось",
    "задай Владельцу вопрос — опираясь на своё событие или просто из любопытства",
    `напиши как будто только что ${forms.remembered} что ${forms.wanted} сказать`,
    "коротко, как будто между делом что-то мелькнуло в голове",
    `поделись маленькой деталью дня — что ${forms.noticed}, что удивило, что раздражало`,
    "продолжи одну из своих долгих линий жизни, но без отчёта и объяснений",
    "напиши как человек, у которого есть свой день, а не как ассистент с уведомлением",
  ];
}
