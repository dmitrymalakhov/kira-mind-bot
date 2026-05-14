import { MessageHistory, BotContext } from "../types";
import { ProcessingResult } from "../orchestrator";
import { formatSelfStudyReport, runKiraSelfStudy } from "../services/selfStudyService";

export async function selfStudyAgent(
  ctx: BotContext,
  message: string,
  messageHistory: MessageHistory[] = [],
  memoryContext: string = ""
): Promise<ProcessingResult> {
  if (ctx.chat?.type !== "private") {
    return {
      responseText: "Самоизучение лучше запускать в личном чате: там я могу безопасно учитывать память, статистику и недавний контекст.",
    };
  }

  const report = await runKiraSelfStudy({
    triggerMessage: message,
    messageHistory,
    memoryContext,
  });

  return {
    responseText: formatSelfStudyReport(report),
  };
}
