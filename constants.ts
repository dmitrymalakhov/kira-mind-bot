// Время жизни кеша в миллисекундах (24 часа)
export const CONTACTS_CACHE_TTL = 24 * 60 * 60 * 1000;
export const MAX_MESSAGE_LENGTH = 4000;

// Таймзона пользователя для интерпретации времени напоминаний
export const USER_TIMEZONE = process.env.USER_TIMEZONE || "Europe/Moscow";

// Время, через которое отправленное напоминание считается просроченным
export const REMINDER_EXPIRY_TIME = Number(process.env.REMINDER_EXPIRY_TIME_MS || 4 * 60 * 60 * 1000);
