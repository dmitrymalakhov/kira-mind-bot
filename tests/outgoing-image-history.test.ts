import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InputFile } from 'grammy';
import * as completion from '../ai/chatCompletion';
import * as generation from '../services/imageGenerationService';
import * as selfMemory from '../utils/kiraSelfMemory';
import * as episodes from '../services/MemoryEpisodeService';
import * as orchestrator from '../orchestrator';
import * as storage from '../services/SessionStorage';
import { imageGenerationAgent } from '../agents/imageGenerationAgent';
import { mapsAgent } from '../agents/googleMapsAgent';
import { GoogleMapsService } from '../services/googleMaps';
import { describeOutgoingImage } from '../services/outgoingImageDescription';
import { generatedImageHistoryText, normalizeImageDescription } from '../utils/generatedImage';
import { sendResultToUser, resolveReplyTo, replyWithPhotoAndStore } from '../handlers/shared';
import { mergeProcessingResults } from '../orchestration/executor';
import { extractAndSaveFactsFromConversation } from '../utils/enhancedFactExtraction';
import { FactExtractionService, type DialoguePair } from '../services/FactExtractionService';
import { executeRecurringTask } from '../services/recurringTaskScheduler';
import { RecurringTaskRepository } from '../services/RecurringTaskRepository';
import { AppDataSource } from '../data-source';
import type { BotContext, MessageHistory, SentMessageContext, SessionData } from '../types';
import type { RecurringTask } from '../types/recurringTaskTypes';

const cat = 'Я нарисовала кота-астронавта в белом скафандре с золотой рыбкой в лапах на фоне синего космоса. Получилось ярко и мечтательно.';
const selfie = 'Я сижу у окна в кафе в зелёном свитере и держу чашку. Вокруг тёплый вечерний свет.';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/NkAAAAASUVORK5CYII=', 'base64');
const answer = (content: string): any => ({ choices: [{ message: { content } }] });
const session = (): SessionData => ({ reminders: [], messageHistory: [], dialogueSummary: '', lastSummarizedIndex: -1, domains: {} });

function context() {
    const deliveries: any[] = [];
    const ctx = {
        chat: { id: 730001, type: 'private' },
        from: { id: 730001 },
        session: session(),
        api: { sendChatAction: async () => true },
        reply: async (text: string, options?: any) => { deliveries.push({ text, options }); return { message_id: deliveries.length }; },
        replyWithPhoto: async (photo: any, options?: any) => { deliveries.push({ photo, options }); return { message_id: deliveries.length }; },
    } as unknown as BotContext;
    return { ctx, deliveries };
}

test('vision reads outgoing bytes; readable Russian description and request fallback never expose the generation prompt', async t => {
    t.mock.method(completion, 'createChatCompletionForTask', async (...[task, params]: Parameters<typeof completion.createChatCompletionForTask>) => {
        assert.equal(task, 'browserVision');
        const content = params.messages[1].content as any[];
        assert.equal(content[1].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
        assert.match(String(params.messages[0].content), /одета|одет/);
        return answer(selfie);
    });
    assert.equal(await describeOutgoingImage(png, 'image/png', true), selfie);
    assert.equal(generatedImageHistoryText({ generatedImageDescription: cat }), cat);
    assert.equal(normalizeImageDescription('A long English scene prompt'), undefined);
    assert.equal(normalizeImageDescription('```json {"prompt":"кот"} ```'), undefined);
    assert.equal(normalizeImageDescription('{"description":"кот на фоне заката"}'), undefined);
    assert.equal(normalizeImageDescription('кот '.repeat(500)), undefined);
    t.mock.method(completion, 'createChatCompletionForTask', async () => { throw new Error('private provider body'); });
    assert.equal(await describeOutgoingImage(png), undefined);
    assert.match(generatedImageHistoryText({ generatedImageRequest: 'Нарисуй кота с рыбкой' }), /Нарисуй кота с рыбкой/);
});

test('description timeout is optional and bounded', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(completion, 'createChatCompletionForTask', () => new Promise(() => {}));
    const description = describeOutgoingImage(png);
    t.mock.timers.tick(15_000);
    assert.equal(await description, undefined);
});

