# Changelog

## 2026-07-09

- Общий rich-рендер структурных сообщений сделан компактнее: вместо тяжёлых блочных тегов (`p`, `h*`, `ul`, `details`, `hr`) основные форматированные сообщения теперь рендерятся в более плоский HTML с одиночными переносами строк, чтобы в Telegram было меньше лишнего вертикального воздуха.
- DM-отчёт о новых личных сообщениях сделан заметно компактнее: имя, мета и новые реплики по контакту теперь рендерятся одним плотным блоком без лишнего вертикального воздуха между абзацами и списком.
- Исправлено время в DM-отчёте и тихих часах: формат сообщений теперь всегда использует `USER_TIMEZONE`, а не локальную таймзону процесса/сервера.

## 2026-07-07

- DM-отчёт о новых личных сообщениях больше не прячет диалоги в сворачиваемые секции: теперь это один плоский дайджест, где по каждому человеку сразу видны имя, мета и все новые сообщения в хронологическом порядке.
- Исправлен старт `admin-panel` в Docker runtime-образе: в production stage теперь копируется `memoryEmbeddingProfileRegistry.js`, без которого контейнер падал с `Cannot find module './memoryEmbeddingProfileRegistry'` сразу после запуска.
- Memory embeddings вынесены в отдельный стабильный profile `stable-1536` (`openai:text-embedding-3-small`, `1536`, `Cosine`), который больше не зависит от `AI_MODEL_PRESET`: переключение conversational preset не должно менять memory write/read path, смешивать разные embedding-модели в одной коллекции или ломать Qdrant по размерности.
- Runtime и admin-panel теперь используют один и тот же memory embedding profile и валидируют совместимость существующих Qdrant-коллекций до записи; в админке добаван read-only статус memory profile и совместимости памяти с текущей схемой Qdrant.
- Gemini embeddings для runtime memory-path теперь принудительно запрашиваются в размерности `1536` через `output_dimensionality`, чтобы `gemini-full` и будущие Gemini-based embedding presets оставались совместимы с текущими Qdrant-коллекциями и не падали на `expected dim: 1536, got 3072`.
- В README добавлена короткая пометка: если после обновления Qdrant-коллекция памяти окажется несовместимой по размерности, её нужно пересоздать или вручную мигрировать, а не пытаться чинить переключением `AI_MODEL_PRESET`.
- Структурные и системные сообщения бота переведены на rich formatting (Bot API 10.1 `sendRichMessage` / `editMessageText({rich_message}`) с автоматическим фолбэком на HTML): утренний дайджест, DM-report, Inbox Guardian, уведомления об важных сообщениях в группах, рефлексия, напоминания по итогам переговоров, `/chats`, `/contacts`, `/memory_history`, `/memory_reflection_cleanup`, карточки/список/пикер напоминаний и меню групп чатов теперь используют таблицы, заголовки, сворачиваемые секции и чек-листы.
- Добавлен общий helper-слой `utils/richMessage.ts` (DSL блоков, экранирование пользовательских данных, рендер rich-HTML и fallback-HTML, `sendStructured`/`editStructured`/`editStructuredCtx` с фолбэком и кешем несовместимости); аварийный рубильник — `RICH_MESSAGES_ENABLED` (по умолчанию `true`).
- Устранён класс багов с поломкой markdown на спецсимволах: имена контактов, тексты напоминаний, названия чатов и факты памяти теперь экранируются во всех структурных сообщениях.
- `grammy` обновлена до `^1.44.0`, `@grammyjs/types` до `3.28.0` для доступа к типам `InputRichMessage` и методам Bot API 10.1.
- Свободные ответы LLM в диалоге намеренно оставлены plain text — бот сохраняет «человеческий» стиль общения.
- Smoke-тесты rich-форматирования добавлены в `test:ts:interaction` (`testRichMessage`): проверка рендера всех блоков, экранирования, эмуляции таблиц в fallback, разбиения длинных сообщений и фолбэка при ошибке API.
- `make logs-no-db` снова работает на macOS: `server-deploy.sh` больше не зависит от `mapfile`, поэтому просмотр логов без `postgres` и `qdrant` совместим с системным Bash 3.2.
- Из `docker-compose.server.yml` удалён устаревший атрибут `version`, чтобы Docker Compose не печатал лишнее предупреждение при server-операциях.
- Исправлена Docker-сборка `admin-panel`: в builder stage добавлено копирование `ai/`, чтобы TypeScript-билд находил модуль `ai/presetSummary`, импортируемый фронтендом (`../../../ai/presetSummary`).
- В runtime-образ `admin-panel` теперь копируются все `ai/*.json` единым glob вместо точечного списка: ранее отсутствовал `provider-capability-overrides.json`, из-за чего контейнер падал на старте с `Cannot find module` в `presetAvailability.js`.

