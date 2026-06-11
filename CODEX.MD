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
