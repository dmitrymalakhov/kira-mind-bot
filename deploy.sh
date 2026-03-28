#!/bin/bash

# Функция для отображения помощи
show_help() {
    echo "Usage: $0 [--kira-mind-bot] [--sergey-brain-bot] [--server-ip <ip>]"
    echo
    echo "Options:"
    echo "  --kira-mind-bot              Deploy the Kira-Mind bot"
    echo "  --sergey-brain-bot           Deploy the Sergey-Brain bot"
    echo "  --server-ip <ip>             Target server IP address"
    exit 1
}

DEPLOY_KIRA_MIND_BOT=false
DEPLOY_SERGEY_BRAIN_BOT=false

SERVER_IP="165.232.120.123"

while [[ $# -gt 0 ]]; do
    case $1 in
        --kira-mind-bot)
            DEPLOY_KIRA_MIND_BOT=true
            shift
            ;;
        --sergey-brain-bot)
            DEPLOY_SERGEY_BRAIN_BOT=true
            shift
            ;;
        --server-ip)
            SERVER_IP="$2"
            shift 2
            ;;
        *)
            show_help
            ;;
    esac
done

# Проверка, что хотя бы один проект выбран для деплоя
if [ "$DEPLOY_KIRA_MIND_BOT" = false ] && [ "$DEPLOY_SERGEY_BRAIN_BOT" = false ]; then
    show_help
fi

cd "$(dirname "$0")"
DEPLOY_STARTED_AT=$(date '+%Y-%m-%d %H:%M:%S')

# --- Статус: старт деплоя ---
echo ""
echo "=============================================="
echo "  🚀 ДЕПЛОЙ — ${DEPLOY_STARTED_AT}"
echo "=============================================="
echo "📍 Сервер: ${SERVER_IP}"
echo "📦 Проекты для деплоя:"
[ "$DEPLOY_KIRA_MIND_BOT" = true ]       && echo "  • kira-mind-bot"
[ "$DEPLOY_SERGEY_BRAIN_BOT" = true ]    && echo "  • sergey-brain-bot"
echo "=============================================="
echo ""

# _deploy используется как staging-папка (не конфликтует с dist/ от TypeScript)
rm -rf _deploy
mkdir -p _deploy

