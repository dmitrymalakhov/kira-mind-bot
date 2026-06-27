# CODEX

## Назначение файла
- `CODEX.MD` в корне проекта хранит локальный инженерный контекст именно для `kira-mind-bot`.
- Глобальный `../CODEX.MD` не редактируется для проектных деталей, которые относятся только к этому репозиторию.

## Архитектурные решения
- Live health/monitoring для внешних систем должен жить отдельным диагностическим слоем:
  - bot runtime публикует узкие internal health endpoints;
  - admin backend агрегирует их вместе с infra/API checks;
  - бизнес-логика бота не должна содержать admin-oriented monitoring orchestration.
- Reminder-flows, которые продолжаются следующим сообщением пользователя после callback-кнопки, считаются context-critical и должны переживать отдельные Telegram updates через session storage.
- Contact-aware memory logic должна быть централизована:
  - правила идентичности контакта, tag-based matching и проверки subject-а не дублируются по модулям;
  - retrieval, proactive hints и memory-gap должны использовать одни и те же helper-ы contact-memory.

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
