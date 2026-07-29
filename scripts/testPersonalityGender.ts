import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    buildPersonalityMoodStyles,
    buildProactiveMessageFormats,
    getPersonalityGenderForms,
    selectPersonalityGenderText,
} from "../utils/personalityGender";

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
    const { getBotGenderedText } = require("../persona") as typeof import("../persona");

    assert.equal(selectPersonalityGenderText("женский", "создала", "создал"), "создала");
    assert.equal(selectPersonalityGenderText("мужской", "нашла", "нашёл"), "нашёл");
    assert.equal(selectPersonalityGenderText(undefined, "сохранила", "сохранил"), "сохранила");
    assert.equal(getBotGenderedText("получила медиа", "получил медиа"), "получил медиа");
    assert.equal(getBotGenderedText("не смогла", "не смог"), "не смог");
    const { parseRecurringTaskEdit } = require("../services/recurringTaskService") as typeof import("../services/recurringTaskService");
    assert.match(
        parseRecurringTaskEdit("расписание: неизвестно когда", "Europe/Moscow").scheduleError ?? "",
        /^Не понял новое расписание/u,
    );

    const projectRoot = path.resolve(__dirname, "..");
    const reminderEditorSource = fs.readFileSync(path.join(projectRoot, "utils/reminderEditor.ts"), "utf8");
    const studyChatSource = fs.readFileSync(path.join(projectRoot, "utils/studyChatPipeline.ts"), "utf8");
    const commandsSource = fs.readFileSync(path.join(projectRoot, "handlers/commands.ts"), "utf8");
    assert.match(reminderEditorSource, /getBotGenderedText\([\s\S]{0,120}"Не увидел изменений\."/u);
    assert.match(studyChatSource, /загрузил \$\{fetchResult\.messageCount\} сообщений/u);
    assert.match(studyChatSource, /Изучил переписку[\s\S]{0,300}Запомнил \$\{savedCount\}/u);
    assert.match(studyChatSource, /Ничего не сохранил: \$\{reason\}/u);
    assert.match(commandsSource, /getBotGenderedText\([\s\S]{0,120}"📝 Вот что я запомнил из нашего общения:"/u);

    const malePromptLanguage = JSON.stringify({
        forms: getPersonalityGenderForms("мужской"),
        moods: buildPersonalityMoodStyles("мужской"),
        proactiveFormats: buildProactiveMessageFormats("мужской"),
    });
    assert.match(malePromptLanguage, /устал|настроен|задумчив|воодушевлён|написал первым/u);
    assert.doesNotMatch(
        malePromptLanguage,
        /устала|настроена|задумчива|воодушевлена|написала первой|подругой|почувствовала/u,
    );

    const femalePromptLanguage = JSON.stringify({
        forms: getPersonalityGenderForms("женский"),
        moods: buildPersonalityMoodStyles("женский"),
        proactiveFormats: buildProactiveMessageFormats("женский"),
    });
    assert.match(femalePromptLanguage, /устала|настроена|задумчива|воодушевлена|написала первой/u);

    console.log("personality gender fallback checks passed");
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
