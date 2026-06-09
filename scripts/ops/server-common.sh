#!/bin/bash

SERVER_COMPOSE_FILE="${SERVER_COMPOSE_FILE:-docker-compose.server.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env}"
PERSONALITY_FILE="${PERSONALITY_FILE:-personality.json}"
ADMIN_STATE_FILE="${ADMIN_STATE_FILE:-${HOME}/.kira-admin-state}"
DEFAULT_ADMIN_USERNAME="${DEFAULT_ADMIN_USERNAME:-admin}"
ADMIN_PORT_FALLBACK="${ADMIN_PORT_FALLBACK:-8080}"
COMPOSE_CMD=()
DOCKER_CMD=()

resolve_compose_cmd() {
    if docker compose version >/dev/null 2>&1; then
        DOCKER_CMD=(docker)
        COMPOSE_CMD=(docker compose -f "$SERVER_COMPOSE_FILE")
        return 0
    fi

    if command -v sudo >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
        DOCKER_CMD=(sudo docker)
        COMPOSE_CMD=(sudo docker compose -f "$SERVER_COMPOSE_FILE")
        return 0
    fi

    return 1
}

compose() {
    "${COMPOSE_CMD[@]}" "$@"
}

ensure_server_repo_root() {
    [ -f "$SERVER_COMPOSE_FILE" ] || return 1
    [ -f "package.json" ] || return 1
    [ -d "admin-panel" ] || return 1
}

load_env_if_present() {
    if [ -f "$ENV_FILE" ]; then
        set -a
        # shellcheck disable=SC1090
        source "$ENV_FILE"
        set +a
    fi
}

load_admin_state_if_present() {
    if [ -f "$ADMIN_STATE_FILE" ]; then
        set -a
        # shellcheck disable=SC1090
        source "$ADMIN_STATE_FILE"
        set +a
    fi
}

generate_admin_password() {
    cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 20 2>/dev/null || openssl rand -hex 10
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
ADMIN_PORT=${ADMIN_PORT}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
}

ensure_admin_state() {
    load_admin_state_if_present

    if [ -z "${ADMIN_PORT:-}" ]; then
        ADMIN_PORT=$(( (RANDOM % 2000) + 7000 ))
    fi

    if [ -z "${ADMIN_USERNAME:-}" ]; then
        ADMIN_USERNAME="$DEFAULT_ADMIN_USERNAME"
    fi

    if [ -z "${ADMIN_PASSWORD:-}" ]; then
        ADMIN_PASSWORD="$(generate_admin_password)"
    fi

    save_admin_state
}

collect_app_services() {
    APP_SERVICES=("kira-mind-bot" "admin-panel")
}

safe_docker_cleanup() {
    "${DOCKER_CMD[@]}" image prune -af
    "${DOCKER_CMD[@]}" builder prune -af
    "${DOCKER_CMD[@]}" container prune -f
}

service_is_running() {
    local service="$1"
    compose ps --status running "$service" 2>/dev/null | grep -q "$service"
}

verify_services_running() {
    local services=("$@")
    local service
    for service in "${services[@]}"; do
        if ! service_is_running "$service"; then
            compose logs --tail 40 "$service" 2>/dev/null || true
            return 1
        fi
    done

    return 0
}

detect_linux_host_ip() {
    local host_ip=""

    if command -v hostname >/dev/null 2>&1; then
        host_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    fi

    if [ -z "$host_ip" ] && command -v ip >/dev/null 2>&1; then
        host_ip=$(ip route get 1 2>/dev/null | awk '/src/ {for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}')
    fi

    echo "$host_ip"
}

detect_macos_host_ip() {
    local default_iface=""

    if ! command -v route >/dev/null 2>&1 || ! command -v ifconfig >/dev/null 2>&1; then
        return
    fi

    default_iface=$(route get default 2>/dev/null | awk '/interface: / {print $2; exit}')
    if [ -z "$default_iface" ]; then
        return
    fi

    ifconfig "$default_iface" 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}'
}

detect_host_ip() {
    local os_name=""
    local host_ip=""

    os_name=$(uname -s 2>/dev/null || echo "")

    case "$os_name" in
        Darwin)
            host_ip=$(detect_macos_host_ip)
            ;;
        Linux)
            host_ip=$(detect_linux_host_ip)
            ;;
    esac

    if [ -z "$host_ip" ]; then
        case "$os_name" in
            Darwin)
                host_ip=$(detect_linux_host_ip)
                ;;
            Linux)
                host_ip=$(detect_macos_host_ip)
                ;;
        esac
    fi

    echo "${host_ip:-localhost}"
}

show_admin_panel_access() {
    local host_ip="$1"
    local admin_port="${ADMIN_PORT:-$ADMIN_PORT_FALLBACK}"
    local admin_username="${ADMIN_USERNAME:-$DEFAULT_ADMIN_USERNAME}"
    local admin_password="${ADMIN_PASSWORD:-changeme}"

    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║        🌐 ПАНЕЛЬ УПРАВЛЕНИЯ              ║"
    echo "╠══════════════════════════════════════════╣"
    echo "║  URL:     http://${host_ip}:${admin_port}"
    echo "║  Логин:   ${admin_username}"
    echo "║  Пароль:  ${admin_password}"
    echo "╚══════════════════════════════════════════╝"
}
