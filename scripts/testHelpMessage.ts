import assert from "node:assert/strict";
import { buildHelpOverviewBlocks, buildHelpTopicBlocks } from "../utils/helpMessage";
import { renderFallbackHtml } from "../utils/richMessage";

const overview = renderFallbackHtml(buildHelpOverviewBlocks(false));
assert.match(overview, /Чем я могу помочь/);
assert.match(overview, /\/help напоминания/);
assert.match(overview, /Планирование/);

const publicOverview = renderFallbackHtml(buildHelpOverviewBlocks(true));
assert.match(publicOverview, /Личные данные и действия владельца я не раскрываю/);

const topic = renderFallbackHtml(buildHelpTopicBlocks("фото <script>", "Можно <точно>\nВот пример"));
assert.match(topic, /фото &lt;script&gt;/);
assert.match(topic, /Можно &lt;точно&gt;<br\/>Вот пример/);
assert.doesNotMatch(topic, /<script>/);

console.log("✓ /help рендерится структурно и безопасно экранирует тему и ответ");
