# Changelog

## 2026-06-01

- Добавлен `server-install.sh` для установки и redeploy прямо на VPS из текущего git-checkout.
- Добавлен `docker-compose.server.yml` для серверного сценария; legacy `docker-compose.yml` и `deploy.sh` сохранены отдельно для старого remote-deploy потока.
- Добавлен `Dockerfile.server`, чтобы серверный сценарий собирал TypeScript в `dist/` и запускал `dist/index.js`, не ломая legacy deploy flow.
- README обновлён под новый серверный сценарий с обязательным VPN через `socks5h://172.17.0.1:10808`.
