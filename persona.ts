import { config } from "./config";
import { selectPersonalityGenderText } from "./utils/personalityGender";

export function getBotPersona(): string {
  return config.persona;
}

export function getCommunicationStyle(): string {
  return config.communicationStyle;
}

export function getBotBiography(): string {
  return config.biography || "";
}

export function getBotGenderedText(feminine: string, masculine: string): string { return selectPersonalityGenderText(config.eventDescriptionGender, feminine, masculine); }
