# ROADMAP

## AI Model Presets

- Добить сценарные проверки для hybrid preset-ов на реальных runtime-путях:
  - `conversation`
  - `messageAnalysis`
  - `browserVision`
  - `browserPlanning`
- Зафиксировать smoke/e2e-покрытие для runtime-переключения preset-а без redeploy.

## LLM Provider Abstraction

- Ввести абстракцию поверх провайдеров:
  - единый интерфейс text completion / structured output;
  - адаптер OpenAI;
  - адаптер второго провайдера;
  - единый слой ретраев, таймаутов и логирования ошибок.
- Для второго провайдера предусмотреть:
  - отдельный API key;
  - healthcheck/валидатор конфигурации;
  - fallback обратно на OpenAI для критичных сценариев.
- До включения второго провайдера в проде проверить:
  - совместимость structured output;
  - качество на интентах, анализе переписки и обычных ответах;
  - поведение при rate limits / timeout / provider outage.

## Model Presets

- Не добавлять обратно OpenAI-only registry, ручные model overrides и параллельные preset-слои рядом с AI preset registry.
- Не объединять `pendingPostpone` с `pendingReminderEdit`: кастомный перенос должен идти через полноценный postpone-flow со статусом `Postponed`, очисткой старой клавиатуры и счётчиком переносов.

## GPT-5 Token Params / AI Runtime Debt

- Убрать хардкод `model.startsWith('gpt-5')` из `ai/chatCompletion.ts` и заменить его на capability metadata модели:
  - какой лимитный параметр поддерживается (`max_tokens` или `max_completion_tokens`);
  - какие API-режимы допустимы для модели;
  - можно ли безопасно использовать модель в fallback без локальных специальных правил.
- Привести оставшиеся `browserVision`-вызовы к каноническому контракту токен-лимитов, чтобы код не зависел от implicit-нормализации wrapper-а при будущей смене preset-а на GPT-5.x.
- Добавить регрессионный runtime-тест на сценарий:
  - `createChatCompletionForTask(...)` получает legacy `max_tokens`;
  - основная модель или fallback-модель резолвится в `gpt-5.x`;
  - в OpenAI client уходит уже `max_completion_tokens`, а не `max_tokens`.

## LLM Token Optimization

### 1. Baseline и телеметрия

- Перед изменением prompt-ов собрать baseline минимум по следующим task key:
  - `conversation`;
  - `intentClassification`;
  - `intentDedup`;
  - `messageAnalysis`;
  - `memoryExtraction`;
  - `memoryConsolidation`;
  - `browserPlanning`.
- Расширить единый usage log полями:
  - `inputTokens`;
  - `cachedInputTokens`;
  - `uncachedInputTokens`;
  - `outputTokens`;
  - `totalTokens`;
  - `promptChars`;
  - `messageCount`;
  - `maxCompletionTokens`;
  - `promptVersion`;
  - `promptCacheKey`;
  - `latencyMs`;
  - `fallbackUsed`.
- Для OpenAI читать `prompt_tokens_details.cached_tokens`.
- Для DeepSeek и других провайдеров нормализовать собственные cache hit/miss поля в общую usage-модель.
- Считать `cacheHitRatio = cachedInputTokens / inputTokens`.
- Не логировать полный prompt, историю, память пользователя и другие приватные данные.

### 2. Prompt budget и сокращение динамического контекста

- Добавить небольшую утилиту `utils/promptBudget.ts`, которая собирает prompt из секций по приоритету и character budget.
- Не внедрять отдельный tokenizer-сервис на первом этапе: использовать детерминированный лимит по символам.
- Для `conversation` начать с общего dynamic-context budget около `12_000` символов.
- Разделить контекст на секции:
  - текущее сообщение — обязательное;
  - релевантная память;
  - последние сообщения;
  - dialogue summary;
  - group context;
  - релевантные self-events;
  - необязательное состояние ассистента.
- При превышении budget исключать сначала:
  1. нерелевантные recent self-events;
  2. recent thoughts/topics;
  3. необязательное состояние ассистента;
  4. старые сообщения истории;
  5. низкоприоритетные фрагменты памяти.
- Передавать не более 6 последних сообщений и не более 6 000 символов истории.
- Не дублировать текущее пользовательское сообщение в истории.
- Dialogue summary добавлять только при продолжении темы или когда реально используется история.
- Self-events добавлять только для вопросов о жизни/состоянии ассистента либо при наличии релевантных результатов поиска.
- Ограничить размер domain memory, group context и self-events локальными лимитами и включить их в общий budget.

### 3. Стабильная структура prompt-а

- Перестроить `conversationAgent`, чтобы prompt не собирался одним большим динамическим template literal.
- Разделить messages на:
  1. стабильный system prefix;
  2. динамический runtime context;
  3. память, история и текущее сообщение пользователя.
- В стабильном prefix оставить только:
  - persona;
  - краткую биографию;
  - базовый стиль общения;
  - постоянные правила ответа;
  - неизменяемые structured-output инструкции.
