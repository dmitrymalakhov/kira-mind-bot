#!/bin/bash
# =============================================================================
# Kira Mind Bot — Установка и деплой прямо на VPS
#
# Использование:
#   ./server-install.sh
#   ./server-install.sh --skip-config
#   ./server-install.sh --with-sergey
#
# Что делает:
#   1. Проверяет Docker и docker compose на самой VPS
#   2. Проверяет доступность Xray SOCKS5 на 172.17.0.1:10808
#   3. Генерирует или обновляет .env.production
#   4. Создаёт personality.json при первом запуске
#   5. Собирает и запускает контейнеры локально через docker compose
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}ℹ  $*${NC}"; }
success() { echo -e "${GREEN}✅ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠️  $*${NC}"; }
error()   { echo -e "${RED}❌ $*${NC}"; exit 1; }
header()  { echo -e "\n${BOLD}${BLUE}── $* ──────────────────────────────────────${NC}"; }

SKIP_CONFIG=false
DEPLOY_SERGEY=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-config) SKIP_CONFIG=true; shift ;;
        --with-sergey) DEPLOY_SERGEY=true; shift ;;
        *) echo "Usage: $0 [--skip-config] [--with-sergey]"; exit 1 ;;
    esac
done

cd "$(dirname "$0")"

ENV_FILE=".env.production"
COMPOSE_ENV_FILE=".env"
PERSONALITY_FILE="personality.json"
ADMIN_STATE_FILE="${HOME}/.kira-admin-state"
SERVER_COMPOSE_FILE="docker-compose.server.yml"

ensure_repo_root() {
    [ -f "$SERVER_COMPOSE_FILE" ] || error "Не найден $SERVER_COMPOSE_FILE в корне репозитория"
    [ -f "package.json" ] || error "Не найден package.json в текущей директории"
    [ -d "admin-panel" ] || error "Не найдена директория admin-panel"
}

prompt_required_default() {
    local VAR="$1" LABEL="$2" DEFAULT="${3:-}" HINT="${4:-}"
    local VAL=""
    while [ -z "$VAL" ]; do
        [ -n "$HINT" ] && echo -e "  ${YELLOW}→ $HINT${NC}"
        if [ -n "$DEFAULT" ]; then
            read -r -p "  $LABEL [$DEFAULT]: " VAL
            VAL="${VAL:-$DEFAULT}"
        else
            read -r -p "  $LABEL [*]: " VAL
        fi
        [ -z "$VAL" ] && echo -e "  ${RED}Обязательное поле!${NC}"
    done
    eval "$VAR=\"\$VAL\""
}

prompt_optional_default() {
    local VAR="$1" LABEL="$2" DEFAULT="${3:-}" HINT="${4:-}"
    local VAL=""
    [ -n "$HINT" ] && echo -e "  ${YELLOW}→ $HINT${NC}"
    if [ -n "$DEFAULT" ]; then
        read -r -p "  $LABEL [$DEFAULT]: " VAL
        VAL="${VAL:-$DEFAULT}"
    else
        read -r -p "  $LABEL (опционально): " VAL
    fi
    eval "$VAR=\"\$VAL\""
}

prompt_default() {
    local VAR="$1" LABEL="$2" DEFAULT="$3"
    local VAL=""
    read -r -p "  $LABEL [$DEFAULT]: " VAL
    eval "$VAR=\"${VAL:-$DEFAULT}\""
}

load_existing_env() {
    if [ -f "$ENV_FILE" ]; then
        set -a
        # shellcheck disable=SC1090
        source "$ENV_FILE"
        set +a
        info "Найден существующий $ENV_FILE, использую текущие значения как defaults"
    fi
}

load_admin_state() {
    if [ -f "$ADMIN_STATE_FILE" ]; then
        set -a
        # shellcheck disable=SC1090
        source "$ADMIN_STATE_FILE"
        set +a
    fi
}

save_admin_state() {
    cat > "$ADMIN_STATE_FILE" << EOF
ADMIN_PORT=${ADMIN_PORT}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
}

write_compose_env() {
    cat > "$COMPOSE_ENV_FILE" << EOF
DB_HOST=postgres
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=KiraMind
NODE_ENV=production
HTTP_PROXY=${HTTP_PROXY}
HTTPS_PROXY=${HTTPS_PROXY}
ALL_PROXY=${ALL_PROXY}
NO_PROXY=${NO_PROXY}
ADMIN_PORT=${ADMIN_PORT}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
}

