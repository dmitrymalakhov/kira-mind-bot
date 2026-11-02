import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../../data-source';
import { ApiError } from '../../api/contracts';
import { USER_TIMEZONE } from '../../constants';
import { getActiveBotProfile } from '../../utils/botIdentity';
import { WorkoutService } from '../../services/workouts/service';
import { PgWorkoutStore } from '../../services/workouts/store';
import { summary } from '../../services/workouts/domain';
import { objectSchema, textSchema } from './registry';
import type { JsonSchema, ToolContext, ToolDefinition, ToolOutput } from './types';

const str = (description: string) => textSchema(description, 200);
const period = { from: str('Начало периода RFC3339 UTC'), to: str('Конец периода RFC3339 UTC'), activityType: { type: 'string', enum: ['running', 'walking', 'cycling', 'strength', 'other'] } as JsonSchema };
const actionNames = { start: 'начать тренировку', pause: 'поставить тренировку на паузу', resume: 'продолжить тренировку', finish: 'завершить тренировку', record_set: 'записать подход', set_rest: 'запустить отдых', add_note: 'добавить заметку' };
type Factory = (context: ToolContext) => WorkoutService;
const serviceFor: Factory = context => new WorkoutService(new PgWorkoutStore(AppDataSource), { profile: getActiveBotProfile(), ownerId: context.ctx.from!.id });
function definition(name: string, description: string, schema: JsonSchema, effect: ToolDefinition['effect'],
    execute: ToolDefinition['execute']): ToolDefinition {
    return { name, description, skill: 'workouts', effect, ownerOnly: true, privateOnly: true, inputSchema: schema, execute: async (args, context) => {
        try { return await execute(args, context); }
        catch (error) { if (error instanceof ApiError) return { status: 'failed', summary: error.message, data: { code: error.code } }; throw error; }
    } };
}
const read = (data: unknown, message = 'Получены структурированные данные тренировок.'): ToolOutput => ({ status: 'ok', summary: message, data });

