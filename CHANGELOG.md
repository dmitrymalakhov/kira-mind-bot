# Changelog

## 2026-06-01

- Добавлен `server-install.sh` для установки и redeploy прямо на VPS из текущего git-checkout.
- Добавлен `docker-compose.server.yml` для серверного сценария; legacy `docker-compose.yml` и `deploy.sh` сохранены отдельно для старого remote-deploy потока.
- Добавлен `Dockerfile.server`, чтобы серверный сценарий собирал TypeScript в `dist/` и запускал `dist/index.js`, не ломая legacy deploy flow.
- Добавлен `tsconfig.server.json`, а `Dockerfile.server` теперь ставит dev-зависимости и компилирует только код бота без `admin-panel`.
- README обновлён под новый серверный сценарий с ожиданием VPN/маршрутизации на уровне хоста, без app-level proxy-конфига.
- personality-настройки теперь поддерживают переопределение имени персонажа; если имя не задано, сохраняется стандартный fallback профиля (`Кира` / `Сергей`).
