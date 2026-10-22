import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './contracts';

interface ActionClaims {
    owner: number;
    messageId: number;
    data: string;
    text: string;
    expires: number;
    version: string;
}

export class ApiActionTokens {
    constructor(private readonly secret: string, private readonly owner: number) {}

    sign(messageId: number, data: string, text: string, version = ''): string {
        const body = Buffer.from(JSON.stringify({
            owner: this.owner, messageId, data, text: text.slice(0, 4000), expires: Date.now() + 15 * 60_000, version,
        } satisfies ActionClaims)).toString('base64url');
        return `${body}.${this.signature(body)}`;
    }

    verify(token: string): ActionClaims {
        const [body, signature, extra] = token.split('.');
        const expected = body ? this.signature(body) : '';
        if (!signature || extra || signature.length !== expected.length
            || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
            throw new ApiError(400, 'invalid_action', 'Некорректное подтверждение действия.');
        }
        let claims: ActionClaims;
        try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
        catch { throw new ApiError(400, 'invalid_action', 'Некорректное подтверждение действия.'); }
        if (!claims || claims.owner !== this.owner || !Number.isSafeInteger(claims.messageId)
            || claims.messageId >= 0 || typeof claims.version !== 'string'
            || typeof claims.data !== 'string' || typeof claims.text !== 'string'
            || !Number.isFinite(claims.expires) || claims.expires <= Date.now()) {
            throw new ApiError(410, 'action_expired', 'Кнопка устарела. Повтори исходный запрос.');
        }
        return claims;
    }

    private signature(body: string): string {
        return createHmac('sha256', this.secret).update(`kira-api-action:v1:${body}`).digest('base64url');
    }
}
