import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Reminder } from '../reminder';
import type { ProcessingResult, ReminderCreationDetails } from '../orchestrator';
import { ReminderService } from '../services/ReminderService';
import { validateReminderAnalysisCandidates } from '../agents/reminderAgent';
import { ReminderStatus } from '../types/reminderTypes';
import { saveRemindersFromResult, shouldRunProactiveHint } from '../handlers/shared';
import { mergeProcessingResults } from '../orchestration/executor';
import {
    buildReminderConfirmationBlocks,
    buildReminderConfirmationText,
} from '../utils/reminderConfirmation';
import {
    buildTodayImportanceBlocks,
    buildTodayImportanceText,
    todayImportanceTestUtils,
    type TodayImportanceSnapshot,
} from '../utils/todayImportance';
import { renderFallbackHtml } from '../utils/richMessage';

const day = {
    key: '2026-08-11',
    label: 'вторник, 11 августа 2026 г.',
    shortDate: '11.08.2026',
    day: 11,
    month: 8,
    year: 2026,
};

function details(overrides: Partial<ReminderCreationDetails> = {}): ReminderCreationDetails {
    return {
        id: 'reminder-1',
        text: 'Проверить <отчёт> & отзывы',
        reminderMessage: 'Проверить отчёт',
        dueDate: new Date('2026-08-12T07:00:00.000Z'),
        exactTimeSpecified: false,
        ...overrides,
    };
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
    return {
        id: 'reminder-1',
        text: 'Проверить отчёт',
        displayText: 'Проверить отчёт',
        dueDate: new Date('2026-08-11T07:00:00.000Z'),
        chatId: 101,
        status: ReminderStatus.Pending,
        createdAt: new Date('2026-08-10T10:00:00.000Z'),
        ...overrides,
    };
}

function snapshot(overrides: Partial<TodayImportanceSnapshot> = {}): TodayImportanceSnapshot {
    return {
        day,
        timeZone: 'Europe/Moscow',
        now: new Date('2026-08-11T06:00:00.000Z'),
        todayReminders: [],
        earlierUnresolvedReminders: [],
        memoryItems: [],
        memoryLookupFailed: false,
        ...overrides,
    };
}

