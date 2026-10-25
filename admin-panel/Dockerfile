# Stage 1: Build React app
FROM node:23-alpine AS builder
WORKDIR /workspace/admin-panel
COPY admin-panel/package.json admin-panel/package-lock.json* ./
RUN npm install
COPY admin-panel ./
COPY ai ../ai
RUN npm run build

# Stage 2: Production server
FROM node:23-alpine
WORKDIR /app/admin-panel
COPY admin-panel/package.json admin-panel/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /workspace/admin-panel/dist ./dist
COPY admin-panel/*.js ./
COPY admin-panel/runtime-health-metadata.json ./runtime-health-metadata.json
RUN mkdir -p ./src /app/ai /app/utils
COPY admin-panel/src/ai-model-presets.json ./src/ai-model-presets.json
COPY admin-panel/src/timezones.json ./src/timezones.json
COPY ai/*.json /app/ai/
COPY ai/memoryEmbeddingHttp.js /app/ai/memoryEmbeddingHttp.js
COPY ai/localModelRouting.js /app/ai/localModelRouting.js
COPY ai/backgroundFeatureState.js /app/ai/backgroundFeatureState.js
COPY ai/imageGeneration.js /app/ai/imageGeneration.js
COPY assets/characters/kira /app/assets/characters/kira
COPY ai/memoryEmbeddingProviderSupport.js /app/ai/memoryEmbeddingProviderSupport.js
COPY utils/legacyPersonalitySanitizer.js /app/utils/legacyPersonalitySanitizer.js
COPY utils/telegramAccess.js /app/utils/telegramAccess.js
EXPOSE 3000
CMD ["node", "server.js"]
