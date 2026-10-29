import { readFile } from 'fs/promises';
import path from 'path';

export interface KiraSkill {
    id: string;
    description: string;
    intents: string[];
}

export const KIRA_SKILLS: readonly KiraSkill[] = [
    { id: 'mcp', description: 'Подключённые MCP-сервисы: аналитика, внешние данные и разрешённые инструменты.', intents: [] },
    { id: 'web-research', description: 'Актуальные сведения, источники, новости и сравнение вариантов.', intents: ['ВЕБ_ПОИСК'] },
    { id: 'places-and-routes', description: 'Адреса, координаты, места рядом и маршруты.', intents: ['КАРТЫ_ЛОКАЦИИ'] },
    { id: 'reminders', description: 'Создание, изменение и отмена напоминаний и повторений.', intents: ['НАПОМИНАНИЕ'] },
    { id: 'recurring-tasks', description: 'Повторное выполнение сохранённого запроса по расписанию.', intents: [] },
    { id: 'telegram-reading', description: 'Непрочитанные, история чатов, анализ сообщений.', intents: ['ПРОВЕРКА_СООБЩЕНИЙ'] },
    { id: 'contact-communication', description: 'Черновики сообщений, стиль адресата и подтверждение отправки.', intents: ['ОТПРАВКА_СООБЩЕНИЯ', 'ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ'] },
    { id: 'people-and-memory', description: 'Личности и память; телефон, username и bio из доступного профиля Telegram.', intents: [] },
    { id: 'study-chat', description: 'Изучение большой переписки и сохранение подтверждённых фактов.', intents: [] },
    { id: 'chat-monitoring', description: 'Наблюдения по условиям и группы отслеживаемых чатов.', intents: [] },
    { id: 'health-diary', description: 'Дневник наблюдений, фотографии, анализ периода и экспорт.', intents: ['ЗДОРОВЬЕ'] },
    { id: 'image-creation', description: 'Создание изображений и сохранение внешности персонажа.', intents: ['ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ'] },
    { id: 'self-study', description: 'Личность, собственная история и самоизучение Киры.', intents: ['САМОИЗУЧЕНИЕ'] },
    { id: 'browser-workflows', description: 'Самостоятельная работа с сайтами, формами и файлами.', intents: ['БРАУЗЕР_ЗАДАЧА'] },
    { id: 'negotiation', description: 'Длительные переговоры с контактом по цели владельца.', intents: ['ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ'] },
];

export class SkillLoader {
    private readonly loaded = new Map<string, string>();
    constructor(private readonly root = path.resolve(__dirname, '../../skills')) {}

    async load(id: string): Promise<string> {
        if (!KIRA_SKILLS.some(skill => skill.id === id)) throw new Error('Неизвестный скилл');
        const cached = this.loaded.get(id);
        if (cached) return cached;
        const content = await readFile(path.join(this.root, id, 'SKILL.md'), 'utf8');
        if (Buffer.byteLength(content) > 24_000) throw new Error('Скилл слишком велик');
        this.loaded.set(id, content);
        return content;
    }

    async forIntents(intents: string[]): Promise<string[]> {
        const selected = KIRA_SKILLS.filter(skill => skill.intents.some(intent => intents.includes(intent)));
        await Promise.all(selected.map(skill => this.load(skill.id)));
        return selected.map(skill => skill.id);
    }

    instructions(): string { return [...this.loaded.entries()].map(([id, text]) => `Скилл ${id}:\n${text}`).join('\n\n'); }
    ids(): string[] { return [...this.loaded.keys()]; }
}
