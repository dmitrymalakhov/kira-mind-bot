# Stage 1: Build React app
FROM node:23-alpine AS builder
WORKDIR /workspace/admin-panel
COPY admin-panel/package.json admin-panel/package-lock.json* ./
RUN npm install
COPY admin-panel ./
RUN npm run build

# Stage 2: Production server
FROM node:23-alpine
WORKDIR /app/admin-panel
COPY admin-panel/package.json admin-panel/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=builder /workspace/admin-panel/dist ./dist
COPY admin-panel/server.js ./server.js
COPY admin-panel/monitoring.js ./monitoring.js
COPY admin-panel/aiUsageAnalytics.js ./aiUsageAnalytics.js
COPY admin-panel/presetAvailability.js ./presetAvailability.js
COPY admin-panel/runtime-health-metadata.json ./runtime-health-metadata.json
COPY admin-panel/aiPresetRegistry.js ./aiPresetRegistry.js
RUN mkdir -p ./src /app/ai /app/utils
COPY admin-panel/src/ai-model-presets.json ./src/ai-model-presets.json
COPY ai/provider-registry.json /app/ai/provider-registry.json
COPY ai/fallback-models.json /app/ai/fallback-models.json
COPY utils/legacyPersonalitySanitizer.js /app/utils/legacyPersonalitySanitizer.js
EXPOSE 3000
CMD ["node", "server.js"]
