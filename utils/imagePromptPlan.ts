export function characterImagePlanningInstruction(characterName: string): string {
    return `Return one JSON object: {"prompt":"final English scene prompt", "includesCharacter":true|false}.
includesCharacter is true ONLY when the assistant character ${characterName} is depicted in the resulting scene (selfie, yourself, a photo of the assistant, or the named character with other people). Merely addressing the assistant by name does not put them in the picture. Requests to exclude the character or draw unrelated subjects must be false. Interpret the actual scene semantically, including pronouns and conversation context. When present preserve the reference identity, apparent adult age, face and body proportions; never invent or redesign those traits. The reference image is supplied separately by the image service. Do not add the character to unrelated scenes. Do not include analysis or markdown.`;
}

export function parseImagePromptPlan(raw: unknown): { prompt: string; includesCharacter: boolean } {
    if (typeof raw !== 'string') throw new Error('План изображения не получен');
    const parsed = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''));
    if (!parsed || typeof parsed.prompt !== 'string' || !parsed.prompt.trim() || parsed.prompt.length > 14000 ||
        typeof parsed.includesCharacter !== 'boolean') throw new Error('Некорректный план изображения');
    return { prompt: parsed.prompt.trim(), includesCharacter: parsed.includesCharacter };
}
