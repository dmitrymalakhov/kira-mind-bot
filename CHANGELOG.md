# Changelog

## 2026-06-21

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
- Убраны жёсткие owner-имена `Дмитрий` / `Юлия` из дефолтов и runtime-логики; грамматический род пользователя теперь задаётся профилем бота.
- Тексты и подписи, где отображается имя ассистента, теперь используют настроенное `characterName`, а не буквальную строку `Кира`.
- Нейтральные fallback-имена владельца заменены на профильные формы `владелец` / `владелица`.

## 2026-06-02

- Добавлен `server-deploy.sh` для обычного redeploy, просмотра логов, статуса и restart сервисов в VPS-first сценарии.
- `server-install.sh` теперь отвечает за первый запуск и конфигурирование, а не за ежедневный redeploy после `git pull`.
- Обычный server deploy больше не отключает Docker cache принудительно; тяжёлая очистка вынесена в явный режим `deploy --clean`.
- Добавлены `.dockerignore` для корневого образа и `admin-panel`, чтобы уменьшить Docker build context и ускорить сборку на VPS.
