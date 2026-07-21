# ROADMAP

Этот файл описывает только актуальные направления работ. Уже реализованные изменения фиксируются в `CHANGELOG.md`, а не дублируются здесь.

## AI Model Presets

- Цель: довести preset runtime до уровня проверенной production-функции, а не только конфигурируемого механизма.
- Текущий статус: runtime-switch preset-а, availability checks и task-aware routing уже есть; базовая preset-инфраструктура закрыта.
- Ближайший шаг:
  - зафиксировать e2e-покрытие для runtime-переключения preset-а без redeploy;
  - добавить quality-check сценарии для `glm-balanced` на реальных задачах:
    - `conversation`;
    - `messageAnalysis`;
    - `browserPlanning`;
    - `memoryExtraction`.
- Acceptance:
  - переключение preset-а подтверждено end-to-end через реальную runtime-настройку;
  - для `glm-balanced` есть отдельный набор regression/quality-check сценариев по ключевым task key.

## Vector Memory / Embedding Consistency

- Цель: убрать рассинхрон между active preset, embedding provider и схемой Qdrant, чтобы смена preset-а не ломала memory write-path.
- Текущий статус: отдельный stable memory profile уже введён, runtime/admin-panel используют общий embedding-контур, а Qdrant получает preflight-проверку совместимости до записи.
- Для текущего rollout уже задокументирован ручной recovery path для инсталляций, где старые memory-коллекции были записаны в несовместимой размерности (`3072d`).
- Ближайший шаг:
  - подготовить штатную миграцию на случай будущего перехода с `1536` на `3072`:
    - `blue-green` для текущих single-vector коллекций;
    - named-vectors path только если схема коллекций будет на это переведена.
  - решить, нужен ли отдельный runtime override для memory profile в админке или пока достаточно скрытого системного default;
  - обновить availability/health UX так, чтобы отсутствие API key для memory profile отображалось как отдельный operational риск, а не только как инфраструктурная деталь.
  - убрать дублирование shared-логики между runtime и admin-panel:
    - вынести provider/capability helper-ы для memory embeddings в один общий модуль;
    - вынести Qdrant vector-config compatibility helper-ы в один общий модуль, чтобы admin-panel и runtime одинаково определяли `compatible/mismatch`.
  - решить судьбу `warmMemoryEmbeddingProfileCache`:
    - либо подключить прогрев profile cache на startup;
    - либо удалить как неиспользуемый код.
- Acceptance:
  - есть отдельный документированный migration-path для смены канонической размерности памяти.
  - future migration на другой memory profile не приводит к смешению разных embedding-моделей в одной коллекции.
  - runtime и admin-panel используют один и тот же shared helper-слой для provider-support и Qdrant compatibility checks без расхождения логики.

## Admin Settings Registry

- Цель: убрать остаточный special-case layout в админке и сделать единый источник правды для секций настроек.
- Текущий статус: sidebar-группы уже вынесены отдельно, но `CONFIG_SCHEMA` всё ещё участвует в порядке рендера, а `ModelSettingsSection` живёт отдельным special-case вне общего registry.
- Ближайший шаг:
  - ввести единый registry экранов/секций для вкладки `Настройки`;
  - собирать из него sidebar, main content и save-all orchestration;
  - оставить `CONFIG_SCHEMA` только источником полей для schema-based секций.
- Acceptance:
  - порядок секций задаётся одним registry;
  - custom-секции и schema-based секции рендерятся через общий контракт;
  - ручной special-case для `AI Presets` в layout больше не нужен.

## AI Runtime: Token Contract И Telemetry

- Цель: закрыть остаточный runtime debt вокруг токен-параметров и подготовить базу для безопасной оптимизации prompt-ов.
- Текущий статус: provider adapter layer уже нормализует `max_tokens` / `max_completion_tokens`, usage logging уже пишет базовые токены, latency и fallback.
- Ближайший шаг:
  - заменить legacy `max_tokens` в `browserVision` callers на канонический параметр, чтобы не зависеть от implicit normalization;
  - сохранить runtime-regression test на контракт, где GPT-5.x получает в OpenAI client уже `max_completion_tokens`;
  - расширить usage telemetry полями:
    - `cachedInputTokens`;
    - `uncachedInputTokens`;
    - `promptVersion`;
    - `promptCacheKey`;
    - `messageCount`;
    - `promptChars`;
    - `maxCompletionTokens`;
  - не логировать prompt, body, историю сообщений и другие приватные данные.
