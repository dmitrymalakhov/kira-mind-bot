import type { ApiOperationStore } from '../contracts';
import { ApiError } from '../contracts';
import type { WorkoutService } from '../../services/workouts/service';
import { digest, fail, object, uuid } from '../../services/workouts/domain';
import { WORKOUT_CONTRACT, WorkoutsCapability } from './contracts';

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Shared by runtime and account proxy. Exact methods and route shapes; no blanket prefix bypass. */
export function workoutRouteAllowed(method: string, path: string): boolean {
    if (method === 'GET') return ['/api/v1/workouts', '/api/v1/workouts/active', '/api/v1/workouts/commands', '/api/v1/workouts/plans', '/api/v1/workouts/analysis', '/api/v1/health-sync'].includes(path) || new RegExp('^/api/v1/workouts/' + ID + '$').test(path);
    if (method === 'POST') return ['/api/v1/workouts/devices', '/api/v1/workouts/sync', '/api/v1/workouts/commands', '/api/v1/workouts/plans', '/api/v1/health-sync/batch'].includes(path) || new RegExp('^/api/v1/workouts/commands/' + ID + '/(claim|result)$').test(path);
    if (method === 'PUT') return path === '/api/v1/health-sync/consent' || new RegExp('^/api/v1/workouts/plans/' + ID + '$').test(path);
    if (method === 'DELETE') return path === '/api/v1/health-sync/data' || new RegExp('^/api/v1/workouts/(devices|plans)/' + ID + '$').test(path);
    return false;
}
export class WorkoutHttpApi {
    readonly capability: WorkoutsCapability = {
        version: 1, contract: WORKOUT_CONTRACT, features: ['records', 'localSync', 'deviceCommands', 'appleHealthSync', 'plans', 'analysis'],
        limits: { maxBatchItems: 100, maxBodyBytes: 65536, pollIntervalMs: 5000, commandTtlMs: 30000 },
    };
    constructor(readonly service: WorkoutService) {}
    async request(method: string, path: string, parameters: URLSearchParams, read: () => Promise<Record<string, unknown>>, key: string | string[] | undefined, operations: ApiOperationStore): Promise<object> {
        if (!workoutRouteAllowed(method, path)) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        const query: Record<string, string> = {};
        for (const [k, value] of parameters) { if (k in query) fail('invalid_workout', 'Фильтр указан несколько раз.'); query[k] = value; }
        if (method === 'GET') {
            if (path === '/api/v1/workouts') return this.service.history(query);
            if (path.endsWith('/active')) { object(query, []); return this.service.active(); }
            if (path.endsWith('/commands')) return this.service.pollCommands(query);
            if (path.endsWith('/plans')) { object(query, []); return this.service.plans(); }
            if (path.endsWith('/analysis')) return this.service.analysis(query);
            if (path === '/api/v1/health-sync') { object(query, []); return this.service.healthStatus(); }
            object(query, []); return this.service.detail(uuid(path.split('/').pop()));
        }
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail('idempotency_key_required', 'Нужен Idempotency-Key.');
        if (!operations.runJson) throw new ApiError(503, 'workout_receipts_unavailable', 'Сохранение квитанций временно недоступно.');
        const body = method === 'DELETE' ? {} : await read();
        if (method === 'DELETE' && path.includes('/plans/')) object(query, ['expectedRevision']);
        else object(query, []);
        const work = async (): Promise<object> => {
            if (path === '/api/v1/workouts/devices') return this.service.registerDevice(body);
            if (path === '/api/v1/workouts/sync') return this.service.syncWorkout(body);
            if (path === '/api/v1/workouts/commands') return this.service.requestCommand(body);
            if (path === '/api/v1/workouts/plans') return this.service.savePlan(null, body);
            if (path === '/api/v1/health-sync/consent') return this.service.healthConsent(body);
            if (path === '/api/v1/health-sync/batch') return this.service.healthBatch(body);
            if (path === '/api/v1/health-sync/data') return this.service.healthErase();
            const parts = path.split('/'), id = uuid(parts[5]);
            if (parts[4] === 'devices') return this.service.revokeDevice(id);
            if (parts[4] === 'plans') return method === 'DELETE' ? this.service.deletePlan(id, query.expectedRevision) : this.service.savePlan(id, body);
            return parts[6] === 'claim' ? this.service.claimCommand(id, body) : this.service.commandResult(id, body);
        };
        return operations.runJson('workouts:' + this.service.scope.ownerId + ':' + digest(key), digest({ method, path, query, body }), work);
    }
}
