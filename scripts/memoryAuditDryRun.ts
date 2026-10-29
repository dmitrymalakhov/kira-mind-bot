import { config } from '../config';
import { readFileSync, writeFileSync } from 'node:fs';
import { getVectorService } from '../services/VectorServiceFactory';
import { auditMemoryEntries, buildProductionRepairDryRun, auditMemoryRetentionLifecycle } from '../utils/memoryAudit';

async function main(): Promise<void> {
    const svc = getVectorService();
    if (!svc) throw new Error('Vector service недоступен');
    const entries = await svc.getAllMemories(String(config.allowedUserId), { includeArchived: true });
    const sourcesIndex = process.argv.indexOf('--source-messages');
    const sources = sourcesIndex >= 0 ? JSON.parse(readFileSync(process.argv[sourcesIndex + 1], 'utf8')).messages : [];
    const scannedDomains = entries.reduce<Record<string, number>>((counts, entry) => {
        counts[entry.domain] = (counts[entry.domain] ?? 0) + 1;
        return counts;
    }, {});
    const report = {
        generatedAt: new Date().toISOString(),
        mode: 'read-only-dry-run',
        scannedEntries: entries.length,
        scannedDomains,
        issues: auditMemoryEntries(entries),
        repair: buildProductionRepairDryRun(entries),
        lifecycle: auditMemoryRetentionLifecycle(entries, sources),
    };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    const outputIndex = process.argv.indexOf('--out');
    const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
    if (outputPath) {
        writeFileSync(outputPath, serialized, { encoding: 'utf8', mode: 0o600 });
        process.stdout.write(`Dry-run report written to ${outputPath}\n`);
    } else {
        process.stdout.write(serialized);
    }
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