## 2026-07-06

- Исправлена ошибочная атрибуция чужих событий к владельцу в фоновой рефлексии/study-chat: детерминированный фильтр в `deterministicQualityGate` понижает confidence ниже порога сохранения, если факт с `subject:user` описывает событие (ДР/встреча/игра/отпуск и т.п.) без first-person маркера владельца, но с contact/invite-маркером; промпты `buildUserFactsPrompt`/`buildContactFactsPrompt`/`buildCriticPrompt` усилены явным правилом атрибуции событий.
- Консолидация памяти (`memory-schema`/`memory-chapter`/`sleep_open_loop_index`/`sleep_uncertainty_index`) больше не включает в синтез «о владельце» источники про контакты: записи с `subject:contact` или тегами `source_contact:*`/`source_chat:*` исключаются единым helper-ом, чтобы удалённый ложный факт не пересобирался заново.
- Оба фикса покрыты отдельными TS regression-тестами в `test:ts:memory` (`testFactAttributionFilter`, `testUserSynthesisFilter`).
- AI preset-ы получили честные названия по реальному LLM-mapping, а матрица выбора очищена от почти дублирующих Gemini-вариантов; админка теперь показывает LLM/service composition, характеристики, diff по задачам и подтверждение перед сменой критичных маршрутов.
- AI usage logging расширен связанной `traceId`-цепочкой для primary/retry/fallback, классификацией provider errors и отдельным отображением восстановленных Gemini 503 против пользовательских ошибок в админской аналитике.
- `gemini-full` переведён на настоящий Gemini-only контур, включая `gemini-embedding-2` для embeddings и Gemini Files + Interactions API для транскрибации; `glm-full` переведён на `glm-asr-2512` для transcription и теперь честно оставляет OpenAI только на embeddings.
- Для true-full preset-ов отключён скрытый cross-provider fallback на OpenAI при runtime-ошибках, а Gemini `webSearchReasoning` через Interactions API теперь передаёт `system_instruction`, `tools` и `generation_config`, чтобы preset не терял поисковые параметры.
- JSON parse fallback теперь тоже уважает true-full policy без скрытого ухода в GPT/OpenAI, а `embedding` и `transcription` получили тот же single-retry flow и trace-логирование, что и остальные AI-вызовы.
- Логические JSON-провалы теперь пишутся в `ai_usage_logs` как `invalid_response`, а admin analytics считает outcome по финальному attempt цепочки, так что user-visible failure больше не маскируется transport-success логом.
- `kiraSelfMemory` и связанные self-evolution/self-study патчи стали устойчивыми к кривым LLM-спискам: строка вместо массива нормализуется мягко, plain-object игнорируется локально, а `timeline`/`lessons` больше не валят proactive/self-study циклы с `map is not a function`.
- Проактивные подсказки из памяти теперь получают provenance evidence с источником/чатом, временем и открытыми линиями, но без технических `sourceMessageIds` в LLM-prompt, чтобы бот мог объяснять, откуда взял контекст, или отказаться от подсказки при неясном источнике.
- Инструкция для proactive hints запрещает расплывчатое «помню, ты обмолвился» и просит формулировать по реальным полям evidence без выдуманных имён; форматтер покрыт отдельным TS regression test.

## 2026-06-21

