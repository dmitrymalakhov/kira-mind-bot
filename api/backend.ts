import { Bot, Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import type { Update, UserFromGetMe } from 'grammy/types';
import { config } from '../config';
import { BOT_CAPABILITIES } from '../capabilities';
import { BotContext, SessionData } from '../types';
import { registerCallback } from '../callbacks';
import { registerCommandHandlers } from '../handlers/commands';
import { registerTextMessageHandler } from '../handlers/textMessages';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import { RecurringTaskRepository } from '../services/RecurringTaskRepository';
import { ApiBackend, ApiError, ApiReply } from './contracts';
import { ApiActionTokens } from './actionTokens';
import { ApiFiles } from './files';
import { ApiTransport, nextApiMessageId } from './transport';
import { ExternalApiOptions } from './options';
import { readUserSettings, updateUserSettings } from '../services/userSettingsService';
import type { ApiSettingsPatch } from './settings';
import { ApiModelCatalog, ApiModelSettingsStore, BotSettingsApiModelStore, apiTurnPreset, buildApiModelSettings,
    saveApiModelSelection } from './modelSettings';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { SceneService, type SceneTurn } from './scene';
import type { AiPresetName } from '../ai/modelPresets';
import { registerDialogueLifecycle, publicDialogueJob, activateDialogueJob } from '../services/dialogueJobs';
import { DialogueJobRepository } from '../services/DialogueJobRepository';

/** Same handlers, orchestrator, identity and knowledge; only the delivery and session channel differ. */
export class BotApiBackend implements ApiBackend {
    private readonly dispatcher: Bot<BotContext>;
    private readonly storage = new TypeORMSessionStorage(true);
    private readonly files = new ApiFiles();
    private readonly actions: ApiActionTokens;
    private readonly sessionKey: string;
    private readonly botInfo: UserFromGetMe;

    constructor(private readonly bot: Bot<BotContext>, private readonly options: ExternalApiOptions,
                private readonly models: ApiModelSettingsStore = new BotSettingsApiModelStore(),
                private readonly catalog = new ApiModelCatalog()) {
        this.sessionKey = `api:${options.ownerId}`;
        this.actions = new ApiActionTokens(options.token, options.ownerId);
        this.botInfo = bot.botInfo;
        this.dispatcher = new Bot<BotContext>(config.botToken, { botInfo: this.botInfo });
        registerDialogueLifecycle(this.dispatcher);
        registerCallback(this.dispatcher);
        registerCommandHandlers(this.dispatcher);
        registerTextMessageHandler(this.dispatcher, { immediate: true });
        this.dispatcher.use(async ctx => { await ctx.reply('Команда не найдена. Посмотри /help.'); });
    }

    async status() {
        return { ok: true, apiVersion: 'v1', characterName: config.characterName, channel: 'api',
            sharedKnowledge: true, notificationsChannel: 'telegram' };
    }

    async capabilities() {
        return { input: ['text', 'actions'], output: ['text', 'photo', 'document', 'voice'],
            settings: ['modelMode'], scene: { version: 1 }, deferredDialogue: { preference: 'respond-async', results: '/api/v1/dialogue-jobs', cancellation: true }, capabilities: BOT_CAPABILITIES };
    }

    settings() { return readUserSettings(); }
    updateSettings(patch: ApiSettingsPatch) { return updateUserSettings(patch); }
    private sceneService?: SceneService;
    private get scene() { return this.sceneService ??= new SceneService(this.options.ownerId, this.models); }
    sceneCapabilities() { return this.scene.capabilities(); }
    sceneReady(turn: SceneTurn) { return this.scene.ready(turn); }
    sceneTurn(turn: SceneTurn, preset: AiPresetName | null) { return this.scene.turn(turn, preset); }
    sceneActionResult(body: Record<string, unknown>) { return this.scene.actionResult(body); }
    modelSettings() { return buildApiModelSettings(this.models, this.catalog); }
    async turnReady() { await apiTurnPreset(this.models); }
    saveModelSettings(body: Record<string, unknown>) { return saveApiModelSelection(this.models, this.catalog, body); }

    async history(limit: number) {
        const session = await this.storage.read(this.sessionKey);
        return { messages: (session?.messageHistory ?? []).slice(0, limit).reverse().map(item => ({
            role: item.role === 'bot' ? 'assistant' : item.role,
            text: item.content, createdAt: item.timestamp.toISOString(),
        })) };
    }

    async reminders() {
        return { reminders: ReminderRegistry.getInstance().getActiveByChatId(this.options.ownerId).map(item => ({
            id: item.id, text: item.displayText || item.text, status: item.status,
            dueAt: new Date(item.dueDate).toISOString(), recurrence: item.recurrence,
        })) };
    }

    async tasks() {
        const tasks = await RecurringTaskRepository.listByChatId(this.options.ownerId);
        return { tasks: tasks.slice(0, 100).map(item => ({
            id: item.id, title: item.title, prompt: item.prompt, status: item.status,
            schedule: item.schedule, nextRunAt: item.nextRunAt, lastResult: item.lastResult,
        })), hasMore: tasks.length > 100 };
    }

    async dialogueJobs() { return { jobs: (await DialogueJobRepository.list(this.sessionKey)).map(publicDialogueJob) }; }
    async cancelDialogueJob(id: string) { return { cancelled: await DialogueJobRepository.cancel(this.sessionKey, id) }; }

    file(id: string) { return this.files.read(id); }

    async message(text: string, options: { deferredDialogue?: boolean } = {}): Promise<ApiReply> {
        const command = text.match(/^\/[a-zA-Z0-9_]+(?:@[a-zA-Z0-9_]+)?/);
        return this.dispatch({ update_id: 0, message: {
            message_id: nextApiMessageId(), date: Math.floor(Date.now() / 1000),
            from: this.owner(), chat: this.chat(), text,
            ...(command ? { entities: [{ type: 'bot_command', offset: 0, length: command[0].length }] } : {}),
        } }, false, undefined, options.deferredDialogue === true);
    }

    async action(token: string): Promise<ApiReply> {
        const action = this.actions.verify(token);
        return this.dispatch({ update_id: 0, callback_query: {
            id: String(nextApiMessageId()), from: this.owner(), chat_instance: 'external-api',
            data: action.data,
            message: {
                message_id: action.messageId, date: Math.floor(Date.now() / 1000),
                from: this.botInfo, chat: this.chat(), text: action.text,
            },
        } }, true, action.version);
    }

    private owner() { return { id: this.options.ownerId, is_bot: false, first_name: 'Владелец' }; }
    private chat() { return { id: this.options.ownerId, type: 'private' as const, first_name: 'Владелец' }; }

    private async dispatch(update: Update, confirmation = false, expectedVersion?: string, deferredDialogue = false): Promise<ApiReply> {
        const persisted = await this.storage.read(this.sessionKey);
        if (expectedVersion !== undefined && persisted?.apiActionVersion !== expectedVersion) {
            throw new ApiError(410, 'action_expired', 'Кнопка относится к предыдущему запросу. Повтори исходный запрос.');
        }
        const version = randomUUID();
        const transport = new ApiTransport(config.botToken, this.options.ownerId, this.actions,
            this.files, this.bot.api, confirmation, version);
        const ctx = new Context(update, transport.api, this.botInfo) as BotContext;
        const initial: SessionData = {
            reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1,
            domains: {}, sentMessages: {},
        };
        ctx.session = Object.assign(initial, persisted, {
            reminders: ReminderRegistry.getInstance().getActiveByChatId(this.options.ownerId), isAllowedUser: true,
            apiActionVersion: version,
        });
        ctx.sessionStorageKey = this.sessionKey;
        ctx.allowDeferredDialogue = deferredDialogue;
        // The app's own text mode, read once per turn; null follows the server's global preset.
        const preset = await apiTurnPreset(this.models);
        await runWithChannelPreset(preset, async () => { await this.dispatcher.middleware()(ctx, async () => {}); });
        await this.storage.write(this.sessionKey, ctx.session);
        if (ctx.dialogueJobId) await activateDialogueJob(ctx, ctx.dialogueJobId);
        const result = transport.result();
        if (ctx.dialogueJobId) {
            const job = await DialogueJobRepository.find(ctx.dialogueJobId, this.sessionKey);
            if (job) result.backgroundJob = { id: job.id, status: job.status, required: job.input.required };
        }
        return result;
    }
}
