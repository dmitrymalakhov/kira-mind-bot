import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kira-personality-gender-"));
const personalityFile = path.join(tempDir, "personality.json");

try {
    fs.writeFileSync(personalityFile, JSON.stringify({
        KiraMindBot: {
            characterName: "Макс",
            characterGender: "мужской",
            persona: "",
            biography: "",
            proactiveMessageHint: "",
        },
    }));

    process.env.PERSONALITY_FILE = personalityFile;
    process.env.KIRA_BOT_TOKEN = "test-token";

    const { config } = require("../config") as typeof import("../config");

    assert.equal(config.eventDescriptionGender, "мужской");
    assert.match(config.persona, /мужчин|мужском роде/u);
    assert.doesNotMatch(config.persona, /женщин|женском роде/u);
    assert.match(config.biography, /мужчин|помощник/u);
    assert.doesNotMatch(config.biography, /женщин|помощница/u);
    assert.equal(config.proactiveMessageHint, "как будто ты сам написал первым");

    console.log("personality gender fallback checks passed");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
