import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { InputFile } from 'grammy';
import { RUNTIME_DATA_DIR } from '../utils/runtimeData';
import { ApiError } from './contracts';

const FILE_TTL = 24 * 60 * 60_000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ApiFiles {
    private lastCleanup = 0;
    constructor(private readonly directory = path.join(RUNTIME_DATA_DIR, 'api-files')) {}

    async save(file: InputFile): Promise<{ fileUrl: string; filename: string }> {
        // The channel adapter is the only boundary that handles grammY's binary payload.
        const raw = await file.toRaw();
        const chunks: Buffer[] = [];
        let size = 0;
        const append = (chunk: Uint8Array) => {
            size += chunk.byteLength;
            if (size > MAX_FILE_SIZE) throw new ApiError(413, 'file_too_large', 'Файл превышает 20 MiB.');
            chunks.push(Buffer.from(chunk));
        };
        if (raw instanceof Uint8Array) append(raw);
        else for await (const chunk of raw) append(chunk);
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const id = randomUUID();
        const filename = path.basename(file.filename || 'download.bin').replace(/[\r\n]/g, '_');
        await fs.writeFile(path.join(this.directory, `${id}.bin`), Buffer.concat(chunks), { mode: 0o600 });
        await fs.writeFile(path.join(this.directory, `${id}.json`), JSON.stringify({ filename }), { mode: 0o600 });
        await this.cleanup();
        return { fileUrl: `/api/v1/files/${id}`, filename };
    }

    async read(id: string): Promise<{ data: Buffer; filename: string }> {
        if (!FILE_ID.test(id)) throw new ApiError(404, 'file_not_found', 'Файл не найден.');
        try {
            const file = path.join(this.directory, `${id}.bin`);
            const stat = await fs.stat(file);
            if (Date.now() - stat.mtimeMs > FILE_TTL) throw new Error('expired');
            const metadata = JSON.parse(await fs.readFile(path.join(this.directory, `${id}.json`), 'utf8'));
            return { data: await fs.readFile(file), filename: metadata.filename };
        } catch { throw new ApiError(404, 'file_not_found', 'Файл не найден или срок хранения истёк.'); }
    }

    private async cleanup(): Promise<void> {
        if (Date.now() - this.lastCleanup < 60 * 60_000) return;
        this.lastCleanup = Date.now();
        for (const filename of await fs.readdir(this.directory)) {
            if (!/\.(bin|json)$/.test(filename) || !FILE_ID.test(filename.replace(/\.(bin|json)$/, ''))) continue;
            const fullPath = path.join(this.directory, filename);
            const stat = await fs.stat(fullPath).catch(() => undefined);
            if (stat && Date.now() - stat.mtimeMs > FILE_TTL) await fs.unlink(fullPath).catch(() => {});
        }
    }
}
