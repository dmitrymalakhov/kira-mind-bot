import assert from "node:assert/strict";
import test from "node:test";
import {
  buildKiraResidenceUpdate,
  extractDirectKiraRelocationCity,
  looksLikeKiraRelocationRequest,
  normalizeKiraResidenceCity,
  parseKiraResidenceSetting,
} from "../utils/kiraResidence";
import { buildKiraLifeWebGroundingQuery } from "../utils/kiraLifeWebGrounding";

test("recognizes an explicit relocation request addressed to Kira", () => {
  assert.equal(looksLikeKiraRelocationRequest("Кира, переедь в Москву"), true);
  assert.equal(looksLikeKiraRelocationRequest("Хочу, чтобы ты жила в Казани"), true);
  assert.equal(looksLikeKiraRelocationRequest("Кира, может, переедешь в Калининград?"), true);
  assert.equal(looksLikeKiraRelocationRequest("Я переезжаю в Москву"), false);
  assert.equal(looksLikeKiraRelocationRequest("Не переезжай в Москву"), false);
  assert.equal(looksLikeKiraRelocationRequest("Как тебе идея переезда в Москву?"), false);
  assert.equal(extractDirectKiraRelocationCity("Кира, переедь в Москву, пожалуйста"), "Москва");
  assert.equal(extractDirectKiraRelocationCity("Хочу, чтобы ты жила в Казани"), "Казань");
});

test("normalizes and persists current residence separately from origin", () => {
  assert.equal(normalizeKiraResidenceCity("  город Санкт-Петербург "), "Санкт-Петербург");
  assert.equal(normalizeKiraResidenceCity("https://example.com"), null);

  const current = parseKiraResidenceSetting(null, "Санкт-Петербург");
  const update = buildKiraResidenceUpdate(current, "Казань", "conversation", "2026-09-01T08:00:00.000Z");
  assert.equal(update.changed, true);
  assert.deepEqual(update.residence, {
    city: "Казань",
    previousCity: "Санкт-Петербург",
    movedAt: "2026-09-01T08:00:00.000Z",
    source: "conversation",
  });
  assert.deepEqual(parseKiraResidenceSetting(JSON.stringify(update.residence), "Санкт-Петербург"), update.residence);
  assert.equal(buildKiraResidenceUpdate(update.residence, "казань", "admin").changed, false);
});

test("Kira Life grounding treats current residence as authoritative", () => {
  const query = buildKiraLifeWebGroundingQuery({
    characterName: "Кира",
    currentDateTime: "1 сентября 2026, 12:00",
    timezone: "Europe/Moscow",
    currentResidence: "Казань",
    biography: "Выросла и училась в Санкт-Петербурге.",
    personalitySnapshot: "Происхождение: Санкт-Петербург\nПредпочтения: камерное кино",
    recentTopics: "прогулки",
  });

  assert.match(query, /Текущее место жизни персонажа: Казань/iu);
  assert.match(query, /город происхождения.+не считай текущими/iu);
});
