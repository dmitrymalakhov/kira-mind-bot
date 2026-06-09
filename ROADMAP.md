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