write_env_production() {
    cat > "$ENV_FILE" << EOF
# Сгенерировано server-install.sh $(date '+%Y-%m-%d %H:%M:%S')

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

HTTP_PROXY=${HTTP_PROXY}
HTTPS_PROXY=${HTTPS_PROXY}
ALL_PROXY=${ALL_PROXY}
NO_PROXY=${NO_PROXY}

KIRA_PROACTIVE_ENABLED=true
KIRA_PROACTIVE_INTERVAL_MS=86400000
KIRA_PROACTIVE_QUIET_HOURS_ENABLED=true
KIRA_PROACTIVE_QUIET_HOUR_START=23
KIRA_PROACTIVE_QUIET_HOUR_END=8
DM_REPORT_ENABLED=true
DM_REPORT_INTERVAL_MS=1800000
DM_REPORT_QUIET_HOURS_ENABLED=true
INBOX_GUARDIAN_ENABLED=true
INBOX_GUARDIAN_HOUR=21
INBOX_GUARDIAN_LOOKBACK_HOURS=24
INBOX_GUARDIAN_MIN_AGE_MINUTES=60
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
    if [ -n "${ELEVENLABS_API_KEY:-}" ]; then
        cat >> "$ENV_FILE" << EOF
ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY}
ELEVENLABS_VOICE_NAME=Nastya
ELEVENLABS_MODEL_ID=eleven_v3
ELEVENLABS_OUTPUT_FORMAT=mp3_44100_128
ELEVENLABS_VOICE_STABILITY=0.5
EOF
    fi
    if [ -n "${ELEVENLABS_VOICE_ID:-}" ]; then
        echo "ELEVENLABS_VOICE_ID=${ELEVENLABS_VOICE_ID}" >> "$ENV_FILE"
    fi
    if [ -n "${TELEGRAM_API_ID:-}" ]; then
        echo "TELEGRAM_API_ID=${TELEGRAM_API_ID}" >> "$ENV_FILE"
        echo "TELEGRAM_API_HASH=${TELEGRAM_API_HASH}" >> "$ENV_FILE"
    fi
    if [ -n "${TELEGRAM_SESSION_STRING:-}" ]; then
        echo "TELEGRAM_SESSION_STRING=${TELEGRAM_SESSION_STRING}" >> "$ENV_FILE"
    fi
}

ensure_personality_file() {
    if [ ! -f "$PERSONALITY_FILE" ]; then
        cat > "$PERSONALITY_FILE" << EOF
{
  "KiraMindBot": {
    "persona": "",
    "communicationStyle": "",
    "biography": "",
    "ownerName": "${OWNER_NAME}",
    "ownerUsername": "",
    "userName": "${OWNER_NAME}",
    "userBirthDate": "",
    "moodVariants": "",
    "defaultMood": "",
    "proactiveMessageHint": ""
  },
  "SergeyBrainBot": {
    "persona": "",
    "communicationStyle": "",
    "biography": "",
    "ownerName": "",
    "ownerUsername": "",
    "userName": "",
    "userBirthDate": "",
    "moodVariants": "",
    "defaultMood": "",
    "proactiveMessageHint": ""
  }
}
EOF
        success "personality.json создан"
    else
        info "personality.json уже существует, не перезаписываю"
    fi
}

ensure_docker() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD=(docker compose -f "$SERVER_COMPOSE_FILE")
        success "Docker уже доступен"
        return
    fi

    local SUDO=""
    if [ "$(id -u)" -eq 0 ]; then
        SUDO=""
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        SUDO="sudo"
    else
        error "Docker не установлен и у текущего пользователя нет root/sudo для установки"
    fi

    header "Установка Docker"
    export DEBIAN_FRONTEND=noninteractive
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq ca-certificates curl gnupg
    $SUDO install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
    $SUDO apt-get update -qq
    $SUDO apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    $SUDO systemctl enable --now docker

    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD=(docker compose -f "$SERVER_COMPOSE_FILE")
    else
        COMPOSE_CMD=(sudo docker compose -f "$SERVER_COMPOSE_FILE")
    fi
    success "Docker установлен"
}

compose() {
    "${COMPOSE_CMD[@]}" "$@"
}

verify_proxy_endpoint() {
    header "Проверка Xray SOCKS5"
    if ! (exec 3<>/dev/tcp/172.17.0.1/10808) >/dev/null 2>&1; then
        error "Xray SOCKS5 недоступен на 172.17.0.1:10808. Подними Xray на хосте и проверь схему с HTTP_PROXY/HTTPS_PROXY/ALL_PROXY перед запуском."
    fi
    success "Xray SOCKS5 доступен на 172.17.0.1:10808"
}

