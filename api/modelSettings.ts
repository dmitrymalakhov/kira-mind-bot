import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../data-source';
import { BotSettingEntity } from '../entity/BotSettingEntity';
import { aiPresets, AI_PRESET_NAMES, parseAiPresetName, type AiPresetConfig, type AiPresetName } from '../ai/modelPresets';
import { formatGenerativeProviderChain } from '../ai/presetSummary';
import { allowsCrossProviderFallback } from '../ai/runtimeSupport';
import { getActiveAiPresetName } from '../services/aiRuntimeConfigService';
import { getLocalModelRoutes } from '../services/localModelConfigService';
import { getActiveMemoryEmbeddingProfileName } from '../services/memoryEmbeddingRuntimeConfigService';
import type { LocalModelRoutes } from '../ai/localModelRouting';
import { ApiError } from './contracts';

// The admin panel's own validator and LM Studio catalog (CommonJS, copied next to the runtime by build:server), so the
// app sees exactly what the admin panel would allow.
const presetAvailability: {
    getPresetAvailabilityForMemoryProfile(preset: unknown, vars: NodeJS.ProcessEnv, memoryProfileName: string): { enabled: boolean; unavailableReason?: string };
} = require('../admin-panel/presetAvailability');
const localModels: {
    listLocalModels(vars: NodeJS.ProcessEnv): Promise<Array<{ id: string; loadedIds: string[] }>>;
    resolveLocalPreset(preset: AiPresetConfig, routes: LocalModelRoutes): AiPresetConfig;
} = require('../admin-panel/localModels');

/**
 * The mobile app's own text mode: a preset applied only to API turns (runWithChannelPreset), stored apart from the
 * global AI_MODEL_PRESET so Telegram and background work never change with it. The value is JSON with a random
 * revision; a save is a compare-and-set on the whole value.
 */
export const API_AI_MODEL_PRESET_SETTING_KEY = 'API_AI_MODEL_PRESET';
const NO_REVISION = 'none';

export interface ApiModelSelection { preset: AiPresetName | null; revision: string }

export interface ApiModelSettingsStore {
    read(): Promise<ApiModelSelection>;
    /** Throws revision_conflict when the stored revision is not `expectedRevision`. */
    write(preset: AiPresetName | null, expectedRevision: string): Promise<ApiModelSelection>;
}

function parseStored(value: string | undefined): ApiModelSelection {
    if (!value) return { preset: null, revision: NO_REVISION };
    try {
        const parsed = JSON.parse(value) as { preset?: unknown; revision?: unknown };
        const revision = typeof parsed.revision === 'string' ? parsed.revision : NO_REVISION;
        // An unknown stored name (a preset removed from the registry) falls back to the server's mode.
        return { preset: typeof parsed.preset === 'string' ? parseAiPresetName(parsed.preset) : null, revision };
    } catch { return { preset: null, revision: NO_REVISION }; }
}

export class BotSettingsApiModelStore implements ApiModelSettingsStore {
    async read(): Promise<ApiModelSelection> {
        // Before the database is up (start-up, offline tests) there is no stored choice, as for the global preset;
        // a failing query on a live database still throws, so a turn never runs on a guessed mode.
        if (!AppDataSource.isInitialized) return { preset: null, revision: NO_REVISION };
        const row = await AppDataSource.getRepository(BotSettingEntity).findOneBy({ key: API_AI_MODEL_PRESET_SETTING_KEY });
        return parseStored(row?.value);
    }

    async write(preset: AiPresetName | null, expectedRevision: string): Promise<ApiModelSelection> {
        const repo = AppDataSource.getRepository(BotSettingEntity);
        const next: ApiModelSelection = { preset, revision: randomUUID() };
        const value = JSON.stringify(next);
        const row = await repo.findOneBy({ key: API_AI_MODEL_PRESET_SETTING_KEY });
        if (parseStored(row?.value).revision !== expectedRevision) throw conflict();
        if (!row) {
            const inserted = await repo.createQueryBuilder().insert().values({ key: API_AI_MODEL_PRESET_SETTING_KEY, value })
                .orIgnore().returning('key').execute();
            if (!inserted.raw.length) throw conflict();
        } else {
            const updated = await repo.createQueryBuilder().update().set({ value })
                .where('key = :key AND value = :old', { key: API_AI_MODEL_PRESET_SETTING_KEY, old: row.value }).execute();
            if (!updated.affected) throw conflict();
        }
        return next;
    }
}

function conflict() {
    return new ApiError(409, 'revision_conflict', 'Режим уже изменён в другом месте. Обнови настройки и выбери снова.');
}

export interface ApiModelPresetEntry {
    name: AiPresetName;
    title: string;
    description: string;
    characteristics?: AiPresetConfig['characteristics'];
    providers: string;
    runsLocally: boolean;
    cloudFallback: boolean;
    available: boolean;
    unavailableReason?: string;
}

