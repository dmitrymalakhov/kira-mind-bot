.DEFAULT_GOAL := help

.PHONY: \
	help \
	install-server remote-install remote-deploy-bot remote-deploy-admin remote-deploy-all \
	deploy deploy-clean status logs logs-bot logs-admin pause pause-bot pause-admin restart restart-bot restart-admin stop \
	install install-admin build build-admin build-all test lint dev dev-admin

help:
	@printf '%s\n' \
		'Kira Mind Bot' \
		'' \
		'ops:' \
		'  make install-server  # первый запуск на VPS' \
		'  make remote-install  # установка на VPS с локальной машины, нужен SERVER_IP=' \
		'  make remote-deploy-bot    # удалённый деплой только бота, нужен SERVER_IP=' \
		'  make remote-deploy-admin  # удалённый деплой только админки, нужен SERVER_IP=' \
		'  make remote-deploy-all    # удалённый деплой бота и админки, нужен SERVER_IP=' \
		'  make deploy          # обычный redeploy' \
		'  make deploy-clean    # redeploy с безопасной очисткой Docker cache' \
		'  make status          # статус сервисов' \
		'  make logs            # логи всего стека' \
		'  make logs-bot        # логи kira-mind-bot' \
		'  make logs-admin      # логи admin-panel' \
		'  make pause           # пауза app-сервисов' \
		'  make pause-bot       # пауза kira-mind-bot' \
		'  make pause-admin     # пауза admin-panel' \
		'  make restart         # рестарт app-сервисов' \
		'  make restart-bot     # рестарт kira-mind-bot' \
		'  make restart-admin   # рестарт admin-panel' \
		'  make stop            # остановка всего стека' \
		'' \
		'local dev:' \
		'  make install         # npm install для бота' \
		'  make install-admin   # npm install для admin-panel' \
		'  make dev             # локальный запуск бота' \
		'  make dev-admin       # локальный запуск админки' \
		'' \
		'build/test:' \
		'  make build           # сборка server-части' \
		'  make build-admin     # сборка админки' \
		'  make build-all       # полная сборка' \
		'  make test            # тесты' \
		'  make lint            # eslint'

install-server:
	./scripts/ops/server-install.sh

remote-install:
	./scripts/ops/install.sh --server-ip "$(SERVER_IP)"

remote-deploy-bot:
	./scripts/ops/deploy.sh --kira-mind-bot --server-ip "$(SERVER_IP)"

remote-deploy-admin:
	./scripts/ops/deploy.sh --admin-panel --server-ip "$(SERVER_IP)"

remote-deploy-all:
	./scripts/ops/deploy.sh --kira-mind-bot --admin-panel --server-ip "$(SERVER_IP)"

deploy:
	./scripts/ops/server-deploy.sh deploy

deploy-clean:
	./scripts/ops/server-deploy.sh deploy --clean

status:
	./scripts/ops/server-deploy.sh status

logs:
	./scripts/ops/server-deploy.sh logs

logs-bot:
	./scripts/ops/server-deploy.sh logs kira-mind-bot

logs-admin:
	./scripts/ops/server-deploy.sh logs admin-panel

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
