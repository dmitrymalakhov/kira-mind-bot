import assert from 'assert';
import {
    acceptsKiraLifeGroundingDecision,
    classifyKiraLifeGroundingDecision,
    chooseGroundedKiraLifeMessage,
    CONVERSATION_EPISODE_TRUST,
    hasUnsupportedKiraLifeOwnerClaim,
    isEligibleMemoryInsightSource,
    normalizeInsightSourceIndexes,
} from '../utils/proactiveGrounding';
import {
    buildProactiveSourceExplanation,
    isProactiveSourceQuestion,
    resolveProactiveSourceQuestion,
} from '../utils/proactiveSourceQuestion';
import type { SessionData } from '../types';

const unsupported = 'Ты обещала выполнить ранее названное действие.';
assert.equal(hasUnsupportedKiraLifeOwnerClaim(unsupported), true);
const fallbackEvent = 'Сегодня я закончила читать синтетический рассказ и записала одну мысль.';
const guarded = chooseGroundedKiraLifeMessage(unsupported, fallbackEvent, 'женский', 'local_guard');
assert.equal(guarded.usedFallback, true);
assert.equal(guarded.fallbackReason, 'local_guard');
assert.equal(guarded.fallbackSource, 'event');
assert.equal(guarded.message, fallbackEvent);
assert.doesNotMatch(guarded.message, /обещан/iu);

const safe = 'Сегодня я разобрала свои заметки и решила немного выдохнуть.';
assert.deepStrictEqual(chooseGroundedKiraLifeMessage(safe, fallbackEvent, 'женский'), {
    message: safe,
    usedFallback: false,
});
assert.equal(
    hasUnsupportedKiraLifeOwnerClaim('Сегодня мне нужно немного отдохнуть, поэтому я отложила свою работу.'),
    false,
);
assert.equal(hasUnsupportedKiraLifeOwnerClaim('Тебе нужно попробовать этот плейлист.'), false);
assert.equal(hasUnsupportedKiraLifeOwnerClaim('У тебя есть планы на вечер?'), false);
const lively = 'Я сегодня немного выдохнула. А ты как — ещё держишься или уже устроил себе паузу?';
assert.deepStrictEqual(chooseGroundedKiraLifeMessage(lively, fallbackEvent, 'женский'), {
    message: lively,
    usedFallback: false,
});
for (const reason of ['semantic_rejection', 'review_error', 'invalid_review'] as const) {
    const fallback = chooseGroundedKiraLifeMessage(
        'Синтетический неоднозначный кандидат',
        fallbackEvent,
        'женский',
        reason,
    );
    assert.equal(fallback.message, fallbackEvent);
    assert.equal(fallback.fallbackReason, reason);
    assert.equal(fallback.fallbackSource, 'event');
}
const emptyCandidateFallback = chooseGroundedKiraLifeMessage('', fallbackEvent, 'женский', 'empty_candidate');
assert.equal(emptyCandidateFallback.message, fallbackEvent);
assert.equal(emptyCandidateFallback.fallbackReason, 'empty_candidate');

const unsafeFallbackEvent = 'Ты забыл выполнить синтетическое действие.';
const staticFemaleFallback = chooseGroundedKiraLifeMessage(
    unsupported,
    unsafeFallbackEvent,
    'женский',
    'local_guard',
);
assert.equal(staticFemaleFallback.fallbackSource, 'static');
assert.match(staticFemaleFallback.message, /поймала себя/iu);
const staticMaleFallback = chooseGroundedKiraLifeMessage(
    unsupported,
    unsafeFallbackEvent,
    'мужской',
    'local_guard',
);
assert.equal(staticMaleFallback.fallbackSource, 'static');
assert.match(staticMaleFallback.message, /поймал себя/iu);

assert.equal(acceptsKiraLifeGroundingDecision({ safe: true, attributesOwnerObligation: false }), true);
assert.equal(acceptsKiraLifeGroundingDecision({ safe: true, attributesOwnerObligation: true }), false);
assert.equal(acceptsKiraLifeGroundingDecision({ safe: false, attributesOwnerObligation: false }), false);
assert.equal(acceptsKiraLifeGroundingDecision(undefined), false);
assert.equal(classifyKiraLifeGroundingDecision({ safe: true, attributesOwnerObligation: false }), 'safe');
assert.equal(classifyKiraLifeGroundingDecision({ safe: false, attributesOwnerObligation: true }), 'semantic_rejection');
assert.equal(classifyKiraLifeGroundingDecision({ safe: true }), 'invalid_review');
assert.equal(classifyKiraLifeGroundingDecision(undefined), 'invalid_review');

