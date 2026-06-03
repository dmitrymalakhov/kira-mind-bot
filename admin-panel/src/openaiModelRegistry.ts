import registryJson from './openai-model-registry.json';
import type { ModelPreset } from './types';

export type OpenAIModelFieldKind = 'default_text' | 'text_override' | 'fixed';
export type OpenAIModelFieldResolution = 'system_default' | 'inherits_default_text';

export interface OpenAIModelFieldMeta {
  envKey: string;
  configKey: string;
  label: string;
  hint: string;
  placeholder: string;
  kind: OpenAIModelFieldKind;
  resolution: OpenAIModelFieldResolution;
  systemDefault: string;
}

interface RegistryShape {
  fields: OpenAIModelFieldMeta[];
  presets: ModelPreset[];
}

const registry = registryJson as RegistryShape;

export const OPENAI_MODEL_FIELDS = registry.fields;
export const OPENAI_MODEL_KEYS = OPENAI_MODEL_FIELDS.map((field) => field.envKey);
export const OPENAI_MODEL_FIELD_MAP = Object.fromEntries(
  OPENAI_MODEL_FIELDS.map((field) => [field.envKey, field])
) as Record<string, OpenAIModelFieldMeta>;
export const OPENAI_MODEL_PRESETS = registry.presets;

export function rawModelValueEquals(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

export function matchModelPreset(values: Record<string, string | null | undefined>): string | null {
  for (const preset of OPENAI_MODEL_PRESETS) {
    const matches = OPENAI_MODEL_KEYS.every((key) => rawModelValueEquals(values[key], preset.values[key]));
    if (matches) return preset.id;
  }

  return null;
}

export function resolveOpenAIFieldDraftState(
  field: OpenAIModelFieldMeta,
  values: Record<string, string | null | undefined>
) {
  const defaultTextField = OPENAI_MODEL_FIELD_MAP.OPENAI_MODEL_DEFAULT_TEXT;
  const defaultTextRaw = values[defaultTextField.envKey];
  const defaultTextValue =
    typeof defaultTextRaw === 'string' && defaultTextRaw.trim() !== ''
      ? defaultTextRaw
      : defaultTextField.systemDefault;

  const rawValue = values[field.envKey] ?? null;
  const explicitValue = typeof rawValue === 'string' && rawValue.trim() !== '' ? rawValue : null;
  let value = '';
  let source: 'env_file' | 'inherited_default_text' | 'system_default' = 'system_default';

  if (field.kind === 'default_text') {
    value = explicitValue || field.systemDefault;
    source = explicitValue ? 'env_file' : 'system_default';
  } else if (field.kind === 'fixed') {
    value = explicitValue || field.systemDefault;
    source = explicitValue ? 'env_file' : 'system_default';
  } else if (explicitValue) {
    value = explicitValue;
    source = 'env_file';
  } else if (rawValue === '') {
    value = defaultTextValue;
    source = 'inherited_default_text';
  } else if (field.resolution === 'system_default') {
    value = field.systemDefault;
    source = 'system_default';
  } else {
    value = defaultTextValue;
    source = 'inherited_default_text';
  }

  return { value, source };
}
