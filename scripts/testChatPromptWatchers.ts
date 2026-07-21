import assert from "assert";

// Этот тест импортирует chatPromptWatchers, который при загрузке тянет config.ts.
// Config требует KIRA_BOT_TOKEN и OPENAI_API_KEY — в CI или локально их может не быть.
// Задаём фиктивные значения (так же делает testAiRuntimeRouting.ts), чтобы модуль загрузился.
process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || "test-token";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai-key";
process.env.OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "http://localhost:1";

import {
    WatchDeliveryError,
    getErrorStatus,
    isTransientDeliveryError,
    runOnePoll,
    __setPollFnForTests,
    __setPollTimingForTests,
    __getPollSchedulerStateForTests,
    __stopPollSchedulerForTests,
    __bumpPollGenerationForTests,
} from "../services/chatPromptWatchers";

// ─────────────────────────────────────────────────────────────────────────────
// Классификация ошибок доставки: постоянная (повторять бессмысленно) или временная (повторить позже)
// ─────────────────────────────────────────────────────────────────────────────

async function testGetErrorStatusReadsGrammyErrorCode(): Promise<void> {
    const grammyError = Object.assign(new Error("Forbidden: bot was blocked by the user"), {
        error_code: 403,
    });
    assert.strictEqual(getErrorStatus(grammyError), 403, "достаёт error_code из GrammyError");

    const fetchError = Object.assign(new Error("server error"), { status: 503 });
    assert.strictEqual(getErrorStatus(fetchError), 503, "достаёт status из fetch-ошибки");

    const axiosLike = Object.assign(new Error("bad gateway"), { response: { status: 502 } });
    assert.strictEqual(getErrorStatus(axiosLike), 502, "достаёт response.status");

    assert.strictEqual(getErrorStatus(new Error("без кода")), undefined, "без кода → undefined");
}

async function testIsTransientTreats400And403AsPermanent(): Promise<void> {
    const forbidden = Object.assign(new Error("blocked"), { error_code: 403 });
    const badRequest = Object.assign(new Error("chat not found"), { error_code: 400 });
    const rateLimit = Object.assign(new Error("too many requests"), { error_code: 429 });
    const serverError = Object.assign(new Error("internal"), { status: 500 });
    const network = new Error("ETIMEDOUT");

    assert.strictEqual(isTransientDeliveryError(forbidden), false, "403 = permanent");
    assert.strictEqual(isTransientDeliveryError(badRequest), false, "400 = permanent");
    assert.strictEqual(isTransientDeliveryError(rateLimit), true, "429 = transient");
    assert.strictEqual(isTransientDeliveryError(serverError), true, "5xx = transient");
    assert.strictEqual(isTransientDeliveryError(network), true, "без статуса = transient (safe default)");
}

async function testWatchDeliveryErrorKeepsTargetAndFallbackSeparate(): Promise<void> {
    const targetError = Object.assign(new Error("Forbidden"), { error_code: 403 });
    const fallbackError = new Error("ETIMEDOUT");

    const wrapped = new WatchDeliveryError(targetError, fallbackError);
    assert.strictEqual(wrapped.targetError, targetError, "сохраняет исходную ошибку целевого чата");
    assert.strictEqual(wrapped.fallbackError, fallbackError, "сохраняет ошибку повторной отправки владельцу");
}

/**
 * Сценарий: целевой чат отдал 403 (навсегда недоступен), а повторная отправка
 * уведомления владельцу упала по сети. Классификация должна идти по ошибке
 * целевого чата — тогда watcher признаёт её постоянной и не повторяет те же
 * сообщения каждый poll.
 */
