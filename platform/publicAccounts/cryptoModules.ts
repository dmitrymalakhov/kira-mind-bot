/** Preserve native ESM import when the legacy server is compiled as CommonJS. */
const nativeImport = new Function('path', 'return import(path)') as (path: string) => Promise<any>;
let jose: Promise<typeof import('jose')> | undefined;
let attest: Promise<typeof import('node-app-attest')> | undefined;
export const loadJose = (): Promise<typeof import('jose')> => jose ??= nativeImport(require.resolve('jose'));
export const loadAppAttest = (): Promise<typeof import('node-app-attest')> => attest ??= nativeImport(require.resolve('node-app-attest'));