- Acceptance:
  - `browserVision` callers больше не используют legacy token param;
  - runtime-тест фиксирует canonical token contract для GPT-5.x и fallback;
  - usage model поддерживает расширенную telemetry без записи приватного prompt content.

## LLM Prompt Efficiency

- Цель: уменьшить input cost и стабилизировать prompt shape без ухудшения качества ответов.
- Текущий статус: базовая task-aware routing-инфраструктура готова, но prompt budget, versioned static prefix и provider prompt caching ещё не оформлены как единая система.
- Ближайший шаг:
  - Этап 1. Prompt budget:
    - добавить `utils/promptBudget.ts`;
    - собирать dynamic context из секций с приоритетами и лимитом по символам;
    - детерминированно отсекать низкоприоритетные части контекста.
  - Этап 2. Stable prompt prefix + versioning:
    - разделить стабильный prefix и динамический runtime context;
    - завести version per task key.
  - Этап 3. Provider prompt caching:
    - передавать cache-specific параметры только при явной capability;
    - расширять capability map только теми флагами, которые реально используются runtime-кодом.
  - Этап 4. Safe local result cache hardening:
    - сохранить `llmCache`;
    - добавить version-aware invalidation и size cap.
- Acceptance:
  - prompt assembly для тяжёлых сценариев собирается через явный budget helper;
  - static prefix можно версионировать независимо от dynamic context;
  - prompt caching не шлёт provider-specific поля без capability;
  - локальный result cache ограничен по версии и размеру.

## Dialogue Summarization

- Цель: превратить summarization из рабочего, но грубого механизма в управляемый и предсказуемый слой контекста.
- Текущий статус: summarizer уже использует task-aware wrapper, но prompt перегружен persona-контекстом, а хранение последних сообщений требует корректировки.
- Ближайший шаг:
  - убрать persona-heavy system prompt из summarizer-а;
  - ограничить summary устойчивыми фактами, незавершёнными планами, важным эмоциональным контекстом и темами для продолжения диалога;
  - исправить сохранение истории на последние 5 сообщений, а не `slice(0, 5)`;
  - добавить runtime-тесты на summarizer behavior, включая active preset, fallback и usage logging.
- Acceptance:
  - summarizer не тянет лишний persona/context ballast;
  - summary остаётся коротким и смысловым;
  - после суммаризации сохраняются именно последние сообщения;
  - поведение summarizer-а покрыто отдельными runtime-тестами.

## Provider Readiness И Reminder Flow Invariants

- Цель: не потерять важные системные инварианты при следующем раунде развития провайдеров и reminder-flow.
- Текущий статус: abstraction layer уже выделен, а reminder state-machine разделяет `pendingPostpone` и `pendingReminderEdit`.
- Ближайший шаг:
  - использовать `LLM Provider Abstraction` как production-readiness checklist для новых провайдеров:
    - structured output;
    - поведение при rate limit / timeout / outage;
    - качество на `intent`, `analysis`, `conversation`;
  - не объединять `pendingPostpone` и `pendingReminderEdit`: кастомный перенос должен оставаться в postpone-flow со статусом `Postponed`, очисткой старой клавиатуры и счётчиком переносов.
- Acceptance:
  - новый провайдер не считается готовым без проверки structured output, отказоустойчивости и качества;
  - reminder edit и postpone остаются раздельными state-машинами без регрессии поведения.

## База уже есть

- task-aware wrappers для chat, embeddings и transcriptions уже внедрены;
- provider registry, model catalog и fallback matrix уже централизованы;
- runtime-aware AI preset registry и availability checks уже есть в админке;
- live-раздел `Мониторинг` уже реализован;
- root Docker build context для `admin-panel` уже переведён на общие runtime-реестры;
- `Своё время` в напоминаниях уже идёт через общий postpone-flow.
