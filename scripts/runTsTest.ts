import { spawn } from "node:child_process";
import path from "node:path";
import { buildSyntheticTestEnv } from './testEnv';

const requested = process.argv[2]?.trim();

if (!requested) {
    console.error("Usage: ts-node scripts/runTsTest.ts <test-file.ts>");
    process.exit(1);
}

const fileName = requested.endsWith(".ts") ? requested : `${requested}.ts`;
const scriptPath = path.join(process.cwd(), "scripts", fileName);

const child = spawn("ts-node", [scriptPath], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: buildSyntheticTestEnv(),
    shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});
