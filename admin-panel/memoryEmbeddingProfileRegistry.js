'use strict';

const registry = require('../ai/memory-embedding-profiles.json');

const DEFAULT_MEMORY_EMBEDDING_PROFILE = registry.defaultProfile;
const MEMORY_EMBEDDING_PROFILES = registry.profiles;
const MEMORY_EMBEDDING_PROFILE_NAMES = Object.keys(MEMORY_EMBEDDING_PROFILES);

function parseMemoryEmbeddingProfileName(raw) {
  return MEMORY_EMBEDDING_PROFILE_NAMES.includes(raw) ? raw : null;
}

function getMemoryEmbeddingProfile(name) {
  return MEMORY_EMBEDDING_PROFILES[name] || null;
}

module.exports = {
  DEFAULT_MEMORY_EMBEDDING_PROFILE,
  MEMORY_EMBEDDING_PROFILES,
  MEMORY_EMBEDDING_PROFILE_NAMES,
  parseMemoryEmbeddingProfileName,
  getMemoryEmbeddingProfile,
};
