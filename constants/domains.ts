/**
 * Пороги cosine-сходства при поиске по конкретному домену.
 *
 * Логика:
 * - personal/family/health — факты об именах, датах, диагнозах: нужна высокая точность,
 *   лучше не найти, чем найти чужое.
 * - hobbies/entertainment/general — широкие темы, ассоциации важны, порог ниже.
 */
export const DOMAIN_SEARCH_THRESHOLDS: Record<string, number> = {
    personal:      0.75,
    family:        0.72,
    health:        0.70,
    work:          0.65,
    finance:       0.65,
    education:     0.62,
    travel:        0.60,
    social:        0.60,
    home:          0.58,
    hobbies:       0.55,
    entertainment: 0.55,
    general:       0.55,
};

export const PREDEFINED_DOMAINS = {
  WORK: 'work',
  HEALTH: 'health', 
  FAMILY: 'family',
  FINANCE: 'finance',
  EDUCATION: 'education',
  HOBBIES: 'hobbies',
  TRAVEL: 'travel',
  SOCIAL: 'social',
  HOME: 'home',
  PERSONAL: 'personal',
  ENTERTAINMENT: 'entertainment',
  GENERAL: 'general'
} as const;

export const DOMAIN_DESCRIPTIONS = {
  [PREDEFINED_DOMAINS.WORK]: {
    name: 'Работа',
    description: 'Карьера, проекты, встречи, задачи, коллеги',
    keywords: ['работа', 'проект', 'встреча', 'задача', 'офис', 'коллега', 'презентация', 'дедлайн']
  },
  [PREDEFINED_DOMAINS.HEALTH]: {
    name: 'Здоровье',
    description: 'Медицина, врачи, лекарства, симптомы, анализы',
    keywords: ['здоровье', 'врач', 'лекарство', 'боль', 'анализ', 'симптом', 'лечение', 'больница']
  },
  [PREDEFINED_DOMAINS.FAMILY]: {
    name: 'Семья',
    description: 'Родственники, дети, семейные события',
    keywords: ['семья', 'родители', 'дети', 'ребенок', 'мама', 'папа', 'брат', 'сестра', 'семейный']
  },
  [PREDEFINED_DOMAINS.FINANCE]: {
    name: 'Финансы',
    description: 'Деньги, покупки, инвестиции, бюджет',
    keywords: ['деньги', 'покупка', 'цена', 'бюджет', 'зарплата', 'счет', 'банк', 'инвестиции']
  },
  [PREDEFINED_DOMAINS.EDUCATION]: {
    name: 'Образование',
    description: 'Обучение, курсы, навыки, развитие',
    keywords: ['учеба', 'курс', 'навык', 'обучение', 'изучение', 'урок', 'знания', 'развитие']
  },
  [PREDEFINED_DOMAINS.HOBBIES]: {
    name: 'Хобби',
    description: 'Увлечения, творчество, спорт, игры',
    keywords: ['хобби', 'спорт', 'игра', 'творчество', 'рисование', 'музыка', 'фотография', 'коллекция']
  },
  [PREDEFINED_DOMAINS.TRAVEL]: {
    name: 'Путешествия',
    description: 'Поездки, отпуск, билеты, отели',
    keywords: ['путешествие', 'отпуск', 'поездка', 'билет', 'отель', 'виза', 'аэропорт', 'туризм']
  },
  [PREDEFINED_DOMAINS.SOCIAL]: {
    name: 'Социальная жизнь',
    description: 'Друзья, знакомые, встречи, события',
    keywords: ['друзья', 'знакомые', 'вечеринка', 'событие', 'встреча', 'общение', 'компания']
  },
  [PREDEFINED_DOMAINS.HOME]: {
    name: 'Дом и быт',
    description: 'Домашние дела, ремонт, покупки для дома',
    keywords: ['дом', 'квартира', 'ремонт', 'мебель', 'уборка', 'быт', 'хозяйство', 'интерьер']
  },
  [PREDEFINED_DOMAINS.PERSONAL]: {
    name: 'Личное',
    description: 'Размышления, цели, планы, саморазвитие',
    keywords: ['личное', 'цель', 'план', 'мечта', 'размышления', 'чувства', 'переживания']
  },
  [PREDEFINED_DOMAINS.ENTERTAINMENT]: {
    name: 'Развлечения',
    description: 'Фильмы, сериалы, книги, игры, досуг',
    keywords: ['фильм', 'сериал', 'книга', 'игра', 'развлечение', 'досуг', 'кино', 'музыка']
  },
  [PREDEFINED_DOMAINS.GENERAL]: {
    name: 'Общее',
    description: 'Разные темы, не относящиеся к другим категориям',
    keywords: ['общее', 'разное', 'прочее']
  }
};
