import type { ReminderCreationDetails, ReminderCreationFailure } from '../orchestrator';
import { USER_TIMEZONE } from '../constants';
import { esc, footer, heading, list, paragraph, type RichBlock } from './richMessage';

function pluralizeReminders(count: number): string {
    const mod100 = count % 100;
    const mod10 = count % 10;
    if (mod100 >= 11 && mod100 <= 14) return 'напоминаний';
    if (mod10 === 1) return 'напоминание';
    if (mod10 >= 2 && mod10 <= 4) return 'напоминания';
    return 'напоминаний';
}

function formatDueDate(value: Date, timeZone: string): string {
    return new Date(value).toLocaleString('ru-RU', {
        timeZone,
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function detailSuffix(details: ReminderCreationDetails): string {
    const parts: string[] = [];
    if (details.exactTimeSpecified === false) parts.push('время по умолчанию');
    if (details.recurrence) parts.push('повторяется');
    return parts.length ? ` · ${parts.join(' · ')}` : '';
}

export function buildReminderConfirmationText(
    created: ReminderCreationDetails[],
    failures: ReminderCreationFailure[] = [],
    timeZone = USER_TIMEZONE,
): string {
    const lines: string[] = [];
    if (created.length) {
        lines.push(`✅ Создано ${created.length} ${pluralizeReminders(created.length)}`);
        for (const [index, details] of created.entries()) {
            lines.push(`${index + 1}. ${details.text}`);
            lines.push(`${formatDueDate(details.dueDate, timeZone)}${detailSuffix(details)}`);
        }
    }
    if (failures.length) {
        if (lines.length) lines.push('');
        lines.push(`⚠️ Не удалось создать: ${failures.length}`);
        failures.forEach((failure) => lines.push(`• ${failure.text}`));
    }
    lines.push('', 'Открыть и изменить: /reminders');
    return lines.join('\n').trim();
}

export function buildReminderConfirmationBlocks(
    created: ReminderCreationDetails[],
    failures: ReminderCreationFailure[] = [],
    timeZone = USER_TIMEZONE,
): RichBlock[] {
    const blocks: RichBlock[] = [];
    if (created.length) {
        blocks.push(heading(`✅ Создано ${created.length} ${pluralizeReminders(created.length)}`, 2));
        blocks.push(list(created.map((details) => [
            `<b>${esc(details.text)}</b>`,
            `${esc(formatDueDate(details.dueDate, timeZone))}${esc(detailSuffix(details))}`,
        ].join('<br/>')), true));
    }
    if (failures.length) {
        blocks.push(heading(`⚠️ Не удалось создать · ${failures.length}`, 3));
        blocks.push(list(failures.map((failure) => esc(failure.text))));
    }
    if (!created.length && !failures.length) {
        blocks.push(paragraph('Не удалось определить напоминания для создания.'));
    }
    blocks.push(footer('Открыть и изменить: /reminders'));
    return blocks;
}
