import assert from "node:assert/strict";
import { buildHelpOverviewBlocks, buildHelpTopicBlocks } from "../utils/helpMessage";
import { renderFallbackHtml, sendStructured } from "../utils/richMessage";

const capabilities = [
    { title: "Напоминания", category: "Планирование", ownerOnly: true },
    { title: "Поиск в интернете", category: "Интернет" },
    { title: "Карты, адреса и места", category: "Локации" },
];

async function run(): Promise<void> {
    const overview = renderFallbackHtml(buildHelpOverviewBlocks(capabilities, false));
    assert.match(overview, /Чем я могу помочь/);
    assert.match(overview, /\/help напоминания/);
    assert.match(overview, /Напоминания/);

    const publicOverview = renderFallbackHtml(buildHelpOverviewBlocks(capabilities, true));
    assert.match(publicOverview, /Личные данные и действия владельца я не раскрываю/);
    assert.doesNotMatch(publicOverview, /Напоминания/);
    assert.doesNotMatch(publicOverview, /изучить переписку|записать меня через сайт/);
    assert.match(publicOverview, /Поиск в интернете/);
    assert.match(publicOverview, /Найди свежую информацию/);

    const topicBlocks = buildHelpTopicBlocks("фото <script>", "Можно <точно>\nВот пример");
    const topic = renderFallbackHtml(topicBlocks);
    assert.match(topic, /фото &lt;script&gt;/);
    assert.match(topic, /Можно &lt;точно&gt;\nВот пример/);
    assert.doesNotMatch(topic, /<script>|<br\s*\/>/);
    assert.match(topic, /\/help &lt;тема&gt;/);
    assert.doesNotMatch(topic, /<тема>/);

    const calls: Array<{ text: string; other?: Record<string, unknown> }> = [];
    const previousRichSetting = process.env.RICH_MESSAGES_ENABLED;
    process.env.RICH_MESSAGES_ENABLED = "false";
    try {
        await sendStructured({
            sendRichMessage: async () => { throw new Error("rich не должен вызываться"); },
            sendMessage: async (_chatId, text, other) => {
                calls.push({ text, other });
                return { message_id: 1 };
            },
            editMessageText: async () => ({ message_id: 1 }),
        }, 1, topicBlocks);
    } finally {
        if (previousRichSetting === undefined) delete process.env.RICH_MESSAGES_ENABLED;
        else process.env.RICH_MESSAGES_ENABLED = previousRichSetting;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].other?.parse_mode, "HTML");
    assert.match(calls[0].text, /Можно &lt;точно&gt;\nВот пример/);
    assert.doesNotMatch(calls[0].text, /<br\s*\/>/);
    assert.match(calls[0].text, /\/help &lt;тема&gt;/);
    assert.doesNotMatch(calls[0].text, /<тема>/);

    console.log("✓ /help использует каталог возможностей и безопасный HTML fallback");
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
