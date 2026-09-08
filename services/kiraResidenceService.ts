import { createJsonChatCompletionForTask } from "../ai/chatCompletion";
import { config } from "../config";
import { getBotGenderedText } from "../persona";
import {
  buildKiraResidenceUpdate,
  extractDirectKiraRelocationCity,
  KiraResidence,
  KIRA_RESIDENCE_SETTING_KEY,
  looksLikeKiraRelocationRequest,
  normalizeKiraResidenceCity,
  parseKiraResidenceSetting,
} from "../utils/kiraResidence";
import { evolveKiraSelfState } from "../utils/kiraSelfMemory";
import { devLog } from "../utils";
import { getGlobalSetting, setGlobalSettingStrict } from "./botSettingsService";

interface RelocationAnalysis {
  shouldRelocate?: boolean;
  city?: string;
}

export interface KiraRelocationIntent {
  city: string;
}

export async function getKiraResidence(): Promise<KiraResidence> {
  const fallbackCity = config.currentCity;
  const raw = await getGlobalSetting(
    KIRA_RESIDENCE_SETTING_KEY,
    JSON.stringify({ city: fallbackCity, source: "default" }),
  );
  return parseKiraResidenceSetting(raw, fallbackCity);
}

export async function detectKiraRelocationIntent(
  message: string,
  currentResidence: KiraResidence,
): Promise<KiraRelocationIntent | null> {
  if (!looksLikeKiraRelocationRequest(message)) return null;

  let result: RelocationAnalysis | null = null;
  try {
    result = await createJsonChatCompletionForTask<RelocationAnalysis>("messageAnalysis", {
      messages: [
        {
          role: "system",
          content: [
            "Ты выделяешь только явную просьбу владельца персонажу сменить текущий город проживания.",
            "shouldRelocate=true, если владелец прямо просит, предлагает или устанавливает переезд персонажа в конкретный город: «переедь», «давай ты переедешь», «теперь живи», «хочу, чтобы ты жила». Ответь false для отрицания, обсуждения гипотезы, вопроса о плюсах города, переезда самого владельца или третьего лица.",
            "city верни в общепринятой форме и именительном падеже, без слова «город», адреса, района и пояснений.",
            "Верни только JSON: {\"shouldRelocate\": boolean, \"city\": string}.",
          ].join(" "),
        },
        {
          role: "user",
          content: `Сейчас персонаж живёт в городе «${currentResidence.city}». Реплика владельца: «${message.slice(0, 600)}»`,
        },
      ],
      temperature: 0.1,
      response_format: { type: "json_object" },
    });
  } catch (error) {
    devLog("[kira-relocation] intent analysis failed, using direct fallback:", error);
    const fallbackCity = extractDirectKiraRelocationCity(message);
    return fallbackCity ? { city: fallbackCity } : null;
  }

  if (!result) {
    const fallbackCity = extractDirectKiraRelocationCity(message);
    return fallbackCity ? { city: fallbackCity } : null;
  }
  if (!result.shouldRelocate) return null;
  const city = normalizeKiraResidenceCity(result.city);
  if (city) return { city };
  const fallbackCity = extractDirectKiraRelocationCity(message);
  return fallbackCity ? { city: fallbackCity } : null;
}

export async function relocateKira(
  nextCity: string,
  source: "conversation" | "admin" = "conversation",
): Promise<{ previous: KiraResidence; residence: KiraResidence; changed: boolean }> {
  const previous = await getKiraResidence();
  const update = buildKiraResidenceUpdate(previous, nextCity, source);
  if (!update.changed) {
    return { previous, ...update };
  }

  await setGlobalSettingStrict(KIRA_RESIDENCE_SETTING_KEY, JSON.stringify(update.residence));
  return { previous, ...update };
}

export async function rememberKiraRelocation(previousCity: string, nextCity: string, movedAt: string): Promise<void> {
  const year = new Date(movedAt).getUTCFullYear();
  const moved = getBotGenderedText("переехала", "переехал");
  const starting = getBotGenderedText("начала", "начал");

  await evolveKiraSelfState({
    thought: `${starting.charAt(0).toUpperCase()}${starting.slice(1)} новую городскую главу и постепенно обживаюсь в новом месте — ${nextCity}.`,
    topics: ["переезд", nextCity, "новый город"],
    biography: {
      timeline: [{
        title: `Переезд: ${nextCity}`,
        period: `с ${year} года`,
        place: nextCity,
        summary: `Я ${moved}: ${previousCity} → ${nextCity}. Это новое текущее место моей жизни, а прежний город остался частью предыдущей главы.`,
        lessons: ["новый город лучше узнавать постепенно, через повседневные маршруты и привычки"],
        emotionalTone: "любопытство и лёгкое волнение",
      }],
    },
    lifeArc: {
      title: `Новая жизнь: ${nextCity}`,
      summary: `После переезда ${previousCity} → ${nextCity} начинаю строить новую повседневную жизнь.`,
      currentStage: "первые недели после переезда",
      nextStep: "собрать несколько своих маршрутов, мест и бытовых привычек",
      emotionalTone: "любопытство и лёгкое волнение",
      topics: ["переезд", nextCity, "городская жизнь"],
    },
    personality: {
      activeArcs: [`Новая жизнь: ${nextCity}`],
      conversationImprints: [`Владелец поддержал переезд ${previousCity} → ${nextCity}`],
    },
    event: {
      description: `Я ${moved}: ${previousCity} → ${nextCity}. Теперь постепенно собираю здесь новую повседневную жизнь.`,
      type: "event",
      topics: ["переезд", nextCity, "новый город"],
      arc: `Новая жизнь: ${nextCity}`,
      source: "conversation",
    },
  });
}
