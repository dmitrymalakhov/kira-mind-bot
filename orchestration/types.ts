/**
 * Идентификаторы агентов, которые оркестратор может включать в план.
 * Агенты-источники (memory, webSearch) добавляют контекст для следующих шагов.
 * Остальные агенты дают финальный ответ (терминальные).
 */
export type AgentId =
    | 'memory'         // Долговременная память — контекст для ответа
    | 'resolveContact' // Узнать из памяти, кто имеется в виду (роль → имя), params: { relationship }
    | 'webSearch'      // Поиск в интернете — контекст или финальный ответ
    | 'conversation'   // Разговор / ответ с учётом контекста
    | 'reminder'
    | 'readMessages'
    | 'sendMessage'
    | 'negotiateOnBehalf' // Договориться с контактом от имени пользователя (переписка с вопросами к пользователю)
    | 'imageGeneration'
    | 'maps'
    | 'unclearIntent'
    | 'capabilities';  // ответ «что умеет бот» — по решению классификатора/планировщика

/** Один шаг плана: какой агент вызвать и с какими параметрами. */
export interface PlanStep {
    agentId: AgentId;
    params?: Record<string, unknown>;
}

/** План выполнения: последовательность вызовов агентов. */
export interface Plan {
    steps: PlanStep[];
}

/** Результат выполнения одного шага (контекст для следующего или финальный ответ). */
export interface StepResult {
    /** Текст для добавления в контекст следующих шагов (если шаг — источник контекста). */
    contextBlock?: string;
    /** Финальный ответ пользователю (если шаг терминальный). */
    finalResult?: { responseText: string; [k: string]: unknown };
    /** Нужно ли продолжать план (false, если уже вернули финальный ответ). */
    continuePlan: boolean;
}

/** Вход для планировщика (classification передаётся из оркестратора). */
export interface PlanningInput {
    message: string;
    classification: { intent: string; confidenceLevel?: string; details?: Record<string, unknown> };
    messageHistory?: { role: string; content: string }[];
}