- В админке `Мониторинг` добавлена AI usage analytics поверх `ai_usage_logs`: KPI по вызовам и токенам, таймсерия, breakdown по provider/model/task/preset/operation и список последних ошибок.
- Логи AI usage расширены полем `operation` и индексами по ключевым разрезам, чтобы точный учёт токенов строился по `usage` ответа провайдера без анализа исходящего трафика и без тяжёлой runtime-агрегации.
- Исправлены ложные post-response follow-up из памяти: `proactive hint` больше не запускается после reminder/document/image/browser-сценариев и не должен поднимать contact-memory другого человека как реплику о владельце.
- Проверка `memory gap` для упомянутых людей стала contact-aware: сначала используются `resolveContactIdentity` и `contact_*` теги, затем fallback-поиск по вариантам имени, включая кейсы вроде `Юра` / `Юрий`.
- Общая contact-memory логика вынесена в переиспользуемые helper-ы, чтобы retrieval, proactive hints и memory-gap работали по одним правилам идентичности контактов.
- `contact_username` добавлен как сильный identity key без ломки обратной совместимости: runtime понимает старые `contact_name/contact_alias/contact_id/contact_key` и новые `contact_username`, не полагаясь на хардкод словарей имён.
- TS-тесты переведены на общий suite-runner: вместо длинной цепочки однотипных `ts-node scripts/test*.ts` в `package.json` теперь используются команды `test:ts`, `test:ts:ai`, `test:ts:memory`, `test:ts:interaction` и `test:ts:all`.
- В админке блок `AI Presets` теперь явно показывает активный preset, базовое значение из `env/default` и факт runtime-переопределения без технически перегруженного текста про источник.
- Исправлены фантомные факты в ответах “что важного сегодня”: reminder-memory теперь привязывается к напоминанию через `source_reminder:<id>`, синхронно обновляется при переносе/редактировании/отмене/выполнении, а `todayImportance` отфильтровывает устаревшие `planned/future_plan` факты, если активное напоминание по тому же событию уже перенесено.
- AI runtime переведён на capability-first схему для `chat`, `responses`, `embedding` и `transcription`; прямые OpenAI-вызовы из прикладных сервисов убраны.
- Добавлены общий provider registry и model catalog для OpenAI, OpenRouter, Gemini и Z.ai, а также новый preset `glm-balanced`.
- Transitional fallback policy централизована в общей матрице `ai/fallback-models.json`, которую используют и runtime, и admin-panel availability.
- В админке `AI Presets` и monitoring теперь читают общий provider metadata source; локальное дублирование registry убрано.
- Сборка `admin-panel` переведена на root Docker build context, чтобы server-side часть панели могла безопасно использовать общие runtime JSON-реестры.
- README и ROADMAP актуализированы под новые AI provider-ы, capability-first runtime и текущую сборочную схему админки.

## 2026-06-20

- В `server-deploy.sh` для команды `logs` добавлены флаги `--no-postgres` и `--no-qdrant`, чтобы исключать инфраструктурные сервисы из общего потока логов.
- В `Makefile` добавлены цели `make logs-no-db` и `make logs-no-db-follow` как короткие сценарии просмотра логов приложения без `postgres` и `qdrant`.
- `server-deploy.sh help` теперь показывает справку без чтения server-state и не падает вне целевого окружения.
- README обновлён: новые сценарии просмотра логов добавлены в быстрый старт и список частых команд.

## 2026-06-19

- В `server-deploy.sh` для команды `logs` добавлен флаг `--no-postgres`, чтобы смотреть общий поток логов без периодических checkpoint-сообщений PostgreSQL.
- В `Makefile` добавлены цели `make logs-no-postgres` и `make logs-no-postgres-follow`.
- README обновлён: новые команды логов добавлены в быстрый старт и список частых команд.
- Для commit message принято соглашение Conventional Commits с русским `summary`; подробные проверки и развёрнутые списки изменений оставлены для PR, а не для каждого коммита.

## 2026-06-11

- Исправлена потеря контекста при переносе напоминания на произвольное время и при редактировании существующего напоминания: pending-состояния этих сценариев теперь переживают отдельные Telegram updates через session storage.
- В админке добавлен раздел `Мониторинг` с live health checks для контейнера бота, PostgreSQL, Qdrant, Telegram Bot API, Telegram User Client, OpenAI, Gemini и OpenRouter.
- Admin backend получил единый endpoint `GET /api/monitoring/health`, который агрегирует статусы зависимостей и возвращает короткие технические детали по каждой проверке.
- Бот теперь поднимает внутренний runtime health endpoint для безопасной диагностики Telegram User Client без чтения Docker-логов из админки.
- Инициализация Telegram User Client переведена на guarded path: параллельные вызовы больше не должны возвращать сырой клиент до завершения `connect()` и `isUserAuthorized()`.

