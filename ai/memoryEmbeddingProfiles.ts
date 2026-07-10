import memoryEmbeddingProfileRegistry from './memory-embedding-profiles.json';
import type { AiProvider } from './modelPresets';

export type MemoryEmbeddingDistance = 'Cosine' | 'Dot' | 'Euclid';
export type MemoryEmbeddingProfileName = 'stable-1536';

export interface MemoryEmbeddingProfile {
    name: MemoryEmbeddingProfileName;
    title: string;
    description: string;
    provider: AiProvider;
    model: string;
    outputDimension: number;
    distance: MemoryEmbeddingDistance;
}

interface MemoryEmbeddingProfileRegistry {
    defaultProfile: MemoryEmbeddingProfileName;
    profiles: Record<MemoryEmbeddingProfileName, MemoryEmbeddingProfile>;
}

const registry = memoryEmbeddingProfileRegistry as MemoryEmbeddingProfileRegistry;

export const DEFAULT_MEMORY_EMBEDDING_PROFILE = registry.defaultProfile;
export const MEMORY_EMBEDDING_PROFILE_NAMES = Object.keys(registry.profiles) as MemoryEmbeddingProfileName[];
export const memoryEmbeddingProfiles = registry.profiles;

export function parseMemoryEmbeddingProfileName(raw: string | undefined | null): MemoryEmbeddingProfileName | null {
    if (!raw) return null;
    return MEMORY_EMBEDDING_PROFILE_NAMES.includes(raw as MemoryEmbeddingProfileName)
        ? raw as MemoryEmbeddingProfileName
        : null;
}

export function getMemoryEmbeddingProfile(name: MemoryEmbeddingProfileName): MemoryEmbeddingProfile {
    return memoryEmbeddingProfiles[name];
}
