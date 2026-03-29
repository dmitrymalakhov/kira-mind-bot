import type { SectionDef } from './types';

export const CONFIG_SCHEMA: SectionDef[] = [
  {
    id: 'api',
    title: 'API Ключи',
    icon: '🔑',
    fields: [
      {
        key: 'OPENAI_API_KEY',
        label: 'OpenAI API Key',
        type: 'password',
        required: true,
        hint: 'Используется для ChatGPT, генерации изображений и распознавания речи',
      },
      {
        key: 'IDEOGRAM_API_KEY',
        label: 'Ideogram API Key',
        type: 'password',
        hint: 'Для генерации изображений через Ideogram',
      },
      {
        key: 'GOOGLE_MAPS_API_KEY',
        label: 'Google Maps API Key',
        type: 'password',
        hint: 'Для карт, маршрутов и геолокации',
      },
    ],
  },
  {
    id: 'bots',
    title: 'Telegram Боты',
    icon: '🤖',
    fields: [
      {
        key: 'KIRA_BOT_TOKEN',
        label: 'Kira Bot Token',
        type: 'password',
        required: true,
      },
      {
        key: 'KIRA_ALLOWED_USER_ID',
        label: 'Kira — Telegram User ID владельца',
        type: 'text',
        hint: 'Узнать свой ID: напиши @userinfobot в Telegram',
        required: true,
      },
      {
        key: 'SERGEY_BOT_TOKEN',
        label: 'Sergey Bot Token',
        type: 'password',
      },
      {
        key: 'SERGEY_ALLOWED_USER_ID',
        label: 'Sergey — Telegram User ID владельца',
        type: 'text',
        hint: 'Telegram ID пользователя для бота Sergey',
      },
    ],
  },
  {
    id: 'db',
    title: 'База данных',
    icon: '🗄️',
    fields: [
      { key: 'DB_HOST', label: 'Хост', type: 'text', placeholder: 'postgres' },
      { key: 'DB_PORT', label: 'Порт', type: 'number', placeholder: '5432' },
      { key: 'DB_USER', label: 'Пользователь', type: 'text', placeholder: 'postgres' },
      { key: 'DB_PASSWORD', label: 'Пароль', type: 'password', required: true },
      { key: 'DB_NAME', label: 'Имя базы данных', type: 'text', placeholder: 'KiraMind' },
    ],
  },
  {
    id: 'vector',
    title: 'Векторная память',
    icon: '🧠',
    fields: [
      {
        key: 'VECTOR_PROVIDER',
        label: 'Провайдер',
        type: 'text',
        placeholder: 'qdrant',
        hint: 'qdrant или pinecone',
      },
      { key: 'QDRANT_URL', label: 'Qdrant URL', type: 'text', placeholder: 'http://qdrant:6333' },
      {
        key: 'QDRANT_API_KEY',
        label: 'Qdrant API Key',
        type: 'password',
        hint: 'Оставьте пустым если без аутентификации',
      },
      {
        key: 'VECTOR_SEARCH_THRESHOLD',
        label: 'Порог релевантности (0–1)',
        type: 'text',
        placeholder: '0.7',
        hint: 'Минимальная схожесть для поиска в памяти. Меньше — больше результатов, но менее точные.',
      },
    ],
  },
  {
    id: 'telegram',
    title: 'Telegram Клиент',
    icon: '📱',
    fields: [
      {
        key: 'TELEGRAM_API_ID',
        label: 'API ID',
        type: 'text',
        hint: 'Получить на my.telegram.org',
      },
      { key: 'TELEGRAM_API_HASH', label: 'API Hash', type: 'password' },
      {
        key: 'TELEGRAM_SESSION_STRING',
        label: 'Session String',
        type: 'textarea',
        hint: 'Строка сессии авторизованного пользователя',
      },
    ],
  },
  {
    id: 'general',
    title: 'Общие настройки',
    icon: '⚙️',
    fields: [
      { key: 'USER_TIMEZONE', label: 'Временная зона', type: 'text', placeholder: 'Europe/Moscow' },
      {
        key: 'REMINDER_EXPIRY_TIME_MS',
        label: 'Срок хранения напоминаний',
        type: 'duration',
        hint: 'Через сколько времени выполненные напоминания удаляются',
      },
      {
        key: 'PROACTIVE_ONLY_PRIVATE_CHAT',
        label: 'Фоновые сообщения только в личный чат',
        type: 'toggle',
      },
      {
        key: 'GROUP_PUBLIC_MODE',
        label: 'Публичный режим в группах (отвечать всем)',
        type: 'toggle',
      },
    ],
  },
  {
    id: 'kira',
    title: 'Kira — Расписание',
    icon: '🌸',
    fields: [
      { key: 'KIRA_PROACTIVE_ENABLED', label: 'Проактивные сообщения включены', type: 'toggle' },
      {
        key: 'KIRA_PROACTIVE_INTERVAL_MS',
        label: 'Интервал проактивных сообщений',
        type: 'duration',
        hint: 'Как часто Кира пишет первой',
      },
      {
        key: 'KIRA_PROACTIVE_QUIET_HOURS_ENABLED',
        label: 'Тихие часы включены',
        type: 'toggle',
      },
      {
        key: 'KIRA_PROACTIVE_QUIET_HOUR_START',
        label: 'Начало тихих часов (0–23)',
        type: 'number',
        placeholder: '23',
      },
      {
        key: 'KIRA_PROACTIVE_QUIET_HOUR_END',
        label: 'Конец тихих часов (0–23)',
        type: 'number',
        placeholder: '8',
      },
      { key: 'DM_REPORT_ENABLED', label: 'Отчёты о входящих сообщениях включены', type: 'toggle' },
      {
        key: 'DM_REPORT_INTERVAL_MS',
        label: 'Интервал отчётов о сообщениях',
        type: 'duration',
        hint: 'Как часто Кира присылает дайджест непрочитанных',
      },
      { key: 'DM_REPORT_QUIET_HOURS_ENABLED', label: 'Тихие часы для отчётов', type: 'toggle' },
      { key: 'MEMORY_INSIGHT_ENABLED', label: 'Инсайты из памяти включены', type: 'toggle' },
      {
        key: 'MEMORY_INSIGHT_INTERVAL_MS',
        label: 'Интервал проверки памяти',
        type: 'duration',
        hint: 'Как часто бот проверяет память на наличие актуальных напоминаний и планов',
      },
    ],
  },
  {
    id: 'sergey',
    title: 'Sergey — Расписание',
    icon: '🧑‍💼',
    fields: [
      { key: 'SERGEY_PROACTIVE_ENABLED', label: 'Проактивные сообщения включены', type: 'toggle' },
      {
        key: 'SERGEY_PROACTIVE_INTERVAL_MS',
        label: 'Интервал проактивных сообщений',
        type: 'duration',
        hint: 'Как часто Сергей пишет первым',
      },
      {
        key: 'SERGEY_PROACTIVE_QUIET_HOURS_ENABLED',
        label: 'Тихие часы включены',
        type: 'toggle',
      },
      {
        key: 'SERGEY_PROACTIVE_QUIET_HOUR_START',
        label: 'Начало тихих часов (0–23)',
        type: 'number',
        placeholder: '23',
      },
      {
        key: 'SERGEY_PROACTIVE_QUIET_HOUR_END',
        label: 'Конец тихих часов (0–23)',
        type: 'number',
        placeholder: '8',
      },
    ],
  },
];
