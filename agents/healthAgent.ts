import { InlineKeyboard } from 'grammy';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ChatCompletionContentPart } from 'openai/resources/chat';
import type { ProcessingResult } from '../orchestrator';
import type { BotContext, MessageHistory } from '../types';
import openai from '../openai';
import { USER_TIMEZONE } from '../constants';
import { parseLLMJson } from '../utils';
import { HealthLogKind, HealthLogRecord, HealthLogRepository, HealthTimeOfDay } from '../services/HealthLogRepository';

const PENDING_HEALTH_LOG_TTL_MS = 30 * 60 * 1000;
const PENDING_HEALTH_DISCOMFORT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_EXPORT_DAYS = 7;
const DEFAULT_ANALYSIS_DAYS = 7;
const MAX_EXPORT_DAYS = 180;
const MAX_ANALYSIS_DAYS = 30;

interface HealthRequestAnalysis {
    action: 'menu' | 'log' | 'export' | 'analysis' | 'recent' | 'help' | 'cancel' | 'none';
    kind?: HealthLogKind;
    periodDays?: number;
    event?: {
        kind?: HealthLogKind;
        occurredAtIso?: string | null;
        summary?: string | null;
        severity?: number | null;
        symptoms?: string[];
        bodyAreas?: string[];
        foods?: string[];
        drinks?: string[];
        bloodPressure?: BloodPressureReading;
        medications?: string[];
        activities?: string[];
        exposures?: string[];
        suspectedTriggers?: string[];
        notes?: string[];
        tags?: string[];
        confidence?: number;
    };
    responseHint?: string;
}

interface HealthPhotoAnalysis {
    action: 'log' | 'none';
    kind?: HealthLogKind;
    imageType?: 'food' | 'skin' | 'blood_pressure' | 'activity' | 'medication' | 'other';
    summary?: string | null;
    visualSeverity?: number | null;
    needsDiscomfortLevel?: boolean;
    foods?: string[];
    drinks?: string[];
    possibleIngredients?: string[];
    possibleAllergenFlags?: string[];
    symptoms?: string[];
    bodyAreas?: string[];
    bloodPressure?: BloodPressureReading;
    visibleFindings?: string[];
    morphology?: string[];
    distribution?: string | null;
    redness?: string | null;
    swelling?: string | null;
    skinTexture?: string | null;
    medications?: string[];
    activities?: string[];
    exposures?: string[];
    suspectedTriggers?: string[];
    notes?: string[];
    tags?: string[];
    confidence?: number;
    analysisError?: 'quota' | 'unavailable';
    analysisUnavailableReason?: string;
}

interface DiscomfortExtraction {
    level?: number | null;
    note?: string | null;
}

interface BloodPressureReading {
    systolicMmHg?: number | null;
    diastolicMmHg?: number | null;
    pulseBpm?: number | null;
    context?: string | null;
}

const KIND_LABELS: Record<HealthLogKind, string> = {
    food: 'Еда',
    drink: 'Напиток',
    symptom: 'Симптомы',
    medication: 'Лекарство',
    activity: 'Активность/контакт',
    skin: 'Кожа',
    blood_pressure: 'Давление',
    note: 'Заметка',
};

const KIND_PROMPTS: Record<HealthLogKind, string> = {
    food: 'Напиши, наговори или пришли фото того, что ел, и примерно когда. Можно добавить симптомы, если они уже появились.',
    drink: 'Напиши или наговори, что пил и примерно когда. Если это лекарство или алкоголь, тоже укажи.',
    symptom: 'Опиши состояние или пришли фото: зуд, волдыри, покраснение, где локализовано, насколько сильно по 0-10 и когда началось.',
    medication: 'Напиши, что принял: название, дозировка, время и эффект, если уже заметен.',
    activity: 'Опиши, что делал или делаешь: спорт, стресс, душ, холод/жара, животные, бытовая химия, новая одежда и т.п.',
    skin: 'Опиши кожу текстом или пришли фото: где высыпания, размер/цвет, зуд, насколько сильно по 0-10 и когда заметил.',
    blood_pressure: 'Напиши давление и, если есть, пульс: например “120/80, пульс 72, сидя, утром”. Можно прислать фото тонометра, если цифры хорошо видны.',
    note: 'Напиши любую заметку о самочувствии, сне, стрессе, еде, окружении или подозрениях.',
};

export function buildHealthMenuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text('Еда', 'health:log:food')
        .text('Напиток', 'health:log:drink')
        .row()
        .text('Симптомы', 'health:log:symptom')
        .text('Кожа', 'health:log:skin')
        .row()
        .text('Давление', 'health:log:blood_pressure')
        .text('Лекарство', 'health:log:medication')
        .row()
        .text('Активность', 'health:log:activity')
        .text('Заметка', 'health:log:note')
        .row()
        .text('Анализ', 'health:analysis_menu')
        .row()
        .text('Экспорт 7 дней', 'health:export:7')
        .text('Экспорт 30 дней', 'health:export:30');
}

function buildHealthAnalysisKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
        .text('День', 'health:analyze:1')
        .text('Неделя', 'health:analyze:7')
        .row()
        .text('Месяц', 'health:analyze:30')
        .row()
        .text('Назад', 'health:menu');
}

function buildHealthAnalysisMenuResult(): ProcessingResult {
    return {
        responseText: [
            'Выбери период анализа дневника здоровья.',
            '',
            'Я соберу паттерны по симптомам, еде, активности, давлению, времени суток и отмечу, где данных не хватает.',
        ].join('\n'),
        keyboard: buildHealthAnalysisKeyboard(),
    };
}

export function buildHealthMenuResult(): ProcessingResult {
    return {
        responseText: [
            'Открыла дневник здоровья.',
            '',
            'Выбери, что зафиксировать, или напиши сразу обычным сообщением: что ел, что пил, что делал, давление, какие симптомы, что принял и когда. Для еды, кожи и тонометра можно прислать фото, я сохраню описание вместе с записью.',
            'Можно попросить анализ за день, неделю или месяц: я соберу паттерны по симптомам, еде, активности, давлению и времени суток.',
            '',
            'Это дневник наблюдений, не медицинский диагноз.',
        ].join('\n'),
        keyboard: buildHealthMenuKeyboard(),
    };
}

export function shouldRouteHealthPhoto(ctx: BotContext, caption = ''): boolean {
    const now = Date.now();
    const pending = ctx.session.pendingHealthLog;
    if (pending?.expiresAt && pending.expiresAt > now) return true;

    const text = caption.toLowerCase();
    if (!text.trim()) return false;
    return /здоров|дневник|самочувств|еда|ем|ел|съел|пью|выпил|кожа|крапивниц|сып|зуд|чеш|покрасн|волдыр|аллерг|от[её]к|высып|давлен|тонометр|пульс|чсс|мм\s*рт/iu.test(text);
}

export async function handleHealthCallback(ctx: BotContext, callbackData: string): Promise<ProcessingResult | null> {
    if (!callbackData.startsWith('health:')) return null;

    const [, action, value, extra] = callbackData.split(':');
    if (action === 'log' && isHealthLogKind(value)) {
        const now = Date.now();
        ctx.session.pendingHealthLog = {
            mode: value,
            prompt: KIND_PROMPTS[value],
            createdAt: now,
            expiresAt: now + PENDING_HEALTH_LOG_TTL_MS,
        };
        return {
            responseText: KIND_PROMPTS[value],
        };
    }

    if (action === 'export') {
        const days = normalizeExportDays(Number(value) || DEFAULT_EXPORT_DAYS);
        return createHealthExportResult(ctx, days);
    }

    if (action === 'analyze') {
        const days = normalizeAnalysisDays(Number(value) || DEFAULT_ANALYSIS_DAYS);
        return createHealthAnalysisResult(ctx, days);
    }

    if (action === 'analysis_menu') {
        return buildHealthAnalysisMenuResult();
    }

    if (action === 'discomfort' && value && extra) {
        const level = normalizeSeverity(Number(extra));
        if (level == null) {
            return { responseText: 'Не смогла сохранить уровень дискомфорта. Укажи число от 0 до 10.' };
        }
        return updateDiscomfortLevel(ctx, value, level, `Выбрано кнопкой: ${level}/10`);
    }

    if (action === 'menu') {
        return buildHealthMenuResult();
    }

    return {
        responseText: 'Не поняла действие дневника здоровья. Открой /health и выбери пункт ещё раз.',
        keyboard: buildHealthMenuKeyboard(),
    };
}