/** Availability as the admin panel checks it, plus LM Studio actually answering for presets that need it. */
export class ApiModelCatalog {
    constructor(private readonly env: NodeJS.ProcessEnv = process.env,
                private readonly listLocal: typeof localModels.listLocalModels = localModels.listLocalModels) {}

    async presets(): Promise<ApiModelPresetEntry[]> {
        const [routes, memoryProfile] = await Promise.all([getLocalModelRoutes(), getActiveMemoryEmbeddingProfileName()]);
        const usesLocal = (preset: AiPresetConfig) => Object.values(preset.models).some(ref => ref.provider === 'lmstudio');
        let local: { reachable: boolean; models: Set<string> } | undefined;
        if (AI_PRESET_NAMES.some(name => usesLocal(aiPresets[name]))) {
            try {
                const models = await this.listLocal(this.env);
                local = { reachable: true, models: new Set(models.flatMap(model => [model.id, ...model.loadedIds])) };
            } catch { local = { reachable: false, models: new Set() }; }
        }
        return AI_PRESET_NAMES.map(name => {
            const preset = localModels.resolveLocalPreset(aiPresets[name], routes);
            let { enabled, unavailableReason } = presetAvailability.getPresetAvailabilityForMemoryProfile(preset, this.env, memoryProfile);
            if (enabled && usesLocal(preset) && local) {
                const missing = Object.values(preset.models).filter(ref => ref.provider === 'lmstudio' && !local!.models.has(ref.model));
                if (!local.reachable) { enabled = false; unavailableReason = 'LM Studio недоступна: локальный сервер моделей не отвечает.'; }
                else if (missing.length) { enabled = false; unavailableReason = `В LM Studio нет модели ${missing[0].model}.`; }
            }
            return {
                name, title: preset.title, description: preset.description, characteristics: preset.characteristics,
                providers: formatGenerativeProviderChain(preset.models),
                runsLocally: preset.models.conversation.provider === 'lmstudio',
                cloudFallback: allowsCrossProviderFallback(name),
                available: enabled, ...(enabled ? {} : { unavailableReason }),
            };
        });
    }
}

export const API_MODEL_SCOPE_NOTE = 'Только разговор в этом приложении. Telegram и фоновые задачи остаются на режиме сервера; '
    + 'память, её поиск и личность общие и не меняются.';

/** The state the app shows: its own selection, the server's global mode and every preset with its availability. */
export async function buildApiModelSettings(store: ApiModelSettingsStore, catalog: ApiModelCatalog) {
    const [selection, serverPreset, presets, memoryProfile] = await Promise.all([
        store.read(), getActiveAiPresetName(), catalog.presets(), getActiveMemoryEmbeddingProfileName(),
    ]);
    return {
        scope: 'app',
        scopeNote: API_MODEL_SCOPE_NOTE,
        selection: { preset: selection.preset, revision: selection.revision },
        server: { preset: serverPreset, title: aiPresets[serverPreset].title, allChannels: true, changedIn: 'admin' },
        effectivePreset: selection.preset ?? serverPreset,
        memoryEmbeddingProfile: memoryProfile,
        presets,
    };
}

/** Validates a save from the app: only a known, currently available preset, or null for the server's mode. */
export async function saveApiModelSelection(store: ApiModelSettingsStore, catalog: ApiModelCatalog, body: Record<string, unknown>) {
    if (Object.keys(body).some(key => key !== 'preset' && key !== 'expectedRevision')
        || typeof body.expectedRevision !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.expectedRevision)
        || (body.preset !== null && typeof body.preset !== 'string')) {
        throw new ApiError(400, 'invalid_body', 'Передай только preset (имя или null) и expectedRevision.');
    }
    let preset: AiPresetName | null = null;
    if (body.preset !== null) {
        preset = parseAiPresetName(body.preset as string);
        if (!preset) throw new ApiError(400, 'unknown_preset', 'Такого режима нет на сервере.');
        const entry = (await catalog.presets()).find(item => item.name === preset)!;
        if (!entry.available) throw new ApiError(400, 'preset_unavailable', entry.unavailableReason ?? 'Режим сейчас недоступен.');
    }
    await store.write(preset, body.expectedRevision);
    return buildApiModelSettings(store, catalog);
}

/** The app's preset for the next turn, or null to follow the server. A stored mode that lost its keys fails closed. */
export async function apiTurnPreset(store: ApiModelSettingsStore, env: NodeJS.ProcessEnv = process.env): Promise<AiPresetName | null> {
    const { preset } = await store.read();
    if (!preset) return null;
    const [routes, memoryProfile] = await Promise.all([getLocalModelRoutes(), getActiveMemoryEmbeddingProfileName()]);
    const availability = presetAvailability.getPresetAvailabilityForMemoryProfile(localModels.resolveLocalPreset(aiPresets[preset], routes), env, memoryProfile);
    if (!availability.enabled) {
        throw new ApiError(503, 'model_mode_unavailable',
            `Режим «${aiPresets[preset].title}», выбранный в приложении, недоступен: ${availability.unavailableReason ?? 'нет настроек'}. Выбери другой в настройках приложения.`);
    }
    return preset;
}
