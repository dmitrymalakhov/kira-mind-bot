import { AdvancedConsoleLogger, QueryRunner } from 'typeorm';

function privateQuery(query: string): boolean { return /workout_(records|devices|commands|plans|health_state|health_sources)|workout-private|api_operations/.test(query); }
/** TypeORM development logging must never print health parameters, including QueryFailedError payloads. */
export class WorkoutPrivacyLogger extends AdvancedConsoleLogger {
    logQuery(query: string, parameters?: any[], runner?: QueryRunner): void {
        if (!privateQuery(query)) super.logQuery(query, parameters, runner);
    }
    logQueryError(error: string, query: string, parameters?: any[], runner?: QueryRunner): void {
        if (!privateQuery(query)) super.logQueryError(error, query, parameters, runner);
    }
    logQuerySlow(time: number, query: string, parameters?: any[], runner?: QueryRunner): void {
        if (!privateQuery(query)) super.logQuerySlow(time, query, parameters, runner);
    }
}
