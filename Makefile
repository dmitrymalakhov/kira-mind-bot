.DEFAULT_GOAL := help

.PHONY: \
	help \
	install-server remote-install remote-deploy-bot remote-deploy-admin remote-deploy-all \
	deploy deploy-clean up down status logs logs-follow logs-no-db logs-no-db-follow logs-bot logs-bot-follow logs-admin logs-admin-follow \
	pause pause-bot pause-admin restart restart-bot restart-admin stop migrate-instance \
	admin-up admin-rebuild admin-restart admin-pause admin-stop admin-logs admin-logs-follow \
	bot-up bot-rebuild bot-restart bot-pause bot-stop bot-logs bot-logs-follow \
	install install-admin build build-admin build-all test lint dev dev-admin

define SERVER_COMPOSE_PREP
source ./scripts/ops/server-common.sh && \
ensure_server_repo_root && \
resolve_compose_cmd && \
acquire_deploy_lock && \
load_compose_identity_if_present && \
load_env_if_present && \
ensure_admin_state && \
write_compose_env && \
prepare_runtime_data
endef

help:
	@printf '\n%s\n\n' 'Kira Mind Bot'
	@printf '%s\n' '============================================================'
	@printf '%s\n' '  Сценарий 1: Прямой запуск на VPS'
	@printf '%s\n' '============================================================'
	@printf '%s\n' '[Первый запуск]'
	@printf '  %-28s %s\n' 'make install-server' 'Первый запуск прямо на VPS.'
	@printf '\n%s\n' '[Общие команды]'
	@printf '  %-28s %s\n' 'make up' 'Поднять весь стек без пересборки.'
	@printf '  %-28s %s\n' 'make deploy' 'Обычный redeploy app-сервисов.'
	@printf '  %-28s %s\n' 'make deploy-clean' 'Redeploy с compose down и очисткой Docker cache.'
	@printf '  %-28s %s\n' 'make pause' 'Поставить app-сервисы на паузу.'
	@printf '  %-28s %s\n' 'make stop' 'Остановить весь стек без удаления volumes.'
	@printf '  %-28s %s\n' 'make migrate-instance NEW_INSTANCE=...' 'Переименовать project/контейнер без переноса данных.'
	@printf '  %-28s %s\n' 'make down' 'Полностью завершить работу: docker compose down.'
	@printf '  %-28s %s\n' 'make status' 'Показать статус контейнеров.'
	@printf '  %-28s %s\n' 'make logs' 'Показать последние логи всего стека.'
	@printf '  %-28s %s\n' 'make logs-follow' 'Смотреть live-логи всего стека.'
	@printf '  %-28s %s\n' 'make logs-no-db' 'Показать логи стека без postgres и qdrant.'
	@printf '  %-28s %s\n' 'make logs-no-db-follow' 'Смотреть live-логи стека без postgres и qdrant.'
	@printf '\n%s\n' '[Бот и admin-panel]'
	@printf '  %-28s %s\n' 'make admin-up' 'Поднять только admin-panel без пересборки.'
	@printf '  %-28s %s\n' 'make admin-rebuild' 'Пересобрать и заново поднять admin-panel.'
	@printf '  %-28s %s\n' 'make admin-restart' 'Перезапустить admin-panel без пересборки.'
	@printf '  %-28s %s\n' 'make admin-pause' 'Поставить admin-panel на паузу.'
	@printf '  %-28s %s\n' 'make admin-stop' 'Остановить только admin-panel.'
	@printf '  %-28s %s\n' 'make admin-logs' 'Показать последние логи admin-panel.'
	@printf '  %-28s %s\n' 'make admin-logs-follow' 'Смотреть live-логи admin-panel.'
	@printf '  %-28s %s\n' 'make bot-up' 'Поднять только бота без пересборки.'
	@printf '  %-28s %s\n' 'make bot-rebuild' 'Пересобрать и заново поднять бота.'
	@printf '  %-28s %s\n' 'make bot-restart' 'Перезапустить бота без пересборки.'
	@printf '  %-28s %s\n' 'make bot-pause' 'Поставить бота на паузу.'
	@printf '  %-28s %s\n' 'make bot-stop' 'Остановить только бота.'
	@printf '  %-28s %s\n' 'make bot-logs' 'Показать последние логи бота.'
	@printf '  %-28s %s\n' 'make bot-logs-follow' 'Смотреть live-логи бота.'
	@printf '\n%s\n' '============================================================'
	@printf '%s\n' '  Сценарий 2: С локальной машины на удалённый VPS'
	@printf '%s\n' '============================================================'
	@printf '%s\n' '[Первый запуск]'
	@printf '  %-28s %s\n' 'make remote-install SERVER_IP=...' 'Первый запуск удалённо на VPS с локальной машины.'
	@printf '\n%s\n' '[Общие команды]'
	@printf '  %-28s %s\n' 'make remote-deploy-all SERVER_IP=...' 'Удалённо задеплоить бот и admin-panel.'
	@printf '\n%s\n' '[Бот и admin-panel]'
	@printf '  %-28s %s\n' 'make remote-deploy-admin SERVER_IP=...' 'Удалённо задеплоить только admin-panel.'
	@printf '  %-28s %s\n' 'make remote-deploy-bot SERVER_IP=...' 'Удалённо задеплоить только бота.'
	@printf '  %-28s %s\n' 'make remote-deploy-all SERVER_IP=...' 'Удалённо задеплоить бот и admin-panel.'
	@printf '\n%s\n' '============================================================'
	@printf '%s\n' '  Локальная разработка'
	@printf '%s\n' '============================================================'
	@printf '  %-28s %s\n' 'make install' 'npm install для бота.'
	@printf '  %-28s %s\n' 'make install-admin' 'npm install для admin-panel.'
	@printf '  %-28s %s\n' 'make dev' 'Локальный запуск бота.'
	@printf '  %-28s %s\n' 'make dev-admin' 'Локальный запуск админки.'
	@printf '  %-28s %s\n' 'make build' 'Сборка server-части.'
	@printf '  %-28s %s\n' 'make build-admin' 'Сборка админки.'
	@printf '  %-28s %s\n' 'make build-all' 'Полная сборка.'
	@printf '  %-28s %s\n' 'make test' 'Тесты.'
	@printf '  %-28s %s\n' 'make lint' 'ESLint.'