async function testTargetPermanentWithFallbackFailureClassifiedAsPermanent(): Promise<void> {
    const targetError = Object.assign(new Error("Forbidden"), { error_code: 403 });
    const fallbackError = new Error("ETIMEDOUT");
    const wrapped = new WatchDeliveryError(targetError, fallbackError);

    // Решение принимается по wrapped.targetError, а не по wrapped целиком.
    assert.strictEqual(
        isTransientDeliveryError(wrapped.targetError),
        false,
        "403 от целевого чата = permanent, несмотря на временную ошибку сети при отправке владельцу",
    );
    assert.strictEqual(
        isTransientDeliveryError(fallbackError),
        true,
        "сама сетевая ошибка временная, но она не определяет решение",
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Планировщик опроса: зависший poll не должен порождать вторую timer-цепочку
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сценарий: poll запустился, но пока выполнялся, watchdog признал его зависшим и
 * запустил новый poll. Когда зависший poll наконец завершится, он НЕ должен
 * планировать очередной таймер — иначе получится две параллельных цепочки таймеров.
 *
 * Проверка: вызываем runOnePoll, а внутри подмененной функции опроса имитируем
 * срабатывание watchdog-а (увеличиваем счётчик циклов). Если runOnePoll видит, что
 * счётчик изменился, он должен вернуть false — значит вызывающий код не запланирует
 * новый таймер (это сделает watchdog).
 */
async function testRunOnePollReturnsFalseWhenGenerationChanged(): Promise<void> {
    __stopPollSchedulerForTests();
    const restoreTiming = __setPollTimingForTests({ intervalMs: 10, stuckTimeoutMs: 20 });

    const restorePoll = __setPollFnForTests(async () => {
        // Имитируем watchdog: пока этот poll выполнялся, счётчик циклов увеличился
        // (в проде это делает watchdog на отдельном setInterval, когда poll зависает).
        const state = __getPollSchedulerStateForTests();
        assert.strictEqual(state.pollRunning, true, "poll отмечен как выполняющийся");
        __bumpPollGenerationForTests();
    });

    try {
        const shouldContinue = await runOnePoll({} as never);
        assert.strictEqual(shouldContinue, false, "после замены poll не должен планировать новый таймер");

        const state = __getPollSchedulerStateForTests();
        assert.strictEqual(state.pollGeneration, 1, "счётчик циклов увеличился");
    } finally {
        restoreTiming();
        restorePoll();
        __stopPollSchedulerForTests();
    }
}

/**
 * Обратный случай: poll завершился нормально, никто его не прерывал. Тогда runOnePoll
 * возвращает true, и вызывающий код планирует следующий poll — ровно одна цепочка таймеров.
 */
async function testRunOnePollReturnsTrueWhenGenerationStable(): Promise<void> {
    __stopPollSchedulerForTests();
    const restoreTiming = __setPollTimingForTests({ intervalMs: 10, stuckTimeoutMs: 20 });
    let pollRan = false;
    const restorePoll = __setPollFnForTests(async () => { pollRan = true; });

    try {
        const shouldContinue = await runOnePoll({} as never);
        assert.strictEqual(shouldContinue, true, "при нормальном завершении poll планирует следующий цикл");
        assert.strictEqual(pollRan, true, "функция опроса выполнена");
        const state = __getPollSchedulerStateForTests();
        assert.strictEqual(state.pollRunning, false, "флаг выполнения сброшен после завершения");
        assert.strictEqual(state.pollGeneration, 0, "счётчик циклов не менялся");
    } finally {
        restoreTiming();
        restorePoll();
        __stopPollSchedulerForTests();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const tests: Array<{ name: string; fn: () => Promise<void> }> = [
        { name: "getErrorStatus reads grammy error_code", fn: testGetErrorStatusReadsGrammyErrorCode },
        { name: "isTransient treats 400/403 as permanent", fn: testIsTransientTreats400And403AsPermanent },
        { name: "WatchDeliveryError keeps target/fallback separate", fn: testWatchDeliveryErrorKeepsTargetAndFallbackSeparate },
        { name: "target 403 + fallback failure → permanent", fn: testTargetPermanentWithFallbackFailureClassifiedAsPermanent },
        { name: "runOnePoll returns false when generation changed", fn: testRunOnePollReturnsFalseWhenGenerationChanged },
        { name: "runOnePoll returns true when generation stable", fn: testRunOnePollReturnsTrueWhenGenerationStable },
    ];

    let failed = 0;
    for (const test of tests) {
        try {
            await test.fn();
            console.log(`  ✓ ${test.name}`);
        } catch (error) {
            failed += 1;
            console.error(`  ✗ ${test.name}`);
            console.error(error);
        }
    }

    if (failed > 0) {
        console.error(`\n${failed}/${tests.length} тестов провалено`);
        process.exit(1);
    }
    console.log(`\nchatPromptWatchers checks passed (${tests.length} tests)`);
    // Гарантированный выход: тесты не должны оставлять открытых таймеров,
    // но подстраховываемся от зависания процесса на всякий случай.
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
