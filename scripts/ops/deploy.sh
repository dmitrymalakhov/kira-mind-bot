#!/bin/bash
# TypeScript компилируется локально — на сервер уходит уже готовый JS.
# Требования на локальной машине: Node.js, npm, ssh, scp.

show_help() {
    echo "Usage: $0 [--kira-mind-bot] [--admin-panel] [--server-ip <ip>]"
    echo
    echo "Options:"
    echo "  --kira-mind-bot              Deploy the Kira-Mind bot"
    echo "  --admin-panel                Deploy the admin panel"
    echo "  --server-ip <ip>             Target server IP address"
    exit 1
}

DEPLOY_KIRA_MIND_BOT=false
DEPLOY_ADMIN_PANEL=false
SERVER_IP="165.232.120.123"

while [[ $# -gt 0 ]]; do
    case $1 in
        --kira-mind-bot)    DEPLOY_KIRA_MIND_BOT=true; shift ;;
        --admin-panel)      DEPLOY_ADMIN_PANEL=true; shift ;;
        --server-ip)        SERVER_IP="$2"; shift 2 ;;
        *)                  show_help ;;
    esac
done

if [ "$DEPLOY_KIRA_MIND_BOT" = false ] && [ "$DEPLOY_ADMIN_PANEL" = false ]; then
    show_help
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
DEPLOY_STARTED_AT=$(date '+%Y-%m-%d %H:%M:%S')

echo ""
echo "=============================================="
echo "  🚀 ДЕПЛОЙ — ${DEPLOY_STARTED_AT}"
echo "=============================================="
echo "📍 Сервер: ${SERVER_IP}"
echo "📦 Проекты:"
[ "$DEPLOY_KIRA_MIND_BOT" = true ]    && echo "  • kira-mind-bot"
[ "$DEPLOY_ADMIN_PANEL" = true ]      && echo "  • admin-panel"
echo "=============================================="
echo ""

rm -rf _deploy
mkdir -p _deploy

