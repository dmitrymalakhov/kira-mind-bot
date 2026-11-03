import type { Server } from 'node:http';
import type { Bot } from 'grammy';
import type { BotContext } from '../types';
import { readExternalApiOptions } from '../api/options';
import { createExternalApiServer } from '../api/server';
import { BotApiBackend } from '../api/backend';
import { PersistentApiOperations } from '../api/operations';
import { isApiOnlyRuntime, resolveRuntimeIdentity } from '../utils/runtimeIdentity';

export async function startExternalApiServer(bot: Bot<BotContext>): Promise<Server | undefined> {
    // API access always requires an explicit owner, including on legacy installations.
    const options = readExternalApiOptions(process.env, resolveRuntimeIdentity(process.env).allowedUserId);
    if (!options) return undefined;
    if(!isApiOnlyRuntime())await bot.init();
    const server = createExternalApiServer(options, new BotApiBackend(bot, options), new PersistentApiOperations());
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, resolve);
    });
    console.log(`[external-api] listening on ${options.host}:${options.port}`);
    return server;
}
