/** Куда отправить напоминание: в группу по названию или в ЛС контакта */
export type ReminderTargetChat =
    | { type: "group"; groupName: string }
    | { type: "contact"; contactQuery: string };

/** Возможные статусы напоминания */
export enum ReminderStatus {
    Pending = "pending",
    Sent = "sent",
    Completed = "completed",
    Postponed = "postponed",
    Expired = "expired",
}