export async function healthAgent(
    ctx: BotContext,
    message: string,
    _isForwarded: boolean = false,
    _forwardFrom: string = '',
    messageHistory: MessageHistory[] = []
): Promise<ProcessingResult> {
    const pendingDiscomfort = getFreshPendingHealthDiscomfort(ctx);
    if (pendingDiscomfort) {
        return handleDiscomfortText(ctx, message, pendingDiscomfort.recordId);
    }

    const pending = getFreshPendingHealthLog(ctx);
    const analysis = await analyzeHealthRequest(message, pending?.mode, messageHistory);

    if (analysis.action === 'cancel') {
        ctx.session.pendingHealthLog = undefined;
        return { responseText: 'Отменила ввод в дневник здоровья.', keyboard: buildHealthMenuKeyboard() };
    }

    if (analysis.action === 'menu' || analysis.action === 'help') {
        return buildHealthMenuResult();
    }

    if (analysis.action === 'export') {
        return createHealthExportResult(ctx, normalizeExportDays(analysis.periodDays ?? DEFAULT_EXPORT_DAYS));
    }

    if (analysis.action === 'analysis') {
        return createHealthAnalysisResult(ctx, normalizeAnalysisDays(analysis.periodDays ?? DEFAULT_ANALYSIS_DAYS));
    }

    if (analysis.action === 'recent') {
        return buildRecentHealthLogsResult(ctx);
    }

    if (pending || analysis.action === 'log') {
        const record = await saveHealthLog(ctx, message, analysis, pending?.mode);
        ctx.session.pendingHealthLog = undefined;
        return {
            responseText: formatSavedHealthLog(record),
            keyboard: new InlineKeyboard()
                .text('Добавить ещё', 'health:menu')
                .text('Экспорт 7 дней', 'health:export:7'),
        };
    }

    return buildHealthMenuResult();
}

export async function healthPhotoAgent(
    ctx: BotContext,
    imageBuffer: Buffer,
    caption = '',
    photoFileId?: string,
    messageHistory: MessageHistory[] = [],
    additionalImages: Buffer[] = [],
    photoFileIds: string[] = []
): Promise<ProcessingResult> {
    const pending = getFreshPendingHealthLog(ctx);
    const analysis = await analyzeHealthPhoto(imageBuffer, caption, pending?.mode, messageHistory, additionalImages);

    if (analysis.action === 'none' && !pending) {
        return {
            responseText: 'Не уверена, что это фото относится к дневнику здоровья. Если хочешь сохранить его как еду или кожу, открой /health и выбери нужный тип.',
            keyboard: buildHealthMenuKeyboard(),
        };
    }

    const record = await saveHealthPhotoLog(
        ctx,
        caption,
        analysis,
        pending?.mode,
        photoFileId,
        photoFileIds.length ? photoFileIds : photoFileId ? [photoFileId] : []
    );
    ctx.session.pendingHealthLog = undefined;

    if (shouldAskDiscomfort(record, analysis)) {
        const question = 'Укажи уровень дискомфорта/зуда по шкале 0-10: 0 — не зудит, 10 — максимально сильно.';
        const now = Date.now();
        ctx.session.pendingHealthDiscomfort = {
            recordId: record.id,
            question,
            createdAt: now,
            expiresAt: now + PENDING_HEALTH_DISCOMFORT_TTL_MS,
        };
        return {
            responseText: `${formatSavedHealthLog(record)}\n\n${question}`,
            keyboard: buildDiscomfortKeyboard(record.id),
        };
    }

    return {
        responseText: formatSavedHealthLog(record),
        keyboard: new InlineKeyboard()
            .text('Добавить ещё', 'health:menu')
            .text('Экспорт 7 дней', 'health:export:7'),
    };
}

export async function createHealthExportResult(ctx: BotContext, days = DEFAULT_EXPORT_DAYS): Promise<ProcessingResult> {
    const userId = ctx.from?.id;
    if (!userId) {
        return { responseText: 'Не могу определить пользователя для экспорта дневника.' };
    }

    const to = new Date();
    const from = new Date(to.getTime() - normalizeExportDays(days) * 24 * 60 * 60 * 1000);
    const records = await HealthLogRepository.findByPeriod(userId, from, to);
    const exportFile = await createHealthExportFile(userId, records, from, to);

    return {
        responseText: records.length
            ? `Подготовила экспорт дневника здоровья за ${normalizeExportDays(days)} дней: ${records.length} записей.`
            : `За последние ${normalizeExportDays(days)} дней записей в дневнике здоровья нет. Я всё равно приложила пустой отчёт с периодом.`,
        documentFilePath: exportFile.filePath,
        documentFilename: exportFile.filename,
        documentCaption: 'Дневник здоровья для личных наблюдений или врача.',
    };
}

export async function createHealthAnalysisResult(ctx: BotContext, days = DEFAULT_ANALYSIS_DAYS): Promise<ProcessingResult> {
    const userId = ctx.from?.id;
    if (!userId) {
        return { responseText: 'Не могу определить пользователя для анализа дневника.' };
    }

    const normalizedDays = normalizeAnalysisDays(days);
    const to = new Date();
    const from = new Date(to.getTime() - normalizedDays * 24 * 60 * 60 * 1000);
    const records = await HealthLogRepository.findByPeriod(userId, from, to);

    if (!records.length) {
        return {
            responseText: `За ${formatPeriodLabel(normalizedDays)} в дневнике здоровья нет записей для анализа.`,
            keyboard: buildHealthMenuKeyboard(),
        };
    }

    const aiAnalysis = await buildAIHealthAnalysis(records, from, to, normalizedDays);
    return {
        responseText: aiAnalysis ?? buildLocalHealthAnalysis(records, from, to, normalizedDays),
        keyboard: buildHealthAnalysisKeyboard()
            .row()
            .text('Экспорт этого периода', `health:export:${normalizedDays}`),
    };
}

function getFreshPendingHealthLog(ctx: BotContext): NonNullable<BotContext['session']['pendingHealthLog']> | undefined {
    const pending = ctx.session.pendingHealthLog;
    if (!pending) return undefined;
    if (pending.expiresAt <= Date.now()) {
        ctx.session.pendingHealthLog = undefined;
        return undefined;
    }
    return pending;
}

function getFreshPendingHealthDiscomfort(ctx: BotContext): NonNullable<BotContext['session']['pendingHealthDiscomfort']> | undefined {
    const pending = ctx.session.pendingHealthDiscomfort;
    if (!pending) return undefined;
    if (pending.expiresAt <= Date.now()) {
        ctx.session.pendingHealthDiscomfort = undefined;
        return undefined;
    }
    return pending;
}