collect_config() {
    header "Настройка бота"
    echo ""
    echo "Отвечай на вопросы ниже. Обязательные поля отмечены [*]."
    echo "VPN через Xray обязателен и будет записан в .env.production."
    echo ""

    echo -e "\n${BOLD}OpenAI${NC}"
    prompt_required_default OPENAI_API_KEY "OpenAI API Key" "${OPENAI_API_KEY:-}" "https://platform.openai.com/api-keys"

    echo -e "\n${BOLD}Telegram Bot${NC}"
    prompt_required_default KIRA_BOT_TOKEN "Токен бота" "${KIRA_BOT_TOKEN:-}" "Создать: напиши @BotFather → /newbot"
    prompt_required_default KIRA_ALLOWED_USER_ID "Твой Telegram User ID" "${KIRA_ALLOWED_USER_ID:-}" "Узнать: напиши @userinfobot"

    echo -e "\n${BOLD}Имя владельца бота${NC}"
    prompt_default OWNER_NAME "Как тебя зовут (для бота)" "${OWNER_NAME:-Пользователь}"

    if [ -n "${DB_PASSWORD:-}" ]; then
        info "Использую существующий пароль БД из $ENV_FILE"
    else
        DB_PASSWORD=$(cat /dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | head -c 24)
        info "Пароль БД сгенерирован автоматически"
    fi

    echo -e "\n${BOLD}Опциональные интеграции${NC}"
    prompt_optional_default GOOGLE_MAPS_API_KEY "Google Maps API Key" "${GOOGLE_MAPS_API_KEY:-}" "https://console.cloud.google.com → Maps JavaScript API"
    prompt_optional_default IDEOGRAM_API_KEY "Ideogram API Key" "${IDEOGRAM_API_KEY:-}" "https://ideogram.ai/manage-api"
    prompt_optional_default ELEVENLABS_API_KEY "ElevenLabs API Key" "${ELEVENLABS_API_KEY:-}" "https://elevenlabs.io/app/settings/api-keys"
    if [ -n "${ELEVENLABS_API_KEY:-}" ]; then
        prompt_optional_default ELEVENLABS_VOICE_ID "ElevenLabs Voice ID (Nastya)" "${ELEVENLABS_VOICE_ID:-}" "Можно оставить пустым: бот найдёт голос по имени Nastya через /v2/voices"
    fi

    echo -e "\n${BOLD}Telegram User Client (чтение входящих сообщений)${NC}"
    echo -e "  ${YELLOW}→ Нужен только если хочешь чтобы бот видел твои переписки${NC}"
    local TG_DEFAULT="N"
    if [ -n "${TELEGRAM_API_ID:-}" ] || [ -n "${TELEGRAM_SESSION_STRING:-}" ]; then
        TG_DEFAULT="Y"
    fi
    read -r -p "  Настроить? (${TG_DEFAULT}/n): " SETUP_TG_CLIENT
    SETUP_TG_CLIENT="${SETUP_TG_CLIENT:-$TG_DEFAULT}"
    if [[ "$SETUP_TG_CLIENT" =~ ^[Yy]$ ]]; then
        prompt_required_default TELEGRAM_API_ID "API ID" "${TELEGRAM_API_ID:-}" "https://my.telegram.org/apps → создай приложение"
        prompt_required_default TELEGRAM_API_HASH "API Hash" "${TELEGRAM_API_HASH:-}" ""
        prompt_optional_default TELEGRAM_SESSION_STRING "TELEGRAM_SESSION_STRING" "${TELEGRAM_SESSION_STRING:-}" "Можно вставить позже через панель управления или вручную в .env.production"
    else
        TELEGRAM_API_ID=""
        TELEGRAM_API_HASH=""
        TELEGRAM_SESSION_STRING=""
    fi

    echo -e "\n${BOLD}Настройки${NC}"
    prompt_default USER_TIMEZONE "Часовой пояс" "${USER_TIMEZONE:-Europe/Moscow}"

    echo -e "\n${BOLD}Обязательный VPN через Xray${NC}"
    prompt_default ALL_PROXY "SOCKS5 URL" "${ALL_PROXY:-socks5h://172.17.0.1:10808}"
    HTTP_PROXY="$ALL_PROXY"
    HTTPS_PROXY="$ALL_PROXY"
    prompt_default NO_PROXY "NO_PROXY" "${NO_PROXY:-localhost,127.0.0.1,postgres,qdrant}"
}

