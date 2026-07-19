import { config } from '../config';
import { writeFileSync } from 'node:fs';
import { getVectorService } from '../services/VectorServiceFactory';
import { auditMemoryEntries, buildProductionRepairDryRun } from '../utils/memoryAudit';

async function main(): Promise<void> {
    const svc = getVectorService();
    if (!svc) throw new Error('Vector service недоступен');
    const entries = await svc.getAllMemories(String(config.allowedUserId));
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