export function workoutTools(factory: Factory = serviceFor): ToolDefinition[] {
    return [
        definition('workouts.context', 'Прочитать активную тренировку, реальные устройства и доступность Apple Health. Сначала найди здесь ID для управления.', objectSchema({}), 'read',
            async (_args, context) => read(await factory(context).context())),
        definition('workouts.history', 'История собственных тренировок из структурированного хранилища; не векторная память.', objectSchema({
            ...period, limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: str('nextCursor предыдущей страницы'),
        }, []), 'read', async (args, context) => read(await factory(context).history(Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))))),
        definition('workouts.get', 'Получить результаты выбранной реальной тренировки, подходы и заметки.', objectSchema({ id: str('UUID из workouts.context/history') }), 'read',
            async (args, context) => { const { workout } = await factory(context).detail(String(args.id)); return read({ workout: { ...summary(workout), sets: workout.sets, notes: workout.notes } }); }),
        definition('workouts.analysis', 'Сравнить одинаковые виды/условия занятий и получить суммы с полнотой measured/missing; IDs только из найденной истории.', objectSchema({
            ...period, ids: str('От 2 до 10 UUID через запятую, если выбраны конкретные занятия'),
        }, []), 'read', async (args, context) => {
            const data = await factory(context).analysis(args as Record<string, string>);
            let remaining = 8;
            const groups = data.groups.map(group => { const count = Math.min(remaining, args.ids ? 10 : 2); const workouts = group.workouts.slice(0, count); remaining -= workouts.length;
                return { ...group, workouts, detailsOmitted: group.workouts.length > workouts.length }; });
            return read({ ...data, groups });
        }),
        definition('workouts.health', 'Прочитать синхронизированные дневные шаги Apple Health; указывать время обновления. Пусто не означает ноль или отказ в разрешении.', objectSchema({
            localDate: str('Локальная дата YYYY-MM-DD'), timeZone: str('Часовой пояс IANA'),
        }, []), 'read', async (args, context) => {
            const data = await factory(context).healthStatus();
            return read({ sync: data.sync, dailySteps: data.dailySteps.filter(row => (!args.localDate || row.localDate === args.localDate) && (!args.timeZone || row.timeZone === args.timeZone)).slice(0, 10) });
        }),
        definition('workouts.command', 'Запросить управление тренировкой Киры на её реальном устройстве. Это queued, фактический успех требует события и ACK устройства.', objectSchema({
            action: { type: 'string', enum: Object.keys(actionNames) }, workoutId: str('UUID сессии из контекста; без него используется активная'),
            deviceId: str('UUID выбранного iPhone из контекста'), activityType: period.activityType,
            location: { type: 'string', enum: ['indoor', 'outdoor', 'unspecified'] }, timeZone: str('Часовой пояс IANA'),
            set: objectSchema({ id: str('ID подхода для исправления'), exercise: str('Упражнение'), repetitions: { type: 'integer', minimum: 1, maximum: 10000 }, weightKg: { type: 'number', minimum: 0, maximum: 10000 } }, ['exercise', 'repetitions']),
            durationMs: { type: 'integer', minimum: 1000, maximum: 86400000 }, text: textSchema('Дословная заметка владельца'),
        }, ['action']), 'state', async (args, context) => {
            const service = factory(context), target = await service.context(), action = args.action as keyof typeof actionNames;
            let body: Record<string, unknown>;
            if (action === 'start') {
                if (!args.activityType) return { status: 'needs_input', summary: 'Какую тренировку начать: бег, ходьба, велосипед или силовую?', question: 'Какую тренировку начать?', data: { devices: target.devices } };
                const devices = target.devices.filter(d => !args.deviceId || d.id === args.deviceId);
                if (devices.length !== 1) return { status: 'needs_input', summary: devices.length ? 'На каком iPhone начать тренировку?' : 'Открой раздел тренировок в приложении Киры на iPhone.', question: 'Выбери подключённый iPhone.', data: { devices: target.devices } };
                const d = devices[0];
                body = { deviceId: d.id, bindingId: d.bindingId, action, args: { activityType: args.activityType, location: args.location ?? 'unspecified', mode: 'manual', timeZone: args.timeZone ?? target.latestDailySteps?.timeZone ?? USER_TIMEZONE } };
            } else {
                const id = args.workoutId ?? target.active?.id;
                if (!id) return { status: 'failed', summary: 'Активная тренировка не найдена. Если она записывается офлайн, открой приложение для синхронизации.' };
                const { workout: w } = await service.detail(String(id));
                let actionArgs: Record<string, unknown> = {};
                if (action === 'record_set') {
                    if (!args.set) return { status: 'needs_input', summary: 'Укажи упражнение и число повторений.', question: 'Какое упражнение и сколько повторений?' };
                    const s = args.set as Record<string, unknown>; actionArgs = { set: { id: s.id ?? randomUUID(), exercise: s.exercise, repetitions: s.repetitions, weightKg: s.weightKg ?? null } };
                } else if (action === 'set_rest') actionArgs = { durationMs: args.durationMs ?? 90000 };
                else if (action === 'add_note') {
                    if (!args.text) return { status: 'needs_input', summary: 'Какую заметку добавить?', question: 'Какую заметку добавить?' };
                    actionArgs = { text: args.text };
                }
                body = { workoutId: w.id, deviceId: w.recorderDeviceId, bindingId: w.recorderBindingId, expectedSeq: w.seq, action, args: actionArgs };
            }
            const { command } = await service.requestCommand(body);
            const responseText = 'Передала на iPhone запрос: ' + actionNames[action] + '. Ожидаю подтверждения устройства. Если связи нет, используй кнопку в приложении.';
            return { status: 'ok', summary: responseText, data: { command, applied: false }, result: { responseText, skipOptionalFollowups: true } };
        }),
        definition('workouts.savePlan', 'Сохранить запрошенный план/шаблон тренировки. Шаги составляй в текущем плане ответа, исходя из запроса и найденных результатов.', objectSchema({
            title: str('Название'), activityType: period.activityType, kind: { type: 'string', enum: ['plan', 'template'] },
            steps: { type: 'array', maxItems: 100, items: objectSchema({ title: str('Упражнение/интервал'), durationMs: { type: 'integer', minimum: 0 },
                distanceM: { type: 'number', minimum: 0 }, sets: { type: 'integer', minimum: 1 }, repetitions: { type: 'integer', minimum: 1 },
                weightKg: { type: 'number', minimum: 0 }, restMs: { type: 'integer', minimum: 0 } }, ['title']) },
        }), 'state', async (args, context) => {
            const data = await factory(context).savePlan(null, { ...args, id: randomUUID() });
            return { status: 'ok', summary: 'План тренировки сохранён.', data, result: { responseText: 'План «' + data.plan.title + '» сохранён.', skipOptionalFollowups: true } };
        }),
    ];
}
