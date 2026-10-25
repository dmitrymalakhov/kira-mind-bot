#!/usr/bin/env python3
"""Adopt the current installation as an ordinary account, retaining its original storage."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent


def env_file(path):
    result = {}
    for line in path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            result[key.strip()] = value.strip().strip('\"\'')
    return result


def write_env(path, updates):
    lines = path.read_text().splitlines()
    pending = dict(updates)
    for index, line in enumerate(lines):
        key = line.split('=', 1)[0]
        if key in pending:
            lines[index] = key + '=' + pending.pop(key)
    lines.extend(key + '=' + value for key, value in pending.items())
    temporary = path.with_name(path.name + '.migration-tmp')
    temporary.write_text('\n'.join(lines) + '\n')
    temporary.chmod(0o600)
    temporary.replace(path)


def copy_private(source, target):
    if source.is_symlink():
        return
    if source.is_dir():
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.chmod(0o700)
        for entry in source.iterdir():
            copy_private(entry, target / entry.name)
    elif stat.S_ISREG(source.stat().st_mode):
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(source, target)
        target.chmod(0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--docker', default='docker')
    args = parser.parse_args()
    os.chdir(ROOT)
    private = ROOT / 'runtime-data/account-migration'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    private.chmod(0o700)
    environment = dict(os.environ)
    environment['PATH'] = str(Path(args.docker).resolve().parent) + os.pathsep + environment.get('PATH', '')
    environment['SERVER_COMPOSE_OVERRIDE'] = 'docker-compose.accounts.yml'

    def run(command, *, allow_failure=False, input=None):
        result = subprocess.run(command, input=input, capture_output=True, text=True, env=environment)
        if result.returncode and not allow_failure:
            raise RuntimeError('Command failed; private command output was suppressed')
        return result

    def compose(*command):
        return run([str(ROOT / 'scripts/ops/local.sh'), *command])

    config = env_file(ROOT / '.env')
    runtime = env_file(ROOT / '.env.production')
    instance = config.get('KIRA_INSTANCE_NAME')
    if not instance:
        raise RuntimeError('An explicit existing instance identity is required')
    inspected = json.loads(run([args.docker, 'inspect', instance]).stdout)[0]
    if Path(inspected['Config']['Labels']['com.docker.compose.project.working_dir']).resolve() != ROOT:
        raise RuntimeError('Existing container belongs to another directory')
    active_env = dict(item.split('=', 1) for item in inspected['Config']['Env'] if '=' in item)
    for key in ['DB_NAME', 'DB_USER', 'DB_PASSWORD', 'KIRA_BOT_TOKEN', 'KIRA_ALLOWED_USER_ID', 'KIRA_API_TOKEN']:
        if runtime.get(key) != active_env.get(key):
            raise RuntimeError('Running configuration differs from the private env file; migration stopped')
    if not inspected['State']['Running']:
        raise RuntimeError('Expected an active original bot before migration')
    bindings = inspected['NetworkSettings']['Ports'].get('3200/tcp') or []
    if len(bindings) != 1 or bindings[0]['HostIp'] != '127.0.0.1':
        raise RuntimeError('Expected one private API port binding')
    port = bindings[0]['HostPort']
    print('Existing instance and private configuration match; original database and Qdrant namespace will be retained.', flush=True)
    if not args.apply:
        return

    old_env = (ROOT / '.env').read_bytes()
    old_runtime = (ROOT / '.env.production').read_bytes()
    for name, value in [('compose-before.env', old_env), ('runtime-before.env', old_runtime)]:
        backup = private / name
        if not backup.exists():
            backup.write_bytes(value)
            backup.chmod(0o600)
    key_file = private / 'platform-master.key'
    key = runtime.get('KIRA_PLATFORM_MASTER_KEY')
    if not key:
        key = key_file.read_text().strip() if key_file.exists() else secrets.token_hex(32)
        key_file.write_text(key + '\n')
        key_file.chmod(0o600)
        write_env(ROOT / '.env.production', {'KIRA_PLATFORM_MASTER_KEY': key})
    stopped = False
    started_accounts = False
    try:
        print('Building account runtime while the current bot stays online...', flush=True)
        compose('build', 'kira-accounts')
        print('Preparing an ordinary account and restricted PostgreSQL role...', flush=True)
        compose('run', '--rm', '--no-deps', '-T', 'kira-accounts', 'node', 'dist/platform/importExisting.js', 'prepare')
        state = json.loads((ROOT / 'runtime-data/accounts/import/current-account.json').read_text())
        if state['phase'] == 'active':
            raise RuntimeError('An import is already active; inspect its runtime before repeating migration')
        account_id = str(uuid.UUID(state['accountId']))
        target = ROOT / 'runtime-data/accounts' / ('kira_u_' + account_id.replace('-', ''))
        data = target / 'data'
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        legacy_dirs = ['browser-profiles', 'browser-trajectories', 'browser-site-patterns.json']
        legacy_root = Path(inspected['Config']['WorkingDir']) / 'dist/data'
        exists_code = 'const fs=require("fs"); console.log(JSON.stringify(process.argv.slice(1).map(p=>fs.existsSync(p))))'
        exists = json.loads(run([args.docker, 'exec', instance, 'node', '-e', exists_code,
                                 *[str(legacy_root / name) for name in legacy_dirs]]).stdout)
        print('Pausing the old poller briefly; original storage remains in place...', flush=True)
        run([args.docker, 'stop', instance])
        stopped = True
        allowed = {'allowed-user-chat.json', 'dm-report-state.json', 'browser-credentials.json',
                   'browser-sessions', 'browser-profiles', 'browser-trajectories', 'browser-site-patterns.json',
                   'api-files', 'image-generation'}
        for source in (ROOT / 'runtime-data').iterdir():
            if source.name in allowed or source.name.endswith(('-self-memory.json', '-personal-chat-memory-index.json')):
                copy_private(source, data / source.name)
        for name, exists in zip(legacy_dirs, exists):
            if exists:
                temporary = private / ('legacy-' + name)
                if temporary.exists():
                    raise RuntimeError('Legacy browser snapshot already exists; inspect it before a retry')
                run([args.docker, 'cp', instance + ':' + str(legacy_root / name), str(temporary)])
                copy_private(temporary, data / name)
        personality = json.loads((ROOT / 'personality.json').read_text())
        profile = personality.setdefault('KiraMindBot', {})
        for name, variable in [('ownerName', 'OWNER_NAME'), ('ownerUsername', 'OWNER_USERNAME'),
                               ('userName', 'USER_NAME'), ('userBirthDate', 'USER_BIRTH_DATE')]:
            if not profile.get(name) and runtime.get(variable):
                profile[name] = runtime[variable]
        profile_file = target / 'personality.json'
        profile_file.write_text(json.dumps(personality, ensure_ascii=False))
        profile_file.chmod(0o600)
        compose('run', '--rm', '--no-deps', '-T', 'kira-accounts', 'node', 'dist/platform/importExisting.js', 'activate')
        compose('run', '--rm', '--no-deps', '-T', 'kira-accounts', 'node', 'dist/platform/importExisting.js', 'check')
        write_env(ROOT / '.env', {'KIRA_ACCOUNTS_MODE': 'true', 'ACCOUNTS_PORT': port})
        print('Starting the account service on the previous API address...', flush=True)
        started_accounts = True
        compose('up', '-d', '--no-deps', 'kira-accounts')
        import urllib.request
        import urllib.error
        token = state['accessToken']
        base = 'http://127.0.0.1:' + port + '/api/v1'
        def request(route, body=None):
            headers = {'Authorization': 'Bearer ' + token}
            if body is not None:
                headers.update({'Content-Type': 'application/json', 'Idempotency-Key': 'migration-' + uuid.uuid4().hex})
            req = urllib.request.Request(base + route, data=json.dumps(body).encode() if body is not None else None, headers=headers)
            with urllib.request.urlopen(req, timeout=20) as response:
                return json.load(response)
        for attempt in range(60):
            try:
                current = request('/account')['account']
                if current['id'] != account_id:
                    raise RuntimeError('Current API credential resolved to another account')
                if current['bot']['status'] == 'ready':
                    break
            except (OSError, urllib.error.URLError, KeyError):
                pass
            time.sleep(2)
        else:
            raise RuntimeError('Imported runtime did not become ready')
        settings = request('/settings')
        if not request('/status').get('ok') or not request('/messages', {'text': '/help'}).get('messages'):
            raise RuntimeError('Imported API did not pass the command check')
        if bool(runtime.get('TELEGRAM_SESSION_STRING')) != settings['telegram']['personalSessionConfigured']:
            raise RuntimeError('Personal Telegram configuration was not retained')
        compose('up', '-d', '--no-deps', 'admin-panel')
        print('Migration verified: ordinary account, same API credential/address, command handlers and personal Telegram configuration work.', flush=True)
        print('Private login details: runtime-data/accounts/import/current-account.json', flush=True)
    except Exception:
        print('Migration stopped; restoring the original running instance...', flush=True)
        if started_accounts:
            run([str(ROOT / 'scripts/ops/local.sh'), 'stop', 'kira-accounts'], allow_failure=True)
        (ROOT / '.env').write_bytes(old_env)
        (ROOT / '.env').chmod(0o600)
        (ROOT / '.env.production').write_bytes(old_runtime)
        (ROOT / '.env.production').chmod(0o600)
        if stopped:
            run([args.docker, 'start', instance], allow_failure=True)
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else 'Migration failed; private error details were suppressed.')
        raise SystemExit(1)
