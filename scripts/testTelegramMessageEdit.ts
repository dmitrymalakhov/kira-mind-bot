import assert from "assert";
import type { InlineKeyboardMarkup } from "grammy/types";
import {
    editMessageTextIfChanged,
    editReplyMarkupIfChanged,
    recordReplyMarkupState,
    runNonCriticalTelegramEdit,
} from "../utils/telegramMessageEdit";
import { editStructured, paragraph } from "../utils/richMessage";

const oldMarkup: InlineKeyboardMarkup = {
    inline_keyboard: [[{ text: "Старая кнопка", callback_data: "old" }]],
};
const emptyMarkup: InlineKeyboardMarkup = { inline_keyboard: [] };

function namedMarkup(name: string): InlineKeyboardMarkup {
    return { inline_keyboard: [[{ text: name, callback_data: name }]] };
}

function message(replyMarkup: InlineKeyboardMarkup = oldMarkup) {
    return {
        message_id: 42,
        chat: { id: 1001 },
        reply_markup: replyMarkup,
    };
}

async function testSkipsUnchangedMarkup(): Promise<void> {
    let calls = 0;
    const api = {
        editMessageReplyMarkup: async () => {
            calls += 1;
        },
    };

    const changed = await editReplyMarkupIfChanged(api, message(emptyMarkup), emptyMarkup);

    assert.equal(changed, false);
    assert.equal(calls, 0, "одинаковая клавиатура не должна отправляться в Telegram");
}

async function testSerializesConcurrentDuplicates(): Promise<void> {
    let calls = 0;
    let releaseFirst!: () => void;
    const firstCall = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });
    const api = {
        editMessageReplyMarkup: async () => {
            calls += 1;
            await firstCall;
        },
    };
    const callbackMessage = message();

    const first = editReplyMarkupIfChanged(api, callbackMessage, emptyMarkup);
    const second = editReplyMarkupIfChanged(api, callbackMessage, emptyMarkup);
    await Promise.resolve();
    assert.equal(calls, 1, "первое изменение должно начаться сразу");

    releaseFirst();
    const results = await Promise.all([first, second]);

    assert.deepStrictEqual(results, [true, false]);
    assert.equal(calls, 1, "конкурентный дубль не должен создавать второй API-вызов");
}

async function testSkipsSequentialStaleCallback(): Promise<void> {
    let calls = 0;
    const api = {
        editMessageReplyMarkup: async () => {
            calls += 1;
        },
    };
    const firstMessage = {
        ...message(),
        message_id: 43,
    };

    const first = await editReplyMarkupIfChanged(api, firstMessage, emptyMarkup);
    const staleDuplicate = await editReplyMarkupIfChanged(api, firstMessage, emptyMarkup);

    assert.equal(first, true);
    assert.equal(staleDuplicate, false);
    assert.equal(calls, 1, "последовательный callback со старым snapshot не должен повторять API-вызов");
}

async function testTrustsRecordedExternalState(): Promise<void> {
    let markupCalls = 0;
    let textCalls = 0;
    const api = {
        editMessageReplyMarkup: async () => {
            markupCalls += 1;
        },
        editMessageText: async () => {
            textCalls += 1;
            return { message_id: 44 };
        },
        sendRichMessage: async () => ({ message_id: 44 }),
        sendMessage: async () => ({ message_id: 44 }),
    };
    const firstMessage = {
        ...message(),
        message_id: 44,
    };

    const first = await editReplyMarkupIfChanged(api, firstMessage, emptyMarkup);
    const previousRichSetting = process.env.RICH_MESSAGES_ENABLED;
    process.env.RICH_MESSAGES_ENABLED = "false";
    try {
        await editStructured(
            api as any,
            firstMessage.chat.id,
            firstMessage.message_id,
            [paragraph("Карточка восстановлена")],
            { replyMarkup: oldMarkup },
        );
    } finally {
        if (previousRichSetting === undefined) {
            delete process.env.RICH_MESSAGES_ENABLED;
        } else {
            process.env.RICH_MESSAGES_ENABLED = previousRichSetting;
        }
    }
    const restoredMessage = {
        ...firstMessage,
        reply_markup: oldMarkup,
    };
    const afterExternalRestore = await editReplyMarkupIfChanged(api, restoredMessage, emptyMarkup);

    assert.equal(first, true);
    assert.equal(afterExternalRestore, true);
    assert.equal(markupCalls, 2, "фактически восстановленную клавиатуру нужно изменить повторно");
    assert.equal(textCalls, 1, "восстановление через editStructured должно быть выполнено");
}

