import { Bot } from 'grammy';
import { BotContext } from '../types';
import { processBuffers } from './reflectionModeService';
import { devLog } from '../utils';

/** Интервал запуска цикла обработки буферов — каждые 5 минут */
const INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

export function startReflectionModeScheduler(bot: Bot<BotContext>): void {
    if (timer) return;

    timer = setInterval(async () => {
        if (isRunning) return;
        isRunning = true;
        try {
            await processBuffers(bot);
        } catch (e) {
            console.error('[reflectionScheduler] Unhandled error:', e);
        } finally {
            isRunning = false;
        }
    }, INTERVAL_MS);

    devLog('[reflectionScheduler] Started (interval: 5 min)');
}

export function stopReflectionModeScheduler(): void {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
        devLog('[reflectionScheduler] Stopped');
    }
}
