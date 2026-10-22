'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SETTING_KEY = 'IMAGE_GENERATION_SETTINGS';
const MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'];
const SIZES = ['1024x1024', '1024x1536', '1536x1024'];
const QUALITIES = ['low', 'medium', 'high'];
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const IDENTITY_INSTRUCTION = 'The attached reference depicts the assistant character. Whenever this character appears, preserve the exact same facial identity, apparent adult age, body build, height proportions, skin tone, hair and distinctive features. The reference is the identity source of truth. Change only pose, expression, clothes, lighting and scene as requested. Do not copy the reference background or framing. Do not substitute a different person. Other people must remain distinct. Do not add this character to scenes that do not call for them.';

function parseImageSettings(raw) {
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.enabled !== 'boolean' || !MODELS.includes(value.model) ||
      !SIZES.includes(value.size) || !QUALITIES.includes(value.quality)) {
    throw new Error('Укажите поддерживаемую модель GPT Image, размер и качество');
  }
  return { enabled: value.enabled, model: value.model, size: value.size, quality: value.quality };
}
function defaultImageSettings(env = process.env) {
  return parseImageSettings({ enabled: env.OPENAI_IMAGE_ENABLED !== 'false',
    model: env.OPENAI_IMAGE_MODEL || MODELS[0], size: env.OPENAI_IMAGE_SIZE || '1024x1536',
    quality: env.OPENAI_IMAGE_QUALITY || 'medium' });
}
function imageConnection(env = process.env) {
  const apiKey = env.OPENAI_IMAGE_API_KEY || env.OPENAI_API_KEY;
  const baseURL = String(env.OPENAI_IMAGE_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const url = new URL(baseURL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Некорректный OpenAI Image Base URL');
  }
  if (!apiKey) throw new Error('Не настроен ключ OpenAI для изображений');
  return { apiKey, baseURL };
}
function imageMime(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) throw new Error('Загрузите изображение PNG, JPEG или WebP');
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0) return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255 && data[data.length - 2] === 255 && data[data.length - 1] === 217) return 'image/jpeg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) + 8 === data.length) return 'image/webp';
  throw new Error('Загрузите изображение PNG, JPEG или WebP');
}
function referencePath(runtimeDir) { return path.join(runtimeDir, 'image-generation', 'character-reference.image'); }
async function readReference(runtimeDir) {
  let data;
  try { data = await fs.readFile(referencePath(runtimeDir)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (data.length > MAX_REFERENCE_BYTES) throw new Error('Референс превышает 10 MiB');
  return { data, mime: imageMime(data), sha256: crypto.createHash('sha256').update(data).digest('hex') };
}
async function saveReference(runtimeDir, data) {
  if (!data.length || data.length > MAX_REFERENCE_BYTES) throw new Error('Референс должен быть не больше 10 MiB');
  imageMime(data);
  const target = referencePath(runtimeDir);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, target); }
  finally { await fs.unlink(temp).catch(() => {}); }
}
async function deleteReference(runtimeDir) {
  await fs.unlink(referencePath(runtimeDir)).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
function buildImageRequest(settings, prompt, reference) {
  const body = { model: settings.model, prompt: reference ? `${IDENTITY_INSTRUCTION}\n\nScene request:\n${prompt}` : prompt,
    n: 1, size: settings.size, quality: settings.quality, output_format: 'jpeg', output_compression: 90 };
  if (reference && ['gpt-image-1', 'gpt-image-1.5'].includes(settings.model)) body.input_fidelity = 'high';
  return body;
}
// Errors deliberately exclude response bodies, prompts, credentials and reference bytes.
async function requestImage({ settings, prompt, reference, env = process.env, fetchImpl = globalThis.fetch }) {
  if (!settings.enabled) throw new Error('Генерация изображений выключена в настройках');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw new Error('Некорректный запрос изображения');
  const { apiKey, baseURL } = imageConnection(env);
  const body = buildImageRequest(settings, prompt, reference);
  const headers = { Authorization: `Bearer ${apiKey}` };
  let payload;
  if (reference) {
    payload = new FormData();
    for (const [key, value] of Object.entries(body)) payload.set(key, String(value));
    payload.set('image', new Blob([reference.data], { type: reference.mime }), `character-reference.${reference.mime === 'image/png' ? 'png' : reference.mime === 'image/jpeg' ? 'jpg' : 'webp'}`);
  } else { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let response;
  try { response = await fetchImpl(`${baseURL}/images/${reference ? 'edits' : 'generations'}`, {
    method: 'POST', headers, body: payload, signal: AbortSignal.timeout(240000), redirect: 'error',
  }); } catch { throw new Error('Нет ответа от OpenAI Image через настроенный gateway'); }
  if (!response.ok) throw new Error(`OpenAI Image: HTTP ${response.status}`);
  const result = await response.json();
  const encoded = result.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || !encoded || encoded.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) {
    throw new Error('OpenAI Image не вернул изображение в base64');
  }
  const data = Buffer.from(encoded, 'base64');
  return { data, mime: imageMime(data), usage: result.usage };
}
module.exports = { SETTING_KEY, MODELS, SIZES, QUALITIES, MAX_REFERENCE_BYTES, IDENTITY_INSTRUCTION,
  parseImageSettings, defaultImageSettings, imageConnection, imageMime, readReference, saveReference,
  deleteReference, buildImageRequest, requestImage };
