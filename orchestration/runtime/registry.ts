import type { JsonSchema, ToolContext, ToolDefinition, ToolOutput } from './types';
import { isDialogueReadTool } from './authorization';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function validateToolArguments(schema: JsonSchema, value: unknown, path = 'args', depth = 0): void {
    if (depth > 8) throw new Error('Слишком глубокие аргументы инструмента');
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: требуется объект`);
        const object = value as Record<string, unknown>;
        for (const required of schema.required ?? []) {
            if (!Object.prototype.hasOwnProperty.call(object, required)) throw new Error(`${path}.${required}: обязательное поле`);
        }
        for (const [key, item] of Object.entries(object)) {
            if (FORBIDDEN_KEYS.has(key)) throw new Error(`${path}: запрещённое поле`);
            const child = schema.properties?.[key];
            if (!child && schema.additionalProperties !== true) throw new Error(`${path}.${key}: неизвестное поле`);
            if (child) validateToolArguments(child, item, `${path}.${key}`, depth + 1);
        }
        return;
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value) || value.length > (schema.maxItems ?? 50)) throw new Error(`${path}: недопустимый массив`);
        if (schema.items) value.forEach((item, index) => validateToolArguments(schema.items!, item, `${path}[${index}]`, depth + 1));
        return;
    }
    if (schema.type === 'string') {
        if (typeof value !== 'string' || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 8_000)) {
            throw new Error(`${path}: недопустимая строка`);
        }
    } else if (schema.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`${path}: требуется boolean`);
    } else if (typeof value !== 'number' || !Number.isFinite(value) ||
        (schema.type === 'integer' && !Number.isInteger(value)) ||
        (schema.minimum !== undefined && value < schema.minimum) ||
        (schema.maximum !== undefined && value > schema.maximum)) {
        throw new Error(`${path}: недопустимое число`);
    }
    if (schema.enum && !schema.enum.includes(value as string | number | boolean)) throw new Error(`${path}: неизвестный вариант`);
}

export class ToolRegistry {
    private readonly tools = new Map<string, ToolDefinition>();

    constructor(definitions: ToolDefinition[], private readonly isOwner: (context: ToolContext) => boolean) {
        for (const definition of definitions) {
            if (!/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(definition.name) || this.tools.has(definition.name)) {
                throw new Error(`Некорректный или повторный tool: ${definition.name}`);
            }
            this.tools.set(definition.name, definition);
        }
    }

    get(name: string): ToolDefinition | undefined { return this.tools.get(name); }

    available(context: ToolContext): ToolDefinition[] {
        return [...this.tools.values()].filter(tool => (!tool.ownerOnly || this.isOwner(context)) && (!tool.privateOnly || context.ctx.chat?.type === 'private'));
    }

    async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutput> {
        const tool = this.tools.get(name);
        if (!tool || (tool.ownerOnly && !this.isOwner(context)) || (tool.privateOnly && context.ctx.chat?.type !== 'private')) {
            return { status: 'failed', summary: 'Инструмент недоступен в этом контексте.' };
        }
        if (context.signal.aborted) return { status: 'failed', summary: 'Задача отменена.' };
        if (context.readOnly && !isDialogueReadTool(tool, args)) {
            return { status: 'failed', summary: 'Фоновый разбор не может изменять данные или выполнять внешние действия.' };
        }
        try {
            if (JSON.stringify(args).length > 24_000) throw new Error('Аргументы слишком велики');
            validateToolArguments(tool.inputSchema, args);
        } catch (error) {
            return { status: 'failed', summary: error instanceof Error ? error.message : 'Некорректные аргументы' };
        }
        // No implicit retries here: even a state operation may have committed before an error.
        try {
            return await tool.execute(args, context);
        } catch {
            return {
                status: tool.effect === 'read' ? 'failed' : 'unknown',
                summary: tool.effect === 'read'
                    ? 'Не удалось получить данные. Не подменяй ошибку выдуманным результатом.'
                    : 'Результат операции неизвестен. Не повторяй её автоматически; сначала проверь состояние.',
            };
        }
    }
}

export const textSchema = (description: string, maxLength = 4_000): JsonSchema => ({ type: 'string', minLength: 1, maxLength, description });
export const objectSchema = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({
    type: 'object', properties, required, additionalProperties: false,
});
