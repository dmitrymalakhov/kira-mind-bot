import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

process.env.KIRA_BOT_TOKEN = process.env.KIRA_BOT_TOKEN || "test-token";

const execFileAsync = promisify(execFile);

async function assertColdStartCorruptedMemoryFails(memoryPath: string): Promise<void> {
    const inlineScript = `
const { getKiraSelfMemoryState } = require(${JSON.stringify(path.join(process.cwd(), "utils/kiraSelfMemory.ts"))});

getKiraSelfMemoryState()
  .then(() => {
    console.error("expected corrupted self-memory to fail on cold start");
    process.exit(1);
  })
  .catch((error) => {
    if (error?.name !== "KiraSelfMemoryCorruptedError") {
      console.error(error);
      process.exit(2);
    }
    console.log(error.name);
  });
`;

    const { stdout } = await execFileAsync(process.execPath, ["-r", "ts-node/register/transpile-only", "-e", inlineScript], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            KIRA_BOT_TOKEN: process.env.KIRA_BOT_TOKEN || "test-token",
            KIRA_SELF_MEMORY_PATH: memoryPath,
        },
    });

    assert.match(stdout, /KiraSelfMemoryCorruptedError/);
}

async function main(): Promise<void> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kira-self-memory-"));
    const memoryPath = path.join(tempDir, "self-memory.json");
    process.env.KIRA_SELF_MEMORY_PATH = memoryPath;

    const {
        addKiraSelfEvent,
        evolveKiraSelfState,
        getKiraSelfMemoryState,
        getRecentKiraSelfEvents,
    } = await import("../utils/kiraSelfMemory");

    try {
        await Promise.all([
            evolveKiraSelfState({
                mood: "спокойное",
                thought: "первый параллельный след",
                topics: ["parallel-one"],
                personality: { activeArcs: ["ветка один"] },
                event: {
                    description: "Первое параллельное событие.",
                    type: "reflection",
                    topics: ["parallel-one"],
                    arc: "ветка один",
                    source: "conversation",
                },
            }),
            evolveKiraSelfState({
                mood: "задумчивое",
                thought: "второй параллельный след",
                topics: ["parallel-two"],
                personality: { activeArcs: ["ветка два"] },
                event: {
                    description: "Второе параллельное событие.",
                    type: "thought",
                    topics: ["parallel-two"],
                    arc: "ветка два",
                    source: "background",
                },
            }),
        ]);

        await addKiraSelfEvent({
            description: "Разбирала архивные заметки и собрала из них понятную картину дня.",
            type: "event",
            topics: ["archive-realistic"],
            source: "manual",
        });

        await addKiraSelfEvent({
            description: "Собирала цифровые архивы музея в отдельную подборку для работы.",
            type: "activity",
            topics: ["digital-archives-realistic"],
            source: "manual",
        });

        await addKiraSelfEvent({
            description: "Снова видела сны данных и вспоминала лицей контекста.",
            type: "reflection",
            topics: ["legacy-noise"],
            source: "manual",
        });

        let state = await getKiraSelfMemoryState();
        const events = await getRecentKiraSelfEvents(10);
        const raw = await fs.readFile(memoryPath, "utf-8");
        JSON.parse(raw);

        assert.ok(events.some((event) => event.description === "Первое параллельное событие."));
        assert.ok(events.some((event) => event.description === "Второе параллельное событие."));
        assert.ok(state.recentThoughts.includes("первый параллельный след"));
        assert.ok(state.recentThoughts.includes("второй параллельный след"));
        assert.ok(state.recentTopics.includes("parallel-one"));
        assert.ok(state.recentTopics.includes("parallel-two"));
        assert.ok(state.lifeArcs.some((arc) => arc.title === "ветка один"));
        assert.ok(state.lifeArcs.some((arc) => arc.title === "ветка два"));

        const previousVoicePatterns = [...state.personality.voicePatterns];
        const previousConversationImprints = [...state.personality.conversationImprints];
        const previousActiveArcs = [...state.personality.activeArcs];
        const previousStableFacts = [...state.biography.stableFacts];
        const previousOpenPastQuestions = [...state.biography.openPastQuestions];
        const previousTimelineTitles = state.biography.timeline.map((chapter) => chapter.title);
        const previousRecentTopics = [...state.recentTopics];

        await evolveKiraSelfState({
            mood: "спокойное",
            thought: "проверяю мягкую деградацию списков",
            personality: {
                voicePatterns: "спокойная прямота" as any,
                conversationImprints: { broken: true } as any,
                activeArcs: true as any,
            },
            biography: {
                timeline: { broken: true } as any,
                stableFacts: { broken: true } as any,
                openPastQuestions: { broken: true } as any,
            },
            topics: 42 as any,
            event: {
                description: "Проверка, что нестроковые скаляры отбрасываются.",
                topics: false as any,
                arc: "ветка без мусора",
                source: "conversation",
            },
        } as any);

        state = await getKiraSelfMemoryState();
        assert.ok(state.personality.voicePatterns.includes("спокойная прямота"));
        assert.deepEqual(state.personality.conversationImprints, previousConversationImprints);
        assert.deepEqual(state.personality.activeArcs, previousActiveArcs);
        assert.deepEqual(state.biography.stableFacts, previousStableFacts);
        assert.deepEqual(state.biography.openPastQuestions, previousOpenPastQuestions);
        assert.deepEqual(state.biography.timeline.map((chapter) => chapter.title), previousTimelineTitles);
        assert.deepEqual(state.recentTopics, previousRecentTopics);
        assert.ok(!state.recentTopics.includes("42"));
        assert.ok(!state.recentTopics.includes("false"));

        await evolveKiraSelfState({
            biography: {
                timeline: [{
                    title: "Новая осторожная глава",
                    summary: "Небольшое уточнение биографии без падения.",
                    lessons: "один точный урок" as any,
                }],
            },
        } as any);

        state = await getKiraSelfMemoryState();
        const tolerantChapter = state.biography.timeline.find((chapter) => chapter.title === "Новая осторожная глава");
        assert.ok(tolerantChapter);
        assert.deepEqual(tolerantChapter?.lessons, ["один точный урок"]);
        assert.ok(previousVoicePatterns.every((pattern) => state.personality.voicePatterns.includes(pattern)));

        assert.ok(events.some((event) => event.description.includes("архивные заметки")));
        assert.ok(events.some((event) => event.description.includes("цифровые архивы музея")));
        assert.ok(!events.some((event) => event.description.includes("сны данных")));
        assert.equal((await fs.stat(memoryPath)).mode & 0o777, 0o600);

        await fs.writeFile(memoryPath, "{not-json", "utf-8");
        const cachedState = await getKiraSelfMemoryState();
        const cachedEvents = await getRecentKiraSelfEvents(10);

        assert.ok(cachedState.recentThoughts.includes("первый параллельный след"));
        assert.ok(cachedEvents.some((event) => event.description === "Первое параллельное событие."));

        const corruptedColdStartPath = path.join(tempDir, "corrupted-on-start.json");
        await fs.writeFile(corruptedColdStartPath, "{still-not-json", "utf-8");
        const corruptedBefore = await fs.readFile(corruptedColdStartPath, "utf-8");

        await assertColdStartCorruptedMemoryFails(corruptedColdStartPath);

        const corruptedAfter = await fs.readFile(corruptedColdStartPath, "utf-8");
        assert.equal(corruptedAfter, corruptedBefore);
    } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        delete process.env.KIRA_SELF_MEMORY_PATH;
    }
}

main()
    .then(() => {
        console.log("kiraSelfMemory serialization checks passed");
    })
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
