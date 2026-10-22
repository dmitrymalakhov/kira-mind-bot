/** Deployment identity comes from private environment, never a built-in user. */
export function resolveRuntimeIdentity(env: Record<string, string | undefined>) {
    const positiveId = (value: string | undefined): number => {
        const text = value?.trim() || '';
        const number = Number(text);
        return /^\d+$/.test(text) && Number.isSafeInteger(number) && number > 0 ? number : 0;
    };
    const allowedUserId = positiveId(env.KIRA_ALLOWED_USER_ID ?? env.ALLOWED_USER_ID);
    return {
        allowedUserId,
        adminUserId: positiveId(env.KIRA_ADMIN_USER_ID ?? env.ADMIN_USER_ID ?? String(allowedUserId)),
        ownerName: env.OWNER_NAME?.trim() || 'владелец',
        ownerUsername: env.OWNER_USERNAME?.trim().replace(/^@/, '') || undefined,
        userName: env.USER_NAME?.trim() || env.OWNER_NAME?.trim() || 'владелец',
        userBirthDate: env.USER_BIRTH_DATE?.trim() || '',
        botUsername: (env.KIRA_BOT_USERNAME ?? env.BOT_USERNAME)?.trim().replace(/^@/, '') || '',
    };
}
