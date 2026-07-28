import assert from "assert";
import {
  buildKiraLifeWebGroundingQuery,
  extractKiraLifeWebSources,
  parseKiraLifeWebGrounding,
  selectKiraLifeWebProfileContext,
} from "../utils/kiraLifeWebGrounding";

const query = buildKiraLifeWebGroundingQuery({
  characterName: "Алиса",
  currentDateTime: "28 июля 2026 года, вторник, 18:30",
  timezone: "Europe/Moscow",
  biography: "Алиса живёт в Казани, бегает длинные дистанции, выращивает орхидеи и чинит плёночные камеры.",
  personalitySnapshot: [
    "Предпочтения: индустриальная архитектура, итальянский язык.",
    "Долгие линии жизни: чаще выходить из дома.",
    "Отношение к владельцу: приватная синтетическая деталь.",
    "Следы разговоров: ещё одна приватная синтетическая деталь.",
  ].join("\n"),
  recentTopics: "прогулка, вода",
});

assert.match(query, /Казани/u);
assert.match(query, /выращивает орхидеи/u);
assert.match(query, /плёночные камеры/u);
assert.match(query, /итальянский язык/u);
assert.match(query, /текущее место жизни явно следует из биографии/u);
assert.match(query, /сам определи тип внешней опоры/u);
assert.match(query, /НЕ закрытый список категорий/u);
assert.match(query, /лишь возможные примеры/u);
assert.match(query, /не делай каждую опору локальной/u);
assert.match(query, /устойчивый внешний факт/u);
assert.match(query, /РЕАЛЬНАЯ ДЕТАЛЬ/u);
assert.match(query, /КОНТЕКСТ ИЗ ИСТОЧНИКОВ/u);
assert.doesNotMatch(query, /Выбери один сценарий/u);
assert.match(query, /NO_GROUNDING/u);
assert.doesNotMatch(query, /приватная синтетическая деталь/u);

assert.equal(
  selectKiraLifeWebProfileContext([
    "Происхождение: Казань",
    "Предпочтения: городское кино",
    "Отношение к владельцу: не отправлять в поиск",
  ].join("\n")),
  "Происхождение: Казань\nПредпочтения: городское кино",
);

const resultText = [
  "ОПОРА: синтетическое исследование о ритме бега",
  "МЕСТО/ВРЕМЯ: не требуется",
  "ПОЧЕМУ ПОДХОДИТ: продолжает интерес к длинным дистанциям",
  "РЕАЛЬНАЯ ДЕТАЛЬ: исследование сравнивает устойчивость нескольких вариантов каденса",
  "КОНТЕКСТ ИЗ ИСТОЧНИКОВ: профильный обзор советует адаптировать выводы к опыту бегуна",
  "ИСТОЧНИКИ:",
  "https://cinema.example/schedule?utm_source=test",
  "https://reviews.example/long-street",
  "https://reviews.example/long-street",
].join("\n");

const grounding = parseKiraLifeWebGrounding(resultText, "2026-07-28T15:30:00.000Z");
assert(grounding);
assert.equal(grounding.researchedAt, "2026-07-28T15:30:00.000Z");
assert.deepEqual(grounding.sources, [
  "https://cinema.example/schedule",
  "https://reviews.example/long-street",
]);
assert.match(grounding.summary, /ритме бега/u);

assert.deepEqual(
  extractKiraLifeWebSources("Официально: (https://example.org/item?fbclid=tracking)."),
  ["https://example.org/item"],
);
assert.equal(parseKiraLifeWebGrounding("NO_GROUNDING"), undefined);
assert.equal(
  parseKiraLifeWebGrounding("ОПОРА: название есть, но прямого веб-источника для проверки актуальности нет.".repeat(3)),
  undefined,
);

console.log("kira life web grounding checks passed");
