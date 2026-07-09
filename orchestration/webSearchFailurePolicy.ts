import type { PlanStep } from './types';

/**
 * После отказа поиска можно безопасно продолжить только объясняющий ответ.
 * Любое действие может зависеть от отсутствующих данных и должно быть остановлено.
 */
export function canContinueAfterWebSearchFailure(nextStep: PlanStep | undefined): boolean {
    return nextStep?.agentId === 'conversation';
}