assert.equal(isEligibleMemoryInsightSource({ subject: 'user', memoryKind: 'goal', status: 'planned' }), true);
assert.equal(isEligibleMemoryInsightSource({ subject: 'system', memoryKind: 'episode', tags: ['memory-episode'] }), false);
assert.equal(isEligibleMemoryInsightSource({ subject: 'contact', memoryKind: 'goal' }), false);
assert.equal(isEligibleMemoryInsightSource({ subject: 'user', tags: ['unconfirmed'] }), false);
assert.equal(isEligibleMemoryInsightSource({ subject: 'user', status: 'done' }, 'plan'), false);
assert.equal(isEligibleMemoryInsightSource({ subject: 'user', status: 'done' }, 'done'), true);
assert.deepStrictEqual(normalizeInsightSourceIndexes([2, '1', 2, 0, 8, 'bad'], 3), [1, 2]);
assert.deepStrictEqual(normalizeInsightSourceIndexes(undefined, 3), []);
assert.equal(CONVERSATION_EPISODE_TRUST.subject, 'system');
assert(CONVERSATION_EPISODE_TRUST.tags.includes('subject:system'));

assert.equal(isProactiveSourceQuestion('Какую запись?'), true);
assert.equal(isProactiveSourceQuestion('Что за сообщение?'), true);
assert.equal(isProactiveSourceQuestion('О чём ты?'), true);
assert.equal(isProactiveSourceQuestion('Почему это опасно?'), false);

const now = 1_800_000_000_000;
const insight: NonNullable<SessionData['lastProactiveInsight']> = {
    message: 'Синтетическое проактивное сообщение',
    sourceMemories: ['Синтетическое событие внутренней жизни'],
    createdAt: now - 60_000,
    messageId: 501,
    kind: 'kiraLife',
};
const immediate = resolveProactiveSourceQuestion({
    message: 'Что за сообщение?',
    insight,
    now,
    history: [
        { role: 'user', content: 'Что за сообщение?', timestamp: new Date(now) },
        { role: 'bot', content: insight.message, timestamp: new Date(now - 60_000) },
    ],
});
assert.equal(immediate?.messageId, 501);

const intervening = resolveProactiveSourceQuestion({
    message: 'Что за сообщение?',
    insight,
    now,
    history: [
        { role: 'user', content: 'Что за сообщение?', timestamp: new Date(now) },
        { role: 'bot', content: 'Другое сообщение', timestamp: new Date(now - 10_000) },
        { role: 'bot', content: insight.message, timestamp: new Date(now - 60_000) },
    ],
});
assert.equal(intervening, undefined);

const expiredImmediate = resolveProactiveSourceQuestion({
    message: 'Что за сообщение?',
    insight: { ...insight, createdAt: now - 11 * 60_000 },
    now,
    history: [
        { role: 'user', content: 'Что за сообщение?', timestamp: new Date(now) },
        { role: 'bot', content: insight.message, timestamp: new Date(now - 11 * 60_000) },
    ],
});
assert.equal(expiredImmediate, undefined);

const replied = resolveProactiveSourceQuestion({
    message: 'Какую запись?',
    insight: { ...insight, createdAt: now - 60 * 60_000 },
    now,
    replyContext: {
        messageId: 501,
        text: insight.message,
        kind: 'proactive',
    },
});
assert.equal(replied?.messageId, 501);

const newerInsight: NonNullable<SessionData['lastProactiveInsight']> = {
    message: 'Более новое проактивное сообщение',
    sourceMemories: ['Другой синтетический источник'],
    createdAt: now - 10_000,
    messageId: 502,
    kind: 'memoryInsight',
};
const repliedToOlderMessage = resolveProactiveSourceQuestion({
    message: 'Какую запись?',
    insight: newerInsight,
    now,
    replyContext: {
        messageId: 501,
        text: insight.message,
        kind: 'proactive',
        proactiveInsight: { ...insight, createdAt: now - 60 * 60_000 },
    },
});
assert.equal(repliedToOlderMessage?.messageId, 501);
assert.equal(repliedToOlderMessage?.kind, 'kiraLife');

const explanation = buildProactiveSourceExplanation(insight);
assert.match(explanation, /внутренней линии жизни/iu);
assert.match(explanation, /не из твоей памяти/iu);
assert.match(explanation, /моя ошибка/iu);
assert.doesNotMatch(explanation, /приписала|связала|написала/iu);

const webGroundedExplanation = buildProactiveSourceExplanation({
    ...insight,
    webSources: ['https://culture.example/synthetic-event'],
});
assert.match(webGroundedExplanation, /проверены по веб-источникам/iu);
assert.match(webGroundedExplanation, /https:\/\/culture\.example\/synthetic-event/iu);

const fallbackExplanation = buildProactiveSourceExplanation({
    ...insight,
    message: 'Синтетический резервный текст',
    sourceMemories: [fallbackEvent],
    webSources: ['https://example.test/synthetic-source'],
    generationOutcome: 'fallback',
});
assert.match(fallbackExplanation, /безопасной резервной форме/iu);
assert.match(fallbackExplanation, /отправлено само событие/iu);
assert.match(fallbackExplanation, /синтетический рассказ/iu);
assert.match(fallbackExplanation, /https:\/\/example\.test\/synthetic-source/iu);
assert.doesNotMatch(fallbackExplanation, /не приписываю резервному тексту/iu);

const staticFallbackExplanation = buildProactiveSourceExplanation({
    ...insight,
    message: 'Синтетический нейтральный резервный текст',
    sourceMemories: [],
    generationOutcome: 'fallback',
});
assert.match(staticFallbackExplanation, /нейтральный текст без источников/iu);

console.log('proactive grounding checks passed');
