.DEFAULT_GOAL := help

BOT_SERVICE := kira-mind-bot
ADMIN_SERVICE := admin-panel

.PHONY: \
	help \
	install-server remote-install remote-deploy \
	deploy status logs pause restart rebuild stop up down \
	install install-admin build build-admin build-all test lint dev dev-admin \
	deploy-clean logs-follow logs-bot logs-bot-follow logs-admin logs-admin-follow \
	pause-bot pause-admin restart-bot restart-admin rebuild-admin \
	remote-deploy-bot remote-deploy-admin remote-deploy-all \
	admin-logs admin-logs-follow admin-restart admin-pause admin-stop admin-rebuild admin-up \
	bot-logs bot-logs-follow bot-restart bot-pause bot-stop bot-up

help:
	@printf '\n%s\n\n' 'Kira Mind Bot'
	@printf '%s\n' '============================================================'
	@printf '%s\n' '  Сценарий 1: Прямой запуск на VPS'
	@printf '%s\n' '============================================================'
	@printf '%s\n' '[Первый запуск]'
	@printf '  %-28s %s\n' 'make install-server' 'Первый запуск прямо на VPS.'
	@printf '\n%s\n' '[Общие команды]'
	@printf '  %-28s %s\n' 'make up' 'Поднять весь локальный стек без пересборки.'
	@printf '  %-28s %s\n' 'make deploy' 'Обычный redeploy app-сервисов.'
	@printf '  %-28s %s\n' 'make deploy-clean' 'Redeploy с compose down и очисткой Docker cache.'
	@printf '  %-28s %s\n' 'make pause' 'Поставить app-сервисы на паузу.'
	@printf '  %-28s %s\n' 'make stop' 'Остановить весь локальный стек без удаления volumes.'
	@printf '  %-28s %s\n' 'make down' 'Полностью завершить работу: docker compose down.'
	@printf '  %-28s %s\n' 'make status' 'Показать статус контейнеров.'
	@printf '  %-28s %s\n' 'make logs' 'Показать последние логи всего стека.'
	@printf '  %-28s %s\n' 'make logs-follow' 'Смотреть live-логи всего стека.'
	@printf '\n%s\n' '[Бот и admin-panel]'
	@printf '  %-28s %s\n' 'make admin-up' 'Поднять только admin-panel без пересборки.'
	@printf '  %-28s %s\n' 'make admin-rebuild' 'Пересобрать и заново поднять admin-panel.'
	@printf '  %-28s %s\n' 'make admin-restart' 'Перезапустить admin-panel без пересборки.'
	@printf '  %-28s %s\n' 'make admin-pause' 'Поставить admin-panel на паузу.'
	@printf '  %-28s %s\n' 'make admin-stop' 'Остановить только admin-panel.'
	@printf '  %-28s %s\n' 'make admin-logs' 'Показать последние логи admin-panel.'
	@printf '  %-28s %s\n' 'make admin-logs-follow' 'Смотреть live-логи admin-panel.'
	@printf '  %-28s %s\n' 'make bot-up' 'Поднять только бота без пересборки.'
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

install-server:
	./scripts/ops/server-install.sh

remote-install:
	./scripts/ops/install.sh --server-ip "$(SERVER_IP)"

remote-deploy:
	@if [ -z "$(SERVER_IP)" ]; then \
		echo 'Нужно указать SERVER_IP, например: make remote-deploy SERVICE=admin SERVER_IP=1.2.3.4'; \
		exit 1; \
	fi
	@if [ "$(SERVICE)" = "bot" ]; then \
		./scripts/ops/deploy.sh --kira-mind-bot --server-ip "$(SERVER_IP)"; \
	elif [ "$(SERVICE)" = "admin" ]; then \
		./scripts/ops/deploy.sh --admin-panel --server-ip "$(SERVER_IP)"; \
	elif [ "$(SERVICE)" = "all" ] || [ -z "$(SERVICE)" ]; then \
		./scripts/ops/deploy.sh --kira-mind-bot --admin-panel --server-ip "$(SERVER_IP)"; \
	else \
		echo 'SERVICE должен быть одним из: bot, admin, all'; \
		exit 1; \
	fi

deploy:
	@if [ "$(CLEAN)" = "1" ]; then \
		./scripts/ops/server-deploy.sh deploy --clean; \
	else \
		./scripts/ops/server-deploy.sh deploy; \
	fi

