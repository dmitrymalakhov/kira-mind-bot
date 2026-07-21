import type { PlanStep } from './types';

export const SILENT_STEPS = new Set<PlanStep['agentId']>(['memory', 'resolveContact']);

export function isSilentInternalKnowledgePipeline(steps: PlanStep[]): boolean {
    const visibleSteps = steps.filter(step => !SILENT_STEPS.has(step.agentId));
    return visibleSteps.length === 2 &&
        visibleSteps[0]?.agentId === 'webSearch' &&
        visibleSteps[1]?.agentId === 'conversation';
}
