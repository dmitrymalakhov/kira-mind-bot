#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');

function git(args) { return cp.execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }); }
function isPrivatePath(file) {
  const name = file.replace(/\\/g, '/');
  if (/^(?:\.env\.example|\.env\.production\.example)$/.test(name)) return false;
  return /(?:^|\/)(?:\.env(?:\..*)?|\.kira-admin-state|personality\.json|browser-credentials\.json|known_hosts|id_rsa|id_ed25519)$/.test(name)
    || /^(?:backups|runtime-data|data|tmp|temp|handlers\/temp|\.claude|\.codex|\.zcode|\.aws|\.ssh)\//.test(name)
    || /\.(?:pem|key|p12|pfx|dump|snapshot|sqlite3?|db|session(?:-journal)?|tar(?:\.gz)?|tgz|bak)$/i.test(name);
}

function readKnownValues(root) {
  const values = new Map();
  for (const file of ['.env', '.env.production', '.env.local', '.kira-admin-state']) {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) continue;
    for (const line of fs.readFileSync(target, 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) values.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
    }
  }
  try {
    const personality = JSON.parse(fs.readFileSync(path.join(root, 'personality.json'), 'utf8'));
    for (const profile of Object.values(personality)) {
      for (const key of ['ownerName', 'ownerUsername', 'userName', 'userBirthDate']) {
        if (typeof profile?.[key] === 'string') values.set(`PERSONALITY_${key}`, profile[key]);
      }
    }
  } catch { /* A local personality file is optional. */ }
  return [...values].flatMap(([key, value]) => {
    const secret = /TOKEN|PASSWORD|SECRET|API_KEY|API_HASH|SESSION_STRING|PRIVATE_KEY/.test(key);
    const identity = /ALLOWED_USER_ID|ADMIN_USER_ID|OWNER_NAME|OWNER_USERNAME|USER_NAME|USER_BIRTH_DATE|SSH_HOST|SERVER_(?:IP|HOST)|^PERSONALITY_/.test(key);
    if ((!secret && !identity) || value.length < (secret ? 8 : 4)) return [];
    if (/^(?:synthetic|test|example|your_|changeme|placeholder|владелец|Пользователь|Тестовый)/i.test(value) || value === 'lm-studio') return [];
    return [{ value, rule: secret ? 'current-secret' : 'current-private-identity' }];
  });
}

const PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['telegram-token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['gateway-key', /\blmr_live_[A-Za-z0-9_-]{12,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['personal-home-path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//g],
  ['embedded-url-password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi],
];
function isSynthetic(value) {
  return /^(?:(?:sk-(?:proj-|svcacct-)?|lmr_live_|ghp_|\d{8,12}:)?(?:synthetic|test[-_]|fake[-_]|example[-_]|dummy[-_]|your_|placeholder))/i.test(value)
    || value === '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
}
function scanText(file, content, known = []) {
  if (isPrivatePath(file)) return [{ path: file, line: 1, rule: 'private-runtime-file' }];
  if (content.includes('\0')) return [];
  const findings = [];
  content.split('\n').forEach((line, index) => {
    const rules = new Set();
    for (const entry of known) if (line.includes(entry.value)) rules.add(entry.rule);
    for (const [rule, pattern] of PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) if (!isSynthetic(match[0])) rules.add(rule);
    }
    for (const match of line.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
      const address = match[0];
      const allowed = /^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|1\.1\.1\.1$|8\.8\.8\.8$)/.test(address);
      if (!allowed && !line.includes(`Chrome/${address}`)) rules.add('deployment-ip-address');
    }
    if (!/^(?:tests\/|scripts\/test)/.test(file)) {
      if (/\b(?:allowedUserId|adminUserId)\s*:\s*[1-9]\d{5,}/.test(line)) rules.add('hardcoded-user-id');
      if (/\buserBirthDate\s*:\s*['"]\d{2}\.\d{2}\.\d{4}['"]/.test(line)) rules.add('hardcoded-birth-date');
    }
    for (const rule of rules) findings.push({ path: file, line: index + 1, rule });
  });
  return findings;
}

function main() {
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  process.chdir(root);
  const staged = process.argv.includes('--staged');
  const files = [...new Set(git(staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
    : ['ls-files', '-co', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean))];
  const known = readKnownValues(root);
  const findings = [];
  for (const file of files) {
    if (isPrivatePath(file)) { findings.push({ path: file, line: 1, rule: 'private-runtime-file' }); continue; }
    let bytes;
    if (staged) bytes = git(['show', `:${file}`]);
    else {
      try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) { findings.push({ path: file, line: 1, rule: 'symlink-needs-review' }); continue; }
        if (!stat.isFile()) continue;
        bytes = fs.readFileSync(file);
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    }
    findings.push(...scanText(file, bytes.toString('utf8'), known));
  }
  if (findings.length) {
    console.error('Privacy check failed. Values are hidden:');
    for (const item of findings.slice(0, 100)) console.error(`${item.path}:${item.line} [${item.rule}]`);
    console.error(`Found ${findings.length} issue(s). Move private settings into ignored env/runtime files.`);
    process.exitCode = 1;
  } else console.log(`Privacy check passed (${files.length} ${staged ? 'staged' : 'project'} files).`);
}
if (require.main === module) {
  try { main(); }
  catch { console.error('Privacy check could not read Git/files safely. Commit is blocked; no values are shown.'); process.exitCode = 1; }
}
module.exports = { isPrivatePath, scanText, readKnownValues };
