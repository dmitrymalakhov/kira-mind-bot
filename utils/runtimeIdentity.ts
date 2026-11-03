/** Deployment identity comes from private environment, never a built-in user. */
export const API_ONLY_TRANSPORT_TOKEN = 'internal-api-only-transport';
export function isApiOnlyRuntime(env: Record<string,string|undefined> = process.env):boolean {
    if(env.KIRA_RUNTIME_MODE!=='api_only')return false;
    const principal=Number(env.KIRA_RUNTIME_PRINCIPAL);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(env.KIRA_TENANT_ID || '')
        && /^-\d+$/.test(env.KIRA_RUNTIME_PRINCIPAL || '') && Number.isSafeInteger(principal) && principal<0;
}
export function isValidRuntimeOwnerId(id:number,env:Record<string,string|undefined> = process.env):boolean {
    return Number.isSafeInteger(id) && (id>0 || isApiOnlyRuntime(env) && id===Number(env.KIRA_RUNTIME_PRINCIPAL));
}
export function resolveRuntimeIdentity(env: Record<string, string | undefined>) {
    const positiveId = (value: string | undefined): number => {
        const text = value?.trim() || '';
        const number = Number(text);
        return /^\d+$/.test(text) && Number.isSafeInteger(number) && number > 0 ? number : 0;
    };
    if(env.KIRA_RUNTIME_MODE==='api_only' && !isApiOnlyRuntime(env))throw new Error('Invalid API-only runtime principal');
    const allowedUserId = isApiOnlyRuntime(env) ? Number(env.KIRA_RUNTIME_PRINCIPAL) : positiveId(env.KIRA_ALLOWED_USER_ID ?? env.ALLOWED_USER_ID);
    return {
        allowedUserId,
        adminUserId: isApiOnlyRuntime(env) ? 0 : positiveId(env.KIRA_ADMIN_USER_ID ?? env.ADMIN_USER_ID ?? String(allowedUserId)),
        ownerName: env.OWNER_NAME?.trim() || 'владелец',
        ownerUsername: env.OWNER_USERNAME?.trim().replace(/^@/, '') || undefined,
        userName: env.USER_NAME?.trim() || env.OWNER_NAME?.trim() || 'владелец',
        userBirthDate: env.USER_BIRTH_DATE?.trim() || '',
        botUsername: (env.KIRA_BOT_USERNAME ?? env.BOT_USERNAME)?.trim().replace(/^@/, '') || '',
    };
}