## 2026-06-10

- Provider-specific AI contract logic вынесена из общих runtime wrapper-ов в отдельный слой provider adapters; preset registry сохранён как единственный источник маршрутизации `task -> provider + model`.
- Все прикладные вызовы `openai.chat.completions.create` переведены на task-aware wrapper `createChatCompletionForTask(...)`; legacy-слой `openAiModels` удалён из runtime-конфига.
- Browser planning и browser vision теперь тоже резолвят модель через task-aware preset runtime, а не через прямой OpenAI chat completion.
- Для `embeddings` и `audio.transcriptions` сохранён low-level OpenAI client, но выбор модели теперь берётся из активного preset-а без возврата compat-проекции `openAiModels`.
- Кнопка `Своё время` у напоминаний использует общий LLM-разбор даты, но сохраняет полноценную семантику откладывания: статус `Postponed`, очистку старой клавиатуры и счётчик переносов.

## 2026-06-09

- `server-common.sh` теперь определяет адрес хоста кроссплатформенно: Linux через `hostname -I`/`ip`, macOS через `route`/`ifconfig`, с fallback на `localhost` вместо заглушки `YOUR_VPS_IP`.
- README уточнён: адрес админ-панели в конце деплоя теперь зависит от окружения, а не всегда показывается как `YOUR_VPS_IP`.
- В `server-deploy.sh` добавлена команда `pause`, которая останавливает только app-сервисы без остановки `postgres` и `qdrant`.
- Добавлен корневой `Makefile` с короткими целями для VPS-операций, локальной разработки и сборки.
- `README.md` полностью перестроен под сценарное чтение: быстрый старт, частые команды и ключевые пути теперь вынесены вверх, а длинные справочные блоки уплотнены.
- В `Makefile` и `README.md` явно описан второй путь установки и деплоя через `install.sh` / `deploy.sh` с локальной машины на VPS.
- Операционные shell-скрипты перенесены в `scripts/ops/`; внешний интерфейс остался через `make`, а README обновлён на новые пути.
- README теперь явно поясняет, что `make` выполняется на хосте как удобная обёртка и не является обязательным: все сценарии можно запускать напрямую через `scripts/ops/*`.
- В README добавлена короткая команда установки `make` для Ubuntu/Debian рядом с пояснением, что он не нужен Docker-контейнерам.
- `make logs*` возвращены в обычный режим без follow; для live-просмотра добавлены отдельные цели `logs-follow`, `logs-bot-follow` и `logs-admin-follow`.

## 2026-06-01

- Добавлен `server-install.sh` для установки и redeploy прямо на VPS из текущего git-checkout.
- Добавлен `docker-compose.server.yml` для серверного сценария; legacy `docker-compose.yml` и `deploy.sh` сохранены отдельно для старого remote-deploy потока.
- Добавлен `Dockerfile.server`, чтобы серверный сценарий собирал TypeScript в `dist/` и запускал `dist/index.js`, не ломая legacy deploy flow.
- Добавлен `tsconfig.server.json`, а `Dockerfile.server` теперь ставит dev-зависимости и компилирует только код бота без `admin-panel`.
- README обновлён под новый серверный сценарий с ожиданием VPN/маршрутизации на уровне хоста, без app-level proxy-конфига.
- personality-настройки теперь поддерживают явную установку имени ассистента; если имя не задано, используется профильный fallback `ассистентка` / `ассистент`.
- Убраны жёстко заданные owner-имена из дефолтов и runtime-логики; грамматический род пользователя теперь задаётся профилем бота.
- Тексты и подписи, где отображается имя ассистента, теперь используют настроенное `characterName`, а не буквальную строку `Кира`.
- Нейтральные fallback-имена владельца заменены на профильные формы `владелец` / `владелица`.

## 2026-06-02

- Добавлен `server-deploy.sh` для обычного redeploy, просмотра логов, статуса и restart сервисов в VPS-first сценарии.
- `server-install.sh` теперь отвечает за первый запуск и конфигурирование, а не за ежедневный redeploy после `git pull`.
- Обычный server deploy больше не отключает Docker cache принудительно; тяжёлая очистка вынесена в явный режим `deploy --clean`.
- Добавлены `.dockerignore` для корневого образа и `admin-panel`, чтобы уменьшить Docker build context и ускорить сборку на VPS.
