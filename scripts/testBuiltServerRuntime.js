const assert = require("node:assert/strict");

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || "test-token";

const configModule = require("../dist/config.js");
const sanitizerModule = require("../dist/utils/legacyPersonalitySanitizer.js");
const localModels = require('../dist/ai/localModelRouting.js');
assert.equal(localModels.defaultLocalRoutes('synthetic/model').fast.reasoningEffort, 'none');

assert.ok(configModule, "dist/config.js should load successfully");
assert.equal(typeof sanitizerModule.hasLegacyDigitalBiography, "function");

console.log("built server runtime checks passed");
