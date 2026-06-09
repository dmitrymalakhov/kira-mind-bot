# ROADMAP

## AI Model Presets

- Единый источник истины для модельной конфигурации — provider-aware AI preset registry (`ai-model-presets.json`).
- Не возвращать отдельные OpenAI-only registry/пресеты: это создаёт дублирование, скрытые overrides и риск незаметного расхода токенов.
- Runtime-переключение активного preset выполняется через админку и хранится в БД, чтобы изменения применялись без redeploy.
- Новые LLM-вызовы должны идти через task-aware wrapper (`createChatCompletionForTask` / `createResponseForTask`), а не напрямую через вручную выбранные модели.

## LLM Provider Abstraction

- Поддержать второй текстовый LLM-провайдер, не ломая текущий OpenAI-only путь.
- Вынести выбор не только модели, но и провайдера на уровень конфигурации задач:
  - `intentClassification`
  - `intentDedup`
  - `conversation`
  - `messageAnalysis`
  - `memoryExtraction`
  - `memoryConsolidation`
  - `webSearchReasoning`
  - `browserPlanning`
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

- Поддерживать единый список preset-ов:
  - `GPT Max`
  - `GPT Balanced`
  - `GPT Lean`
  - `Hybrid DeepSeek + GPT`
  - `Hybrid Gemini + GPT`
- Для каждого preset хранить полный task-aware mapping `provider + model`, описание и fallback-политику.
- UI админки должен показывать активный runtime preset, понятный человекочитаемый источник значения и перечень моделей по задачам.
- Не добавлять отдельные OpenAI-only пресеты, ручные model overrides и второй registry рядом с AI preset registry.
