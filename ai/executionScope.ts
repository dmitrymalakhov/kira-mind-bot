import { AsyncLocalStorage } from 'node:async_hooks';

/** Request-local cancellation for an interactive task; ordinary/background calls have no scope. */
interface AiExecutionScope {
    signal: AbortSignal;
    assertActive(): void;
    onRequest(): void;
}
const scopes = new AsyncLocalStorage<AiExecutionScope>();
export function withAiExecutionScope<T>(scope: AiExecutionScope, work: () => T): T { return scopes.run(scope, work); }
export function assertAiExecutionActive(): void { scopes.getStore()?.assertActive(); }
/** Transport options, never part of the model's JSON body. Check after any provider queue wait. */
export function aiRequestOptions(): { signal?: AbortSignal } {
    const scope = scopes.getStore();
    if (!scope) return {};
    scope.assertActive(); scope.onRequest();
    return { signal: scope.signal };
}