# ── Сборка kira-mind-bot ──────────────────────────────────────────────────────
if [ "$DEPLOY_KIRA_MIND_BOT" = true ]; then
    echo "🔨 Сборка kira-mind-bot (ASSISTANT_PROFILE=KiraMindBot)..."
    ASSISTANT_PROFILE=KiraMindBot npm run build

    mkdir -p _deploy/kira-mind-bot
    cp -r dist/* _deploy/kira-mind-bot
    cp Dockerfile package.json package-lock.json _deploy/kira-mind-bot/

    if [ -f ".env.production" ]; then
        cp .env.production _deploy/kira-mind-bot/
        echo "✅ Скопирован .env.production для kira-mind-bot"
    else
        echo "⚠️  .env.production не найден"
    fi
    rm -rf dist
fi

# ── Общие файлы ───────────────────────────────────────────────────────────────
echo ""
echo "📁 --- Подготовка архива ---"
cp docker-compose.yml _deploy/
cp personality.json.template _deploy/

if [ "$DEPLOY_ADMIN_PANEL" = true ] && [ -d "admin-panel" ]; then
    rsync -a --exclude='node_modules' --exclude='dist' admin-panel/ _deploy/admin-panel/
    echo "✅ Скопирована admin-panel"

    if [ -f ".env.production" ]; then
        mkdir -p _deploy/kira-mind-bot
        cp .env.production _deploy/kira-mind-bot/
        echo "✅ Скопирован .env.production для admin-panel"
    else
        echo "⚠️  .env.production не найден"
    fi
fi

# .env для docker-compose (DB_* переменные из .env.production)
if [ -f ".env.production" ]; then
    grep -E '^(DB_|NODE_ENV)' .env.production > _deploy/.env && echo "✅ Создан .env для docker-compose"
fi

echo "Содержимое _deploy: $(ls _deploy)"
echo ""

# ── Архив и отправка ──────────────────────────────────────────────────────────
echo "📦 Создание deployment-source.tar..."
tar -czf deployment-source.tar -C ./_deploy .
ARCHIVE_SIZE=$(du -h deployment-source.tar | cut -f1)
echo "📏 Размер архива: ${ARCHIVE_SIZE}"
echo ""

echo "⬆️  --- Загрузка на сервер ${SERVER_IP} ---"
scp deployment-source.tar root@${SERVER_IP}:/root/source
echo "✅ Загрузка завершена."
echo ""

# ── Выполнение на сервере ─────────────────────────────────────────────────────
echo "🖥️  --- Выполнение на сервере ---"
ssh root@${SERVER_IP} << EOF
  set -e

  cleanup_failed_build() {
    status="\$?"
    if [ "\$status" -ne 0 ]; then
      echo ""
      echo "🧹 Сборка прервана — очищаю Docker build cache, чтобы сервер не остался без места..."
      docker builder prune -af 2>/dev/null || true
      docker image prune -f 2>/dev/null || true
      df -h / | tail -1 || true
    fi
  }
  trap cleanup_failed_build EXIT

  cd /root/source

  echo ""
  echo "🖥️  === [Сервер] \$(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
  echo ""

  echo "💾 Диск и Docker до очистки:"
  df -h / | tail -1
  docker system df 2>/dev/null || true
  echo ""

  echo "🛑 Остановка деплоируемых сервисов..."
  stop_and_remove() {
    local name="\$1"
    docker-compose -f docker-compose.yml stop "\$name" 2>/dev/null && echo "  stop \$name: ok" || true
    docker-compose -f docker-compose.yml rm -f "\$name" 2>/dev/null && echo "  rm \$name: ok" || true
  }
  if [ "$DEPLOY_KIRA_MIND_BOT" = true ];    then stop_and_remove kira-mind-bot; fi
  if [ "$DEPLOY_ADMIN_PANEL" = true ];      then stop_and_remove admin-panel; fi
  echo ""

  echo "🗑️  Очистка Docker..."
  docker container prune -f 2>/dev/null || true
  FREE_MB=\$(df -Pm / | awk 'NR==2 {print \$4}')
  if [ "\${FREE_MB:-0}" -lt 2048 ]; then
    echo "  Свободно \${FREE_MB:-0} MB — выполняю полную очистку image/build cache."
    docker image prune -af 2>/dev/null || true
    docker builder prune -af 2>/dev/null || true
  else
    echo "  Свободно \${FREE_MB:-0} MB — сохраняю свежий build cache."
    docker image prune -f 2>/dev/null || true
    docker builder prune -f --filter until=168h 2>/dev/null || true
  fi
  df -h / | tail -1
  echo ""

  echo "📂 Распаковка архива..."
  tar -xzf deployment-source.tar
  rm deployment-source.tar
  ls -la
  echo ""

    if [ -f "/root/source/kira-mind-bot/.env.production" ]; then
      set -a; source /root/source/kira-mind-bot/.env.production; set +a
    fi
    KIRA_INSTANCE_NAME="\${KIRA_INSTANCE_NAME:-kira-mind-bot}"
    echo "KIRA_INSTANCE_NAME=\$KIRA_INSTANCE_NAME" > .env

    # personality.json — создаём из шаблона только при первом деплое, никогда не перезаписываем
  if [ ! -f "/root/source/personality.json" ]; then
    if [ -f "/root/source/personality.json.template" ]; then
      cp /root/source/personality.json.template /root/source/personality.json
      echo "✅ Создан personality.json из шаблона"
    else
      echo '{"KiraMindBot":{}}' > /root/source/personality.json
      echo "✅ Создан пустой personality.json"
    fi
  else
    echo "✅ personality.json уже существует — настройки сохранены"
  fi

  if [ "$DEPLOY_ADMIN_PANEL" = true ]; then
    # Учётные данные admin-panel
    ADMIN_STATE_FILE="/root/source/.kira-admin-state"
    if [ -f "\$ADMIN_STATE_FILE" ]; then
      set -a; source "\$ADMIN_STATE_FILE"; set +a
    fi
    if [ -z "\$ADMIN_PORT" ]; then
      ADMIN_PORT=\$(( (RANDOM % 2000) + 7000 ))
      echo "ADMIN_PORT=\$ADMIN_PORT" >> "\$ADMIN_STATE_FILE"
      echo "🔒 Сгенерирован порт admin-panel: \$ADMIN_PORT"
    fi
    if [ -z "\$ADMIN_PASSWORD" ]; then
      ADMIN_PASSWORD=\$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 20 2>/dev/null || openssl rand -hex 10)
      echo "ADMIN_PASSWORD=\$ADMIN_PASSWORD" >> "\$ADMIN_STATE_FILE"
      echo "🔒 Сгенерирован пароль admin-panel"
    fi
    if [ -z "\$ADMIN_USERNAME" ]; then
      ADMIN_USERNAME="admin"
      echo "ADMIN_USERNAME=\$ADMIN_USERNAME" >> "\$ADMIN_STATE_FILE"
    fi
    echo "ADMIN_PORT=\$ADMIN_PORT"         >> .env
    echo "ADMIN_USERNAME=\$ADMIN_USERNAME" >> .env
    echo "ADMIN_PASSWORD=\$ADMIN_PASSWORD" >> .env
    echo ""
  fi

  export NODE_ENV=production
  DEPLOYED_SERVICES=""

  deploy_service() {
    local name="\$1"
    echo "🚀 Деплой: \$name"
    docker-compose -f docker-compose.yml stop "\$name" 2>/dev/null || true
    docker-compose -f docker-compose.yml build "\$name"
    docker-compose -f docker-compose.yml up "\$name" -d
    echo "✅ \$name запущен."
    DEPLOYED_SERVICES="\$DEPLOYED_SERVICES \$name"
  }

  if [ "$DEPLOY_KIRA_MIND_BOT" = true ];    then deploy_service kira-mind-bot; fi
  if [ "$DEPLOY_ADMIN_PANEL" = true ];      then deploy_service admin-panel; fi

  echo ""
  echo "🧹 Очистка Docker cache после сборки..."
  docker image prune -f 2>/dev/null || true
  FREE_MB=\$(df -Pm / | awk 'NR==2 {print \$4}')
  if [ "\${FREE_MB:-0}" -lt 1536 ]; then
    echo "  Свободно \${FREE_MB:-0} MB — очищаю build cache."
    docker builder prune -af 2>/dev/null || true
  else
    echo "  Свободно \${FREE_MB:-0} MB — оставляю свежий build cache для следующего деплоя."
    docker builder prune -f --filter until=168h 2>/dev/null || true
  fi
  docker image prune -f 2>/dev/null || true
  docker system df 2>/dev/null || true

  echo ""
  echo "✔️  === Проверка сервисов ==="
  for svc in \$DEPLOYED_SERVICES; do
    [ -z "\$svc" ] && continue
    if docker-compose -f docker-compose.yml ps "\$svc" 2>/dev/null | grep -q "Up"; then
      echo "  ✅ \$svc — запущен"
    else
      echo "  ❌ \$svc не запущен"
      docker-compose -f docker-compose.yml logs --tail 20 "\$svc" 2>/dev/null || true
      exit 1
    fi
  done

  if [ "$DEPLOY_ADMIN_PANEL" = true ]; then
    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║        🌐 ПАНЕЛЬ УПРАВЛЕНИЯ              ║"
    echo "╠══════════════════════════════════════════╣"
    echo "║  URL:     http://${SERVER_IP}:\$ADMIN_PORT"
    echo "║  Логин:   \$ADMIN_USERNAME"
    echo "║  Пароль:  \$ADMIN_PASSWORD"
    echo "╚══════════════════════════════════════════╝"
  fi
  echo ""
  echo "🖥️  Деплой завершён: \$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
EOF

STATUS=$?
rm -f deployment-source.tar
rm -rf _deploy

if [ $STATUS -eq 0 ]; then
  echo ""
  echo "=============================================="
  echo "  ✅ Деплой завершён успешно."
  echo "  📅 ${DEPLOY_STARTED_AT} → $(date '+%Y-%m-%d %H:%M:%S')"
  echo "=============================================="
else
  echo "  ❌ Деплой завершился с ошибкой."
  exit 1
fi