test('image generation keeps actual visual details in follow-up context and survives failed vision', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-image-history-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'scene.png');
    await fs.writeFile(filename, png);
    t.mock.method(generation, 'getImageSettings', async () => ({ enabled: true } as any));
    const prompts: string[] = [];
    t.mock.method(generation, 'generateOpenAiImage', async (prompt: string) => { prompts.push(prompt); return filename; });
    const planningInputs: string[] = [];
    let visionFails = false;
    t.mock.method(completion, 'createChatCompletionForTask', async (...[task, params]: Parameters<typeof completion.createChatCompletionForTask>) => {
        if (task === 'browserVision') {
            if (visionFails) throw new Error('synthetic vision error');
            return answer(cat);
        }
        assert.equal(task, 'lightweightText');
        planningInputs.push(String(params.messages[1].content));
        return answer(JSON.stringify({ prompt: 'A deliberately different internal English prompt', includesCharacter: false }));
    });
    const first = await imageGenerationAgent('Нарисуй кота-астронавта с рыбкой в лапах');
    assert.equal(first.generatedImageDescription, cat);
    const history = [{ role: 'bot', content: generatedImageHistoryText(first), timestamp: new Date(), kind: 'image' as const }];
    await imageGenerationAgent('Сделай фон закатом', false, '', history);
    assert.ok(planningInputs[1].includes(cat));
    assert.match(planningInputs[1], /сохрани её сюжет и все детали/);
    assert.ok(!generatedImageHistoryText(first).includes(prompts[0]));
    visionFails = true;
    const fallback = await imageGenerationAgent('Нарисуй кота с рыбкой');
    assert.equal(fallback.imageGenerated, true);
    assert.equal(fallback.generatedImagePath, filename);
    assert.match(generatedImageHistoryText(fallback), /Нарисуй кота с рыбкой/);
});

test('selfie details come from the photo rather than biography or the requested pose', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-selfie-history-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'selfie.png');
    await fs.writeFile(filename, png);
    t.mock.method(generation, 'getImageSettings', async () => ({ enabled: true } as any));
    t.mock.method(generation, 'generateOpenAiImage', async (_prompt: string, includesCharacter: boolean) => { assert.equal(includesCharacter, true); return filename; });
    t.mock.method(selfMemory, 'getKiraSelfMemoryState', async () => { throw new Error('no self-memory in test'); });
    t.mock.method(selfMemory, 'getRecentKiraSelfEvents', async () => []);
    t.mock.method(selfMemory, 'searchKiraSelfEventsByQuery', async () => []);
    t.mock.method(completion, 'createChatCompletionForTask', async (task: string) => answer(task === 'browserVision' ? selfie : '{"prompt":"An internal selfie scene", "includesCharacter":false}'));
    const result = await imageGenerationAgent('Скинь фото, где ты сейчас');
    assert.equal(result.imageGenerated, true);
    assert.equal(result.generatedImageDescription, selfie);
});

test('map history describes the actual marker without a provider URL or API key', async t => {
    t.mock.method(completion, 'createChatCompletionForTask', async () => answer('{"queryType":"address_lookup","address":"Тестовая улица, 12"}'));
    t.mock.method(GoogleMapsService.prototype, 'geocodeAddress', async () => ({
        formatted_address: 'Тестовый город, Тестовая улица, 12', place_id: 'synthetic-place', geometry: { location: { lat: 1, lng: 2 } },
    }) as any);
    t.mock.method(GoogleMapsService.prototype, 'getStaticMapUrl', () => 'https://maps.invalid/static?key=synthetic-private-key');
    const result = await mapsAgent('Покажи на карте Тестовую улицу, 12');
    const text = generatedImageHistoryText(result);
    assert.equal(result.imageGenerated, true);
    assert.match(text, /Тестовая улица, 12/);
    assert.match(text, /красным маркером/);
    assert.ok(!text.includes('https:') && !text.includes('synthetic-private-key'));
    assert.equal(result.generatedImageRequest, 'Покажи на карте Тестовую улицу, 12');
});

test('photo and speech stay separate; history, Reply and restart preserve the scene as assistant image context', async t => {
    const { ctx, deliveries } = context();
    const result = { responseText: 'Вот картинка!', imageGenerated: true, generatedImagePath: '/synthetic/scene.png', generatedImageDescription: cat };
    const merged = mergeProcessingResults([{ responseText: 'Готово.' }, result]);
    assert.equal(merged.generatedImageDescription, cat);
    await sendResultToUser(ctx, merged);
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0].text, merged.responseText);
    assert.ok(deliveries[1].photo instanceof InputFile);
    assert.equal(deliveries[1].options?.caption, undefined);
    assert.equal(ctx.session.messageHistory[0].content, cat);
    assert.equal(ctx.session.messageHistory[0].role, 'bot');
    assert.equal(ctx.session.messageHistory[0].kind, 'image');

    let row: any;
    t.mock.method(AppDataSource, 'getRepository', () => ({
        findOne: async () => row,
        upsert: async (next: any) => { row = JSON.parse(JSON.stringify(next)); },
    }) as any);
    await new storage.TypeORMSessionStorage(true).write('synthetic-photo', ctx.session);
    ctx.session = (await new storage.TypeORMSessionStorage(true).read('synthetic-photo'))!;
    assert.equal(ctx.session.messageHistory[0].kind, 'image');
    (ctx as any).message = { reply_to_message: { message_id: 2, photo: [{}] } };
    assert.equal(resolveReplyTo(ctx).replyToContent, cat);
    assert.equal(resolveReplyTo(ctx).replyContext?.delivery, 'photo');
});

