#!/bin/bash
# =============================================================================
# Kira Mind Bot — Установщик
#
# Использование:
#   ./install.sh --server-ip <IP>
#
# Что делает:
#   1. Устанавливает Docker на VPS (если не установлен)
#   2. Интерактивно собирает все необходимые ключи
#   3. Генерирует .env.production
#   4. Деплоит бота
# =============================================================================

set -e

# ── Цвета ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}ℹ  $*${NC}"; }
success() { echo -e "${GREEN}✅ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠️  $*${NC}"; }
error()   { echo -e "${RED}❌ $*${NC}"; exit 1; }
header()  { echo -e "\n${BOLD}${BLUE}── $* ──────────────────────────────────────${NC}"; }
ask()     { echo -e "${BOLD}$1${NC}"; }

# ── Аргументы ─────────────────────────────────────────────────────────────────
SERVER_IP=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --server-ip) SERVER_IP="$2"; shift 2 ;;
        *) echo "Usage: $0 --server-ip <IP>"; exit 1 ;;
    esac
done

echo -e "\n${BOLD}${BLUE}"
echo "  ██╗  ██╗██╗██████╗  █████╗     ███╗   ███╗██╗███╗   ██╗██████╗ "
echo "  ██║ ██╔╝██║██╔══██╗██╔══██╗    ████╗ ████║██║████╗  ██║██╔══██╗"
echo "  █████╔╝ ██║██████╔╝███████║    ██╔████╔██║██║██╔██╗ ██║██║  ██║"
echo "  ██╔═██╗ ██║██╔══██╗██╔══██║    ██║╚██╔╝██║██║██║╚██╗██║██║  ██║"
echo "  ██║  ██╗██║██║  ██║██║  ██║    ██║ ╚═╝ ██║██║██║ ╚████║██████╔╝"
echo "  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═════╝ "
echo -e "${NC}"
echo -e "${BOLD}  Установщик Kira Mind Bot${NC}\n"

# ── IP адрес ──────────────────────────────────────────────────────────────────
if [ -z "$SERVER_IP" ]; then
    ask "IP адрес твоего VPS:"
    read -r SERVER_IP
fi
[ -z "$SERVER_IP" ] && error "IP адрес не указан"
info "Сервер: $SERVER_IP"

# ── Проверка SSH ──────────────────────────────────────────────────────────────
header "Проверка SSH соединения"
if ! ssh -o ConnectTimeout=5 -o BatchMode=yes root@"$SERVER_IP" 'exit' 2>/dev/null; then
    warn "SSH-ключ не настроен или сервер недоступен."
    echo ""
    echo "Настрой SSH-доступ по ключу:"
    echo "  ssh-copy-id root@$SERVER_IP"
    echo ""
    ask "После настройки нажми Enter для продолжения..."
    read -r
    ssh -o ConnectTimeout=5 root@"$SERVER_IP" 'exit' || error "Не удалось подключиться к $SERVER_IP"
fi
success "SSH соединение установлено"

# ── Docker на VPS ─────────────────────────────────────────────────────────────
header "Проверка Docker на VPS"
DOCKER_OK=$(ssh root@"$SERVER_IP" 'command -v docker && docker compose version 2>/dev/null && echo OK || echo NO' 2>/dev/null | tail -1)

if [ "$DOCKER_OK" != "OK" ]; then
    info "Docker не найден. Устанавливаю..."
    ssh root@"$SERVER_IP" bash << 'REMOTE'
        set -e
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq ca-certificates curl gnupg
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
        chmod a+r /etc/apt/keyrings/docker.gpg
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
            https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
            > /etc/apt/sources.list.d/docker.list
        apt-get update -qq
        apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
        systemctl enable --now docker
        echo "✅ Docker установлен: $(docker --version)"
REMOTE
    success "Docker установлен"
else
    success "Docker уже установлен"
fi

# ── Создание рабочей директории на VPS ────────────────────────────────────────
ssh root@"$SERVER_IP" 'mkdir -p /root/source'

# ── Сбор конфигурации ─────────────────────────────────────────────────────────
header "Настройка бота"
echo ""
echo "Отвечай на вопросы ниже. Обязательные поля отмечены [*]."
echo "Опциональные можно оставить пустыми — бот будет работать без них."
echo ""

prompt_required() {
    local VAR="$1" LABEL="$2" HINT="$3"
    local VAL=""
    while [ -z "$VAL" ]; do
        [ -n "$HINT" ] && echo -e "  ${YELLOW}→ $HINT${NC}"
        read -r -p "  $LABEL [*]: " VAL
        [ -z "$VAL" ] && echo -e "  ${RED}Обязательное поле!${NC}"
    done
    eval "$VAR=\"$VAL\""
}

prompt_optional() {
    local VAR="$1" LABEL="$2" HINT="$3"
    [ -n "$HINT" ] && echo -e "  ${YELLOW}→ $HINT${NC}"
    read -r -p "  $LABEL (опционально): " VAL
    eval "$VAR=\"$VAL\""
}

prompt_default() {
    local VAR="$1" LABEL="$2" DEFAULT="$3"
    read -r -p "  $LABEL [$DEFAULT]: " VAL
    eval "$VAR=\"${VAL:-$DEFAULT}\""
}

# OpenAI
echo -e "\n${BOLD}OpenAI${NC}"
prompt_required OPENAI_API_KEY "OpenAI API Key" "https://platform.openai.com/api-keys"