describe('reminder batch creation', () => {
    test('keeps valid analysis items and reports every invalid item', () => {
        const validation = validateReminderAnalysisCandidates([
            { reminderText: 'Без даты' },
            { reminderText: 'Некорректная дата', reminderTime: 'когда-нибудь потом' },
            { reminderText: 'Готовая задача', reminderTime: '2026-08-12T10:00:00+03:00' },
            null,
        ], false);

        assert.deepEqual(validation.validReminders.map(item => item.reminderText), ['Готовая задача']);
        assert.deepEqual(validation.failures.map(item => item.text), [
            'Без даты',
            'Некорректная дата',
            'Не удалось распознать задачу',
        ]);
    });

    test('accepts a missing time only when the whole request uses the default time', () => {
        const validation = validateReminderAnalysisCandidates([{ reminderText: 'Задача без времени' }], true);
        assert.equal(validation.failures.length, 0);
        assert.equal(validation.validReminders[0].reminderMessage, 'Задача без времени');
    });

    test('ReminderService persists before publishing the reminder', async () => {
        const events: string[] = [];
        const service = new ReminderService({
            save: async () => { events.push('save'); },
            register: () => { events.push('register'); },
            schedule: () => { events.push('schedule'); },
            syncMemory: async () => { events.push('memory'); },
        });
        const ctx = {
            chat: { id: 101, type: 'private' },
            from: { id: 101 },
            session: { reminders: [] },
        } as any;

        const created = await service.createReminder(ctx, details());

        assert.deepEqual(events, ['save', 'register', 'schedule', 'memory']);
        assert.equal(ctx.session.reminders[0], created);
        assert.equal(created.chatId, 101);
    });

    test('reports partial success without hiding a failed item', async () => {
        const first = details({ id: 'ok', text: 'Первая задача' });
        const second = details({ id: 'fail', text: 'Вторая задача' });
        const result: ProcessingResult = {
            responseText: 'temporary',
            reminderCreated: true,
            reminderAction: 'create_reminders_batch',
            reminderDetails: first,
            reminderDetailsList: [first, second],
        };
        const fakeService = {
            async createReminder(_ctx: any, item: ReminderCreationDetails): Promise<Reminder> {
                if (item.id === 'fail') throw new Error('database unavailable');
                return reminder({ id: item.id, text: item.text });
            },
        };

        await saveRemindersFromResult({ chat: { id: 101, type: 'private' }, session: {} } as any, result, fakeService);

        assert.equal(result.reminderCreated, true);
        assert.deepEqual(result.reminderDetailsList?.map((item) => item.id), ['ok']);
        assert.deepEqual(result.reminderCreationFailures, [{ text: 'Вторая задача', error: 'database unavailable' }]);
        assert.match(result.responseText, /Создано 1 напоминание/);
        assert.match(result.responseText, /Не удалось создать: 1/);
        assert.match(result.responseText, /\/reminders/);
    });

    test('reports analysis validation failures even when nothing can be created', async () => {
        const result: ProcessingResult = {
            responseText: '',
            reminderCreated: false,
            reminderAction: 'create_reminders_batch',
            reminderDetailsList: [],
            reminderCreationFailures: [
                { text: 'Задача без даты', error: 'Не удалось определить дату и время' },
                { text: 'Не удалось распознать задачу', error: 'Не удалось определить текст напоминания' },
            ],
        };
        let createCalls = 0;
        const fakeService = {
            async createReminder(): Promise<Reminder> {
                createCalls += 1;
                throw new Error('unexpected call');
            },
        };

        await saveRemindersFromResult({ chat: { id: 101, type: 'private' }, session: {} } as any, result, fakeService);

        assert.equal(createCalls, 0);
        assert.equal(result.reminderCreated, false);
        assert.equal(result.reminderAction, 'create_reminders_batch');
        assert.equal(result.reminderCreationFailures?.length, 2);
        assert.match(result.responseText, /Не удалось создать: 2/);
        assert.equal(result.structuredResponseBlocks?.length! > 0, true);
        assert.equal(shouldRunProactiveHint(result, 'напомни выполнить задачу'), false);
    });

    test('preserves another terminal result and validation failures in a multi-intent plan', async () => {
        const item = details({ id: 'multi', text: 'Проверить задачу' });
        const merged = mergeProcessingResults([
            { responseText: 'Черновик сообщения готов.' },
            {
                responseText: 'Временный текст напоминания',
                reminderCreated: true,
                reminderAction: 'create_reminders_batch',
                reminderDetails: item,
                reminderDetailsList: [item],
                reminderCreationFailures: [{ text: 'Вторая задача', error: 'Некорректная дата' }],
            },
        ]);
        const fakeService = {
            async createReminder(): Promise<Reminder> {
                return reminder({ id: item.id, text: item.text });
            },
        };

        await saveRemindersFromResult({ chat: { id: 101, type: 'private' }, session: {} } as any, merged, fakeService);

        assert.equal(merged.companionResponseText, 'Черновик сообщения готов.');
        assert.equal(merged.reminderCreationFailures?.length, 1);
        assert.match(merged.responseText, /^Черновик сообщения готов\./);
        assert.match(merged.responseText, /Не удалось создать: 1/);
    });

    test('folds unresolved target warnings into the single confirmation', async () => {
        const item = details({
            id: 'target',
            text: 'Сообщить команде',
            targetChat: { type: 'group', groupName: '<Команда>' },
        });
        const result: ProcessingResult = {
            responseText: 'temporary',
            reminderCreated: true,
            reminderDetails: item,
            reminderDetailsList: [item],
        };
        const fakeService = {
            async createReminder(): Promise<Reminder> {
                return reminder({ id: item.id, text: item.text, targetChat: item.targetChat });
            },
        };
        let separateReplies = 0;
        const ctx = {
            chat: { id: 101, type: 'private' },
            session: {},
            reply: async () => { separateReplies += 1; },
        } as any;

        await saveRemindersFromResult(ctx, result, fakeService, async () => null);

        assert.equal(separateReplies, 0);
        assert.match(result.responseText, /Не удалось проверить или найти группу «<Команда>»/);
        assert.doesNotMatch(result.responseText, /Я нашла адресата/);
        assert.equal(result.keyboard, undefined);
        assert.match(renderFallbackHtml(result.structuredResponseBlocks!), /&lt;Команда&gt;/);
    });

    test('formats actual dates, default-time labels, and escaped user text', () => {
        const failure = { text: 'Сломанное <дело>', error: 'failure' };
        const text = buildReminderConfirmationText([details()], [failure], 'Europe/Moscow');
        const html = renderFallbackHtml(buildReminderConfirmationBlocks([details()], [failure], 'Europe/Moscow'));

        assert.match(text, /12 августа 2026 г\. в 10:00/);
        assert.match(text, /время по умолчанию/);
        assert.match(text, /Открыть и изменить: \/reminders/);
        assert.match(html, /Проверить &lt;отчёт&gt; &amp; отзывы/);
        assert.match(html, /Сломанное &lt;дело&gt;/);
        assert.doesNotMatch(html, /\*\*/);
    });
});

describe('structured today summary', () => {
    test('keeps reminders, unresolved items, and memory plans in separate sections', () => {
        const value = snapshot({
            todayReminders: [reminder()],
            earlierUnresolvedReminders: [reminder({ id: 'old', dueDate: new Date('2026-08-10T14:00:00.000Z') })],
            memoryItems: [{
                memory: {
                    id: 'memory-1',
                    content: 'Подготовить <документы>',
                    domain: 'work',
                    timestamp: new Date('2026-08-10T10:00:00.000Z'),
                    importance: 0.8,
                    tags: [],
                },
                score: 1,
                reason: 'срок сегодня',
            }],
        });
        const text = buildTodayImportanceText(value);
        const html = renderFallbackHtml(buildTodayImportanceBlocks(value));

        assert.match(text, /⏰ Напоминания · 1/);
        assert.match(text, /⚠️ Незавершённые · 1/);
        assert.match(text, /📝 Планы из памяти · 1/);
        assert.match(text, /не являются напоминаниями/);
        assert.match(text, /\/reminders/);
        assert.match(html, /Подготовить &lt;документы&gt;/);
        assert.doesNotMatch(html, /\*\*/);
    });

    test('renders explicit empty states', () => {
        const text = buildTodayImportanceText(snapshot());
        assert.match(text, /На сегодня активных напоминаний нет/);
        assert.match(text, /Более ранних незавершённых напоминаний нет/);
        assert.match(text, /В памяти нет конкретных планов на сегодня/);
    });

    test('recognizes reminder-backed memory as a duplicate', () => {
        const active = reminder();
        const duplicateMemory = {
            id: 'memory-reminder-1',
            content: 'Напоминание: Проверить отчёт — 11 августа 2026, 10:00.',
            domain: 'work',
            timestamp: new Date('2026-08-10T10:00:00.000Z'),
            importance: 0.8,
            status: 'planned',
            tags: ['source_reminder:reminder-1'],
        } as any;

        assert.equal(
            todayImportanceTestUtils.duplicatesActiveReminder(duplicateMemory, [active], day, 'Europe/Moscow'),
            true,
        );
    });
});
