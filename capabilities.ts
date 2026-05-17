import openai from "./openai";
import { config } from "./config";
import { getBotPersona, getCommunicationStyle } from "./persona";

type CommandScope = "owner" | "admin" | "group" | "public";

export interface BotCommandDescription {
    command: string;
    description: string;
    scope: CommandScope;
    usage?: string;
    examples?: string[];
    showInTelegramMenu?: boolean;
}

export interface BotCapabilityDescription {
    id: string;
    title: string;
    category: string;
    summary: string;
    examples: string[];
    commands?: string[];
    limitations?: string[];
    ownerOnly?: boolean;
}

export interface CapabilitiesAnswerOptions {
    publicMode?: boolean;
}

export const BOT_COMMANDS: BotCommandDescription[] = [
    {
        command: "help",
        description: "Спросить о возможностях бота",
        scope: "public",
        usage: "/help [тема]",
        examples: ["/help напоминания", "/help как попросить тебя изучить чат"],
        showInTelegramMenu: true,
    },
    {
        command: "reminders",
        description: "Активные напоминания",
        scope: "owner",
        usage: "/reminders",
        showInTelegramMenu: true,
    },
    {
        command: "reflection",
        description: "Режим рефлексии и накопления знаний",
        scope: "owner",
        usage: "/reflection",
        showInTelegramMenu: true,
    },
    {
        command: "self_study",
        description: "Самоизучение возможностей, ограничений и потребностей",
        scope: "owner",
        usage: "/self_study [last]",
        examples: ["/self_study", "/self_study last"],
        showInTelegramMenu: true,
    },
    {
        command: "health",
        description: "Дневник здоровья и самочувствия",
        scope: "owner",
        usage: "/health",
        examples: ["/health", "/health_export 30"],
        showInTelegramMenu: true,
    },
    {
        command: "health_export",
        description: "Экспорт дневника здоровья за период",
        scope: "owner",
        usage: "/health_export [дней]",
    },
    {
        command: "summary",
        description: "Сводка текущего диалога",
        scope: "owner",
        usage: "/summary",
        showInTelegramMenu: true,
    },
    {
        command: "history",
        description: "Недавняя история диалога",
        scope: "owner",
        usage: "/history",
    },
    {
        command: "clear",
        description: "Очистить историю диалога и сохранить факты",
        scope: "owner",
        usage: "/clear",
        showInTelegramMenu: true,
    },
    {
        command: "contacts",
        description: "Список Telegram-контактов",
        scope: "owner",
        usage: "/contacts",
        showInTelegramMenu: true,
    },
    {
        command: "chats",
        description: "Список чатов, где присутствует бот",
        scope: "owner",
        usage: "/chats",
        showInTelegramMenu: true,
    },
    {
        command: "chatgroups",
        description: "Группы Telegram-чатов для анализа и отслеживания",
        scope: "owner",
        usage: "/chatgroups",
    },
    {
        command: "public_mode",
        description: "Включить или выключить публичный режим в текущей группе",
        scope: "group",
        usage: "/public_mode",
    },
    {
        command: "telegram_unread",
        description: "Непрочитанные сообщения Telegram за 24 часа",
        scope: "owner",
        usage: "/telegram_unread",
        showInTelegramMenu: true,
    },
    {
        command: "telegram_read",
        description: "Отметить Telegram-сообщения как прочитанные",
        scope: "owner",
        usage: "/telegram_read",
    },
    {
        command: "telegram_reset",
        description: "Сбросить сохранённые Telegram-сообщения",
        scope: "owner",
        usage: "/telegram_reset",
    },
    {
        command: "admin_menu",
        description: "Административное меню памяти и диагностики",
        scope: "admin",
        usage: "/admin_menu",
    },
    {
        command: "memory_stats",
        description: "Статистика памяти и последние факты",
        scope: "admin",
        usage: "/memory_stats",
    },
    {
        command: "memory_search",
        description: "Ручной поиск по долговременной памяти",
        scope: "admin",
        usage: "/memory_search <запрос>",
    },
    {
        command: "memory_cleanup",
        description: "Очистка старых фактов",
        scope: "admin",
        usage: "/memory_cleanup",
    },
    {
        command: "debug_facts",
        description: "Диагностика извлечения фактов",
        scope: "admin",
        usage: "/debug_facts",
    },
    {
        command: "insights",
        description: "Паттерны и инсайты по долговременной памяти",
        scope: "owner",
        usage: "/insights",
    },
    {
        command: "memory_health",
        description: "Отчёт о качестве памяти",
        scope: "owner",
        usage: "/memory_health",
    },
    {
        command: "memory_repair_contacts",
        description: "Миграция старых контактных фактов",
        scope: "admin",
        usage: "/memory_repair_contacts",
    },
    {
        command: "memory_compress",
        description: "Сжать старые факты домена",
        scope: "admin",
        usage: "/memory_compress <домен>",
    },
    {
        command: "memory_history",
        description: "История изменений найденного факта",
        scope: "owner",
        usage: "/memory_history <запрос>",
    },
];