async function testCanonicalizesButtonPropertyOrder(): Promise<void> {
    let calls = 0;
    const api = {
        editMessageReplyMarkup: async () => {
            calls += 1;
        },
    };
    const observedMarkup = {
        inline_keyboard: [[{ callback_data: "same", text: "Та же кнопка" }]],
    } as InlineKeyboardMarkup;
    const desiredMarkup = {
        inline_keyboard: [[{ text: "Та же кнопка", callback_data: "same" }]],
    } as InlineKeyboardMarkup;

    const changed = await editReplyMarkupIfChanged(
        api,
        { ...message(observedMarkup), message_id: 45 },
        desiredMarkup,
    );

    assert.equal(changed, false);
    assert.equal(calls, 0, "порядок полей кнопки не должен создавать ложное изменение");
}

async function testRecordedAtomicTransitionSkipsStaleCallback(): Promise<void> {
    let calls = 0;
    const api = {
        editMessageReplyMarkup: async () => {
            calls += 1;
        },
    };
    const messageId = 46;

    recordReplyMarkupState(1001, messageId, emptyMarkup, oldMarkup);
    const changed = await editReplyMarkupIfChanged(
        api,
        { ...message(oldMarkup), message_id: messageId },
        emptyMarkup,
    );

    assert.equal(changed, false);
    assert.equal(calls, 0, "stale callback не должен повторять уже выполненный атомарный переход");
}

async function testSkipsCallbackOlderThanOneTransition(): Promise<void> {
    const applied: string[] = [];
    const api = {
        editMessageReplyMarkup: async (
            _chatId: number | string,
            _messageId: number,
            options: { reply_markup: InlineKeyboardMarkup },
        ) => {
            applied.push(options.reply_markup.inline_keyboard[0][0].text);
        },
    };
    const messageId = 47;
    const markupA = namedMarkup("A");
    const markupB = namedMarkup("B");
    const markupC = namedMarkup("C");

    await editReplyMarkupIfChanged(api, { ...message(markupA), message_id: messageId }, markupB);
    await editReplyMarkupIfChanged(api, { ...message(markupB), message_id: messageId }, markupC);
    const staleChanged = await editReplyMarkupIfChanged(
        api,
        { ...message(markupA), message_id: messageId },
        markupB,
    );

    assert.equal(staleChanged, false);
    assert.deepStrictEqual(applied, ["B", "C"], "старый A→B не должен откатывать актуальное состояние C");
}

async function testSkipsDuplicateStructuredEdit(): Promise<void> {
    let editCalls = 0;
    const api = {
        editMessageReplyMarkup: async () => undefined,
        editMessageText: async () => {
            editCalls += 1;
            return { message_id: 48 };
        },
        sendRichMessage: async () => ({ message_id: 48 }),
        sendMessage: async () => ({ message_id: 48 }),
    };
    const previousRichSetting = process.env.RICH_MESSAGES_ENABLED;
    process.env.RICH_MESSAGES_ENABLED = "false";

    try {
        const blocks = [paragraph("Одинаковое состояние")];
        await editStructured(api as any, 1001, 48, blocks, { replyMarkup: emptyMarkup });
        await editStructured(api as any, 1001, 48, blocks, { replyMarkup: emptyMarkup });
    } finally {
        if (previousRichSetting === undefined) {
            delete process.env.RICH_MESSAGES_ENABLED;
        } else {
            process.env.RICH_MESSAGES_ENABLED = previousRichSetting;
        }
    }

    assert.equal(editCalls, 1, "повторный editStructured не должен обращаться к Telegram");
}

async function testSkipsDuplicatePlainTextEdit(): Promise<void> {
    let editCalls = 0;
    const api = {
        editMessageText: async () => {
            editCalls += 1;
            return { message_id: 49 };
        },
    };
    const options = { reply_markup: emptyMarkup };

    await editMessageTextIfChanged(api, 1001, 49, "Одинаковый текст", options);
    await editMessageTextIfChanged(api, 1001, 49, "Одинаковый текст", options);

    assert.equal(editCalls, 1, "повторный plain-text edit не должен обращаться к Telegram");
}

async function testPlainTextEditInvalidatesStructuredState(): Promise<void> {
    let editCalls = 0;
    const api = {
        editMessageReplyMarkup: async () => undefined,
        editMessageText: async () => {
            editCalls += 1;
            return { message_id: 50 };
        },
        sendRichMessage: async () => ({ message_id: 50 }),
        sendMessage: async () => ({ message_id: 50 }),
    };
    const previousRichSetting = process.env.RICH_MESSAGES_ENABLED;
    process.env.RICH_MESSAGES_ENABLED = "false";

    try {
        const blocks = [paragraph("Структурная карточка")];
        await editStructured(api as any, 1001, 50, blocks, { replyMarkup: oldMarkup });
        await editMessageTextIfChanged(api, 1001, 50, "Промежуточный текст", { reply_markup: emptyMarkup });
        await editStructured(api as any, 1001, 50, blocks, { replyMarkup: oldMarkup });
    } finally {
        if (previousRichSetting === undefined) {
            delete process.env.RICH_MESSAGES_ENABLED;
        } else {
            process.env.RICH_MESSAGES_ENABLED = previousRichSetting;
        }
    }

    assert.equal(editCalls, 3, "внешнее plain-text изменение должно инвалидировать structured fingerprint");
}