validate_existing_config() {
    [ -f "$ENV_FILE" ] || error "Флаг --skip-config требует существующий $ENV_FILE"
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    [ -n "${OPENAI_API_KEY:-}" ] || error "В $ENV_FILE отсутствует OPENAI_API_KEY"
    [ -n "${KIRA_BOT_TOKEN:-}" ] || error "В $ENV_FILE отсутствует KIRA_BOT_TOKEN"
    [ -n "${KIRA_ALLOWED_USER_ID:-}" ] || error "В $ENV_FILE отсутствует KIRA_ALLOWED_USER_ID"
    [ -n "${DB_PASSWORD:-}" ] || error "В $ENV_FILE отсутствует DB_PASSWORD"
    [ -n "${ALL_PROXY:-}" ] || error "В $ENV_FILE отсутствует ALL_PROXY. VPN-конфиг обязателен."
    [ -n "${HTTP_PROXY:-}" ] || error "В $ENV_FILE отсутствует HTTP_PROXY. VPN-конфиг обязателен."
    [ -n "${HTTPS_PROXY:-}" ] || error "В $ENV_FILE отсутствует HTTPS_PROXY. VPN-конфиг обязателен."
    [ -n "${NO_PROXY:-}" ] || error "В $ENV_FILE отсутствует NO_PROXY. VPN-конфиг обязателен."
}

ensure_admin_state() {
    load_admin_state
    if [ -z "${ADMIN_PORT:-}" ]; then
        ADMIN_PORT=$(( (RANDOM % 2000) + 7000 ))
    fi
    if [ -z "${ADMIN_USERNAME:-}" ]; then
        ADMIN_USERNAME="admin"
    fi
    if [ -z "${ADMIN_PASSWORD:-}" ]; then
        ADMIN_PASSWORD=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 20 2>/dev/null || openssl rand -hex 10)
    fi
    save_admin_state
}

deploy_stack() {
    header "Деплой"

    local app_services=("kira-mind-bot" "admin-panel")
    if [ "$DEPLOY_SERGEY" = true ]; then
        app_services+=("sergey-brain-bot")
    fi

    compose up -d postgres qdrant
    compose stop "${app_services[@]}" 2>/dev/null || true
    compose build --no-cache "${app_services[@]}"
    compose up -d "${app_services[@]}"

    for svc in postgres qdrant "${app_services[@]}"; do
        if ! compose ps "$svc" 2>/dev/null | grep -q "Up"; then
            compose logs --tail 40 "$svc" 2>/dev/null || true
            error "Сервис $svc не запустился"
        fi
    done

    success "Сервисы успешно запущены"

    local HOST_IP
    HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    HOST_IP=${HOST_IP:-YOUR_VPS_IP}

    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║        🌐 ПАНЕЛЬ УПРАВЛЕНИЯ              ║"
    echo "╠══════════════════════════════════════════╣"
    echo "║  URL:     http://${HOST_IP}:${ADMIN_PORT}"
    echo "║  Логин:   ${ADMIN_USERNAME}"
    echo "║  Пароль:  ${ADMIN_PASSWORD}"
    echo "╚══════════════════════════════════════════╝"
}

echo -e "\n${BOLD}${BLUE}"
echo "  ██╗  ██╗██╗██████╗  █████╗     ███╗   ███╗██╗███╗   ██╗██████╗ "
echo "  ██║ ██╔╝██║██╔══██╗██╔══██╗    ████╗ ████║██║████╗  ██║██╔══██╗"
echo "  █████╔╝ ██║██████╔╝███████║    ██╔████╔██║██║██╔██╗ ██║██║  ██║"
echo "  ██╔═██╗ ██║██╔══██╗██╔══██║    ██║╚██╔╝██║██║██║╚██╗██║██║  ██║"
echo "  ██║  ██╗██║██║  ██║██║  ██║    ██║ ╚═╝ ██║██║██║ ╚████║██████╔╝"
echo "  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝╚═╝  ╚═╝    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═════╝ "
echo -e "${NC}"
echo -e "${BOLD}  Установка Kira Mind Bot прямо на VPS${NC}\n"

ensure_repo_root
ensure_docker
verify_proxy_endpoint

if [ "$SKIP_CONFIG" = true ]; then
    validate_existing_config
    info "Использую существующий $ENV_FILE без интерактивного обновления"
else
    load_existing_env
    collect_config
    write_env_production
    success "$ENV_FILE обновлён"
fi

ensure_admin_state
write_compose_env
ensure_personality_file
deploy_stack