test('visual descriptions are excluded from delayed fact extraction and episodic evidence', async t => {
    const { ctx } = context();
    ctx.session.messageHistory = [
        { role: 'bot', content: cat, timestamp: new Date(), kind: 'image' },
        { role: 'bot', content: 'Вот картинка!', timestamp: new Date() },
        { role: 'user', content: 'Нарисуй кота', timestamp: new Date() },
    ];
    t.mock.method(episodes, 'createMemoryEpisode', async (_ctx: BotContext, messages: MessageHistory[]) => {
        assert.ok(messages.every(m => m.kind !== 'image' && !m.content.includes('золотой рыбкой')));
        return null;
    });
    t.mock.method(episodes, 'updateWorkingMemoryFromMessages', async () => undefined);
    let called = false;
    t.mock.method(FactExtractionService.prototype, 'extractFactsFromDialogue', async (pairs: DialoguePair[]) => {
        called = true;
        assert.ok(pairs.every(p => !p.botResponse.includes('золотой рыбкой')));
        return [];
    });
    assert.equal(await extractAndSaveFactsFromConversation(ctx), 0);
    assert.equal(called, true);
});

test('image-only history cannot become an episode or working-memory facts', async t => {
    const { ctx } = context();
    const images = [{ role: 'bot', content: selfie, timestamp: new Date(), kind: 'image' as const }];
    t.mock.method(completion, 'createChatCompletionForTask', async () => { assert.fail('image descriptions must not reach memory LLMs'); });
    assert.equal(await episodes.createMemoryEpisode(ctx, images), null);
    assert.equal(await episodes.updateWorkingMemoryFromMessages(ctx, images), undefined);
});

test('recurring runs persist both generated photos and browser photos without replacing live history', async t => {
    const persisted: any[] = [];
    const contexts: any[] = [];
    t.mock.method(storage.TypeORMSessionStorage.prototype, 'read', async () => session());
    t.mock.method(storage, 'appendPersistedHistory', async (...args: Parameters<typeof storage.appendPersistedHistory>) => { persisted.push(args); });
    t.mock.method(storage, 'appendPersistedSentMessageContext', async (_id: number, context: SentMessageContext) => { contexts.push(context); });
    t.mock.method(storage, 'mergePersistedBackgroundContinuation', async () => {});
    t.mock.method(RecurringTaskRepository, 'completeRun', async () => undefined as any);
    t.mock.method(RecurringTaskRepository, 'failRun', async () => { assert.fail('task must succeed'); });
    t.mock.method(orchestrator, 'processMessage', async (ctx: BotContext) => {
        await replyWithPhotoAndStore(ctx, new InputFile(png), 'На скриншоте я показала страницу с котом.');
        return { responseText: 'Готово!', imageGenerated: true, generatedImageUrl: 'https://maps.invalid/static', generatedImageDescription: cat };
    });
    let photoId = 0;
    const bot: any = { api: {
        sendPhoto: async () => ({ message_id: ++photoId }),
        sendMessage: async () => ({ message_id: 10 }),
        raw: { sendRichMessage: async () => ({ message_id: 10 }) },
    } };
    const task: RecurringTask = {
        id: 'synthetic-image-task', profile: 'test', title: 'Картинка', prompt: 'Нарисуй кота',
        chatId: 730001, userId: 730001, chatType: 'private', status: 'active',
        schedule: { type: 'interval', intervalMinutes: 60, anchorDate: '2026-10-27' },
        timezone: 'Europe/Moscow', nextRunAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
        consecutiveFailures: 0, runCount: 0,
    };
    await executeRecurringTask(bot, task);
    assert.equal(photoId, 2);
    assert.equal(persisted.filter(entry => entry[3]?.kind === 'image').length, 2);
    assert.equal(contexts.filter(entry => entry.delivery === 'photo').length, 2);
    assert.ok(persisted.some(entry => entry[2] === cat));
});