up:
	@if [ -n "$(SERVICE)" ]; then \
		docker compose up -d "$(SERVICE)"; \
	else \
		docker compose up -d; \
	fi

status:
	./scripts/ops/server-deploy.sh status

logs:
	@if [ "$(FOLLOW)" = "1" ] && [ -n "$(SERVICE)" ]; then \
		./scripts/ops/server-deploy.sh logs -f "$(SERVICE)"; \
	elif [ "$(FOLLOW)" = "1" ]; then \
		./scripts/ops/server-deploy.sh logs -f; \
	elif [ -n "$(SERVICE)" ]; then \
		./scripts/ops/server-deploy.sh logs "$(SERVICE)"; \
	else \
		./scripts/ops/server-deploy.sh logs; \
	fi

pause:
	@if [ -n "$(SERVICE)" ]; then \
		./scripts/ops/server-deploy.sh pause "$(SERVICE)"; \
	else \
		./scripts/ops/server-deploy.sh pause; \
	fi

restart:
	@if [ -n "$(SERVICE)" ]; then \
		./scripts/ops/server-deploy.sh restart "$(SERVICE)"; \
	else \
		./scripts/ops/server-deploy.sh restart; \
	fi

rebuild:
	@if [ -z "$(SERVICE)" ]; then \
		echo 'Нужно указать SERVICE, например: make rebuild SERVICE=admin-panel'; \
		exit 1; \
	fi
	docker compose build "$(SERVICE)"
	docker compose up -d "$(SERVICE)"

stop:
	@if [ -n "$(SERVICE)" ]; then \
		./scripts/ops/server-deploy.sh stop "$(SERVICE)"; \
	else \
		./scripts/ops/server-deploy.sh stop; \
	fi

down:
	docker compose down

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

deploy-clean:
	@$(MAKE) deploy CLEAN=1

logs-follow:
	@$(MAKE) logs FOLLOW=1

logs-bot:
	@$(MAKE) logs SERVICE=$(BOT_SERVICE)

logs-bot-follow:
	@$(MAKE) logs SERVICE=$(BOT_SERVICE) FOLLOW=1

logs-admin:
	@$(MAKE) logs SERVICE=$(ADMIN_SERVICE)

logs-admin-follow:
	@$(MAKE) logs SERVICE=$(ADMIN_SERVICE) FOLLOW=1

pause-bot:
	@$(MAKE) pause SERVICE=$(BOT_SERVICE)

pause-admin:
	@$(MAKE) pause SERVICE=$(ADMIN_SERVICE)

restart-bot:
	@$(MAKE) restart SERVICE=$(BOT_SERVICE)

restart-admin:
	@$(MAKE) restart SERVICE=$(ADMIN_SERVICE)

rebuild-admin:
	@$(MAKE) rebuild SERVICE=$(ADMIN_SERVICE)

remote-deploy-bot:
	@$(MAKE) remote-deploy SERVICE=bot SERVER_IP="$(SERVER_IP)"

remote-deploy-admin:
	@$(MAKE) remote-deploy SERVICE=admin SERVER_IP="$(SERVER_IP)"

remote-deploy-all:
	@$(MAKE) remote-deploy SERVICE=all SERVER_IP="$(SERVER_IP)"

admin-logs:
	@$(MAKE) logs SERVICE=$(ADMIN_SERVICE)

admin-logs-follow:
	@$(MAKE) logs SERVICE=$(ADMIN_SERVICE) FOLLOW=1

admin-restart:
	@$(MAKE) restart SERVICE=$(ADMIN_SERVICE)

admin-pause:
	@$(MAKE) pause SERVICE=$(ADMIN_SERVICE)

admin-stop:
	@$(MAKE) stop SERVICE=$(ADMIN_SERVICE)

admin-rebuild:
	@$(MAKE) rebuild SERVICE=$(ADMIN_SERVICE)

admin-up:
	@$(MAKE) up SERVICE=$(ADMIN_SERVICE)

bot-logs:
	@$(MAKE) logs SERVICE=$(BOT_SERVICE)

bot-logs-follow:
	@$(MAKE) logs SERVICE=$(BOT_SERVICE) FOLLOW=1

bot-restart:
	@$(MAKE) restart SERVICE=$(BOT_SERVICE)

bot-pause:
	@$(MAKE) pause SERVICE=$(BOT_SERVICE)

bot-stop:
	@$(MAKE) stop SERVICE=$(BOT_SERVICE)

bot-up:
	@$(MAKE) up SERVICE=$(BOT_SERVICE)
