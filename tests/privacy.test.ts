import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveRuntimeIdentity } from '../utils/runtimeIdentity';
const { scanText, isPrivatePath } = require('../scripts/checkPrivacy');

test('deployment identity has no built-in owner and invalid IDs fail closed', () => {
  assert.equal(resolveRuntimeIdentity({}).allowedUserId, 0);
  assert.equal(resolveRuntimeIdentity({}).adminUserId, 0);
  assert.equal(resolveRuntimeIdentity({}).userBirthDate, '');
  for (const value of ['-1', 'NaN', '1.5', 'Infinity', '123foo', '9007199254740992']) assert.equal(resolveRuntimeIdentity({ KIRA_ALLOWED_USER_ID: value }).allowedUserId, 0);
  const resolved = resolveRuntimeIdentity({ KIRA_ALLOWED_USER_ID: '100001', ALLOWED_USER_ID: '100099', KIRA_ADMIN_USER_ID: '100002', KIRA_BOT_USERNAME: '@synthetic_bot', USER_BIRTH_DATE: '01.01.2000' });
  assert.equal(resolved.allowedUserId, 100001); assert.equal(resolved.adminUserId, 100002);
  assert.equal(resolved.botUsername, 'synthetic_bot'); assert.equal(resolved.userBirthDate, '01.01.2000');
  assert.equal(resolveRuntimeIdentity({ ALLOWED_USER_ID: '100003' }).allowedUserId, 100003);
});

test('privacy guard blocks real secret shapes, local data and home paths without returning values', () => {
  for (const file of ['.env', '.env.production', 'backups/copy.dump', '.claude/settings.local.json', 'runtime-data/browser-credentials.json', 'data/private.json', 'private.pem']) assert.equal(isPrivatePath(file), true, file);
  for (const file of ['.env.example', '.env.production.example', 'ai/modelPresets.ts', 'scripts/fixtures/memory-retrieval.synthetic.json']) assert.equal(isPrivatePath(file), false, file);
  const value = ['sk', 'proj', 'AbCDeFGhIJKlmnOPqRstUVwxYZ0123456789'].join('-');
  const findings = scanText('source.ts', `const key = '${value}';`);
  assert.equal(findings[0].rule, 'openai-key'); assert.ok(!JSON.stringify(findings).includes(value));
  assert.equal(scanText('source.ts', "const x = '/Users/" + "private-owner/project';")[0].rule, 'personal-home-path');
  assert.equal(scanText('source.ts', 'const host = "198.51.100.3";').length, 0);
  assert.equal(scanText('source.ts', `const host = "${[10, 40, 50, 60].join('.')}";`)[0].rule, 'deployment-ip-address');
  assert.equal(scanText('source.ts', 'const token = "synthetic-test-token";').length, 0);
  assert.equal(scanText('source.ts', 'copied private value', [{ value: 'private value', rule: 'current-secret' }])[0].rule, 'current-secret');
});

test('staged privacy check reads the Git index even if the working copy has been cleaned', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kira-privacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runGit = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  runGit('init', '--quiet');
  const file = path.join(root, 'source.ts');
  const secret = ['sk', 'proj', 'AbCDeFGhIJKlmnOPqRstUVwxYZ0123456789'].join('-');
  fs.writeFileSync(file, `const key = '${secret}';`);
  runGit('add', 'source.ts');
  fs.writeFileSync(file, 'const key = process.env.OPENAI_API_KEY;');
  const checker = path.resolve(__dirname, '../scripts/checkPrivacy.js');
  const result = spawnSync(process.execPath, [checker, '--staged'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /openai-key/);
  assert.ok(!result.stderr.includes(secret));
  runGit('add', 'source.ts');
  assert.equal(spawnSync(process.execPath, [checker, '--staged'], { cwd: root }).status, 0);
  fs.writeFileSync(path.join(root, '.env.production'), 'SYNTHETIC_VALUE=not-a-secret');
  runGit('add', '.env.production');
  const blocked = spawnSync(process.execPath, [checker, '--staged'], { cwd: root, encoding: 'utf8' });
  assert.equal(blocked.status, 1); assert.match(blocked.stderr, /private-runtime-file/);
});
