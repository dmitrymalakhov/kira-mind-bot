export type BrowserFailureCode = 'browser_profile_in_use' | 'browser_runtime_unavailable' | 'browser_launch_failed' | 'browser_navigation_failed' | 'browser_failed';

function message(error: unknown): string {
    try {
        if (typeof error === 'string') return error;
        if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
    } catch { /* Exception getters are not trusted either. */ }
    return '';
}

/** Public messages are constants: provider/Playwright output never becomes an assistant reply or session reason. */
export function browserPublicFailure(error: unknown): { code: BrowserFailureCode; reply: string } {
    const raw = message(error);
    if (/SingletonLock|ProcessSingleton|profile (?:is |already )?in use|user data directory is already in use/iu.test(raw))
        return { code: 'browser_profile_in_use', reply: 'Браузер сейчас занят другой сессией; попробуй ещё раз позже.' };
    if (/Missing X server|\$DISPLAY|cannot open display|executable (?:doesn.t exist|not found)|ENOENT|EACCES|error while loading shared libraries/iu.test(raw))
        return { code: 'browser_runtime_unavailable', reply: 'Браузер сейчас недоступен на сервере; попробуй ещё раз позже.' };
    if (/browserType\.launch|launchPersistentContext|<launching>|failed to launch/iu.test(raw))
        return { code: 'browser_launch_failed', reply: 'Не удалось запустить браузер; попробуй ещё раз позже.' };
    if (/page\.goto|net::ERR_|navigation.*(?:failed|timeout)|Timeout.*(?:navigat|page\.goto)/iu.test(raw))
        return { code: 'browser_navigation_failed', reply: 'Не удалось открыть страницу; проверь адрес или попробуй ещё раз позже.' };
    return { code: 'browser_failed', reply: 'Не удалось завершить задачу в браузере; попробуй ещё раз позже.' };
}

/** Internal diagnostic only. Do not attach it to replies, assistance requests, session reasons or public traces. */
export function browserInternalDiagnostic(error: unknown): string {
    return message(error)
        .replace(/((?:Bearer|Basic)\s+)[A-Za-z0-9._~+\/-]+=*/giu, '$1[REDACTED]')
        .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[REDACTED]@')
        .replace(/((?:password|passwd|token|api[_-]?key|secret|session[_-]?id)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu, '$1[REDACTED]')
        .replace(/((?:set-cookie|cookie|authorization)\s*[:=]\s*)[^\r\n]+/giu, '$1[REDACTED]')
        .replace(/([?&][^\s=&]+)=([^\s&#]+)/gu, '$1=[REDACTED]')
        .slice(0, 1200);
}