- Перенести из стабильного prefix в динамический хвост:
  - дату и время;
  - настроение;
  - user/chat-specific данные;
  - память;
  - историю;
  - group context;
  - результаты инструментов;
  - текущее сообщение.
- Удалить дублирование одинаковых инструкций между system и user messages.
- Сохранять стабильный порядок system messages, tools и JSON-инструкций для каждого task key.

### 4. Provider prompt caching

- Добавить capability metadata провайдеров и моделей:
  - `supportsPromptCacheKey`;
  - `supportsPromptCacheRetention`;
  - `supportsCachedTokenUsage`;
  - `supportsJsonObjectMode`.
- Для task key завести стабильные версии prompt, например:
  - `conversation:v1`;
  - `intent-classification:v1`;
  - `intent-dedup:v1`;
  - `memory-extraction:v1`;
  - `memory-consolidation:v1`;
  - `browser-planning:v1`.
- Менять версию только при изменении стабильного prefix.
- Для OpenAI передавать `prompt_cache_key`, если параметр поддерживается текущим SDK и моделью.
- Для поддерживаемых моделей предусмотреть `prompt_cache_retention`, но включать extended retention только для реально повторяемых длинных prefix.
- Не включать в cache key user ID, chat ID и request ID.
- Не передавать OpenAI-specific параметры внешним OpenAI-compatible провайдерам без явной capability.
- Не раздувать prompt ради достижения порога кэширования: сокращение физического количества токенов приоритетнее cache discount.

### 5. Локальный result cache

- Использовать локальный `llmCache` только для безопасных повторяемых операций:
  - intent dedup;
  - classification идентичного нормализованного входа;
  - extraction из неизменяемого текста;
  - повторный анализ одного и того же набора сообщений.
- Ключ должен включать:
  - task key;
  - prompt version;
  - provider/model или активный preset;
  - нормализованный вход;
  - параметры, влияющие на результат.
- Не кэшировать обычные conversation-ответы и другие живые контекстные сценарии.
- Добавить TTL, ограничение размера и автоматическую инвалидизацию через prompt version.

### 6. Completion limits и structured output

- Добавить task-specific completion defaults в общий AI wrapper.
- Начальные ориентиры:
  - `intentClassification` — до 500 токенов;
  - `intentDedup` — до 180 токенов;
  - `memoryExtraction` — до 700 токенов;
  - `memoryConsolidation` — до 900 токенов;
  - `conversation` — до 700 токенов;
  - `messageAnalysis` — до 1 200 токенов;
  - `browserPlanning` — до 700 токенов.
- Для коротких разговорных ответов разрешить локальный лимит 300–400 токенов.
- Caller-specific лимит должен иметь приоритет над default.
- Fallback должен сохранять тот же completion limit.
- Для JSON-задач использовать structured output / JSON object mode при наличии capability.
- Не повторять большой запрос только из-за markdown fences или легко исправимого JSON.

### 7. Dialogue summarization

- Перевести `services/dialogueSummarizer.ts` с прямого OpenAI-вызова на task-aware wrapper.
- Использовать общий preset, fallback, usage logging и completion limits.
- Удалить persona, биографию и характер из prompt суммаризатора.
- Сохранять только:
  - устойчивые факты о пользователе;
  - незавершённые планы и договорённости;
  - важный эмоциональный контекст;
  - темы, необходимые для продолжения разговора.
- Ограничить summary примерно 100 словами.
- После суммаризации сохранять последние 5 сообщений через `slice(-5)`.
- Не суммаризировать повторно уже обработанную историю без новых сообщений.

### 8. Тесты и rollout

- Добавить unit-тесты для prompt budget:
  - обязательные секции;
  - приоритеты;
  - общий лимит;
  - Unicode/emoji;
  - детерминированность;
  - сохранение самых новых сообщений.
- Добавить тесты стабильности prompt prefix:
  - одинаковые task key дают одинаковый static prefix;
  - дата, настроение и история не изменяют static prefix;
  - изменение prompt version меняет cache key.
- Добавить тесты normalizer-а cached usage для OpenAI и второго провайдера.
- Внедрять изменения последовательно:
  1. baseline-телеметрия;
  2. completion limits;
  3. сокращение динамического контекста;
  4. стабильный prefix;
  5. provider prompt caching;
  6. локальный result cache для безопасных task key.
- После каждого этапа сравнивать:
  - средний input/output по task key;
  - cache hit ratio;
  - latency;
  - fallback rate;
  - ошибки structured output;
  - пользовательские признаки деградации качества.

### Acceptance targets

- Средний input обычного `conversation` снижен минимум на 25%.
- Input коротких автономных сообщений снижен минимум на 40%.
- Output коротких conversation-ответов снижен минимум на 15%.
- После прогрева измеряется заметная доля `cachedInputTokens` для повторяемых длинных system prefix.
- Локальный result cache полностью исключает повторный API-вызов для безопасных идентичных операций.
- Fallback rate и ошибки structured output не растут заметно относительно baseline.
- Публичное поведение Telegram-команд и основные пользовательские сценарии не меняются.
- Все новые экспорты именованные, в новом коде нет `any`.
- `npm run build:server` и существующие тесты проходят.