export const BOT_CAPABILITIES: BotCapabilityDescription[] = [
    {
        id: "capability-help",
        title: "Подсказки по собственным возможностям",
        category: "Справка",
        summary: "Отвечает на вопросы о том, что бот умеет, умеет ли он конкретное действие и как правильно попросить.",
        examples: [
            "Ты можешь изучить переписку с человеком?",
            "Как попросить тебя отправить сообщение маме?",
            "Что ты умеешь с напоминаниями?",
        ],
        commands: ["/help [тема]"],
    },
    {
        id: "conversation-memory",
        title: "Диалог и долговременная память",
        category: "Общение",
        summary: "Отвечает на вопросы, поддерживает диалог, использует сохранённые факты, умеет запоминать и забывать факты по просьбе.",
        examples: [
            "Запомни, что я работаю над проектом Kira Mind Bot",
            "Что ты помнишь обо мне?",
            "Забудь, что я живу в старом районе",
        ],
        commands: ["/summary", "/history", "/clear", "/insights", "/memory_health", "/memory_history <запрос>"],
    },
    {
        id: "reminders",
        title: "Напоминания",
        category: "Планирование",
        summary: "Создаёт одно или несколько напоминаний, переносит и отменяет их, поддерживает повторения и напоминания для групп или контактов.",
        examples: [
            "Напомни завтра в 9:30 позвонить врачу",
            "Каждый понедельник в 10 напоминай проверить отчёты",
            "Перенеси напоминание про врача на пятницу",
            "Отмени все напоминания на сегодня",
        ],
        commands: ["/reminders"],
        ownerOnly: true,
    },
    {
        id: "health-diary",
        title: "Дневник здоровья",
        category: "Здоровье",
        summary: "Фиксирует наблюдения о еде, напитках, симптомах, коже, давлении/пульсе, лекарствах, активности, фото еды/кожи/тонометра и самочувствии, анализирует дневник за день/неделю/месяц и выгружает документ за выбранный период.",
        examples: [
            "Запусти дневник здоровья",
            "Запиши: съел креветки, через час зуд на руках 6 из 10",
            "Запиши давление 120/80, пульс 72",
            "Сохрани фото тонометра",
            "Сохрани фото того, что я ем",
            "Сохрани фото кожи и спроси уровень зуда",
            "Проанализируй здоровье за неделю",
            "Выгрузи дневник здоровья за 30 дней",
        ],
        commands: ["/health", "/health_export [дней]"],
        limitations: ["Это дневник наблюдений, не диагноз и не медицинская рекомендация. Фото-анализ описывает видимые признаки и неопределённость."],
        ownerOnly: true,
    },
    {
        id: "telegram-reading",
        title: "Чтение и анализ Telegram-переписок",
        category: "Telegram",
        summary: "Показывает непрочитанные сообщения, анализирует переписку с контактом или групповой чат, может сохранить найденные факты в память.",
        examples: [
            "Покажи непрочитанные сообщения",
            "Изучи чат с женой и запомни важное обо мне",
            "Проанализируй переписку с Артёмом за неделю",
            "Изучи группу Рабочие чаты и сохрани важные факты",
        ],
        commands: ["/telegram_unread", "/telegram_read", "/telegram_reset", "/chatgroups"],
        limitations: ["Нужна настроенная Telegram-сессия пользователя."],
        ownerOnly: true,
    },
    {
        id: "telegram-sending",
        title: "Отправка сообщений и переговоры",
        category: "Telegram",
        summary: "Готовит и отправляет сообщения контактам или группам, а также может вести переговоры от имени пользователя с уточнениями.",
        examples: [
            "Напиши маме, что я задержусь на полчаса",
            "Отправь в чат команды: завтра встречаемся в 11",
            "Договорись с поставщиком о доставке цветов завтра",
        ],
        limitations: ["Перед отправкой бот готовит черновик и может попросить подтверждение или уточнение."],
        ownerOnly: true,
    },
    {
        id: "contacts-portraits",
        title: "Контакты и портреты людей",
        category: "Telegram",
        summary: "Работает со списком контактов, разрешает роли вроде «жена» или «мама» через память, строит психологический портрет по переписке.",
        examples: [
            "Покажи контакты",
            "Проанализируй переписку с Юлей и составь портрет",
            "Напиши жене, что я скоро буду",
        ],
        commands: ["/contacts"],
        ownerOnly: true,
    },
    {
        id: "chat-groups-tracking",
        title: "Группы чатов и отслеживание",
        category: "Telegram",
        summary: "Позволяет объединять несколько Telegram-чатов в именованные группы и включать умное отслеживание важных сообщений.",
        examples: [
            "Создай группу Рабочие чаты из этих Telegram-чатов",
            "Проанализируй Рабочие чаты",
        ],
        commands: ["/chatgroups", "/chats"],
        ownerOnly: true,
    },
    {
        id: "web-search",
        title: "Поиск в интернете",
        category: "Интернет",
        summary: "Ищет актуальную информацию в сети и использует найденное в ответе или следующем действии.",
        examples: [
            "Найди последние новости про OpenAI",
            "Поищи, где сегодня купить билеты",
            "Найди рецепт и отправь его маме",
        ],
    },
    {
        id: "browser-automation",
        title: "Действия в браузере",
        category: "Интернет",
        summary: "Через Playwright открывает сайты, заполняет формы, нажимает кнопки, помогает записаться, забронировать или скачать файл.",
        examples: [
            "Зайди на сайт клиники и запиши меня к врачу",
            "Открой сайт и заполни форму заявки",
            "Скачай PDF со страницы",
        ],
        limitations: ["Пароли, 2FA, captcha, платежи и документы требуют явного участия пользователя."],
        ownerOnly: true,
    },
    {
        id: "maps",
        title: "Карты, адреса и места",
        category: "Локации",
        summary: "Ищет адреса, места рядом, маршруты и работает с отправленной геолокацией.",
        examples: [
            "Найди кафе рядом",
            "Как добраться до Красной площади?",
            "Что находится по этому адресу?",
        ],
    },
    {
        id: "images",
        title: "Фото и изображения",
        category: "Медиа",
        summary: "Анализирует присланные изображения, распознаёт видимый текст и генерирует картинки по описанию.",
        examples: [
            "Что на этом фото?",
            "Прочитай текст на изображении",
            "Нарисуй кота в стиле акварели",
        ],
    },
    {
        id: "voice",
        title: "Голосовые сообщения",
        category: "Медиа",
        summary: "Распознаёт голосовые сообщения и обрабатывает их как обычный текстовый запрос.",
        examples: ["Отправь голосом: напомни завтра купить кофе"],
    },
    {
        id: "proactive",
        title: "Проактивные режимы",
        category: "Автоматизация",
        summary: "Может делать утренний дайджест, фоново анализировать важные факты, присылать инсайты и отчёты по личным сообщениям.",
        examples: [
            "Включи режим рефлексии",
            "Покажи статус режима рефлексии",
        ],
        commands: ["/reflection"],
        ownerOnly: true,
    },
    {
        id: "self-study",
        title: "Самоизучение",
        category: "Самонастройка",
        summary: "Анализирует собственный каталог функций, ограничения, состояние, статистику рефлексии и практические потребности, затем сохраняет отчёт в самопамять.",
        examples: [
            "Изучи себя и свои возможности",
            "Проанализируй свои ограничения и потребности",
            "Пойми, чего тебе не хватает, чтобы лучше мне помогать",
        ],
        commands: ["/self_study", "/self_study last"],
        limitations: ["Работает только в личном чате владельца, чтобы не раскрывать внутренний контекст в группах."],
        ownerOnly: true,
    },
    {
        id: "public-groups",
        title: "Публичный режим в группах",
        category: "Группы",
        summary: "В группе бот может отвечать другим участникам, если публичный режим включён, но доступ к личным функциям владельца ограничен.",
        examples: [
            "Включи публичный режим в этой группе",
            "Что ты умеешь в публичном чате?",
        ],
        commands: ["/public_mode"],
        limitations: ["В публичном режиме недоступны личные напоминания, чтение личных переписок, отправка сообщений и переговоры от имени владельца."],
    },
];

