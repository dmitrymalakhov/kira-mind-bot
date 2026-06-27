import { getRecentKiraSelfEvents, KiraSelfState, formatKiraPersonalitySnapshot } from "./kiraSelfMemory";

type SelfEventList = Awaited<ReturnType<typeof getRecentKiraSelfEvents>>;

export function buildCorruptedSelfMemoryReply(characterName: string): string {
  return `Сейчас моя внутренняя память о себе недоступна, поэтому я не хочу придумывать детали о жизни ${characterName}. Если восстановить self-memory, я смогу ответить точнее.`;
}

export function buildAssistantLifeContext(
  selfState: KiraSelfState | null,
  recentSelfEvents: SelfEventList,
  relevantSelfEvents: SelfEventList,
  currentDate: Date,
): string {
  if (!selfState) {
    return "";
  }

  function relativeTimeLabel(dateStr: string): string {
    const now = currentDate;
    const eventDate = new Date(dateStr);
    const diffMs = now.getTime() - eventDate.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffHours < 3) return "только что";
    if (diffHours < 12) return "сегодня утром/днём";
    if (diffDays < 1) return "сегодня";
    if (diffDays === 1) return "вчера";
    if (diffDays <= 3) return `${diffDays} дня назад`;
    return `${diffDays} дней назад`;
  }

  const personalitySnapshot = formatKiraPersonalitySnapshot(selfState);
  const formatSelfEvent = (event: SelfEventList[number], idx: number): string => {
    const arc = event.arc ? ` Линия: ${event.arc}.` : "";
    return `${idx + 1}. [${relativeTimeLabel(event.date)}] (${event.type}) ${event.description}${arc}`;
  };

  return `\nСамовосприятие и развивающаяся личность:\n${personalitySnapshot}` +
    `\n\nТвоя жизнь / недавние события:\n${recentSelfEvents.map(formatSelfEvent).join("\n") || "Пока нет событий."}` +
    `\n\nРелевантные события по текущему запросу:\n${relevantSelfEvents.map(formatSelfEvent).join("\n") || "Не найдено."}` +
    `\n\nТекущее состояние:\nНастроение: ${selfState.mood}\nНедавние мысли: ${selfState.recentThoughts.join("; ") || "нет"}\nНедавние темы: ${selfState.recentTopics.join(", ") || "нет"}`;
}
