const assert = require("node:assert/strict");

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || "test-token";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test";

const configModule = require("../dist/config.js");
const sanitizerModule = require("../dist/utils/legacyPersonalitySanitizer.js");
const localModels = require('../dist/ai/localModelRouting.js');
assert.equal(require('../dist/utils/telegramAccess.js').readTelegramUserCredentials({ KIRA_BOT_TOKEN: 'synthetic-bot-token' }), null);
assert.equal(require('../dist/ai/backgroundFeatureState.js').requiresTelegramSession('reflection'), true);
assert.equal(localModels.defaultLocalRoutes('synthetic/model').fast.reasoningEffort, 'none');
assert.equal(require('../dist/ai/imageGeneration.js').defaultImageSettings({}).model, 'gpt-image-2.5-sunburst');
assert.ok(require('node:fs').existsSync(require('../dist/ai/imageGeneration.js').DEFAULT_REFERENCE_PATH), 'Built runtime must include the default Kira reference');

assert.ok(configModule, "dist/config.js should load successfully");
assert.equal(typeof require('../dist/api/server.js').createExternalApiServer, 'function', 'Built AR/model API must load its packaged dependencies');
assert.equal(typeof require('../dist/platform/server.js').createPlatformServer, 'function', 'Built account API must load the combined runtime');
assert.equal(typeof sanitizerModule.hasLegacyDigitalBiography, "function");

console.log("built server runtime checks passed");