export function getTelegramMenuCommands(): Array<{ command: string; description: string }> {
    return BOT_COMMANDS
        .filter((item) => item.showInTelegramMenu)
        .map(({ command, description }) => ({ command, description }));
}

export function getCapabilitiesKnowledgeBase(options: CapabilitiesAnswerOptions = {}): string {
    const scope = options.publicMode
        ? "Публичный групповой режим: личные owner-only функции недоступны другим участникам."
        : "Личный режим владельца: доступны owner-only функции при наличии нужных настроек.";

    const capabilities = BOT_CAPABILITIES.map((capability) => {
        const lines = [
            `- ${capability.title} [${capability.category}]`,
            `  id: ${capability.id}`,
            `  описание: ${capability.summary}`,
            capability.ownerOnly ? "  доступ: только владелец" : undefined,
            capability.examples.length ? `  как попросить: ${capability.examples.join(" | ")}` : undefined,
            capability.commands?.length ? `  команды: ${capability.commands.join(", ")}` : undefined,
            capability.limitations?.length ? `  ограничения: ${capability.limitations.join(" ")}` : undefined,
        ].filter(Boolean);
        return lines.join("\n");
    }).join("\n");

    const commands = BOT_COMMANDS.map((command) => {
        const usage = command.usage ? `; использование: ${command.usage}` : "";
        const examples = command.examples?.length ? `; примеры: ${command.examples.join(" | ")}` : "";
        return `- /${command.command}: ${command.description}; доступ: ${command.scope}${usage}${examples}`;
    }).join("\n");

    return [
        `Имя ассистента: ${config.characterName}`,
        scope,
        "",
        "Каталог возможностей:",
        capabilities,
        "",
        "Каталог команд:",
        commands,
    ].join("\n");
}

