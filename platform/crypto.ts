import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

export async function passwordHash(password: string): Promise<string> {
    const salt = randomBytes(16).toString('hex');
    const key = await derive(password, salt, 64) as Buffer;
    return `${salt}:${key.toString('hex')}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
    const [salt, hash] = stored.split(':');
    const actual = await derive(password, salt, 64) as Buffer;
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A stable operator key is required; changing it requires an explicit credential migration. */
export class PlatformSecrets {
    private readonly key: Buffer;
    constructor(secret: string) {
        if (!/^[0-9a-f]{64}$/i.test(secret)) throw new Error('KIRA_PLATFORM_MASTER_KEY must be 32 random bytes in hex');
        this.key = Buffer.from(secret, 'hex');
    }
    seal(value: unknown, accountId: string): string {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.key, iv);
        cipher.setAAD(Buffer.from(accountId));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    }
    open<T>(value: string, accountId: string): T {
        const data = Buffer.from(value, 'base64');
        const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
        cipher.setAAD(Buffer.from(accountId));
        cipher.setAuthTag(data.subarray(12, 28));
        return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
    }
    derive(accountId: string, purpose: 'database' | 'api'): string {
        return createHmac('sha256', this.key).update(`${purpose}:${accountId}`).digest('hex');
    }
}
