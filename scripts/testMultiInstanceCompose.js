'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const sourceCompose = path.join(repoRoot, 'docker-compose.server.yml');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kira-compose-isolation-'));
const composeFile = path.join(tempDir, 'docker-compose.server.yml');

function cleanup() {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function render(instanceName, adminPort) {
  const result = spawnSync(
    'docker',
    ['compose', '-f', composeFile, 'config', '--format', 'json'],
    {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        KIRA_INSTANCE_NAME: instanceName,
        ADMIN_PORT: String(adminPort),
        DB_PASSWORD: 'test-password',
      },
    }
  );

  if (result.status !== 0) {
    throw new Error(`docker compose config failed: ${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

function assertInstance(config, name, adminPort) {
  assert.strictEqual(config.name, name);
  assert.strictEqual(config.services['kira-mind-bot'].container_name, name);
  assert.strictEqual(config.volumes.postgres_data.name, `${name}_postgres_data`);
  assert.strictEqual(config.volumes.qdrant_storage.name, `${name}_qdrant_storage`);
  assert.strictEqual(config.networks.default.name, `${name}_default`);
  assert.deepStrictEqual(config.services.postgres.networks, { default: null });
  assert.deepStrictEqual(config.services.qdrant.networks, { default: null });
  assert.deepStrictEqual(config.services['kira-mind-bot'].networks, { default: null });
  assert.strictEqual(config.services.postgres.ports, undefined);
  assert.strictEqual(config.services.qdrant.ports, undefined);
  assert.strictEqual(config.services['admin-panel'].ports[0].published, String(adminPort));
}

function assertNoDestructiveVolumeCleanup() {
  const files = [
    path.join(repoRoot, 'Makefile'),
    path.join(repoRoot, 'scripts', 'ops', 'server-common.sh'),
    path.join(repoRoot, 'scripts', 'ops', 'server-deploy.sh'),
    path.join(repoRoot, 'scripts', 'ops', 'server-install.sh'),
    path.join(repoRoot, 'scripts', 'ops', 'deploy.sh'),
  ];
  const forbidden = [
    /container\s+prune/,
    /image\s+prune/,
    /builder\s+prune/,
    /volume\s+prune/,
    /docker\s+volume\s+rm/,
    /\bdown\b[^\n]*(?:\s-v\b|--volumes\b)/,
    /system\s+prune[^\n]*--volumes/,
  ];

  for (const file of files) {
    assert.ok(fs.existsSync(file), `${path.relative(repoRoot, file)} must exist`);
    const content = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${path.relative(repoRoot, file)} contains destructive volume cleanup`);
    }
  }
}

function assertOperationalSecurity() {
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');
  const deployScript = fs.readFileSync(path.join(repoRoot, 'scripts', 'ops', 'deploy.sh'), 'utf8');
  const adminServer = fs.readFileSync(path.join(repoRoot, 'admin-panel', 'server.js'), 'utf8');
  const installScripts = [
    fs.readFileSync(path.join(repoRoot, 'scripts', 'ops', 'install.sh'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'scripts', 'ops', 'server-install.sh'), 'utf8'),
  ];

  assert.match(gitignore, /^\.kira-admin-state$/m);
  assert.match(deployScript, /source \.\/scripts\/ops\/server-common\.sh/);
  assert.match(deployScript, /--remote-dir/);
  assert.match(deployScript, /rsync -a ai\/ _deploy\/ai\//);
  assert.match(deployScript, /legacyPersonalitySanitizer\.js/);
  assert.match(adminServer, /\/containers\/\$\{encodeURIComponent\(name\)\}\/json/);
  for (const script of installScripts) {
    assert.doesNotMatch(script, /\beval\s/);
  }
}

try {
  assertNoDestructiveVolumeCleanup();
  assertOperationalSecurity();

  const dockerAvailable = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  if (!dockerAvailable) {
    console.log('multi-instance compose rendering skipped: Docker Compose unavailable');
  } else {
    fs.copyFileSync(sourceCompose, composeFile);
    fs.writeFileSync(path.join(tempDir, '.env.production'), '', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'personality.json'), '{}', 'utf8');

    const primary = render('kira-mind-bot', 7875);
    const secondary = render('kira-wife', 7876);

    assertInstance(primary, 'kira-mind-bot', 7875);
    assertInstance(secondary, 'kira-wife', 7876);
    assert.notStrictEqual(primary.volumes.postgres_data.name, secondary.volumes.postgres_data.name);
    assert.notStrictEqual(primary.volumes.qdrant_storage.name, secondary.volumes.qdrant_storage.name);
    assert.notStrictEqual(primary.networks.default.name, secondary.networks.default.name);
    console.log('multi-instance compose isolation checks passed');
  }
} finally {
  cleanup();
}
