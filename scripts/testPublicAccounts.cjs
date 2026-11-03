'use strict';
// Explicit disposable localhost PostgreSQL only; no DB_* or live-provider settings are read.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Pass the disposable PostgreSQL port');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'tests')).filter(f => /^platform-public-.*\.test\.ts$/.test(f)).sort().map(f => 'tests/' + f);
const env = { ...process.env, NODE_ENV: 'test', KIRA_PLATFORM_TEST_PG_PORT: String(port),
    KIRA_BOT_TOKEN: '1234567890:abcdefghijklmnopqrstuvwxyzABCDE', OPENAI_API_KEY: 'synthetic-public-test' };
delete env.NODE_TEST_CONTEXT;
const child = spawnSync(process.execPath, ['--test','--require','ts-node/register',...files], {cwd:root,env,stdio:'inherit'});
process.exitCode = child.status ?? 1;
