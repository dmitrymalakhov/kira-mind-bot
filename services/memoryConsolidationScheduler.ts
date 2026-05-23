import { config } from '../config';
import { runMemoryConsolidationForUser } from './MemoryConsolidationService';
import { runMemorySleepCycleForUser } from './MemorySleepCycleService';

const INTERVAL_MS = config.memoryConsolidationIntervalMs ?? 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

async function runCycle(): Promise<void> {
    if (isRunning) return;
    isRunning = true;

    try {
        const userId = String(config.allowedUserId);
        const result = await runMemoryConsolidationForUser(userId, {
            minFacts: config.memoryConsolidationMinFacts,
            limit: 600,
            periodDays: 180,
            maxDomains: 6,
        });
        const sleep = await runMemorySleepCycleForUser(userId);

        console.log('[memory-consolidation] cycle completed:', {
            created: result.created,
            replaced: result.replaced,
            domains: result.domains,
            skipped: result.skipped,
            sleep,
        });
    } catch (error) {
        console.error('[memory-consolidation] cycle failed:', error);
    } finally {
        isRunning = false;
    }
}

export function startMemoryConsolidationScheduler(): void {
    if (!config.memoryConsolidationEnabled) return;

    if (timer) clearInterval(timer);
    timer = setInterval(() => {
        runCycle();
    }, INTERVAL_MS);

    setTimeout(() => {
        runCycle();
    }, 10 * 60 * 1000);

    console.log('[memory-consolidation] Scheduler started, interval:', INTERVAL_MS / 60_000, 'min');
}
