const assert = require("node:assert/strict");

// Imports exercise the built application, but must never start a real account
// session or inherit provider credentials from an operator's environment/.env.
Object.assign(process.env, {
    NODE_ENV: 'test', KIRA_BOT_TOKEN: 'synthetic-test-token', OPENAI_API_KEY: 'synthetic-test-openai-key',
    GEMINI_API_KEY: 'synthetic-test-gemini-key', TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '', TELEGRAM_SESSION_STRING: '',
    PERSONALITY_FILE: require('node:path').join(process.cwd(), 'fixtures/nonexistent-test-personality.json'),
});

const configModule = require("../dist/config.js");
const sanitizerModule = require("../dist/utils/legacyPersonalitySanitizer.js");
const localModels = require('../dist/ai/localModelRouting.js');
assert.equal(require('../dist/utils/telegramAccess.js').readTelegramUserCredentials({ KIRA_BOT_TOKEN: 'synthetic-bot-token' }), null);
assert.equal(require('../dist/utils/telegramAccess.js').readTelegramUserCredentials(process.env), null, 'Smoke tests cannot use an operator Telegram session');
assert.equal(require('../dist/ai/backgroundFeatureState.js').requiresTelegramSession('reflection'), true);
assert.equal(localModels.defaultLocalRoutes('synthetic/model').fast.reasoningEffort, 'none');
assert.equal(require('../dist/ai/imageGeneration.js').defaultImageSettings({}).model, 'gpt-image-2.5-sunburst');
assert.equal(typeof require('../dist/utils/mcpConnection.js').connectMcp, 'function', 'Built MCP runtime must include the shared connector');
assert.deepEqual(require('../dist/utils/mcpConfig.js').parseMcpConfig({ servers: {} }), {});
assert.ok(require('node:fs').existsSync(require('../dist/ai/imageGeneration.js').DEFAULT_REFERENCE_PATH), 'Built runtime must include the default Kira reference');

assert.ok(configModule, "dist/config.js should load successfully");
assert.equal(typeof require('../dist/api/server.js').createExternalApiServer, 'function', 'Built AR/model API must load its packaged dependencies');
assert.equal(typeof require('../dist/platform/server.js').createPlatformServer, 'function', 'Built account API must load the combined runtime');
assert.equal(typeof sanitizerModule.hasLegacyDigitalBiography, "function");

async function checkRuntimeSkills() {
    const { SkillLoader, KIRA_SKILLS } = require('../dist/orchestration/runtime/skills.js');
    const loader = new SkillLoader();
    for (const skill of KIRA_SKILLS) assert.match(await loader.load(skill.id), /name:/, `Packaged skill ${skill.id} must load`);
    assert.equal(loader.ids().length, KIRA_SKILLS.length);
    assert.equal(require('../dist/orchestration/runtime/kernel.js').orchestrationMode(), 'skills');
    console.log("built server runtime checks passed");
}
checkRuntimeSkills().catch(error => { console.error(error); process.exitCode = 1; });
