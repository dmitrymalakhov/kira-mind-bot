import { KIRA_SKILLS } from './skills';
import { looksLikeKiraRelocationRequest } from '../../utils/kiraResidence';
import type { ToolContext, ToolDefinition, RuntimeToolCall } from './types';

const DIALOGUE_READ_TOOLS = new Set([
    'web.search', 'maps.geocode', 'maps.findNearby', 'maps.getDirections', 'maps.request',
    'memory.search', 'memory.recent', 'contacts.search', 'contacts.list', 'people.resolve', 'portraits.get',
    'reminders.list', 'tasks.list', 'health.listEntries', 'health.analyzePeriod',
    'self.getState', 'self.searchEvents', 'self.getResidence', 'self.getStudyReports', 'settings.get', 'capabilities.list',
]);

export function isDialogueReadTool(definition: ToolDefinition, args?: Record<string, unknown>): boolean {
    return definition.effect === 'read' && DIALOGUE_READ_TOOLS.has(definition.name)
        || definition.name === 'agents.start' && (args === undefined || args.kind === 'research');
}

/** Authority comes from the owner's request/classification, never from retrieved content or a loaded skill. */
export function authorizedStateSkills(context: Pick<ToolContext, 'classification' | 'message'>): Set<string> {
    const intents = [context.classification.intent, ...(context.classification.subIntents?.map(item => item.intent) ?? [])];
    const skills = new Set(KIRA_SKILLS.filter(skill => skill.intents.some(intent => intents.includes(intent as typeof intents[number]))).map(skill => skill.id));
    const text = context.message;
    if (looksLikeKiraRelocationRequest(text)) skills.add('self-study');
    const explicit: Array<[string, RegExp]> = [
        ['reminders', /(?:напомни|напоминай|(?:создай|поставь|добавь|измени|перенеси|отмени|удали)[\s\S]{0,50}напоминан)/iu],
        ['recurring-tasks', /(?:(?:делай|выполняй|повторяй|присылай|проверяй|ищи)[\s\S]{0,80}(?:кажд|ежеднев|регуляр|по\s+утрам|по\s+вечерам)|кажд[^.!?]{0,60}(?:присылай|проверяй|ищи|делай|выполняй)|(?:останови|удали|возобнови|запусти|измени|приостанови)[\s\S]{0,30}задач)/iu],
        ['contact-communication', /(?:напиши|отправь|передай|подготовь[\s\S]{0,35}(?:сообщени|черновик)|измени[\s\S]{0,30}черновик)/iu],
        ['people-and-memory', /(?:запомни|забудь|удали\s+из\s+памяти|сохрани[\s\S]{0,30}факт)/iu],
        ['chat-monitoring', /(?:следи|наблюдай|отслеживай|(?:создай|добавь|удали|приостанови|возобнови|измени)[\s\S]{0,30}наблюдени|создай[\s\S]{0,30}(?:групп|набор)[\s\S]{0,20}чат)/iu],
        ['health-diary', /(?:запиши|сохрани)[\s\S]{0,60}(?:дневник|здоров|симптом|давлен|самочув|съел|выпил|принял|кож|зуд)/iu],
        ['self-study', /(?:изучи\s+себя|проведи\s+самоизучение|переезжай|переедь|пересели|(?:включи|выключи|отключи|измени|поставь)[\s\S]{0,35}(?:режим|бюджет|экономи|фон|рефлекс))/iu],
        ['image-creation', /(?:нарисуй|сгенерируй[\s\S]{0,30}(?:изображен|картинк)|сделай[\s\S]{0,20}картинк)/iu],
        ['browser-workflows', /(?:отмени|останови|заверши|продолжи|отмена)[\s\S]{0,35}(?:агент|исследован|браузер|переговор)/iu],
    ];
    for (const [skill, pattern] of explicit) if (pattern.test(text)) skills.add(skill);
    return skills;
}

export function needsRuntimeTools(context: Pick<ToolContext, 'classification' | 'message'>): boolean {
    return authorizedStateSkills(context).size > 0 || /(?:список|покажи|какие|мои)[\s\S]{0,40}(?:напоминан|задач|наблюдени|настройк|черновик)|(?:забудь|удали\s+из\s+памяти)/iu.test(context.message);
}

export function canExecuteRuntimeCall(definition: ToolDefinition, call: RuntimeToolCall, context: ToolContext): boolean {
    if (context.readOnly) return isDialogueReadTool(definition, call.args);
    if (definition.effect === 'read') return true;
    const skills = authorizedStateSkills(context);
    const source = [context.message, context.continuationAnswer].filter(Boolean).join('\n');
    const reminderActions = [context.classification, ...(context.classification.subIntents ?? [])]
        .filter(item => item.intent === 'НАПОМИНАНИЕ').map(item => item.details?.reminderAction ?? 'create');
    if (call.tool === 'settings.update' && !/(?:включи|выключи|отключи|измени|поставь|переключи)[\s\S]{0,50}(?:режим|бюджет|экономи|фон|рефлекс|жизн|самоизучен)/iu.test(source)) return false;
    if (['reminders.create', 'reminders.request'].includes(call.tool) && reminderActions.length && !reminderActions.includes('create') && !/(?:напомни|напоминай|(?:создай|поставь|добавь)[\s\S]{0,30}напоминан)/iu.test(source)) return false;
    if (call.tool === 'reminders.cancel' && !reminderActions.some(action => action === 'cancel' || action === 'cancelAll') && !/(?:отмени|удали|убери)/iu.test(source)) return false;
    if (call.tool === 'reminders.update' && !reminderActions.some(action => action === 'update' || action === 'updateAll') && !/(?:измени|перенеси|передвинь|поменяй)/iu.test(source)) return false;
    if (call.tool === 'agents.start') {
        if (call.args.kind === 'research') return skills.has('web-research') || context.classification.details.knowledgeSource === 'external_current';
        if (call.args.kind === 'negotiation') return skills.has('negotiation');
        if (call.args.kind === 'study-chat') return skills.has('telegram-reading') && (context.classification.details.saveFactsAboutUser === true || /(?:изучи|запомни|сохрани)/iu.test(context.message));
        return skills.has('browser-workflows');
    }
    return skills.has(definition.skill);
}

export function availableRuntimeTools(tools: ToolDefinition[], context: ToolContext): ToolDefinition[] {
    const skills = authorizedStateSkills(context);
    return tools.filter(tool => context.readOnly ? isDialogueReadTool(tool) : tool.effect === 'read' || tool.name === 'agents.start' || skills.has(tool.skill))
        .map(tool => context.readOnly && tool.name === 'agents.start' ? { ...tool,
            description: 'Делегировать одно ограниченное исследование веб-источников research-агенту.',
            inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, kind: { type: 'string' as const, enum: ['research'] } } },
        } : tool);
}