async function analyzeHealthPhoto(
    imageBuffer: Buffer,
    caption: string,
    pendingKind?: HealthLogKind,
    messageHistory: MessageHistory[] = [],
    additionalImages: Buffer[] = []
): Promise<HealthPhotoAnalysis> {
    const now = new Date();
    const history = messageHistory.slice(-6)
        .map((item, index) => `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}`)
        .join('\n');

    const content: ChatCompletionContentPart[] = [
        {
            type: 'text',
            text: [
                `Текущие дата и время: ${now.toLocaleString('ru-RU', { timeZone: USER_TIMEZONE, day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'long' })}. Таймзона: ${USER_TIMEZONE}.`,
                pendingKind ? `Активный режим дневника: ${pendingKind} (${KIND_LABELS[pendingKind]}).` : 'Активного режима дневника нет.',
                caption ? `Подпись пользователя к фото: ${caption}` : 'Подписи к фото нет.',
                history ? `История:\n${history}` : '',
                '',
                'Проанализируй фото для личного дневника здоровья. Не ставь диагноз и не назначай лечение.',
                'Если это фото еды/напитка: распознай видимые продукты, напитки, вероятные ингредиенты и возможные пищевые триггеры только как гипотезы по изображению/подписи.',
                'Если это фото кожи: опиши видимые проявления нейтрально: покраснение, волдыри/приподнятые элементы, отёк, распределение, примерную зону тела, визуальную выраженность 0-10. Не утверждай диагноз; можно писать "визуально похоже/совместимо", если уместно.',
                'Если это фото тонометра или записи давления: извлеки давление и пульс, только если значения читаются явно.',
                'Если это фото активности/лекарства/окружения: опиши, что видно и что можно сохранить как контекст.',
                'Для фото кожи или симптомов всегда needsDiscomfortLevel=true, потому что пользователь должен отдельно указать субъективный зуд/дискомфорт.',
                'Верни только JSON без markdown.',
                '',
                'Формат JSON:',
                '{',
                '  "action": "log | none",',
                '  "kind": "food | drink | symptom | medication | activity | skin | blood_pressure | note",',
                '  "imageType": "food | skin | blood_pressure | activity | medication | other",',
                '  "summary": "короткая фактическая сводка",',
                '  "visualSeverity": 0,',
                '  "needsDiscomfortLevel": true,',
                '  "foods": [], "drinks": [], "possibleIngredients": [], "possibleAllergenFlags": [],',
                '  "bloodPressure": { "systolicMmHg": 120, "diastolicMmHg": 80, "pulseBpm": 72, "context": "значения на тонометре" },',
                '  "symptoms": [], "bodyAreas": [], "visibleFindings": [], "morphology": [],',
                '  "distribution": "строка или null", "redness": "строка или null", "swelling": "строка или null", "skinTexture": "строка или null",',
                '  "medications": [], "activities": [], "exposures": [], "suspectedTriggers": [], "notes": [], "tags": [], "confidence": 0.0',
                '}',
            ].filter(Boolean).join('\n'),
        },
        {
            type: 'image_url',
            image_url: {
                url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`,
            },
        },
    ];

    for (const image of additionalImages) {
        content.push({
            type: 'image_url',
            image_url: {
                url: `data:image/jpeg;base64,${image.toString('base64')}`,
            },
        });
    }

    let analysisFailure: unknown;
    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5.4',
            messages: [
                {
                    role: 'system',
                    content: 'Ты анализируешь фото для личного дневника здоровья. Твоя задача — извлечь наблюдаемые факты и неопределённость, а не давать медицинский диагноз. Отвечай только валидным JSON.',
                },
                {
                    role: 'user',
                    content,
                },
            ],
            temperature: 0.4,
        });
        const parsed = parseLLMJson<HealthPhotoAnalysis>(response.choices[0]?.message?.content || '');
        if (parsed?.action) return normalizePhotoAnalysis(parsed, pendingKind);
    } catch (error) {
        analysisFailure = error;
        console.error('[health] photo analysis failed:', error);
    }

    const fallbackKind = pendingKind ?? inferPhotoKindFromCaption(caption) ?? 'note';
    const isSkinLike = fallbackKind === 'skin' || fallbackKind === 'symptom';
    const isQuotaError = isOpenAIQuotaError(analysisFailure);
    const reason = isQuotaError
        ? 'Лимит OpenAI API исчерпан, поэтому автоматическое распознавание фото временно недоступно.'
        : 'Автоматическое распознавание фото временно недоступно из-за технической ошибки.';

    return {
        action: 'log',
        kind: fallbackKind,
        imageType: fallbackKind === 'food' || fallbackKind === 'drink'
            ? 'food'
            : isSkinLike
                ? 'skin'
                : fallbackKind === 'blood_pressure'
                    ? 'blood_pressure'
                    : fallbackKind === 'activity'
                        ? 'activity'
                        : fallbackKind === 'medication'
                            ? 'medication'
                            : 'other',
        summary: buildPhotoAnalysisUnavailableSummary(fallbackKind, caption, isQuotaError),
        needsDiscomfortLevel: isSkinLike,
        notes: [reason, caption ? `Подпись пользователя: ${caption}` : 'Подписи к фото не было.'],
        tags: normalizeTags([fallbackKind, 'photo', 'analysis_unavailable'], fallbackKind),
        confidence: 0,
        analysisError: isQuotaError ? 'quota' : 'unavailable',
        analysisUnavailableReason: reason,
    };
}

function normalizePhotoAnalysis(analysis: HealthPhotoAnalysis, pendingKind?: HealthLogKind): HealthPhotoAnalysis {
    let inferredKind: HealthLogKind = 'note';
    if (isHealthLogKind(analysis.kind)) {
        inferredKind = analysis.kind;
    } else if (pendingKind) {
        inferredKind = pendingKind;
    } else if (analysis.imageType === 'blood_pressure' || normalizeBloodPressureReading(analysis.bloodPressure)) {
        inferredKind = 'blood_pressure';
    } else if (analysis.imageType === 'food') {
        inferredKind = 'food';
    } else if (analysis.imageType === 'skin') {
        inferredKind = 'skin';
    } else if (analysis.imageType === 'medication') {
        inferredKind = 'medication';
    } else if (analysis.imageType === 'activity') {
        inferredKind = 'activity';
    }

    return {
        ...analysis,
        action: analysis.action || 'log',
        kind: inferredKind,
        visualSeverity: normalizeSeverity(analysis.visualSeverity),
        needsDiscomfortLevel: Boolean(analysis.needsDiscomfortLevel || inferredKind === 'skin' || inferredKind === 'symptom'),
        tags: normalizeTags(analysis.tags, inferredKind),
    };
}

async function analyzeHealthRequest(
    message: string,
    pendingKind?: HealthLogKind,
    messageHistory: MessageHistory[] = []
): Promise<HealthRequestAnalysis> {
    const now = new Date();
    const history = messageHistory.slice(-6)
        .map((item, index) => `${index + 1}. ${item.role === 'user' ? 'Пользователь' : 'Бот'}: ${item.content}`)
        .join('\n');

    const requestedAnalysisDays = parseHealthAnalysisDays(message);
    if (requestedAnalysisDays) {
        return {
            action: 'analysis',
            periodDays: requestedAnalysisDays,
        };
    }

    const localPressure = extractBloodPressureReading(message);
    if (pendingKind === 'blood_pressure') {
        if (/^\s*(отмена|cancel|стоп)\s*$/iu.test(message)) {
            return { action: 'cancel', kind: pendingKind };
        }
        return {
            action: 'log',
            kind: 'blood_pressure',
            event: {
                kind: 'blood_pressure',
                summary: buildHealthTextSummary('blood_pressure', localPressure, message),
                bloodPressure: localPressure,
                tags: ['blood_pressure', 'pressure'],
            },
        };
    }

    if (localPressure && /давлен|пульс|чсс|запиш|сохрани/iu.test(message)) {
        return {
            action: 'log',
            kind: 'blood_pressure',
            event: {
                kind: 'blood_pressure',
                summary: buildHealthTextSummary('blood_pressure', localPressure, message),
                bloodPressure: localPressure,
                tags: ['blood_pressure', 'pressure'],
            },
        };
    }

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                {
                    role: 'system',
                    content: [
                        `Текущие дата и время: ${now.toLocaleString('ru-RU', { timeZone: USER_TIMEZONE, day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'long' })}. Таймзона: ${USER_TIMEZONE}.`,
                        'Ты управляешь личным дневником здоровья пользователя. Не ставь диагнозы и не назначай лечение.',
                        'Определи, что пользователь хочет сделать: открыть меню, сохранить запись, экспортировать дневник, проанализировать дневник за период, показать недавние записи, отменить ввод или получить подсказку.',
                        'Если активен pendingKind, обычное сообщение пользователя почти всегда является содержимым записи этого типа.',
                        'Для записи извлекай наблюдаемые факты: еда, напитки, симптомы, зоны тела, давление/пульс, лекарства, активности, контакты/триггеры, субъективную силу 0-10, время события.',
                        'Для давления сохраняй систолическое и диастолическое в мм рт. ст. и пульс, если пользователь его указал. Не интерпретируй норму/опасность, только фиксируй измерение.',
                        'Не выдумывай факты. Если интенсивность не названа, severity=null. suspectedTriggers заполняй только как гипотезы из текста, не как медицинский вывод.',
                        'Верни только JSON без markdown.',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        pendingKind ? `Активный режим ввода: ${pendingKind} (${KIND_LABELS[pendingKind]}).` : 'Активного режима ввода нет.',
                        history ? `История:\n${history}` : '',
                        `Сообщение пользователя: ${message}`,
                        '',
                        'Формат JSON:',
                        '{',
                        '  "action": "menu | log | export | analysis | recent | help | cancel | none",',
                        '  "kind": "food | drink | symptom | medication | activity | skin | blood_pressure | note",',
                        '  "periodDays": 7,',
                        '  "event": {',
                        '    "kind": "food | drink | symptom | medication | activity | skin | blood_pressure | note",',
                        '    "occurredAtIso": "ISO 8601 или null",',
                        '    "summary": "короткая фактическая сводка",',
                        '    "severity": 0,',
                        '    "symptoms": [], "bodyAreas": [], "foods": [], "drinks": [],',
                        '    "bloodPressure": { "systolicMmHg": 120, "diastolicMmHg": 80, "pulseBpm": 72, "context": "сидя утром" },',
                        '    "medications": [], "activities": [], "exposures": [],',
                        '    "suspectedTriggers": [], "notes": [], "tags": [], "confidence": 0.0',
                        '  },',
                        '  "responseHint": "короткая подсказка для ответа, если нужна"',
                        '}',
                    ].filter(Boolean).join('\n'),
                },
            ],
            temperature: 1,
        });

        const parsed = parseLLMJson<HealthRequestAnalysis>(response.choices[0]?.message?.content || '');
        if (parsed?.action) return normalizeAnalysis(parsed, pendingKind);
    } catch (error) {
        console.error('[health] request analysis failed:', error);
    }

    if (pendingKind) {
        return {
            action: 'log',
            kind: pendingKind,
            event: {
                kind: pendingKind,
                summary: message.trim().slice(0, 240),
                tags: [pendingKind],
            },
        };
    }

    return { action: 'menu' };
}

function normalizeAnalysis(analysis: HealthRequestAnalysis, pendingKind?: HealthLogKind): HealthRequestAnalysis {
    const action = analysis.action || (pendingKind ? 'log' : 'menu');
    const kind = isHealthLogKind(analysis.event?.kind)
        ? analysis.event!.kind
        : isHealthLogKind(analysis.kind)
            ? analysis.kind
            : pendingKind;

    return {
        ...analysis,
        action,
        kind,
        event: analysis.event
            ? {
                ...analysis.event,
                kind,
                severity: normalizeSeverity(analysis.event.severity),
                bloodPressure: normalizeBloodPressureReading(analysis.event.bloodPressure),
                tags: normalizeTags(analysis.event.tags, kind),
            }
            : undefined,
    };
}

async function saveHealthLog(
    ctx: BotContext,
    rawText: string,
    analysis: HealthRequestAnalysis,
    pendingKind?: HealthLogKind
): Promise<HealthLogRecord> {
    const now = new Date();
    const event = analysis.event ?? {};
    const kind = isHealthLogKind(event.kind)
        ? event.kind
        : isHealthLogKind(analysis.kind)
            ? analysis.kind
            : pendingKind ?? 'note';

    const occurredAt = event.occurredAtIso ? new Date(event.occurredAtIso) : now;
    const validOccurredAt = !isNaN(occurredAt.getTime()) ? occurredAt : now;
    const bloodPressure = kind === 'blood_pressure'
        ? normalizeBloodPressureReading(event.bloodPressure) ?? extractBloodPressureReading(rawText)
        : normalizeBloodPressureReading(event.bloodPressure);
    const structured = {
        symptoms: ensureStringArray(event.symptoms),
        bodyAreas: ensureStringArray(event.bodyAreas),
        foods: ensureStringArray(event.foods),
        drinks: ensureStringArray(event.drinks),
        bloodPressure,
        medications: ensureStringArray(event.medications),
        activities: ensureStringArray(event.activities),
        exposures: ensureStringArray(event.exposures),
        suspectedTriggers: ensureStringArray(event.suspectedTriggers),
        notes: ensureStringArray(event.notes),
        confidence: typeof event.confidence === 'number' ? event.confidence : undefined,
        source: 'text',
    };

    return HealthLogRepository.save({
        id: uuidv4(),
        userId: ctx.from?.id ?? ctx.chat?.id ?? 0,
        chatId: ctx.chat?.id,
        kind,
        rawText,
        summary: event.summary?.trim() || buildHealthTextSummary(kind, bloodPressure, rawText),
        severity: normalizeSeverity(event.severity),
        occurredAt: validOccurredAt,
        timeOfDay: getHealthTimeOfDay(validOccurredAt),
        structured,
        tags: normalizeTags(kind === 'blood_pressure' ? [...(event.tags ?? []), 'pressure'] : event.tags, kind),
        createdAt: now,
    });
}

async function saveHealthPhotoLog(
    ctx: BotContext,
    caption: string,
    analysis: HealthPhotoAnalysis,
    pendingKind?: HealthLogKind,
    photoFileId?: string,
    photoFileIds: string[] = []
): Promise<HealthLogRecord> {
    const now = new Date();
    const kind = isHealthLogKind(analysis.kind)
        ? analysis.kind
        : pendingKind ?? 'note';

    const structured = {
        symptoms: ensureStringArray(analysis.symptoms),
        bodyAreas: ensureStringArray(analysis.bodyAreas),
        foods: ensureStringArray(analysis.foods),
        drinks: ensureStringArray(analysis.drinks),
        bloodPressure: normalizeBloodPressureReading(analysis.bloodPressure) ?? (kind === 'blood_pressure' ? extractBloodPressureReading(caption) : undefined),
        medications: ensureStringArray(analysis.medications),
        activities: ensureStringArray(analysis.activities),
        exposures: ensureStringArray(analysis.exposures),
        suspectedTriggers: ensureStringArray(analysis.suspectedTriggers),
        possibleIngredients: ensureStringArray(analysis.possibleIngredients),
        possibleAllergenFlags: ensureStringArray(analysis.possibleAllergenFlags),
        visibleFindings: ensureStringArray(analysis.visibleFindings),
        morphology: ensureStringArray(analysis.morphology),
        distribution: normalizeOptionalText(analysis.distribution),
        redness: normalizeOptionalText(analysis.redness),
        swelling: normalizeOptionalText(analysis.swelling),
        skinTexture: normalizeOptionalText(analysis.skinTexture),
        notes: ensureStringArray(analysis.notes),
        confidence: typeof analysis.confidence === 'number' ? analysis.confidence : undefined,
        imageType: analysis.imageType,
        photoFileIds,
        analysisError: analysis.analysisError,
        analysisUnavailableReason: analysis.analysisUnavailableReason,
        source: 'photo',
    };

    const rawText = caption.trim() || '[Фото для дневника здоровья]';
    return HealthLogRepository.save({
        id: uuidv4(),
        userId: ctx.from?.id ?? ctx.chat?.id ?? 0,
        chatId: ctx.chat?.id,
        kind,
        rawText,
        summary: analysis.summary?.trim() || buildPhotoSummary(kind, structured, rawText),
        severity: normalizeSeverity(analysis.visualSeverity),
        occurredAt: now,
        timeOfDay: getHealthTimeOfDay(now),
        structured,
        tags: normalizeTags([...(analysis.tags ?? []), 'photo'], kind),
        photoFileId,
        createdAt: now,
    });
}

async function handleDiscomfortText(ctx: BotContext, message: string, recordId: string): Promise<ProcessingResult> {
    const extracted = await extractDiscomfortLevel(message);
    if (extracted.level == null) {
        return {
            responseText: 'Укажи уровень дискомфорта/зуда числом от 0 до 10. Например: 0, 4 или 8.',
            keyboard: buildDiscomfortKeyboard(recordId),
        };
    }

    return updateDiscomfortLevel(ctx, recordId, extracted.level, extracted.note || message);
}

async function updateDiscomfortLevel(
    ctx: BotContext,
    recordId: string,
    level: number,
    note?: string
): Promise<ProcessingResult> {
    const record = await HealthLogRepository.findById(recordId);
    if (!record) {
        ctx.session.pendingHealthDiscomfort = undefined;
        return { responseText: 'Не нашла запись дневника, к которой нужно добавить уровень дискомфорта.' };
    }

    if (ctx.from?.id && record.userId !== ctx.from.id) {
        return { responseText: 'Эта запись дневника относится к другому пользователю.' };
    }

    const structured = {
        ...(record.structured ?? {}),
        subjectiveDiscomfortLevel: level,
        itchLevel: level,
        discomfortNote: note,
        discomfortCapturedAt: new Date().toISOString(),
    };
    const updated = await HealthLogRepository.update({
        ...record,
        structured,
        tags: normalizeTags([...(record.tags ?? []), 'discomfort'], record.kind),
    });

    ctx.session.pendingHealthDiscomfort = undefined;
    return {
        responseText: [
            `Сохранила уровень дискомфорта/зуда: ${level}/10.`,
            `Запись: ${updated.summary || updated.rawText}`,
        ].join('\n'),
        keyboard: new InlineKeyboard()
            .text('Добавить ещё', 'health:menu')
            .text('Экспорт 7 дней', 'health:export:7'),
    };
}

async function extractDiscomfortLevel(message: string): Promise<DiscomfortExtraction> {
    const direct = message.match(/\b(10|[0-9])\b/u);
    if (direct) {
        return { level: Number(direct[1]), note: message };
    }

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Извлеки субъективный уровень зуда/дискомфорта по шкале 0-10 из сообщения пользователя. 0 = не беспокоит, 10 = максимально сильный дискомфорт. Если числа нет, но есть словесная оценка, оцени приблизительно. Верни только JSON {"level": number|null, "note": string|null}.',
                },
                { role: 'user', content: message.slice(0, 500) },
            ],
            temperature: 1,
        });
        const parsed = parseLLMJson<DiscomfortExtraction>(response.choices[0]?.message?.content || '');
        const level = normalizeSeverity(parsed?.level);
        return { level: level ?? null, note: parsed?.note || message };
    } catch (error) {
        console.error('[health] discomfort extraction failed:', error);
        return { level: null, note: message };
    }
}

async function buildRecentHealthLogsResult(ctx: BotContext): Promise<ProcessingResult> {
    const userId = ctx.from?.id;
    if (!userId) return { responseText: 'Не могу определить пользователя для дневника.' };

    const recent = await HealthLogRepository.findRecent(userId, 8);
    if (!recent.length) {
        return { responseText: 'В дневнике здоровья пока нет записей.', keyboard: buildHealthMenuKeyboard() };
    }

    const lines = recent.map((record) => {
        const time = formatDateTime(record.occurredAt);
        const severity = record.severity == null ? '' : `, сила ${record.severity}/10`;
        const timeOfDay = record.timeOfDay ? `, ${record.timeOfDay}` : '';
        return `- ${time}${timeOfDay}: ${KIND_LABELS[record.kind]}${severity} — ${record.summary || record.rawText}`;
    });

    return {
        responseText: ['Последние записи дневника здоровья:', '', ...lines].join('\n'),
        keyboard: buildHealthMenuKeyboard(),
    };
}

async function buildAIHealthAnalysis(
    records: HealthLogRecord[],
    from: Date,
    to: Date,
    days: number
): Promise<string | null> {
    const local = buildHealthAnalysisSnapshot(records, from, to, days);
    const compactRecords = records.slice(-80).map((record) => ({
        time: formatDateTime(record.occurredAt),
        timeOfDay: record.timeOfDay || getHealthTimeOfDay(record.occurredAt),
        kind: record.kind,
        summary: record.summary || record.rawText,
        severity: record.severity ?? null,
        structured: compactStructuredForAnalysis(record.structured),
    }));

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                {
                    role: 'system',
                    content: [
                        'Ты анализируешь личный дневник здоровья пользователя. Не ставь диагнозы, не назначай лечение и не делай медицинских утверждений.',
                        'Ищи только наблюдательные паттерны: что совпадало по времени, какие симптомы/еда/активности/давление чаще встречались, где данных мало.',
                        'Отвечай по-русски, кратко, с конкретными пунктами. Если есть потенциально тревожные признаки, советуй обратиться к врачу/скорой без драматизации.',
                    ].join('\n'),
                },
                {
                    role: 'user',
                    content: [
                        `Период: ${formatDateTime(from)} - ${formatDateTime(to)} (${formatPeriodLabel(days)}).`,
                        `Локальная сводка:\n${local}`,
                        '',
                        'Записи JSON:',
                        JSON.stringify(compactRecords),
                        '',
                        'Сформируй анализ в формате:',
                        '1. Краткий итог',
                        '2. Что повторяется/возможные связи',
                        '3. Давление и симптомы, если есть данные',
                        '4. Что стоит фиксировать дальше',
                        '5. Когда стоит обратиться к врачу',
                    ].join('\n'),
                },
            ],
            temperature: 0.6,
        });
        const text = response.choices[0]?.message?.content?.trim();
        if (!text) return null;
        return [
            `Анализ дневника здоровья за ${formatPeriodLabel(days)}`,
            '',
            text,
            '',
            'Это анализ наблюдений из дневника, не диагноз.',
        ].join('\n');
    } catch (error) {
        console.error('[health] analysis failed:', error);
        return null;
    }
}

function buildLocalHealthAnalysis(
    records: HealthLogRecord[],
    from: Date,
    to: Date,
    days: number
): string {
    return [
        `Анализ дневника здоровья за ${formatPeriodLabel(days)}`,
        `Период: ${formatDateTime(from)} - ${formatDateTime(to)}`,
        '',
        buildHealthAnalysisSnapshot(records, from, to, days),
        '',
        'Это анализ наблюдений из дневника, не диагноз.',
    ].join('\n');
}

function buildHealthAnalysisSnapshot(
    records: HealthLogRecord[],
    _from: Date,
    _to: Date,
    _days: number
): string {
    const byKind = new Map<string, number>();
    const byTimeOfDay = new Map<string, number>();
    const foods = new Map<string, number>();
    const drinks = new Map<string, number>();
    const symptoms = new Map<string, number>();
    const areas = new Map<string, number>();
    const triggers = new Map<string, number>();
    const medications = new Map<string, number>();
    const activities = new Map<string, number>();
    const symptomScores: number[] = [];
    const discomfortScores: number[] = [];
    const pressureReadings: BloodPressureReading[] = [];

    for (const record of records) {
        incrementCounter(byKind, KIND_LABELS[record.kind] || record.kind);
        incrementCounter(byTimeOfDay, record.timeOfDay || getHealthTimeOfDay(record.occurredAt));

        const structured = record.structured ?? {};
        for (const item of ensureStringArray(structured.foods)) incrementCounter(foods, item);
        for (const item of ensureStringArray(structured.drinks)) incrementCounter(drinks, item);
        for (const item of ensureStringArray(structured.symptoms)) incrementCounter(symptoms, item);
        for (const item of ensureStringArray(structured.bodyAreas)) incrementCounter(areas, item);
        for (const item of ensureStringArray(structured.suspectedTriggers)) incrementCounter(triggers, item);
        for (const item of ensureStringArray(structured.medications)) incrementCounter(medications, item);
        for (const item of ensureStringArray(structured.activities)) incrementCounter(activities, item);

        if (record.severity != null && (record.kind === 'skin' || record.kind === 'symptom')) {
            symptomScores.push(record.severity);
        }
        if (typeof structured.subjectiveDiscomfortLevel === 'number') {
            discomfortScores.push(structured.subjectiveDiscomfortLevel);
        }
        const pressure = normalizeBloodPressureReading(structured.bloodPressure);
        if (pressure) pressureReadings.push(pressure);
    }

    const lines = [
        `Записей: ${records.length}. По типам: ${formatCounter(byKind) || 'нет разбивки'}.`,
        `По времени суток: ${formatCounter(byTimeOfDay) || 'нет данных'}.`,
    ];

    if (foods.size || drinks.size) {
        lines.push(`Еда/напитки чаще всего: ${[formatTopCounter(foods, 6), formatTopCounter(drinks, 4)].filter(Boolean).join('; ') || 'нет данных'}.`);
    }
    if (symptoms.size || areas.size) {
        lines.push(`Симптомы и зоны: ${[formatTopCounter(symptoms, 6), formatTopCounter(areas, 5)].filter(Boolean).join('; ') || 'нет данных'}.`);
    }
    if (symptomScores.length || discomfortScores.length) {
        lines.push(`Выраженность: ${formatScoreSummary('визуальная/симптомы', symptomScores)}${symptomScores.length && discomfortScores.length ? '; ' : ''}${formatScoreSummary('зуд/дискомфорт', discomfortScores)}.`);
    }
    if (pressureReadings.length) {
        lines.push(`Давление: ${formatPressureSummary(pressureReadings)}.`);
    }
    if (triggers.size || activities.size || medications.size) {
        lines.push(`Контекст: ${[
            formatTopCounter(triggers, 5) ? `возможные триггеры: ${formatTopCounter(triggers, 5)}` : '',
            formatTopCounter(activities, 5) ? `активности: ${formatTopCounter(activities, 5)}` : '',
            formatTopCounter(medications, 5) ? `лекарства: ${formatTopCounter(medications, 5)}` : '',
        ].filter(Boolean).join('; ')}.`);
    }

    const gaps = buildHealthAnalysisGaps(records);
    if (gaps.length) lines.push(`Что стоит фиксировать точнее: ${gaps.join('; ')}.`);
    lines.push('Если симптомы быстро усиливаются, есть отёк лица/горла, затруднение дыхания, сильная слабость или необычно высокое/низкое давление с плохим самочувствием, лучше обратиться за медицинской помощью.');
    return lines.join('\n');
}

function formatSavedHealthLog(record: HealthLogRecord): string {
    const structured = record.structured ?? {};
    const severity = record.severity == null ? '' : `\nВизуальная выраженность: ${record.severity}/10`;
    const discomfort = typeof structured.subjectiveDiscomfortLevel === 'number'
        ? `\nСубъективный зуд/дискомфорт: ${structured.subjectiveDiscomfortLevel}/10`
        : '';
    const triggers = ensureStringArray(record.structured?.suspectedTriggers).slice(0, 4);
    const triggerText = triggers.length ? `\nВозможные триггеры из записи: ${triggers.join(', ')}` : '';
    const findings = ensureStringArray(structured.visibleFindings).slice(0, 5);
    const findingsText = findings.length ? `\nВидимые признаки: ${findings.join(', ')}` : '';
    const bodyAreas = ensureStringArray(structured.bodyAreas).slice(0, 5);
    const bodyAreasText = bodyAreas.length ? `\nЗоны: ${bodyAreas.join(', ')}` : '';
    const foods = ensureStringArray(structured.foods).slice(0, 8);
    const foodsText = foods.length ? `\nРаспознано на фото/в записи: ${foods.join(', ')}` : '';
    const pressureText = formatBloodPressureLine(structured.bloodPressure);
    const pressureBlock = pressureText ? `\n${pressureText}` : '';
    const analysisUnavailable = typeof structured.analysisUnavailableReason === 'string' && structured.analysisUnavailableReason.trim()
        ? `\nAI-оценка фото: временно недоступна. ${structured.analysisUnavailableReason.trim()}`
        : '';
    const notes = ensureStringArray(structured.notes).slice(0, 3);
    const notesText = notes.length ? `\nЗаметки: ${notes.join('; ')}` : '';

    return [
        `Сохранила запись в дневник здоровья: ${KIND_LABELS[record.kind]}.`,
        `Время события: ${formatDateTime(record.occurredAt)}`,
        `Время суток: ${record.timeOfDay || getHealthTimeOfDay(record.occurredAt)}`,
        `Кратко: ${record.summary || record.rawText}`,
        foodsText,
        findingsText,
        bodyAreasText,
        pressureBlock,
        severity,
        discomfort,
        triggerText,
        analysisUnavailable,
        notesText,
        '',
        'Это наблюдение для дневника, не диагноз.',
    ].filter(Boolean).join('\n');
}

async function createHealthExportFile(
    userId: number,
    records: HealthLogRecord[],
    from: Date,
    to: Date
): Promise<{ filePath: string; filename: string }> {
    const filename = `health-diary-${formatFileDate(from)}-${formatFileDate(to)}.txt`;
    const filePath = path.join(os.tmpdir(), `${userId}-${Date.now()}-${filename}`);
    const lines: string[] = [
        'Дневник здоровья',
        `Период: ${formatDateTime(from)} - ${formatDateTime(to)}`,
        `Записей: ${records.length}`,
        '',
        'Важно: это личный дневник наблюдений, не медицинское заключение.',
        '',
    ];

    let currentDay = '';
    for (const record of records) {
        const day = formatDay(record.occurredAt);
        if (day !== currentDay) {
            currentDay = day;
            lines.push(day);
        }

        const structured = record.structured ?? {};
        const details = [
            formatList('Еда', structured.foods),
            formatList('Напитки', structured.drinks),
            formatBloodPressureLine(structured.bloodPressure),
            formatList('Симптомы', structured.symptoms),
            formatList('Зоны', structured.bodyAreas),
            formatList('Лекарства', structured.medications),
            formatList('Активности/контакты', structured.activities),
            formatList('Вероятные ингредиенты', structured.possibleIngredients),
            formatList('Пищевые флаги из фото', structured.possibleAllergenFlags),
            formatList('Видимые признаки кожи', structured.visibleFindings),
            formatList('Морфология', structured.morphology),
            formatScalar('Распределение', structured.distribution),
            formatScalar('Покраснение', structured.redness),
            formatScalar('Отёк', structured.swelling),
            formatScalar('Текстура кожи', structured.skinTexture),
            formatScalar('Субъективный зуд/дискомфорт', typeof structured.subjectiveDiscomfortLevel === 'number' ? `${structured.subjectiveDiscomfortLevel}/10` : undefined),
            formatScalar('AI-оценка фото недоступна', structured.analysisUnavailableReason),
            formatList('Возможные триггеры из текста', structured.suspectedTriggers),
            formatList('Заметки', structured.notes),
        ].filter(Boolean);

        const timeOfDay = record.timeOfDay || getHealthTimeOfDay(record.occurredAt);
        lines.push(`- ${formatTime(record.occurredAt)} (${timeOfDay}) [${KIND_LABELS[record.kind]}] ${record.summary || record.rawText}`);
        if (record.severity != null) lines.push(`  Выраженность: ${record.severity}/10`);
        if (details.length) {
            for (const detail of details) lines.push(`  ${detail}`);
        }
        lines.push(`  Исходный текст: ${record.rawText}`);
        lines.push('');
    }

    await fs.promises.writeFile(filePath, lines.join('\n'), 'utf8');
    return { filePath, filename };
}

function isHealthLogKind(value: unknown): value is HealthLogKind {
    return value === 'food' ||
        value === 'drink' ||
        value === 'symptom' ||
        value === 'medication' ||
        value === 'activity' ||
        value === 'skin' ||
        value === 'blood_pressure' ||
        value === 'note';
}

function normalizeSeverity(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.max(0, Math.min(10, Math.round(value)));
}

function normalizeTags(tags: unknown, kind?: HealthLogKind): string[] | undefined {
    const values = ensureStringArray(tags)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12);
    if (kind && !values.includes(kind)) values.unshift(kind);
    return values.length ? Array.from(new Set(values)) : undefined;
}

function ensureStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeExportDays(days: number): number {
    if (!Number.isFinite(days) || days <= 0) return DEFAULT_EXPORT_DAYS;
    return Math.min(MAX_EXPORT_DAYS, Math.max(1, Math.round(days)));
}

function normalizeAnalysisDays(days: number): number {
    if (!Number.isFinite(days) || days <= 0) return DEFAULT_ANALYSIS_DAYS;
    if (days <= 1) return 1;
    if (days <= 7) return 7;
    return MAX_ANALYSIS_DAYS;
}

function formatPeriodLabel(days: number): string {
    const normalized = normalizeAnalysisDays(days);
    if (normalized === 1) return 'день';
    if (normalized === 7) return 'неделю';
    if (normalized === 30) return 'месяц';
    return `${normalized} дней`;
}

function parseHealthAnalysisDays(message: string): number | undefined {
    const text = message.toLowerCase();
    if (!/(анализ|проанализ|разбер|сводк|итог|динамик|паттерн|статистик|что\s+видно|что\s+по\s+здоров)/iu.test(text)) {
        return undefined;
    }
    if (/(месяц|30\s*д|тридцат)/iu.test(text)) return 30;
    if (/(недел|7\s*д|семь\s+д)/iu.test(text)) return 7;
    if (/(день|сутк|сегодня|за\s+1\s*д)/iu.test(text)) return 1;
    return DEFAULT_ANALYSIS_DAYS;
}

function buildDiscomfortKeyboard(recordId: string): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (let level = 0; level <= 10; level++) {
        keyboard.text(String(level), `health:discomfort:${recordId}:${level}`);
        if (level === 5) keyboard.row();
    }
    return keyboard;
}

function shouldAskDiscomfort(record: HealthLogRecord, analysis: HealthPhotoAnalysis): boolean {
    if (analysis.needsDiscomfortLevel) return true;
    return record.kind === 'skin' || record.kind === 'symptom';
}

function buildPhotoSummary(
    kind: HealthLogKind,
    structured: Record<string, unknown>,
    fallback: string
): string {
    if (kind === 'food') {
        const foods = ensureStringArray(structured.foods);
        if (foods.length) return `Фото еды: ${foods.slice(0, 8).join(', ')}`;
    }
    if (kind === 'skin' || kind === 'symptom') {
        const findings = ensureStringArray(structured.visibleFindings);
        const areas = ensureStringArray(structured.bodyAreas);
        const parts = [
            findings.length ? findings.slice(0, 5).join(', ') : undefined,
            areas.length ? `зоны: ${areas.slice(0, 4).join(', ')}` : undefined,
        ].filter(Boolean);
        if (parts.length) return `Фото кожи: ${parts.join('; ')}`;
    }
    if (kind === 'blood_pressure') {
        const pressure = formatBloodPressureValue(structured.bloodPressure);
        if (pressure) return `Давление: ${pressure}`;
    }
    return fallback;
}

function compactStructuredForAnalysis(structured: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!structured) return {};
    return {
        foods: ensureStringArray(structured.foods).slice(0, 8),
        drinks: ensureStringArray(structured.drinks).slice(0, 8),
        symptoms: ensureStringArray(structured.symptoms).slice(0, 8),
        bodyAreas: ensureStringArray(structured.bodyAreas).slice(0, 8),
        medications: ensureStringArray(structured.medications).slice(0, 8),
        activities: ensureStringArray(structured.activities).slice(0, 8),
        exposures: ensureStringArray(structured.exposures).slice(0, 8),
        suspectedTriggers: ensureStringArray(structured.suspectedTriggers).slice(0, 8),
        visibleFindings: ensureStringArray(structured.visibleFindings).slice(0, 8),
        bloodPressure: normalizeBloodPressureReading(structured.bloodPressure),
        subjectiveDiscomfortLevel: typeof structured.subjectiveDiscomfortLevel === 'number' ? structured.subjectiveDiscomfortLevel : undefined,
        notes: ensureStringArray(structured.notes).slice(0, 5),
    };
}

function incrementCounter(counter: Map<string, number>, value: string): void {
    const key = value.trim().toLowerCase();
    if (!key) return;
    counter.set(key, (counter.get(key) ?? 0) + 1);
}

function formatCounter(counter: Map<string, number>): string {
    return formatTopCounter(counter, 12);
}

function formatTopCounter(counter: Map<string, number>, limit: number): string {
    return Array.from(counter.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
        .slice(0, limit)
        .map(([key, count]) => `${key} (${count})`)
        .join(', ');
}

function formatScoreSummary(label: string, values: number[]): string {
    if (!values.length) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return `${label}: среднее ${avg.toFixed(1)}/10, диапазон ${min}-${max}/10`;
}

function formatPressureSummary(readings: BloodPressureReading[]): string {
    const systolic = readings.map((item) => item.systolicMmHg).filter((value): value is number => typeof value === 'number');
    const diastolic = readings.map((item) => item.diastolicMmHg).filter((value): value is number => typeof value === 'number');
    const pulse = readings.map((item) => item.pulseBpm).filter((value): value is number => typeof value === 'number');
    const last = readings[readings.length - 1];
    return [
        `${readings.length} измерений`,
        systolic.length && diastolic.length ? `среднее ${average(systolic).toFixed(0)}/${average(diastolic).toFixed(0)} мм рт. ст.` : '',
        systolic.length && diastolic.length ? `диапазон ${Math.min(...systolic)}-${Math.max(...systolic)}/${Math.min(...diastolic)}-${Math.max(...diastolic)}` : '',
        pulse.length ? `пульс средний ${average(pulse).toFixed(0)}` : '',
        last ? `последнее ${formatBloodPressureValue(last)}` : '',
    ].filter(Boolean).join(', ');
}

function average(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildHealthAnalysisGaps(records: HealthLogRecord[]): string[] {
    const gaps = new Set<string>();
    const skinOrSymptoms = records.filter((record) => record.kind === 'skin' || record.kind === 'symptom');
    if (skinOrSymptoms.some((record) => typeof record.structured?.subjectiveDiscomfortLevel !== 'number')) {
        gaps.add('для кожных симптомов указывать зуд/дискомфорт 0-10');
    }
    if (records.some((record) => record.kind === 'blood_pressure' && !normalizeBloodPressureReading(record.structured?.bloodPressure)?.context)) {
        gaps.add('для давления добавлять контекст: сидя/после нагрузки/после лекарства/самочувствие');
    }
    if (records.some((record) => (record.kind === 'food' || record.kind === 'drink') && !ensureStringArray(record.structured?.suspectedTriggers).length)) {
        gaps.add('для еды отмечать время появления симптомов после приёма');
    }
    return Array.from(gaps);
}

function inferPhotoKindFromCaption(caption: string): HealthLogKind | undefined {
    const text = caption.toLowerCase();
    if (!text.trim()) return undefined;
    if (/давлен|тонометр|пульс|чсс|мм\s*рт/iu.test(text)) {
        return 'blood_pressure';
    }
    if (/кожа|крапивниц|сып|зуд|чеш|покрасн|волдыр|аллерг|от[её]к|высып|пятн|раздраж/iu.test(text)) {
        return 'skin';
    }
    if (/еда|ем|ел|съел|завтрак|обед|ужин|перекус|блюдо|пища|продукт/iu.test(text)) {
        return 'food';
    }
    if (/пью|выпил|напит|чай|кофе|вода|сок|алкогол/iu.test(text)) {
        return 'drink';
    }
    if (/лекар|таблет|принял|доз|антигистамин|мазь|крем/iu.test(text)) {
        return 'medication';
    }
    if (/делал|делаю|активност|спорт|стресс|душ|жара|холод|животн|химия|одежд/iu.test(text)) {
        return 'activity';
    }
    if (/симптом|самочувств|болит|тошн|температур|давлен/iu.test(text)) {
        return 'symptom';
    }
    return undefined;
}

function buildHealthTextSummary(kind: HealthLogKind, bloodPressure: BloodPressureReading | undefined, rawText: string): string {
    if (kind === 'blood_pressure') {
        const pressure = formatBloodPressureValue(bloodPressure);
        if (pressure) return `Давление: ${pressure}`;
    }
    return rawText.trim().slice(0, 240);
}

function normalizeBloodPressureReading(value: unknown): BloodPressureReading | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const source = value as Record<string, unknown>;
    const systolicMmHg = normalizeInteger(source.systolicMmHg ?? source.systolic ?? source.upper, 60, 260);
    const diastolicMmHg = normalizeInteger(source.diastolicMmHg ?? source.diastolic ?? source.lower, 35, 180);
    const pulseBpm = normalizeInteger(source.pulseBpm ?? source.pulse ?? source.heartRate ?? source.hr, 30, 230);
    const context = normalizeOptionalText(source.context ?? source.note ?? source.notes);
    if (systolicMmHg == null && diastolicMmHg == null && pulseBpm == null && !context) return undefined;
    return { systolicMmHg, diastolicMmHg, pulseBpm, context };
}

function extractBloodPressureReading(text: string): BloodPressureReading | undefined {
    const pressureMatch = text.match(/\b(6\d|7\d|8\d|9\d|1\d{2}|2[0-5]\d|260)\s*(?:\/|\\|[-–—]|на)\s*(3[5-9]|4\d|5\d|6\d|7\d|8\d|9\d|1[0-7]\d|180)\b/iu);
    const pulseMatch = text.match(/\b(?:пульс|чсс|сердцебиен\w*)\D{0,16}(3\d|4\d|5\d|6\d|7\d|8\d|9\d|1\d{2}|2[0-2]\d|230)\b/iu);
    const systolicMmHg = pressureMatch ? normalizeInteger(pressureMatch[1], 60, 260) : undefined;
    const diastolicMmHg = pressureMatch ? normalizeInteger(pressureMatch[2], 35, 180) : undefined;
    const pulseBpm = pulseMatch ? normalizeInteger(pulseMatch[1], 30, 230) : undefined;
    if (systolicMmHg == null && diastolicMmHg == null && pulseBpm == null) return undefined;
    return { systolicMmHg, diastolicMmHg, pulseBpm };
}

function normalizeInteger(value: unknown, min: number, max: number): number | undefined {
    const num = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number(value.replace(',', '.').trim())
            : NaN;
    if (!Number.isFinite(num)) return undefined;
    const rounded = Math.round(num);
    if (rounded < min || rounded > max) return undefined;
    return rounded;
}

function formatBloodPressureLine(value: unknown): string | null {
    const text = formatBloodPressureValue(value);
    return text ? `Давление: ${text}` : null;
}

function formatBloodPressureValue(value: unknown): string | null {
    const reading = normalizeBloodPressureReading(value);
    if (!reading) return null;
    const parts: string[] = [];
    if (reading.systolicMmHg != null && reading.diastolicMmHg != null) {
        parts.push(`${reading.systolicMmHg}/${reading.diastolicMmHg} мм рт. ст.`);
    } else if (reading.systolicMmHg != null) {
        parts.push(`систолическое ${reading.systolicMmHg} мм рт. ст.`);
    } else if (reading.diastolicMmHg != null) {
        parts.push(`диастолическое ${reading.diastolicMmHg} мм рт. ст.`);
    }
    if (reading.pulseBpm != null) parts.push(`пульс ${reading.pulseBpm}`);
    if (reading.context) parts.push(reading.context);
    return parts.length ? parts.join(', ') : null;
}

function buildPhotoAnalysisUnavailableSummary(kind: HealthLogKind, caption: string, quotaError: boolean): string {
    const base = kind === 'skin' || kind === 'symptom'
        ? 'Фото кожи сохранено без автоматической визуальной оценки'
        : kind === 'food' || kind === 'drink'
            ? 'Фото еды/напитка сохранено без автоматического распознавания'
            : kind === 'blood_pressure'
                ? 'Фото показателя давления сохранено без автоматического распознавания'
                : 'Фото сохранено без автоматического распознавания';
    const reason = quotaError ? 'из-за лимита OpenAI API' : 'из-за временной технической ошибки';
    return caption.trim()
        ? `${base} ${reason}: ${caption.trim()}`
        : `${base} ${reason}.`;
}

function isOpenAIQuotaError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const candidate = error as {
        status?: number;
        code?: string;
        type?: string;
        error?: { code?: string; type?: string; message?: string };
        message?: string;
    };
    return candidate.status === 429 ||
        candidate.code === 'insufficient_quota' ||
        candidate.type === 'insufficient_quota' ||
        candidate.error?.code === 'insufficient_quota' ||
        candidate.error?.type === 'insufficient_quota' ||
        /insufficient_quota|exceeded your current quota/i.test(candidate.message ?? candidate.error?.message ?? '');
}

function normalizeOptionalText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getHealthTimeOfDay(date: Date): HealthTimeOfDay {
    const hour = Number(new Intl.DateTimeFormat('ru-RU', {
        timeZone: USER_TIMEZONE,
        hour: '2-digit',
        hour12: false,
    }).format(date));

    if (hour >= 5 && hour <= 11) return 'утро';
    if (hour >= 12 && hour <= 16) return 'день';
    if (hour >= 17 && hour <= 22) return 'вечер';
    return 'ночь';
}

function formatList(label: string, value: unknown): string | null {
    const items = ensureStringArray(value);
    return items.length ? `${label}: ${items.join(', ')}` : null;
}

function formatScalar(label: string, value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    return `${label}: ${value.trim()}`;
}

function formatDateTime(date: Date): string {
    return date.toLocaleString('ru-RU', {
        timeZone: USER_TIMEZONE,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatDay(date: Date): string {
    return date.toLocaleDateString('ru-RU', {
        timeZone: USER_TIMEZONE,
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        weekday: 'long',
    });
}

function formatTime(date: Date): string {
    return date.toLocaleTimeString('ru-RU', {
        timeZone: USER_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
    });
}

function formatFileDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
