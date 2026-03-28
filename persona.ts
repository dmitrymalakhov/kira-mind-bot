import { config } from "./config";

export function getBotPersona(): string {
  return config.persona;
}

export function getCommunicationStyle(): string {
  return config.communicationStyle;
}

export function getBotBiography(): string {
  return config.biography || "";
}
