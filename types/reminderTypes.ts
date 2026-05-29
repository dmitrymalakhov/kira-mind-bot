/** Куда отправить напоминание: в группу по названию или в ЛС контакта */
export type ReminderTargetChat =
    | { type: "group"; groupName: string }
    | { type: "contact"; contactQuery: string };

/** Согласие владельца на отправку напоминания найденному адресату */
export type ReminderTargetNotificationStatus = "pending" | "enabled" | "disabled";

/** Возможные статусы напоминания */
export enum ReminderStatus {
    Pending = "pending",
    Sent = "sent",
    Completed = "completed",
    Postponed = "postponed",
    Expired = "expired",
}

/** Правило повторения напоминания */
export interface RecurrenceRule {
    type: "hourly" | "daily" | "weekly" | "monthly" | "yearly";
    /** Шаг повторения (каждые N единиц) */
    interval: number;
    /** Для weekly: дни недели (0=вс, 1=пн, ..., 6=сб) */
    daysOfWeek?: number[];
}
