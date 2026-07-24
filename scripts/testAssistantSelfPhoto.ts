import assert from "node:assert/strict";
import {
  buildAssistantSelfPhotoPromptBrief,
  isAssistantSelfPhotoRequest,
} from "../utils/assistantSelfPhoto";
import { postProcessPlan } from "../orchestration/planner";

assert.equal(isAssistantSelfPhotoRequest("скинь фотку где ты сейчас"), true);
assert.equal(isAssistantSelfPhotoRequest("Пришли своё селфи"), true);
assert.equal(isAssistantSelfPhotoRequest("покажи, как ты сейчас выглядишь"), true);
assert.equal(isAssistantSelfPhotoRequest("сфоткайся"), true);
assert.equal(isAssistantSelfPhotoRequest("скинь фотку кота"), false);
assert.equal(isAssistantSelfPhotoRequest("покажи фото моей жены"), false);
assert.equal(isAssistantSelfPhotoRequest("расскажи, где ты сейчас"), false);

const prompt = buildAssistantSelfPhotoPromptBrief({
  message: "пришли фото, где ты сейчас",
  characterName: "Алиса",
  characterGender: "женский",
  persona: "Алиса воспринимает свою жизнь как непрерывную личную историю.",
  biography: "У Алисы короткие тёмные волосы и серые глаза.",
  selfLifeContext: "Настроение: задумчивое. Недавнее событие: читает дома у окна.",
  formattedDateTime: "24 июля 2026 г., пятница, 13:00",
});

assert.match(prompt, /short dark hair|короткие тёмные волосы/iu);
assert.match(prompt, /читает дома у окна/iu);
assert.match(prompt, /spontaneous phone selfie/iu);
assert.match(prompt, /not a generic character portrait/iu);
assert.doesNotMatch(prompt, /владелец любит|контекст пользователя/iu);

const malePrompt = buildAssistantSelfPhotoPromptBrief({
  message: "сфоткайся",
  characterName: "Алекс",
  characterGender: "мужской",
  persona: "Алекс живёт последовательной собственной жизнью.",
  biography: "У Алекса тёмные волосы и спортивное телосложение.",
  selfLifeContext: "",
  formattedDateTime: "24 июля 2026 г., пятница, 13:00",
});
assert.match(malePrompt, /an adult man/iu);

const forcedImagePlan = postProcessPlan(
  { steps: [{ agentId: "conversation" }] },
  {
    intent: "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ",
    confidenceLevel: "ВЫСОКИЙ",
    details: {},
  },
);
assert.deepEqual(forcedImagePlan.steps, [{ agentId: "imageGeneration" }]);

console.log("assistant self-photo checks passed");
