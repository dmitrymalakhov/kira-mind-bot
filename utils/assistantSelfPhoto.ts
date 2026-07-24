const DIRECT_SELFIE_RE =
  /(?:^|[\s,.!?;:])(?:сфоткайся|сфотографируйся|сними\s+себя|сделай\s+(?:мне\s+)?селфи|take\s+(?:a\s+)?selfie)(?=$|[\s,.!?;:])/iu;
const PHOTO_WORD_RE =
  /(?:^|[\s,.!?;:])(?:фото(?:графи[юяи])?|фотк[ауие]|селфи|снимок|photo|selfie|picture|pic)(?=$|[\s,.!?;:])/iu;
const PHOTO_REQUEST_RE =
  /(?:^|[\s,.!?;:])(?:скинь|пришли|отправь|покажи|дай|сделай|покажись|send|show|take)(?=$|[\s,.!?;:])/iu;
const ASSISTANT_SELF_REFERENCE_RE =
  /(?:где\s+ты|как\s+ты(?:\s+сейчас)?\s+выглядишь|(?:^|[\s,.!?;:])(?:ты|тебя|себя|сво[еёюйя]|тво[еёюйя])(?=$|[\s,.!?;:]))/iu;
const SHOW_APPEARANCE_RE =
  /(?:покажи|покажись|show)[\s\S]{0,50}(?:как\s+ты(?:\s+сейчас)?\s+выглядишь|себя|yourself)/iu;

export function isAssistantSelfPhotoRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (DIRECT_SELFIE_RE.test(text) || SHOW_APPEARANCE_RE.test(text)) return true;
  return PHOTO_REQUEST_RE.test(text) &&
    PHOTO_WORD_RE.test(text) &&
    ASSISTANT_SELF_REFERENCE_RE.test(text);
}

export interface AssistantSelfPhotoPromptInput {
  message: string;
  characterName: string;
  characterGender: "женский" | "мужской";
  persona: string;
  biography: string;
  selfLifeContext: string;
  formattedDateTime: string;
}

export function buildAssistantSelfPhotoPromptBrief(
  input: AssistantSelfPhotoPromptInput,
): string {
  const genderLabel = input.characterGender === "мужской" ? "adult man" : "adult woman";
  return `
The user asked ${input.characterName} to send a current personal photo:
"${input.message}"

Create an English image-generation prompt for a believable casual smartphone selfie of ${input.characterName}, an ${genderLabel}.
This is a visual continuation of the same person's biography and current life, not a generic character portrait.

Current date and time:
${input.formattedDateTime}

Stable persona:
${input.persona}

Stable biography and physical appearance:
${input.biography}

Current self-memory, mood, recent events and life context:
${input.selfLifeContext || "No recent self-memory event is available. Use only the stable biography and a modest everyday setting appropriate to the current time."}

Requirements:
- Preserve every explicit physical trait from the biography. Do not replace hair, facial features, age range, build or grooming with a random look.
- Derive the setting, activity, clothes, mood and lighting from the most recent relevant self-memory and the current time.
- If no exact current place is stored, choose a modest everyday setting consistent with the biography; do not invent a trip, event, workplace or landmark.
- Make it feel like a spontaneous phone selfie sent during an ongoing private chat: natural perspective, ordinary framing, plausible skin texture and small photographic imperfections.
- Keep the person fully clothed and the scene non-sexual.
- Show one adult person. No collage, split screen, captions, UI, logos, watermarks or written text.
- Do not depict an AI, robot, avatar, virtual interface, fantasy setting or professional studio shoot.
- Respect any concrete visual detail in the user's request unless it contradicts stable identity or current self-memory.

Return only the final English image-generation prompt, without quotes, markdown or explanation.
`.trim();
}
