'use strict';

// Standalone node:test processes keep file isolation without the affected
// parent runner's mixed UTF-8/V8 stdout framing (nodejs/node#64061, #64706).
// Every file runs once; failures are propagated, never retried or hidden.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const files = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync(path.join(__dirname, '../tests'))
    .filter(file => file.endsWith('.test.ts')).sort().map(file => path.join(__dirname, '../tests', file));
if (!files.length) throw Error('No unit test files found');
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
let next = 0, failedFiles = 0;
const totals = { tests: 0, pass: 0, fail: 0, skipped: 0 };
async function worker() {
    while (next < files.length) {
        const file = files[next++];
        await new Promise(resolve => {
            const child = spawn(process.execPath, ['--test-reporter=tap', '--require', 'ts-node/register', file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            let tail = '';
            child.stdout.on('data', chunk => { process.stdout.write(chunk); tail = (tail + chunk.toString('utf8')).slice(-12_000); });
            child.stderr.on('data', chunk => process.stderr.write(chunk));
            child.on('error', error => { process.stderr.write(`${path.basename(file)}: ${error.message}\n`); });
            child.on('close', code => {
                for (const key of Object.keys(totals)) totals[key] += Number(tail.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] || 0);
                if (code !== 0 || !/^# tests \d+$/m.test(tail)) failedFiles++;
                process.stdout.write(`Unit file ${code === 0 ? 'finished' : 'failed'}: ${path.basename(file)}\n`);
                resolve();
            });
        });
    }
}
Promise.all([worker(), worker()]).then(() => {
    process.stdout.write(`Unit totals: ${JSON.stringify({ files: files.length, failedFiles, ...totals })}\n`);
    if (failedFiles || totals.fail) process.exitCode = 1;
}).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
