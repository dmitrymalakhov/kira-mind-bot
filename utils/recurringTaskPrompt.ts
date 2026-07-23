import type { MessageClassification } from "../orchestrator";
import type { Plan, PlanStep } from "../orchestration/types";

const EXPLICIT_REMINDER_REQUEST_RE =
    /(?:^|\s)(?:напомни|напоминай|не\s+дай\s+забыть|не\s+забудь|(?:создай|поставь|добавь)(?:\s+\S+){0,3}\s+напоминание)(?=\s|$|[,.!?;:])/iu;

const RECURRING_ACTION_REWRITES: Array<[RegExp, string]> = [
    [/^рассказыва(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Расскажи"],
    [/^показыва(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Покажи"],
    [/^(?:присыла(?:й|йте|ть)|отправля(?:й|йте|ть)|получать)(?=$|[\s,;:—-])/iu, "Подготовь"],
    [/^(?:находи(?:те|ть)?|ищи(?:те|ть)?)(?=$|[\s,;:—-])/iu, "Найди"],
    [/^проверя(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Проверь"],
    [/^собира(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Собери"],
    [/^(?:готовь(?:те)?|подготавлива(?:й|йте|ть))(?=$|[\s,;:—-])/iu, "Подготовь"],
    [/^генериру(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Сгенерируй"],
    [/^рису(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Нарисуй"],
    [/^анализиру(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Проанализируй"],
    [/^запуска(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Запусти"],
    [/^выполня(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Выполни"],
    [/^дела(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Сделай"],
    [/^повторя(?:й|йте|ть)(?=$|[\s,;:—-])/iu, "Повтори"],
    [/^пиши(?:те)?(?=$|[\s,;:—-])/iu, "Напиши"],
];

export function normalizeRecurringExecutionPrompt(prompt: string): string {
    const normalized = prompt.replace(/\s+/g, " ").trim();
    for (const [pattern, replacement] of RECURRING_ACTION_REWRITES) {
        if (pattern.test(normalized)) return normalized.replace(pattern, replacement);
    }
    return normalized;
}

export function isExplicitReminderRequest(prompt: string): boolean {
    return EXPLICIT_REMINDER_REQUEST_RE.test(prompt);
}

export function guardRecurringTaskClassification(
    classification: MessageClassification,
    prompt: string,
    requiresWeb: boolean,
): { classification: MessageClassification; adjusted: boolean } {
    const explicitReminder = isExplicitReminderRequest(prompt);
    const filteredSubIntents = explicitReminder
        ? classification.subIntents
        : classification.subIntents?.filter(
            (subIntent) => subIntent.intent !== "НАПОМИНАНИЕ",
        );
    const removedReminderSubIntent =
        filteredSubIntents?.length !== classification.subIntents?.length;
    const replacedPrimaryReminder =
        !explicitReminder && classification.intent === "НАПОМИНАНИЕ";
    const allowedScores = explicitReminder
        ? classification.intentScores ?? []
        : classification.intentScores?.filter(
            (candidate) => candidate.intent !== "НАПОМИНАНИЕ",
        ) ?? [];
    const removedReminderScore =
        !explicitReminder &&
        allowedScores.length !== (classification.intentScores?.length ?? 0);
    const rankedIntent = allowedScores.find(
        (candidate) => candidate.intent !== "НЕОПРЕДЕЛЕНО",
    )?.intent;
    const resolvedUnknownIntent = classification.intent === "НЕОПРЕДЕЛЕНО";
    const intent: MessageClassification["intent"] = replacedPrimaryReminder
        ? requiresWeb ? "ВЕБ_ПОИСК" : "РАЗГОВОР"
        : resolvedUnknownIntent
            ? rankedIntent ?? (requiresWeb ? "ВЕБ_ПОИСК" : "РАЗГОВОР")
            : classification.intent;
    const details = { ...classification.details };
    if (!explicitReminder) {
        delete details.reminderAction;
        delete details.reminderBatchPeriod;
        delete details.reminderCancelQuery;
        delete details.reminderUpdateQuery;
        delete details.reminderUpdateNewTime;
        delete details.reminderUpdateNewText;
    }
    const intentScores = allowedScores.some((candidate) => candidate.intent === intent)
        ? allowedScores
        : [{
            intent,
            score: 1,
            reason: "Фоновый запуск выбирает наиболее подходящий вариант без дополнительного вопроса.",
        }, ...allowedScores];
    const adjusted =
        removedReminderSubIntent ||
        removedReminderScore ||
        replacedPrimaryReminder ||
        resolvedUnknownIntent ||
        classification.confidenceLevel !== "ВЫСОКИЙ" ||
        Boolean(classification.ambiguityReason) ||
        Boolean(classification.clarificationQuestion);

    if (!adjusted) return { classification, adjusted: false };

    return {
        adjusted: true,
        classification: {
            ...classification,
            intent,
            confidenceLevel: "ВЫСОКИЙ",
            ambiguityReason: undefined,
            clarificationQuestion: undefined,
            subIntents: filteredSubIntents?.length ? filteredSubIntents : undefined,
            intentScores,
            details,
        },
    };
}

function fallbackRecurringSteps(classification: MessageClassification): PlanStep[] {
    switch (classification.intent) {
        case "НАПОМИНАНИЕ":
            return [{ agentId: "reminder" }];
        case "ГЕНЕРАЦИЯ_ИЗОБРАЖЕНИЯ":
            return [{ agentId: "imageGeneration" }];
        case "КАРТЫ_ЛОКАЦИИ":
            return [{ agentId: "maps" }];
        case "ПРОВЕРКА_СООБЩЕНИЙ":
            return [{ agentId: "readMessages" }];
        case "ВЕБ_ПОИСК":
            return [{ agentId: "webSearch" }, { agentId: "conversation" }];
        case "ОТПРАВКА_СООБЩЕНИЯ":
            return [{ agentId: "sendMessage" }];
        case "ДЕЛЕГИРОВАНИЕ_ЗАДАЧИ":
            return [{ agentId: "negotiateOnBehalf" }];
        case "ВОЗМОЖНОСТИ_БОТА":
            return [{ agentId: "capabilities" }];
        case "САМОИЗУЧЕНИЕ":
            return [{ agentId: "selfStudy" }];
        case "БРАУЗЕР_ЗАДАЧА":
            return [{ agentId: "browserTask" }];
        case "ЗДОРОВЬЕ":
            return [{ agentId: "health" }];
        case "РАЗГОВОР":
        case "НЕОПРЕДЕЛЕНО":
        default:
            return [{ agentId: "conversation" }];
    }
}

export function guardRecurringTaskPlan(
    plan: Plan,
    prompt: string,
    classification: MessageClassification,
): { plan: Plan; adjusted: boolean } {
    const explicitReminder = isExplicitReminderRequest(prompt);
    const filteredSteps = plan.steps.filter((step) =>
        step.agentId !== "unclearIntent" &&
        (explicitReminder || step.agentId !== "reminder")
    );
    if (filteredSteps.length === plan.steps.length) return { plan, adjusted: false };

    const onlyContextSteps = filteredSteps.every((step) =>
        step.agentId === "resolveContact" ||
        step.agentId === "memory" ||
        step.agentId === "webSearch"
    );
    const fallbackSteps = fallbackRecurringSteps(classification);
    const missingFallbackSteps = fallbackSteps.filter((fallbackStep) =>
        !filteredSteps.some((step) => step.agentId === fallbackStep.agentId)
    );
    return {
        adjusted: true,
        plan: {
            steps: [
                ...filteredSteps,
                ...(filteredSteps.length === 0 || onlyContextSteps
                    ? missingFallbackSteps
                    : []),
            ],
        },
    };
}

/**
 * Даёт маршрутизатору знаний понять, что относительные даты фоновой задачи
 * относятся к текущему запуску. Сам сохранённый пользовательский prompt при
 * этом остаётся чистым и не получает служебный текст.
 */
export function buildRecurringKnowledgeSourceText(prompt: string): string {
    return [
        normalizeRecurringExecutionPrompt(prompt),
        "Это очередной запуск по расписанию: учитывай текущую дату и используй актуальные данные на момент запуска.",
    ].join("\n");
}
