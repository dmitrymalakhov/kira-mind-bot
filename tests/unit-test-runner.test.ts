import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('unit runner retains non-ASCII output, executes every file and propagates assertion failures', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kira-unit-runner-'));
    try {
        const files = ['fail.cjs', 'pass.cjs'].map(file => path.join(dir, file));
        writeFileSync(files[0], "const {test}=require('node:test'); test('synthetic failing assertion',()=>{require('node:assert/strict').equal(1,2)});\n");
        writeFileSync(files[1], "const {test}=require('node:test'); console.log('🟡 Проверка UTF-8'); test('synthetic passing assertion',()=>{});\n");
        const result = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts/runUnitTests.cjs'), ...files], { encoding: 'utf8', timeout: 20_000 });
        assert.equal(result.status, 1);
        assert.match(result.stdout, /Проверка UTF-8/);
        assert.match(result.stdout, /synthetic failing assertion/);
        assert.match(result.stdout, /synthetic passing assertion/);
        const totals = JSON.parse(result.stdout.match(/Unit totals: (.+)/)![1]);
        assert.deepEqual(totals, { files: 2, failedFiles: 1, tests: 2, pass: 1, fail: 1, skipped: 0 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
