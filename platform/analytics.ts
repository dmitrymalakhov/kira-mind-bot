import { DataSource } from 'typeorm';
import { tenantName } from './store';

/** Privileged migration; workers receive only grants in their own database. */
export async function provisionTenantAnalytics(admin: DataSource, accountId: string, database: string, imported: boolean,
    open = (options: any): Promise<DataSource> => new DataSource(options).initialize()): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error('Invalid analytics database');
    const role = tenantName(accountId);
    const db = await open({ ...admin.options, database, entities: [], synchronize: false, logging: false });
    try {
        await require('../admin-panel/productAnalyticsStore').ensureProductAnalyticsSchema(db);
        await db.query(`GRANT SELECT,INSERT,UPDATE ON product_analytics_tasks,product_analytics_assessments,product_analytics_meta,product_analytics_preferences TO "${role}"`);
    } finally { await db.destroy(); }
    await admin.query(`INSERT INTO kira_analytics_sources(account_id,database_name,imported) VALUES($1,$2,$3)
        ON CONFLICT(account_id) DO UPDATE SET database_name=excluded.database_name,imported=excluded.imported`,
        [accountId, database, imported]);
}
