import assert from 'node:assert/strict';
import test from 'node:test';
import { browserInternalDiagnostic, browserPublicFailure } from '../utils/browserFailureReply';

const syntheticProxy = new URL('http://proxy.invalid');
syntheticProxy.username = 'synthetic-user'; syntheticProxy.password = 'synthetic-proxy-password';
const launchLog = `browserType.launchPersistentContext: Target page, context or browser has been closed
Browser logs:
<launching> /usr/bin/chromium-browser --disable-background-networking --no-first-run --user-data-dir=/tmp/synthetic-account/browser --proxy-server=${syntheticProxy.href}
<launched> pid=123
[pid=123][err] Failed to create /tmp/synthetic-account/browser/SingletonLock: File exists
[pid=123][err] Failed to create a ProcessSingleton for your profile directory.
Call log:
  - <launching> /usr/bin/chromium-browser --remote-debugging-pipe`;

test('a full Playwright launch log becomes one safe sentence with a bounded reason code', () => {
    const result = browserPublicFailure(new Error(launchLog));
    assert.equal(result.code, 'browser_profile_in_use');
    assert.equal(result.reply, 'Браузер сейчас занят другой сессией; попробуй ещё раз позже.');
    assert.doesNotMatch(result.reply, /chromium|launch|Singleton|--|\/usr|\/tmp|synthetic|pid=|\n/);
    assert.ok(result.reply.length < 160);
});

test('missing display, binary/runtime failures, generic launch and navigation errors stay distinct without disclosing paths', () => {
    for (const message of ['browserType.launch: Missing X server or $DISPLAY', 'spawn /synthetic/chromium ENOENT',
        'Executable doesn\'t exist at /tmp/synthetic/browser', 'error while loading shared libraries: synthetic.so', 'spawn /tmp/synthetic EACCES'])
        assert.equal(browserPublicFailure(message).code, 'browser_runtime_unavailable');
    assert.equal(browserPublicFailure('browserType.launch: Target page, context or browser has been closed').code, 'browser_launch_failed');
    assert.equal(browserPublicFailure('page.goto: net::ERR_NAME_NOT_RESOLVED at https://synthetic.invalid/private').code, 'browser_navigation_failed');
    for (const input of [null, undefined, {}, 42, { message: 7 }, 'synthetic-secret-raw-exception', { get message() { throw Error('bad getter'); } }]) {
        const result = browserPublicFailure(input);
        assert.equal(result.code, 'browser_failed'); assert.equal(result.reply, 'Не удалось завершить задачу в браузере; попробуй ещё раз позже.');
    }
});

test('useful internal diagnostics redact credentials, headers, query values and bound the entire launch log', () => {
    const raw = launchLog + '\nAuthorization: Bearer synthetic-auth-secret\nCookie: session=synthetic-cookie-secret; private=synthetic-extra\n' +
        'token=synthetic-token-secret password="synthetic-password-secret" api_key=synthetic-api-secret\n' +
        'url=https://example.invalid/?account=synthetic-account-secret&token=synthetic-query-token';
    const diagnostic = browserInternalDiagnostic(new Error(raw));
    assert.match(diagnostic, /ProcessSingleton/); assert.match(diagnostic, /REDACTED/);
    for (const secret of ['synthetic-proxy-password', 'synthetic-auth-secret', 'synthetic-cookie-secret', 'synthetic-extra', 'synthetic-token-secret',
        'synthetic-password-secret', 'synthetic-api-secret', 'synthetic-account-secret', 'synthetic-query-token']) assert.ok(!diagnostic.includes(secret), secret);
    assert.ok(browserInternalDiagnostic('token=' + 'a'.repeat(5000)).length <= 1200);
    assert.ok(!browserInternalDiagnostic('token=' + 'a'.repeat(5000)).includes('a'.repeat(20)));
    assert.ok(!browserInternalDiagnostic('password="synthetic password with spaces"').includes('password with spaces'));
    assert.equal(browserInternalDiagnostic({}), '');
});

test('model failures use a constant public reply rather than a provider exception', () => {
    const result = browserPublicFailure(new Error('Connection error at https://synthetic.invalid/private token=synthetic-secret'), 'model');
    assert.equal(result.code, 'browser_model_unavailable');
    assert.equal(result.reply, 'Не удалось получить следующий шаг от модели. Попробуй продолжить задачу позже.');
    assert.doesNotMatch(result.reply, /Connection|synthetic|token|https/);
});