# Telegram Bot
echo -e "\n${BOLD}Telegram Bot${NC}"
prompt_required KIRA_BOT_TOKEN "Токен бота" "Создать: напиши @BotFather → /newbot"
prompt_required KIRA_ALLOWED_USER_ID "Твой Telegram User ID" "Узнать: напиши @userinfobot"

# Владелец
echo -e "\n${BOLD}Имя владельца бота${NC}"
prompt_default OWNER_NAME "Как тебя зовут (для бота)" "Пользователь"

# DB
echo -e "\n${BOLD}База данных${NC}"
DB_PASSWORD=$(cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | head -c 24)
echo -e "  ${GREEN}Пароль БД сгенерирован автоматически${NC}"

# Опциональные
echo -e "\n${BOLD}Опциональные интеграции${NC}"
prompt_optional GOOGLE_MAPS_API_KEY "Google Maps API Key" "https://console.cloud.google.com → Maps JavaScript API"
prompt_optional IDEOGRAM_API_KEY "Ideogram API Key" "https://ideogram.ai/manage-api"

# Telegram User Client
echo -e "\n${BOLD}Telegram User Client (чтение входящих сообщений)${NC}"
echo -e "  ${YELLOW}→ Нужен только если хочешь чтобы бот видел твои переписки${NC}"
read -r -p "  Настроить? (y/N): " SETUP_TG_CLIENT
if [[ "$SETUP_TG_CLIENT" =~ ^[Yy]$ ]]; then
    prompt_required TELEGRAM_API_ID "API ID" "https://my.telegram.org/apps → создай приложение"
    prompt_required TELEGRAM_API_HASH "API Hash" ""
    echo -e "\n  ${YELLOW}Для получения Session String запусти:${NC}"
    echo -e "  ${BOLD}./scripts/get-telegram-session.sh${NC}"
    echo -e "  и вставь полученную строку:"
    read -r -p "  TELEGRAM_SESSION_STRING: " TELEGRAM_SESSION_STRING
fi

# Часовой пояс
echo -e "\n${BOLD}Настройки${NC}"
prompt_default USER_TIMEZONE "Часовой пояс" "Europe/Moscow"

# ── Запись .env.production ────────────────────────────────────────────────────
header "Создание .env.production"

ENV_FILE="$(dirname "$0")/.env.production"

cat > "$ENV_FILE" << EOF
# Сгенерировано install.sh $(date '+%Y-%m-%d %H:%M:%S')

OPENAI_API_KEY=${OPENAI_API_KEY}

KIRA_BOT_TOKEN=${KIRA_BOT_TOKEN}
KIRA_ALLOWED_USER_ID=${KIRA_ALLOWED_USER_ID}
SERGEY_BOT_TOKEN=${SERGEY_BOT_TOKEN:-}
SERGEY_ALLOWED_USER_ID=${SERGEY_ALLOWED_USER_ID:-}

DB_HOST=postgres
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=KiraMind

VECTOR_PROVIDER=qdrant
QDRANT_URL=http://qdrant:6333

USER_TIMEZONE=${USER_TIMEZONE}

KIRA_PROACTIVE_ENABLED=true
KIRA_PROACTIVE_INTERVAL_MS=86400000
KIRA_PROACTIVE_QUIET_HOURS_ENABLED=true
KIRA_PROACTIVE_QUIET_HOUR_START=23
KIRA_PROACTIVE_QUIET_HOUR_END=8
DM_REPORT_ENABLED=true
DM_REPORT_INTERVAL_MS=1800000
DM_REPORT_QUIET_HOURS_ENABLED=true
MEMORY_INSIGHT_ENABLED=true
MEMORY_INSIGHT_INTERVAL_MS=10800000
PROACTIVE_ONLY_PRIVATE_CHAT=true
GROUP_PUBLIC_MODE=false
EOF

if [ -n "${GOOGLE_MAPS_API_KEY:-}" ]; then
    echo "GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY}" >> "$ENV_FILE"
fi
if [ -n "${IDEOGRAM_API_KEY:-}" ]; then
    echo "IDEOGRAM_API_KEY=${IDEOGRAM_API_KEY}" >> "$ENV_FILE"
fi
if [ -n "${TELEGRAM_API_ID:-}" ]; then
    echo "TELEGRAM_API_ID=${TELEGRAM_API_ID}" >> "$ENV_FILE"
    echo "TELEGRAM_API_HASH=${TELEGRAM_API_HASH}" >> "$ENV_FILE"
fi
if [ -n "${TELEGRAM_SESSION_STRING:-}" ]; then
    echo "TELEGRAM_SESSION_STRING=${TELEGRAM_SESSION_STRING}" >> "$ENV_FILE"
fi

success ".env.production создан"

# ── Personality.json для имени владельца ──────────────────────────────────────
PERSONALITY_FILE="$(dirname "$0")/personality.json"
if [ ! -f "$PERSONALITY_FILE" ]; then
    cat > "$PERSONALITY_FILE" << EOF
{
  "KiraMindBot": {
    "ownerName": "${OWNER_NAME}",
    "userName": "${OWNER_NAME}"
  },
  "SergeyBrainBot": {}
}
EOF
    success "personality.json создан"
fi

# ── Деплой ────────────────────────────────────────────────────────────────────
header "Деплой"
info "Запускаю deploy.sh..."
echo ""

chmod +x "$(dirname "$0")/deploy.sh"
"$(dirname "$0")/deploy.sh" --kira-mind-bot --server-ip "$SERVER_IP"