async function testMarkupOnlyEditInvalidatesStructuredState(): Promise<void> {
    let textEditCalls = 0;
    let markupEditCalls = 0;
    const api = {
        editMessageReplyMarkup: async () => {
            markupEditCalls += 1;
        },
        editMessageText: async () => {
            textEditCalls += 1;
            return { message_id: 51 };
        },
        sendRichMessage: async () => ({ message_id: 51 }),
        sendMessage: async () => ({ message_id: 51 }),
    };
    const previousRichSetting = process.env.RICH_MESSAGES_ENABLED;
    process.env.RICH_MESSAGES_ENABLED = "false";

    try {
        const blocks = [paragraph("Структурная карточка")];
        await editStructured(api as any, 1001, 51, blocks, { replyMarkup: oldMarkup });
        await editReplyMarkupIfChanged(
            api,
            { ...message(oldMarkup), message_id: 51 },
            emptyMarkup,
        );
        await editStructured(api as any, 1001, 51, blocks, { replyMarkup: oldMarkup });
    } finally {
        if (previousRichSetting === undefined) {
            delete process.env.RICH_MESSAGES_ENABLED;
        } else {
            process.env.RICH_MESSAGES_ENABLED = previousRichSetting;
        }
    }

    assert.equal(markupEditCalls, 1);
    assert.equal(textEditCalls, 2, "markup-only изменение должно инвалидировать structured fingerprint");
}

async function testPreservesDifferentUpdateOrder(): Promise<void> {
    const calls: InlineKeyboardMarkup[] = [];
    const firstMarkup: InlineKeyboardMarkup = {
        inline_keyboard: [[{ text: "Первая", callback_data: "first" }]],
    };
    const secondMarkup: InlineKeyboardMarkup = {
        inline_keyboard: [[{ text: "Вторая", callback_data: "second" }]],
    };
    const api = {
        editMessageReplyMarkup: async (
            _chatId: number | string,
            _messageId: number,
            options: { reply_markup: InlineKeyboardMarkup },
        ) => {
            calls.push(options.reply_markup);
        },
    };
    const callbackMessage = message();

    await Promise.all([
        editReplyMarkupIfChanged(api, callbackMessage, firstMarkup),
        editReplyMarkupIfChanged(api, callbackMessage, secondMarkup),
    ]);

    assert.deepStrictEqual(calls, [firstMarkup, secondMarkup]);
}

async function testPropagatesErrorsAndAllowsRetry(): Promise<void> {
    const expectedError = new Error("Telegram unavailable");
    let calls = 0;
    const api = {
        editMessageReplyMarkup: async () => {
            calls += 1;
            if (calls === 1) throw expectedError;
        },
    };
    const callbackMessage = message();

    await assert.rejects(
        () => editReplyMarkupIfChanged(api, callbackMessage, emptyMarkup),
        (error: unknown) => error === expectedError,
    );
    const changed = await editReplyMarkupIfChanged(api, callbackMessage, emptyMarkup);

    assert.equal(changed, true);
    assert.equal(calls, 2, "ошибка не должна кешировать неприменённое состояние");
}

async function testNonCriticalEditLogsAndContinues(): Promise<void> {
    const expectedError = new Error("Telegram unavailable");
    const originalConsoleError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
        logged.push(args);
    };

    try {
        const success = await runNonCriticalTelegramEdit("test update", async () => {
            throw expectedError;
        });

        assert.equal(success, false);
        assert.equal(logged.length, 1, "реальная ошибка должна попасть в лог");
        assert.equal(logged[0][1], expectedError);
    } finally {
        console.error = originalConsoleError;
    }
}

async function main(): Promise<void> {
    await testSkipsUnchangedMarkup();
    await testSerializesConcurrentDuplicates();
    await testSkipsSequentialStaleCallback();
    await testTrustsRecordedExternalState();
    await testCanonicalizesButtonPropertyOrder();
    await testRecordedAtomicTransitionSkipsStaleCallback();
    await testSkipsCallbackOlderThanOneTransition();
    await testSkipsDuplicateStructuredEdit();
    await testSkipsDuplicatePlainTextEdit();
    await testPlainTextEditInvalidatesStructuredState();
    await testMarkupOnlyEditInvalidatesStructuredState();
    await testPreservesDifferentUpdateOrder();
    await testPropagatesErrorsAndAllowsRetry();
    await testNonCriticalEditLogsAndContinues();
    console.log("telegram message edit checks passed");
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
