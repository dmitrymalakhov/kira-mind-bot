import assert from "node:assert/strict";
import {
    getReflectionMemoryNoiseReasons,
    isReflectionContactAttributionSupported,
    isReflectionFactAttributionSupported,
    isReflectionMemoryNoiseCandidate,
} from "../utils/reflectionMemoryFilter";

assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакту Альфа назначили медицинскую процедуру',
    subject: 'contact',
    evidence: 'В понедельник будет медицинская процедура',
}, 'Контакт Альфа'), false);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакту Альфа назначили медицинскую процедуру',
    subject: 'contact',
    evidence: '[10:00] Контакт Альфа: В понедельник будет медицинская процедура',
}, 'Контакт Альфа'), false);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакт Альфа работает с пользователем',
    subject: 'contact',
    evidence: '[10:00] Контакт Альфа: Я вместе с пользователем работаю',
}, 'Контакт Альфа'), true);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакт Альфа работает с пользователем',
    subject: 'contact',
    evidence: 'Я вместе с пользователем работаю',
}, 'Контакт Альфа'), false);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакт Альфа работает удалённо',
    subject: 'contact',
    evidence: 'Контакт Альфа работает удалённо',
}, 'Контакт Альфа'), true);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакту Альфа назначили медицинскую процедуру',
    subject: 'contact',
    evidence: 'Про Контакт Альфа сказали, что медицинская процедура назначена родственнику',
}, 'Контакт Альфа'), false);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакт Альфа работает удалённо',
    subject: 'contact',
    evidence: '[10:00] Пользователь Тест: ты работаешь удалённо',
}, 'Контакт Альфа', 'Пользователь Тест'), true);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакту Альфа назначили медицинскую процедуру',
    subject: 'contact',
    evidence: '[10:00] Контакт Альфа: Процедуру назначили родственнику\n[10:01] Пользователь Тест: Я работаю удалённо',
}, 'Контакт Альфа', 'Пользователь Тест'), false);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Контакт Альфа работает удалённо',
    subject: 'contact',
    evidence: '[10:00] Пользователь Тест: Контакт Альфа работает удалённо',
}, 'Контакт Альфа', 'Пользователь Тест'), true);
assert.equal(isReflectionContactAttributionSupported({
    content: 'Медицинская процедура назначена родственнику контакта',
    subject: 'third_party',
    evidence: 'Моему родственнику назначили медицинскую процедуру',
}, 'Контакт Альфа'), true);

assert.equal(isReflectionFactAttributionSupported({
    content: 'Пользователь Тест работает удалённо',
    subject: 'user',
    evidence: '[10:00] Контакт Альфа: я работаю удалённо',
}, 'Контакт Альфа', 'Пользователь Тест'), false);
assert.equal(isReflectionFactAttributionSupported({
    content: 'Пользователь Тест работает удалённо',
    subject: 'user',
    evidence: '[10:00] Пользователь Тест: я работаю удалённо',
}, 'Контакт Альфа', 'Пользователь Тест'), true);
assert.equal(isReflectionFactAttributionSupported({
    content: 'Контакту Альфа назначили медицинскую процедуру',
    subject: 'contact',
    evidence: '[10:00] Контакт Альфа: моей маме назначили медицинскую процедуру',
}, 'Контакт Альфа', 'Пользователь Тест'), false);

const chatGptRecognition = {
        content: "10 июня 2026 года Пользователь Тест использует ChatGPT для распознавания материалов и готов донастроить процесс.",
        tags: ["source:reflection", "temporal_scope:current_state"],
        importance: 0.7,
        confidence: 0.8,
};

assert.equal(isReflectionMemoryNoiseCandidate(chatGptRecognition), true);
assert.deepEqual(getReflectionMemoryNoiseReasons(chatGptRecognition), ["technical_process", "one_off_activity"]);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Пользователь Тест занимается рабочей задачей, связанной с перегоном файла, и считает её сложной.",
        tags: ["source:reflection", "temporal_scope:current_state"],
        importance: 0.8,
        confidence: 0.75,
    }),
    true
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Контакт Альфа попросил Пользователя Тест распознать четыре фотографии и объединить их в один большой файл.",
        tags: ["source:reflection", "temporal_scope:past_event"],
        importance: 0.65,
        confidence: 0.8,
    }),
    true
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Контакт Бета находится в Тестовом городе.",
        tags: ["source:reflection", "temporal_scope:current_state"],
        importance: 0.8,
        confidence: 0.8,
    }),
    true
);

assert.deepEqual(
    getReflectionMemoryNoiseReasons({
        content: "Контакт Бета находится в Тестовом городе.",
        tags: ["source:reflection"],
        importance: 0.8,
        confidence: 0.8,
    }),
    ["temporary_state"]
);

assert.deepEqual(
    getReflectionMemoryNoiseReasons({
        content: "Контакт Бета пока в Тестовом городе.",
        tags: ["source:reflection"],
        importance: 0.9,
        confidence: 0.8,
    }),
    ["temporary_state"]
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Контакт Бета сейчас в больнице.",
        tags: ["source:reflection"],
        importance: 0.9,
        confidence: 0.8,
    }),
    false
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Пользователь Тест обычно использует ChatGPT для чернового распознавания материалов.",
        tags: ["source:reflection", "temporal_scope:routine"],
        importance: 0.75,
        confidence: 0.8,
    }),
    false
);

assert.equal(
    isReflectionMemoryNoiseCandidate({
        content: "Пользователь Тест предпочитает короткие голосовые ответы по бытовым вопросам.",
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
