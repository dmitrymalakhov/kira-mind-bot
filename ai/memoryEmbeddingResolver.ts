import {
    DEFAULT_MEMORY_EMBEDDING_PROFILE,
    getMemoryEmbeddingProfile,
    type MemoryEmbeddingProfile,
    type MemoryEmbeddingProfileName,
} from './memoryEmbeddingProfiles';
import {
    getActiveMemoryEmbeddingProfileName,
    getEnvMemoryEmbeddingProfileName,
} from '../services/memoryEmbeddingRuntimeConfigService';

export interface ResolvedMemoryEmbeddingConfig {
    profileName: MemoryEmbeddingProfileName;
    config: MemoryEmbeddingProfile;
}

export function resolveMemoryEmbeddingConfig(): ResolvedMemoryEmbeddingConfig {
    const profileName = getEnvMemoryEmbeddingProfileName();
    return {
        profileName,
        config: getMemoryEmbeddingProfile(profileName),
    };
}

export async function resolveMemoryEmbeddingConfigAsync(): Promise<ResolvedMemoryEmbeddingConfig> {
    const profileName = await getActiveMemoryEmbeddingProfileName();
    return {
        profileName,
        config: getMemoryEmbeddingProfile(profileName),
    };
}

export function getDefaultMemoryEmbeddingConfig(): ResolvedMemoryEmbeddingConfig {
    return {
        profileName: DEFAULT_MEMORY_EMBEDDING_PROFILE,
        config: getMemoryEmbeddingProfile(DEFAULT_MEMORY_EMBEDDING_PROFILE),
    };
}
