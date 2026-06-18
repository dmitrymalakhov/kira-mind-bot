import assert from "node:assert/strict";
import { isReflectionMemoryNoiseCandidate } from "../utils/reflectionMemoryFilter";

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "10 июня 2026 года Дмитрий использует ChatGPT для распознавания материалов и готов донастроить процесс.",
        tags: ["source:reflection", "temporal_scope:current_state"],
        importance: 0.7,
        confidence: 0.8,
    }),
    true
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Дмитрий занимается рабочей задачей, связанной с перегоном файла, и считает её сложной.",
        tags: ["source:reflection", "temporal_scope:current_state"],
        importance: 0.8,
        confidence: 0.75,
    }),
    true
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Юлия Горяева попросила Дмитрия распознать четыре фотографии и объединить их в один большой файл.",
        tags: ["source:reflection", "temporal_scope:past_event"],
        importance: 0.65,
        confidence: 0.8,
    }),
    true
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Владислав Баранюк находится в Туле.",
        tags: ["source:reflection", "temporal_scope:current_state"],
        importance: 0.8,
        confidence: 0.8,
    }),
    true
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Дмитрий обычно использует ChatGPT для чернового распознавания материалов.",
        tags: ["source:reflection", "temporal_scope:routine"],
        importance: 0.75,
        confidence: 0.8,
    }),
    false
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Дмитрий предпочитает короткие голосовые ответы по бытовым вопросам.",
        tags: ["source:reflection", "temporal_scope:preference"],
        importance: 0.7,
        confidence: 0.8,
    }),
    false
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "[ЭПИЗОД ПАМЯТИ: test] Источник: фоновая рефлексия чата",
        tags: ["source:reflection", "memory-episode"],
        memoryKind: "episode",
        importance: 0.6,
        confidence: 0.7,
    }),
    false
);

console.log("reflectionMemoryFilter checks passed");
