import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InputFile } from 'grammy';
import { defaultImageSettings, parseImageSettings, imageConnection, requestImage, saveReference, readReference, deleteReference, buildImageRequest } from '../ai/imageGeneration';
import { parseImagePromptPlan } from '../utils/imagePromptPlan';
import { generatedImageInput } from '../utils/generatedImage';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j/NkAAAAASUVORK5CYII=', 'base64');
const env = { OPENAI_API_KEY: 'synthetic-key', OPENAI_BASE_URL: 'http://gateway.invalid/v1' };
const settings = defaultImageSettings({});

test('image settings are independent from text presets and connection inherits the gateway', () => {
  assert.equal(settings.model, 'gpt-image-2.5-sunburst');
  assert.deepEqual(imageConnection(env), { apiKey: env.OPENAI_API_KEY, baseURL: env.OPENAI_BASE_URL });
  assert.deepEqual(imageConnection({ ...env, OPENAI_IMAGE_API_KEY: 'synthetic-image-key', OPENAI_IMAGE_BASE_URL: 'https://images.invalid/v1/' }), { apiKey: 'synthetic-image-key', baseURL: 'https://images.invalid/v1' });
  const credentialUrl = new URL('https://gateway.invalid/v1');
  credentialUrl.username = 'synthetic-user'; credentialUrl.password = 'synthetic-password';
  assert.throws(() => imageConnection({ OPENAI_API_KEY: 'synthetic-key', OPENAI_BASE_URL: credentialUrl.href }));
  for (const value of [{ ...settings, model: 'local-text' }, { ...settings, quality: 'unbounded' }, { ...settings, enabled: 'true' }]) assert.throws(() => parseImageSettings(value));
});

test('one planning response carries both the scene and character presence; ambiguous output fails closed', () => {
  assert.deepEqual(parseImagePromptPlan('{"prompt":"A cat on a sofa", "includesCharacter":false}'), { prompt: 'A cat on a sofa', includesCharacter: false });
  assert.equal(parseImagePromptPlan('```json\n{"prompt":"The assistant with a cat", "includesCharacter":true}\n```').includesCharacter, true);
  assert.throws(() => parseImagePromptPlan('{"prompt":"A portrait"}'));
  assert.throws(() => parseImagePromptPlan('{"prompt":"", "includesCharacter":true}'));
});

test('generic image uses generations with base64 output and never sends a character reference', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls++;
    assert.equal(url, 'http://gateway.invalid/v1/images/generations');
    const body = JSON.parse(init.body as string);
    assert.equal(body.prompt, 'A cat on a sofa');
    assert.equal(body.model, settings.model);
    assert.equal(body.n, 1);
    assert.equal(body.output_format, 'jpeg');
    assert.equal(body.input_fidelity, undefined);
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  }) as typeof fetch;
  assert.deepEqual((await requestImage({ settings, prompt: 'A cat on a sofa', env, fetchImpl })).data, png);
  assert.equal(calls, 1);
});

test('character images upload the actual reference bytes to edits and keep face, age and proportions', async () => {
  const reference = { data: png, mime: 'image/png' };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    assert.equal(url, 'http://gateway.invalid/v1/images/edits');
    const body = init.body as FormData;
    assert.match(body.get('prompt') as string, /facial identity.*adult age.*body build.*proportions/);
    assert.equal(body.get('input_fidelity'), null);
    const file = body.get('image') as Blob;
    assert.equal(file.type, 'image/png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  }) as typeof fetch;
  await requestImage({ settings, prompt: 'The assistant and another adult at a cafe', reference, env, fetchImpl });
  assert.equal(buildImageRequest({ ...settings, model: 'gpt-image-1.5' }, 'scene', reference).input_fidelity, 'high');
  assert.equal(buildImageRequest({ ...settings, model: 'gpt-image-2' }, 'scene', reference).input_fidelity, undefined);
});

test('failed image requests do not retry, change provider, download URLs or expose response bodies', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response('synthetic-private-body', { status: 403 }); }) as typeof fetch;
  await assert.rejects(requestImage({ settings, prompt: 'scene', env, fetchImpl }), /^Error: OpenAI Image: HTTP 403$/);
  assert.equal(calls, 1);
  await assert.rejects(requestImage({ settings: { ...settings, enabled: false }, prompt: 'scene', env, fetchImpl }));
  assert.equal(calls, 1);
  await assert.rejects(requestImage({ settings, prompt: 'scene', env,
    fetchImpl: (async () => new Response(JSON.stringify({ data: [{ url: 'http://private.invalid/file' }] }))) as typeof fetch }), /base64/);
});

test('canonical reference is private, atomic and refreshes immediately; invalid replacement preserves it', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-image-reference-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(await readReference(directory, null), null);
  await saveReference(directory, png);
  assert.deepEqual((await readReference(directory))?.data, png);
  const target = path.join(directory, 'image-generation', 'character-reference.image');
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  await assert.rejects(saveReference(directory, Buffer.from('<svg>not an image</svg>')));
  assert.deepEqual((await readReference(directory))?.data, png);
  await deleteReference(directory);
  assert.equal(await readReference(directory, null), null);
});

test('a fresh install has the product reference; private overrides win and reset restores the exact default', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-default-reference-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const initial = await readReference(directory);
  assert.ok(initial);
  assert.equal(initial.source, 'default');
  await saveReference(directory, png);
  const custom = await readReference(directory);
  assert.equal(custom?.source, 'custom');
  assert.deepEqual(custom?.data, png);
  await deleteReference(directory);
  const restored = await readReference(directory);
  assert.equal(restored?.source, 'default');
  assert.equal(restored?.sha256, initial.sha256);
  assert.deepEqual(restored?.data, initial.data);
  assert.equal(await readReference(directory, path.join(directory, 'missing-default.png')), null);
});

test('runtime requires a reference for character scenes and transports generated bytes as an InputFile', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kira-image-service-'));
  const previous = process.env.KIRA_RUNTIME_DATA_DIR;
  const previousFetch = globalThis.fetch;
  process.env.KIRA_RUNTIME_DATA_DIR = directory;
  const service = require('../services/imageGenerationService');
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); }) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previous === undefined) delete process.env.KIRA_RUNTIME_DATA_DIR; else process.env.KIRA_RUNTIME_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const imageModule = require('../ai/imageGeneration');
  const originalReader = imageModule.readReference;
  imageModule.readReference = async () => null;
  try { await assert.rejects(service.generateOpenAiImage('A character portrait', true), service.CharacterReferenceRequiredError); }
  finally { imageModule.readReference = originalReader; }
  assert.equal(calls, 0);
  await saveReference(directory, png);
  const filename = await service.generateOpenAiImage('The character outside', true);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readFile(filename), png);
  const input = generatedImageInput({ generatedImagePath: filename });
  assert.ok(input instanceof InputFile);
  const raw = await input.toRaw();
  const chunks: Buffer[] = [];
  if (raw instanceof Uint8Array) chunks.push(Buffer.from(raw));
  else for await (const chunk of raw) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), png);
  await deleteReference(directory);
  await service.generateOpenAiImage('The same character using the product reference', true);
  assert.equal(calls, 2);
  assert.equal(generatedImageInput({ generatedImageUrl: 'https://maps.invalid/static' }), 'https://maps.invalid/static');
});
