import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

interface CloseableBrowser { close(...args: any[]): Promise<void> }

/** Chromium on Unix needs room for its generated IPC/socket paths. Account workers keep
 * their own TMPDIR; only this browser child gets a short, private, per-launch directory.
 * Persistent profile data remains in the existing account directory. */
export async function launchChromium<T extends CloseableBrowser>(
    launch: (env: NodeJS.ProcessEnv) => Promise<T>, env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
    const directory = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'kb-'));
    const cleanup = () => fs.rm(directory, { recursive: true, force: true });
    try {
        await fs.chmod(directory, 0o700);
        const resource = await launch({ ...env, TMPDIR: directory });
        const close = resource.close.bind(resource);
        let closing: Promise<void> | undefined;
        resource.close = (...args: any[]) => {
            if (!closing) {
                const attempt = Promise.resolve().then(() => close(...args)).then(cleanup);
                closing = attempt;
                void attempt.catch(() => {
                    if (closing === attempt) closing = undefined;
                    console.error('[BROWSER] temporary directory retained', { code: 'browser_temp_close_failed', directory });
                });
            }
            return closing;
        };
        return resource;
    } catch (error) {
        try { await cleanup(); }
        catch { console.error('[BROWSER] temporary directory retained', { code: 'browser_temp_cleanup_failed', directory }); }
        throw error;
    }
}