# Сборка и копирование файлов для kira-mind-bot
if [ "$DEPLOY_KIRA_MIND_BOT" = true ]; then
    echo "🔨 [1/2] Сборка kira-mind-bot (ASSISTANT_PROFILE=KiraMindBot)..."
    ASSISTANT_PROFILE=KiraMindBot npm run build

    mkdir -p _deploy/kira-mind-bot
    cp -r dist/* _deploy/kira-mind-bot
    cp Dockerfile _deploy/kira-mind-bot
    cp package.json _deploy/kira-mind-bot
    cp package-lock.json _deploy/kira-mind-bot

    if [ -f ".env.production" ]; then
        cp .env.production _deploy/kira-mind-bot
        echo "✅ Скопирован .env.production для kira-mind-bot"
    else
        echo "⚠️  Файл .env.production не найден для kira-mind-bot"
    fi

    rm -rf dist
fi

# Сборка и копирование файлов для sergey-brain-bot (из той же кодовой базы)
if [ "$DEPLOY_SERGEY_BRAIN_BOT" = true ]; then
    echo "🔨 [2/2] Сборка sergey-brain-bot (ASSISTANT_PROFILE=SergeyBrainBot)..."
    ASSISTANT_PROFILE=SergeyBrainBot npm run build

    mkdir -p _deploy/kira-mind-bot
    cp -r dist/* _deploy/kira-mind-bot
    cp Dockerfile _deploy/kira-mind-bot
    cp package.json _deploy/kira-mind-bot
    cp package-lock.json _deploy/kira-mind-bot

    if [ -f ".env.production" ]; then
        cp .env.production _deploy/kira-mind-bot
        echo "✅ Скопирован .env.production для sergey-brain-bot"
    else
        echo "⚠️  Файл .env.production не найден для sergey-brain-bot"
    fi

    rm -rf dist
fi

# Копирование общего docker-compose.yml в staging
echo ""
echo "📁 --- Подготовка архива ---"
cp docker-compose.yml _deploy

# Генерируем .env для docker-compose из .env.production (нужен для postgres — DB_PASSWORD и т.д.)
grep -E '^DB_' .env.production > _deploy/.env && echo "✅ Создан .env для docker-compose (DB_*)" || echo "⚠️  Не удалось создать .env из .env.production"

echo "Содержимое _deploy: $(ls -la _deploy | tail -n +2)"
echo ""

# Создание архива
echo "📦 Создание deployment-source.tar..."
tar -czvf deployment-source.tar -C ./_deploy .
ARCHIVE_SIZE=$(du -h deployment-source.tar | cut -f1)
echo "📏 Размер архива: ${ARCHIVE_SIZE}"
echo ""

# Копирование архива на удалённый сервер
echo "⬆️  --- Загрузка на сервер ${SERVER_IP} ---"
scp deployment-source.tar root@${SERVER_IP}:/root/source
echo "✅ Загрузка завершена."
echo ""

# Вход на удалённый сервер, очистка Docker, разархивирование и деплой сервисов
# Переменные DEPLOY_* подставляются на клиенте; \$ — выполняются на сервере
echo "🖥️  --- Выполнение на сервере ---"
ssh root@${SERVER_IP} << EOF
  set -e
  cd /root/source

  echo ""
  echo "🖥️  === [Сервер] \$(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
  echo ""

  echo "💾 --- Диск и Docker до очистки ---"
  df -h / | tail -1
  echo "Использование Docker (docker system df):"
  docker system df 2>/dev/null || true
  echo "Контейнеры (все):"
  docker ps -a --format "  {{.Names}}: {{.Status}}" 2>/dev/null || docker ps -a
  echo ""

  echo "🛑 --- Остановка и удаление контейнеров деплоируемых сервисов ---"
  stop_and_remove() {
    local name="\$1"
    docker-compose -f docker-compose.yml stop "\$name" 2>/dev/null && echo "  stop \$name: ok" || true
    docker-compose -f docker-compose.yml rm -f "\$name" 2>/dev/null && echo "  rm \$name: ok" || true
  }
  if [ "$DEPLOY_KIRA_MIND_BOT" = true ]; then stop_and_remove kira-mind-bot; fi
  if [ "$DEPLOY_SERGEY_BRAIN_BOT" = true ]; then stop_and_remove sergey-brain-bot; fi
  echo ""

  echo "🗑️  --- Очистка Docker на сервере ---"
  BEFORE_PRUNE=\$(df / | tail -1 | awk '{print \$4}')
  echo "  🧹 Удаление остановленных контейнеров (container prune)..."
  docker container prune -f 2>/dev/null && echo "    ok" || echo "    skip"
  echo "  🧹 Удаление неиспользуемых образов (image prune)..."
  docker image prune -af 2>/dev/null && echo "    ok" || echo "    skip"
  echo "  🗑️  Удаление кэша билдов (builder prune) — освобождает место для npm install..."
  docker builder prune -af 2>/dev/null && echo "    ok" || echo "    skip"
  AFTER_PRUNE=\$(df / | tail -1 | awk '{print \$4}')
  echo "  Свободно до/после (блоки 1K): \${BEFORE_PRUNE} -> \${AFTER_PRUNE}"
  echo "💾 Диск после очистки:"
  df -h / | tail -1
  echo ""

  echo "📂 --- Распаковка архива ---"
  tar -xzvf deployment-source.tar
  rm deployment-source.tar
  echo "Файлы в /root/source:"
  ls -la
  echo ""

  export NODE_ENV=production
  DEPLOYED_SERVICES=""

  deploy_service() {
    local name="\$1"
    echo ""
    echo "🚀 >>> Деплой сервиса: \$name <<<"
    echo "  ⏹️  Остановка старого контейнера..."
    docker-compose -f docker-compose.yml stop "\$name" 2>/dev/null || true
    echo "  🔨 Сборка и запуск (docker-compose up --build)..."
    docker-compose -f docker-compose.yml up "\$name" -d --build
    echo "  ✅ Сервис \$name запущен."
    DEPLOYED_SERVICES="\$DEPLOYED_SERVICES \$name"
  }

  if [ "$DEPLOY_KIRA_MIND_BOT" = true ]; then
    export ASSISTANT_PROFILE=KiraMindBot
    deploy_service kira-mind-bot
  fi

  if [ "$DEPLOY_SERGEY_BRAIN_BOT" = true ]; then
    export ASSISTANT_PROFILE=SergeyBrainBot
    deploy_service sergey-brain-bot
  fi

  echo ""
  echo "✔️  === Проверка задеплоенных сервисов ==="
  for svc in \$DEPLOYED_SERVICES; do
    [ -z "\$svc" ] && continue
    if docker-compose -f docker-compose.yml ps "\$svc" 2>/dev/null | grep -q "Up"; then
      echo "  ✅ \$svc — запущен"
    else
      echo "  ❌ ОШИБКА: \$svc не запущен после деплоя"
      docker-compose -f docker-compose.yml ps -a
      exit 1
    fi
  done
  echo ""
  echo "📋 Состояние задеплоенных контейнеров (docker ps):"
  docker ps --filter "name=\$(echo \$DEPLOYED_SERVICES | tr ' ' '|')" --format "  {{.Names}}: {{.Status}} ({{.Image}})"
  echo ""
  echo "🖥️  === [Сервер] Деплой завершён: \$(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
EOF

if [ $? -eq 0 ]; then
  echo ""
  echo "=============================================="
  echo "  ✅ Деплой на ${SERVER_IP} завершён успешно."
  echo "  📅 Начало: ${DEPLOY_STARTED_AT}"
  echo "  📅 Конец:  $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================================="
  rm -f deployment-source.tar
  rm -rf _deploy
else
  echo ""
  echo "=============================================="
  echo "  ❌ Деплой завершился с ошибкой."
  echo "  📅 Время: ${DEPLOY_STARTED_AT} — $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================================="
  exit 1
fi
