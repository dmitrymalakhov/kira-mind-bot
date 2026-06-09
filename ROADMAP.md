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
- Если legacy `pendingPostpone` больше не нужен после унификации с `pendingReminderEdit`, удалить его отдельным cleanup-изменением вместе с типами и fallback-веткой.
