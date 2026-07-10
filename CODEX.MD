# CODEX

## Назначение файла
- `AGENTS.md` в корне — кросс-платформенная точка входа для coding agents; он должен отправлять агент к `CODEX-RULES.MD` и `CODEX.MD`.
- `CODEX-RULES.MD` в корне хранит обязательные правила репозитория и имеет более высокий приоритет, чем остальные локальные markdown-файлы.
- `CODEX.MD` в корне проекта хранит локальный инженерный контекст именно для `kira-mind-bot`.
- Глобальный `../CODEX.MD` не редактируется для проектных деталей, которые относятся только к этому репозиторию.

## Архитектурные решения
- Каждый Docker Compose-стек идентифицируется через `KIRA_INSTANCE_NAME`:
  - project name, постоянные volumes и имя bot-контейнера должны быть уникальны для инстанса;
  - внутренние service DNS (`postgres`, `qdrant`, `kira-mind-bot`) остаются одинаковыми внутри изолированных сетей;
  - admin-panel получает физическое имя bot-контейнера через `KIRA_BOT_CONTAINER_NAME`, поэтому мониторинг и restart не должны возвращаться к глобальному хардкоду `kira-mind-bot`;
  - host-порты общих инфраструктурных сервисов не публикуются без явной необходимости, а `ADMIN_PORT` обязан различаться между инстансами.
  - при миграции старой установки существующие `ADMIN_*` сначала читаются из compose `.env`, а затем сохраняются в локальном `.kira-admin-state`; state-файл конкретного инстанса имеет приоритет.
- Live health/monitoring для внешних систем должен жить отдельным диагностическим слоем:
  - bot runtime публикует узкие internal health endpoints;
  - admin backend агрегирует их вместе с infra/API checks;
  - бизнес-логика бота не должна содержать admin-oriented monitoring orchestration.
- Мониторинг Telegram user-client (`services/telegram.ts`) должен читать только рабочие поля GramJS `telegram@^2.26.22`:
  - `client.connected` (геттер → `sender.isConnected()` → `_userConnected`) для transport-состояния;
  - `sender.isReconnecting` (без подчёркивания) для состояния reconnect;
  - приватные поля `sender._disconnected` (всегда `true`), `client._reconnecting` и `sender._reconnecting` (всегда `false`) — мёртвые, их читать нельзя;
  - комбинировать `client.connected && !client.disconnected` некорректно — `client.disconnected` опирается на мёртвый `_disconnected` и всегда `true`, поэтому результат всегда `false`;
  - изменения transport-состояния логируются через подписку на `UpdateConnectionState` (`import { Raw } from "telegram/events"`, `import { UpdateConnectionState } from "telegram/network"`); значения: `connected=1`, `disconnected=-1`, `broken=0`.
- AI usage analytics считает токены только по `usage`, который вернул провайдер:
  - исходящий HTTP-трафик не используется как источник правды для токенов;
  - runtime пишет только дешёвые event-log записи в `ai_usage_logs`;
  - все агрегации, breakdown и time-series считаются только в admin backend по запросу UI.
- True-full AI preset-ы сохраняют провайдера при аварийной деградации:
  - после исчерпанного управляемого runtime retry тяжёлая Gemini-модель может перейти на lite-модель из `ai/degraded-models.json`;
  - provider SDK не должен выполнять скрытые retry поверх runtime retry-flow;
  - Gemini SDK, прямые HTTP-вызовы и ожидание semaphore slot используют ограниченные timeout-ы, а file operations имеют отдельный увеличенный timeout;
  - фактическое переключение модели обязательно логируется отдельным событием `[AI DEGRADED]` с безопасной диагностикой причины.
- Reminder-flows, которые продолжаются следующим сообщением пользователя после callback-кнопки, считаются context-critical и должны переживать отдельные Telegram updates через session storage.
- Contact-aware memory logic должна быть централизована:
  - правила идентичности контакта, tag-based matching и проверки subject-а не дублируются по модулям;
  - retrieval, proactive hints и memory-gap должны использовать одни и те же helper-ы contact-memory.
  - `contact_username` считается сильным identity key наравне с `contact_id`, но не заменяет backward-compatible теги `contact_name/contact_alias/contact_key`.
- Форматирование Telegram-сообщений разделено на два слоя:
  - структурные/системные сообщения (дайджесты, списки, карточки, сводные отчёты, напоминания, меню) идут через единый DSL в `utils/richMessage.ts` (`sendStructured`/`editStructured`/`editStructuredCtx`), который рендерит rich-HTML для Bot API 10.1 (`sendRichMessage` / `editMessageText({rich_message})`) с автоматическим фолбэком на `sendMessage({parse_mode:"HTML"})`;
  - свободные ответы LLM в диалоге остаются plain text без parse_mode — бот намеренно сохраняет «человеческий» стиль, и форматирование туда не добавляется;
  - экранирование пользовательских данных (имена, тексты напоминаний, названия чатов, факты памяти) обязательно через `esc()`/`escAttr()` перед вставкой в блоки;
  - аварийный рубильник rich-форматирования — `RICH_MESSAGES_ENABLED` (по умолчанию `true`).

## Что куда документировать
- `README.md`: пользовательские сценарии, настройка, эксплуатация и высокоуровневое описание возможностей. Не дублировать туда внутренние implementation details.
- `CHANGELOG.md`: хронологический список заметных изменений для владельца/пользователей проекта; писать человеческим языком, не превращать в git-log.
- `CODEX.MD`: долговечный инженерный контекст для будущих Codex-сессий: архитектурные решения, локальные соглашения и запреты на уже признанные ошибочными подходы. Не добавлять сюда каждую фичу, тест или путь к helper-файлу, если это не меняет устойчивое правило разработки.
- `ROADMAP.md`: планы и направления работ; не использовать как журнал уже сделанных изменений.

## Локальные соглашения
- Commit message пишутся в формате Conventional Commits: `<type>(optional-scope): <summary>`.
- Рекомендуемые типы: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.
- `summary` и тело коммита пишутся по-русски.
- Тело коммита опционально. Его стоит добавлять только когда без него теряется контекст решения, мотивация или важное ограничение.
- Если тело коммита есть, оно должно быть коротким и практичным; обычно достаточно блока `Зачем`, иногда вместе с кратким `Что сделано` или пометкой о `BREAKING CHANGE`.
- Подробные шаги проверки, длинные списки изменений и развёрнутые риски должны жить в Pull Request, а не в каждом commit message.
- Пример: `fix(ops): добавить вывод логов без postgres`.
- TypeScript smoke/regression tests в `scripts/test*.ts` запускаются через общие раннеры:
  - `npm run test:ts -- <file>` для одиночного теста;
  - `npm run test:ts:ai`, `test:ts:memory`, `test:ts:interaction`, `test:ts:all` для групповых прогонов.
- Production stage в `admin-panel/Dockerfile` должен автоматически забирать корневые runtime-модули админки через `COPY admin-panel/*.js ./`, а не через ручной список файлов:
  - если в корне `admin-panel/` появляется новый server-side `.js`-модуль, он должен попадать в runtime-образ без отдельной правки Dockerfile;
  - для не-JS runtime-артефактов (`.json`, `src/*`, общие файлы из `ai/` и `utils/`) всё ещё нужно явно проверять копирование в production stage.
