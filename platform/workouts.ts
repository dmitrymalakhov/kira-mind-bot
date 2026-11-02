import { DataSource } from 'typeorm';
import { tenantName } from './store';
import { ensureWorkoutSchema, WORKOUT_TABLES } from '../services/workouts/store';

/** Same privileged-before-worker migration boundary as analytics; never enables tenant synchronize. */
export async function provisionTenantWorkouts(admin: DataSource, accountId: string, database: string,
    open = (options: any): Promise<DataSource> => new DataSource(options).initialize()): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(database)) throw new Error('Invalid workout database');
    const role = tenantName(accountId);
    const db = await open({ ...admin.options, database, entities: [], synchronize: false, logging: false });
    try {
        await db.transaction(async manager => {
            await ensureWorkoutSchema(manager);
            await manager.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ' + WORKOUT_TABLES.join(',') + ' TO "' + role + '"');
        });
    } finally { await db.destroy(); }
}
