import { createVectorService } from '../services/VectorServiceFactory';

// Simple example migration utility
async function migrate() {
    const service = createVectorService();
    if (!service) {
        console.error('No vector service configured');
        return;
    }
    await service.initializeCollection();
    console.log('Migration complete');
}

migrate().catch(err => {
    console.error('Migration error', err);
});
