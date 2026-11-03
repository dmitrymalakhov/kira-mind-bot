import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { DataSource } from 'typeorm';
import { ApiError } from '../../api/contracts';

/** Atomic fixed-duration windows. Only keyed HMACs of public addresses/account names are persisted. */
export class PublicLimits {
    constructor(private db: DataSource, private secret: string, private now = () => new Date()) {
        if (secret.length < 32) throw new Error('Missing public limit secret');
    }
    async take(scope: string, limit: number, seconds: number): Promise<void> {
        await this.reserve(scope, limit, seconds);
    }
    async reserve(scope: string, limit: number, seconds: number): Promise<{ hash: string; expiresAt: Date }> {
        const key = createHmac('sha256', this.secret).update(scope).digest('hex');
        const now = this.now();
        const [row] = await this.db.query(`INSERT INTO kira_public_limits(scope_hash,count,expires_at) VALUES($1,1,$3)
            ON CONFLICT(scope_hash) DO UPDATE SET count=CASE WHEN kira_public_limits.expires_at<=$2 THEN 1 ELSE kira_public_limits.count+1 END,
            expires_at=CASE WHEN kira_public_limits.expires_at<=$2 THEN $3 ELSE kira_public_limits.expires_at END
            RETURNING count,expires_at`, [key, now, new Date(now.getTime() + seconds * 1000)]);
        if (Number(row.count) > limit) throw new ApiError(429, 'rate_limited', 'Слишком много попыток. Повтори позже.');
        return { hash: key, expiresAt: new Date(row.expires_at) };
    }
    async refund(ticket: { hash: string; expiresAt: Date }): Promise<void> {
        await this.db.query('UPDATE kira_public_limits SET count=GREATEST(0,count-1) WHERE scope_hash=$1 AND expires_at=$2', [ticket.hash, ticket.expiresAt]);
    }
    async captchaRequired(scope:string):Promise<boolean>{
        const key=createHmac('sha256',this.secret).update(scope).digest('hex');
        const [row]=await this.db.query('SELECT count FROM kira_public_limits WHERE scope_hash=$1 AND expires_at>$2',[key,this.now()]);
        return Number(row?.count || 0)>=10;
    }
}

const address = (ip: string) => ip.startsWith('::ffff:') ? ip.slice(7) : ip;
/** The gateway strips incoming internal headers, then overwrites both fields on its authenticated hop. */
export function publicClientAddress(req: IncomingMessage, trustedPeers: string[], gatewaySecret: string): string {
    const peer = address(req.socket.remoteAddress || '');
    const supplied = req.headers['x-kira-gateway-secret'];
    const ip = req.headers['x-kira-client-ip'];
    if (trustedPeers.map(address).includes(peer)) {
        const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
        const expected = Buffer.from(gatewaySecret);
        if (!gatewaySecret || actual.length !== expected.length || !timingSafeEqual(actual, expected) || typeof ip !== 'string' || !isIP(ip)) {
            throw new ApiError(401, 'unauthorized', 'Недопустимый gateway.');
        }
        return address(ip);
    }
    // Forwarded headers from non-gateway peers never establish identity or create fresh limit buckets.
    if (!isIP(peer)) throw new ApiError(401, 'unauthorized', 'Недопустимое соединение.');
    return peer;
}