export function getCapabilitiesMessage(): string {
    return [
        "Я могу подсказать точечно, а не только вывалить список команд.",
        "",
        "Коротко: умею ставить и менять напоминания, вести дневник здоровья, помнить факты, искать в интернете, работать с картами, анализировать фото, генерировать картинки, читать и анализировать Telegram-переписки, готовить сообщения, вести переговоры, выполнять некоторые задачи в браузере и запускать самоизучение своих возможностей.",
        "",
        "Спроси, например:",
        "• «Ты можешь изучить переписку с человеком?»",
        "• «Как попросить тебя отправить сообщение маме?»",
        "• «Что ты умеешь с напоминаниями?»",
        "• «Можешь ли ты записать меня через сайт?»",
        "• «Изучи себя и свои потребности»",
    ].join("\n");
}

export async function answerCapabilitiesQuestion(
    question: string,
    options: CapabilitiesAnswerOptions = {}
): Promise<string> {
    const normalizedQuestion = question.trim() || "Кратко расскажи, чем ты умеешь помогать и как тебя просить.";
    const knowledgeBase = getCapabilitiesKnowledgeBase(options);
    const publicModeRule = options.publicMode
        ? "Ты отвечаешь в публичной группе. Ясно отделяй публично доступные функции от личных функций владельца."
        : "Ты отвечаешь владельцу в личном контексте. Можно говорить о личных функциях, но упоминай настройки, если они нужны.";

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-5.4-nano",
            messages: [
                {
                    role: "system",
                    content:
                        `${getBotPersona()}\nСтиль общения: ${getCommunicationStyle()}\n\n` +
                        "Ты отвечаешь на вопросы о возможностях Telegram-бота по каталогу ниже. " +
                        "Используй только этот каталог: не выдумывай функций и не обещай невозможного. " +
                        "Если вопрос конкретный, начни с ясного «Да» или «Нет/не совсем», затем дай 1-3 примера, как пользователя лучше попросить. " +
                        "Если вопрос общий, дай короткий обзор самых полезных направлений и предложи спросить по конкретной теме. " +
                        "Команды упоминай только когда они реально помогают. Не выводи весь каталог и не делай markdown-таблицы. " +
                        "Отвечай по-русски, естественно и по делу. " +
                        publicModeRule,
                },
                {
                    role: "user",
                    content: [
                        `Вопрос пользователя: ${normalizedQuestion}`,
                        "",
                        knowledgeBase,
                    ].join("\n"),
                },
            ],
            temperature: 1,
        });

        const text = response.choices[0]?.message?.content?.trim();
        return text || getCapabilitiesMessage();
    } catch (error) {
        console.error("Capabilities answer error:", error);
        return getCapabilitiesMessage();
    }
}