install-server:
	./scripts/ops/server-install.sh

remote-install:
	./scripts/ops/install.sh --server-ip "$(SERVER_IP)"

remote-deploy-bot:
	./scripts/ops/deploy.sh --kira-mind-bot --server-ip "$(SERVER_IP)" $(if $(REMOTE_DIR),--remote-dir "$(REMOTE_DIR)")

remote-deploy-admin:
	./scripts/ops/deploy.sh --admin-panel --server-ip "$(SERVER_IP)" $(if $(REMOTE_DIR),--remote-dir "$(REMOTE_DIR)")

remote-deploy-all:
	./scripts/ops/deploy.sh --kira-mind-bot --admin-panel --server-ip "$(SERVER_IP)" $(if $(REMOTE_DIR),--remote-dir "$(REMOTE_DIR)")

deploy:
	./scripts/ops/server-deploy.sh deploy

deploy-clean:
	./scripts/ops/server-deploy.sh deploy --clean

up:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose up -d'

down:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose down'

status:
	./scripts/ops/server-deploy.sh status

logs:
	./scripts/ops/server-deploy.sh logs

logs-follow:
	./scripts/ops/server-deploy.sh logs -f

logs-no-db:
	./scripts/ops/server-deploy.sh logs --no-postgres --no-qdrant

logs-no-db-follow:
	./scripts/ops/server-deploy.sh logs -f --no-postgres --no-qdrant

logs-bot:
	./scripts/ops/server-deploy.sh logs kira-mind-bot

logs-bot-follow:
	./scripts/ops/server-deploy.sh logs -f kira-mind-bot

logs-admin:
	./scripts/ops/server-deploy.sh logs admin-panel

logs-admin-follow:
	./scripts/ops/server-deploy.sh logs -f admin-panel

pause:
	./scripts/ops/server-deploy.sh pause

pause-bot:
	./scripts/ops/server-deploy.sh pause kira-mind-bot

pause-admin:
	./scripts/ops/server-deploy.sh pause admin-panel

restart:
	./scripts/ops/server-deploy.sh restart

restart-bot:
	./scripts/ops/server-deploy.sh restart kira-mind-bot

restart-admin:
	./scripts/ops/server-deploy.sh restart admin-panel

stop:
	./scripts/ops/server-deploy.sh stop

migrate-instance:
	@test -n "$(NEW_INSTANCE)" || { echo 'Укажите NEW_INSTANCE, например: make migrate-instance NEW_INSTANCE=aurora-mind-bot'; exit 1; }
	./scripts/ops/server-deploy.sh migrate-instance "$(NEW_INSTANCE)"

admin-up:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose up -d admin-panel'

admin-rebuild:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose build admin-panel && compose up -d admin-panel'

admin-restart:
	$(MAKE) restart-admin

admin-pause:
	$(MAKE) pause-admin

admin-stop:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose stop admin-panel'

admin-logs:
	$(MAKE) logs-admin

admin-logs-follow:
	$(MAKE) logs-admin-follow

bot-up:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose up -d postgres qdrant kira-mind-bot'

bot-rebuild:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose up -d postgres qdrant && compose build kira-mind-bot && compose up -d kira-mind-bot'

bot-restart:
	$(MAKE) restart-bot

bot-pause:
	$(MAKE) pause-bot

bot-stop:
	@bash -lc '$(SERVER_COMPOSE_PREP) && compose stop kira-mind-bot'

bot-logs:
	$(MAKE) logs-bot

bot-logs-follow:
	$(MAKE) logs-bot-follow

install:
	npm install

install-admin:
	npm --prefix admin-panel install

build:
	npm run build

build-admin:
	npm run build:admin

build-all:
	npm run build:all

test:
	npm test

lint:
	npm run lint

dev:
	npm run start:dev

dev-admin:
	npm --prefix admin-panel run dev
