#!/bin/bash
# TypeScript компилируется локально — на сервер уходит уже готовый JS.
# Требования на локальной машине: Node.js, npm, ssh, scp.

show_help() {
    echo "Usage: $0 [--kira-mind-bot] [--admin-panel] [--server-ip <ip>] [--remote-dir <path>]"
    echo
    echo "Options:"
    echo "  --kira-mind-bot              Deploy the Kira-Mind bot"
    echo "  --admin-panel                Deploy the admin panel"
    echo "  --server-ip <ip>             Target server IP address (обязательный)"
    echo "  --remote-dir <path>          Отдельный каталог инстанса на сервере"
    exit 1
}

DEPLOY_KIRA_MIND_BOT=false
DEPLOY_ADMIN_PANEL=false
SERVER_IP=""
REMOTE_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --kira-mind-bot)    DEPLOY_KIRA_MIND_BOT=true; shift ;;
        --admin-panel)      DEPLOY_ADMIN_PANEL=true; shift ;;
        --server-ip)        SERVER_IP="$2"; shift 2 ;;
        --remote-dir)       REMOTE_DIR="$2"; shift 2 ;;
        *)                  show_help ;;
    esac
done

if [ "$DEPLOY_KIRA_MIND_BOT" = false ] && [ "$DEPLOY_ADMIN_PANEL" = false ]; then
    show_help
fi

if [ -z "$SERVER_IP" ]; then
    echo "❌ Не указан --server-ip: целевой адрес VPS обязателен." >&2
    show_help
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"
DEPLOY_STARTED_AT=$(date '+%Y-%m-%d %H:%M:%S')

# shellcheck disable=SC1091
source "$SCRIPT_DIR/server-common.sh"
CONFIGURED_KIRA_INSTANCE_NAME="$(grep -E '^KIRA_INSTANCE_NAME=' .env.production 2>/dev/null | tail -1 | cut -d= -f2- || true)"
if [ -z "$REMOTE_DIR" ]; then
    if [ -z "$CONFIGURED_KIRA_INSTANCE_NAME" ] || [ "$(sanitize_instance_name "$CONFIGURED_KIRA_INSTANCE_NAME")" = "kira-mind-bot" ]; then
        REMOTE_DIR="/root/source"
    else
        REMOTE_DIR="/opt/docker/$(sanitize_instance_name "$CONFIGURED_KIRA_INSTANCE_NAME")"
    fi
fi
if ! validate_remote_deploy_directory "$REMOTE_DIR"; then
    echo "❌ Недопустимый remote-каталог: $REMOTE_DIR" >&2
    exit 1
fi
KIRA_INSTANCE_NAME="$(resolve_instance_name_for_directory "$CONFIGURED_KIRA_INSTANCE_NAME" "$REMOTE_DIR")"

echo ""
echo "=============================================="
echo "  🚀 ДЕПЛОЙ — ${DEPLOY_STARTED_AT}"
echo "=============================================="
echo "📍 Сервер: ${SERVER_IP}"
echo "📁 Каталог: ${REMOTE_DIR}"
echo "🔖 Инстанс: ${KIRA_INSTANCE_NAME}"
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
mkdir -p _deploy/scripts/ops
cp scripts/ops/server-common.sh _deploy/scripts/ops/

if [ "$DEPLOY_ADMIN_PANEL" = true ] && [ -d "admin-panel" ]; then
    rsync -a --exclude='node_modules' --exclude='dist' admin-panel/ _deploy/admin-panel/
    rsync -a ai/ _deploy/ai/
    mkdir -p _deploy/utils
    cp utils/legacyPersonalitySanitizer.js _deploy/utils/
    echo "✅ Скопирована admin-panel"

    if [ -f ".env.production" ]; then
        mkdir -p _deploy/kira-mind-bot
        cp .env.production _deploy/kira-mind-bot/
        echo "✅ Скопирован .env.production для admin-panel"
    else
        echo "⚠️  .env.production не найден"
    fi
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
ssh root@"${SERVER_IP}" "mkdir -p '$REMOTE_DIR'"
scp deployment-source.tar root@${SERVER_IP}:"$REMOTE_DIR/deployment-source.tar"
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
      echo "⚠️  Сборка прервана; глобальная Docker-очистка не выполняется, чтобы не затронуть соседние инстансы."
      df -h / | tail -1 || true
    fi
  }
  trap cleanup_failed_build EXIT

  cd "$REMOTE_DIR"

  echo ""
  echo "🖥️  === [Сервер] \$(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="
  echo ""

  echo "💾 Диск и Docker:"
  df -h / | tail -1
  docker system df 2>/dev/null || true
  echo ""

  echo "📂 Распаковка архива..."
  tar -xzf deployment-source.tar
  rm deployment-source.tar
  ls -la
  echo ""

  export SERVER_COMPOSE_FILE="docker-compose.yml"
  export ENV_FILE="kira-mind-bot/.env.production"
  export COMPOSE_ENV_FILE=".env"
  export ADMIN_STATE_FILE=".kira-admin-state"
  export DEFAULT_KIRA_INSTANCE_NAME="$KIRA_INSTANCE_NAME"
  source ./scripts/ops/server-common.sh
  resolve_compose_cmd || { echo "❌ Docker Compose недоступен"; exit 1; }
  acquire_deploy_lock || { echo "❌ Другой deploy уже выполняется"; exit 1; }
  load_compose_identity_if_present
  load_env_if_present
  ensure_admin_state
  write_compose_env

    # personality.json — создаём из шаблона только при первом деплое, никогда не перезаписываем
  if [ ! -f "$REMOTE_DIR/personality.json" ]; then
    if [ -f "$REMOTE_DIR/personality.json.template" ]; then
      cp "$REMOTE_DIR/personality.json.template" "$REMOTE_DIR/personality.json"
      echo "✅ Создан personality.json из шаблона"
    else
      echo '{"KiraMindBot":{}}' > "$REMOTE_DIR/personality.json"
      echo "✅ Создан пустой personality.json"
    fi
  else
    echo "✅ personality.json уже существует — настройки сохранены"
  fi

  export NODE_ENV=production
  DEPLOYED_SERVICES=""

  deploy_service() {
    local name="\$1"
    echo "🚀 Деплой: \$name"
    compose build "\$name"
    compose up "\$name" -d
    echo "✅ \$name запущен."
    DEPLOYED_SERVICES="\$DEPLOYED_SERVICES \$name"
  }

  if [ "$DEPLOY_KIRA_MIND_BOT" = true ];    then deploy_service kira-mind-bot; fi
  if [ "$DEPLOY_ADMIN_PANEL" = true ];      then deploy_service admin-panel; fi

  echo ""
  echo "🧹 Глобальная Docker-очистка пропущена: соседние инстансы не затрагиваются."
  docker system df 2>/dev/null || true

  echo ""
  echo "✔️  === Проверка сервисов ==="
  for svc in \$DEPLOYED_SERVICES; do
    [ -z "\$svc" ] && continue
    if compose ps --status running "\$svc" 2>/dev/null | grep -q "\$svc"; then
      echo "  ✅ \$svc — запущен"
    else
      echo "  ❌ \$svc не запущен"
      compose logs --tail 20 "\$svc" 2>/dev/null || true
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
