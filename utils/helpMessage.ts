import { esc, footer, heading, list, paragraph, RichBlock } from "./richMessage";

export interface HelpCapability {
    title: string;
    category: string;
    ownerOnly?: boolean;
}

const CATEGORY_EMOJI: Record<string, string> = {
    "Справка": "❔",
    "Общение": "🧠",
    "Планирование": "⏰",
    "Здоровье": "❤️",
    "Telegram": "💬",
    "Интернет": "🌐",
    "Локации": "📍",
    "Медиа": "🖼",
    "Автоматизация": "⚙️",
    "Самонастройка": "✨",
    "Группы": "👥",
};

export function buildHelpOverviewBlocks(
    capabilities: HelpCapability[],
    publicMode = false,
): RichBlock[] {
    const visibleCapabilities = capabilities.filter((capability) => !publicMode || !capability.ownerOnly);
    const categories = new Map<string, string[]>();

    for (const capability of visibleCapabilities) {
        const titles = categories.get(capability.category) ?? [];
        titles.push(capability.title);
        categories.set(capability.category, titles);
    }

    const capabilityItems = Array.from(categories, ([category, titles]) => {
        const emoji = CATEGORY_EMOJI[category] ?? "•";
        return `${emoji} <b>${esc(category)}</b> — ${titles.map(esc).join(", ")}`;
    });

    const blocks: RichBlock[] = [
        heading("✨ Чем я могу помочь", 2),
        paragraph(publicMode
            ? "В этом чате доступны общие вопросы и публичные функции. Личные данные и действия владельца я не раскрываю."
            : "Можно просто написать просьбу своими словами — команду подбирать необязательно."),
        heading("Главное", 3),
        list(capabilityItems),
        heading("Например, спроси", 3),
        list([
            "«Что ты умеешь с напоминаниями?»",
            "«Как попросить тебя изучить переписку?»",
            "«Можешь записать меня через сайт?»",
        ]),
        footer("Нужна подробность? Напиши /help и тему — например: /help напоминания"),
    ];

    return blocks;
}

export function buildHelpTopicBlocks(topic: string, answer: string): RichBlock[] {
    return [
        heading(`❔ ${esc(topic)}`, 2),
        paragraph(esc(answer)),
        footer("Можно уточнить вопрос обычным сообщением или выбрать другую тему через /help <тема>."),
    ];
}
