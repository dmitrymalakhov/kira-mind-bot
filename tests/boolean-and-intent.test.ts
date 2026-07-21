import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isStatusCommandArg, parseBooleanCommandArg } from "../utils/booleanCommandArg";
import {
    isBrowserTaskCancellationChoice,
    isDirectBrowserCancellationCommand,
    looksLikeBrowserTaskCancellation,
    looksLikeNegatedBookingRequest,
} from "../utils/browserTaskCancellation";
import { isTodayImportanceRequest } from "../utils/todayImportanceIntent";

describe("boolean command arguments", () => {
    test("recognizes empty and explicit status arguments", () => {
        for (const value of ["", "   ", "status", "STATUS", "статус", " СтАтУс "]) {
            assert.equal(isStatusCommandArg(value), true, value);
            assert.equal(parseBooleanCommandArg(value), undefined, value);
        }
    });

    test("parses all supported true values", () => {
        for (const value of ["on", "true", "1", "yes", "enable", "enabled", "вкл", "да", "включить"]) {
            assert.equal(parseBooleanCommandArg(value), true, value);
        }
    });

    test("parses all supported false values", () => {
        for (const value of ["off", "false", "0", "no", "disable", "disabled", "выкл", "нет", "выключить"]) {
            assert.equal(parseBooleanCommandArg(value), false, value);
        }
    });

    test("normalizes casing and surrounding whitespace", () => {
        assert.equal(parseBooleanCommandArg("  ENABLED  "), true);
        assert.equal(parseBooleanCommandArg("  ВыКл  "), false);
    });

    test("does not guess unsupported values", () => {
        for (const value of ["maybe", "2", "включено", "выключено", "давай"]) {
            assert.equal(parseBooleanCommandArg(value), undefined, value);
            assert.equal(isStatusCommandArg(value), false, value);
        }
    });
});

describe("browser task cancellation intent", () => {
    test("recognizes direct cancellation commands", () => {
        const cases = [
            "отмена",
            "Отмени!",
            "cancel",
            "STOP",
            "стоп...",
            "просто останови всё",
            "остановить все действия",
            "не продолжай",
            "ничего не делай",
            "просто остановить задачу",
        ];
        for (const value of cases) assert.equal(isDirectBrowserCancellationCommand(value), true, value);
    });

    test("does not mistake descriptive text for a direct command", () => {
        const cases = [
            "как отменить бронь?",
            "кнопка отмена не работает",
            "не останавливай задачу",
            "стоп-кран",
            "продолжай",
            "",
        ];
        for (const value of cases) assert.equal(isDirectBrowserCancellationCommand(value), false, value);
    });

    test("recognizes negated booking requests", () => {
        const cases = [
            "Я больше не хочу бронировать столик",
            "мы не будем записываться к врачу",
            "мне не нужно оформлять заявку",
            "передумал регистрироваться на курс",
            "отбой, бронь больше не нужна",
            "не записывай меня",
            "не бронируй нас",
        ];
        for (const value of cases) assert.equal(looksLikeNegatedBookingRequest(value), true, value);
    });

    test("requires both negation and a booking action", () => {
        const cases = [
            "я хочу забронировать столик",
            "я не хочу продолжать разговор",
            "бронь подтверждена",
            "не актуально",
            "зарегистрируй меня",
        ];
        for (const value of cases) assert.equal(looksLikeNegatedBookingRequest(value), false, value);
    });

    test("recognizes explicit cancellation around an action", () => {
        const cases = [
            "отмени бронирование столика",
            "останови регистрацию на мероприятие",
            "заявку нужно отменить",
            "бронь в ресторане прекрати",
        ];
        for (const value of cases) assert.equal(looksLikeBrowserTaskCancellation(value), true, value);
    });

    test("recognizes cancellation choices tied to an active task", () => {
        const cases = [
            "Отменить уже начатую задачу",
            "Остановить браузерную задачу",
            "Прекратить оформление заявки",
            "не хочу бронировать",
        ];
        for (const value of cases) assert.equal(isBrowserTaskCancellationChoice(value), true, value);
        assert.equal(isBrowserTaskCancellationChoice("Просто обсудим варианты"), false);
    });
});

describe("today importance intent", () => {
    test("recognizes Russian agenda and priority questions", () => {
        const cases = [
            "Что важного у меня сегодня?",
            "Какие планы на сегодня",
            "Есть ли что-нибудь важное сегодня?",
            "Что у меня сегодня по задачам и дедлайнам?",
            "Покажи сегодняшнее расписание",
            "Какие встречи предстоят сегодня",
        ];
        for (const value of cases) assert.equal(isTodayImportanceRequest(value), true, value);
    });

    test("recognizes English agenda questions", () => {
        for (const value of ["Anything important today?", "Today's agenda", "What plans today", "My schedule today"]) {
            assert.equal(isTodayImportanceRequest(value), true, value);
        }
    });

    test("rejects questions without both today and importance concepts", () => {
        const cases = [
            "Что важного?",
            "Как ты сегодня?",
            "Сегодня хорошая погода",
            "Покажи планы на завтра",
            "Что было важного вчера?",
            "",
        ];
        for (const value of cases) assert.equal(isTodayImportanceRequest(value), false, value);
    });

    test("does not hijack explicit live chat inspection", () => {
        const cases = [
            "Проверь сегодня сообщения в чатах",
            "Прочитай сегодняшнюю переписку",
            "Посмотри сегодня сообщения в группе",
            "Проанализируй сегодня чат и важные события",
        ];
        for (const value of cases) assert.equal(isTodayImportanceRequest(value), false, value);
    });

    test("uses word boundaries for today markers", () => {
        assert.equal(isTodayImportanceRequest("сегодняшние важные дела"), true);
        assert.equal(isTodayImportanceRequest("несегодняшние важные дела"), false);
        assert.equal(isTodayImportanceRequest("todayish important plans"), false);
    });
});
