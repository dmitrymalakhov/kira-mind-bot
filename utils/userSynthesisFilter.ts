/**
 * Фильтр источников для user-консолидации памяти.
 *
 * Проблема: сервисы консолидации (schema/chapter/sleep-cycle) строят синтез
 * «о владельце» из источников, но не исключают:
 *   1. контактные факты (subject:'contact' с тегами contact:*);
 *   2. эпизоды фоновой рефлексии/personal-chat про чужой чат (subject:'user'
 *      — захардкожен на записи — но с тегами source_contact:* / source_chat:*).
 *   3. утверждения ассистента и смешанные диалоги с subject:'bot'/'system'.
 * Из-за этого ложный факт (например «у владельца есть личное событие»,
 * пришедший из чата с контактом) пересобирается консолидацией после удаления.
 *
 * Единое правило «годится ли источник для user-синтеза» инкапсулировано здесь,
 * чтобы три сервиса консолидации не расходились в реализациях.
 */

/** Минимальный набор полей памяти, нужный фильтру. */
export interface UserSynthesisSourceLike {
    subject?: string;
    tags?: string[];
}

/**
 * true, если запись может быть источником синтеза ИМЕННО о владельце.
 *
 * false означает: запись не является подтверждённым источником о владельце и не должна попадать
 * в главы/схемы/индексы про владельца. Сама по себе запись может быть
 * легитимной для других целей (контактный retrieval, портреты и т.п.).
 */
export function isEligibleForUserSynthesis(memory: UserSynthesisSourceLike): boolean {
    const tags = memory.tags ?? [];

    // Синтез о владельце принимает только явный user-subject. Legacy-записи без
    // subject остаются совместимыми, но явные bot/system/contact/unknown запрещены.
    if (memory.subject && memory.subject !== 'user') return false;
    if (tags.some((tag) => [
        'subject:bot',
        'subject:system',
        'subject:contact',
        'subject:third_party',
        'subject:unknown',
    ].includes(String(tag)))) return false;

    // Эпизоды фоновой рефлексии/personal-chat про чужой чат: их subject
    //    захардкожен как 'user' на этапе записи, но теги source_contact/source_chat
    //    указывают реального субъекта переписки.
    if (tags.some((tag) => String(tag).startsWith('source_contact:') || String(tag).startsWith('source_chat:'))) {
        return false;
    }

    return true;
}
