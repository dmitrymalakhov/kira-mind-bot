#!/bin/bash

SERVER_COMPOSE_FILE="${SERVER_COMPOSE_FILE:-docker-compose.server.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env}"
PERSONALITY_FILE="${PERSONALITY_FILE:-personality.json}"
ADMIN_STATE_FILE="${ADMIN_STATE_FILE:-${HOME}/.kira-admin-state}"
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

sergey_enabled() {
    if [ "${DEPLOY_SERGEY:-false}" = "true" ]; then
        return 0
    fi

    load_env_if_present
    [ -n "${SERGEY_BOT_TOKEN:-}" ]
}

collect_app_services() {
    APP_SERVICES=("kira-mind-bot" "admin-panel")
    if sergey_enabled; then
        APP_SERVICES+=("sergey-brain-bot")
    fi
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

detect_host_ip() {
    local host_ip
    host_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo "${host_ip:-YOUR_VPS_IP}"
}

show_admin_panel_access() {
    local host_ip="$1"

    echo ""
    echo "╔══════════════════════════════════════════╗"
    echo "║        🌐 ПАНЕЛЬ УПРАВЛЕНИЯ              ║"
    echo "╠══════════════════════════════════════════╣"
    echo "║  URL:     http://${host_ip}:${ADMIN_PORT}"
    echo "║  Логин:   ${ADMIN_USERNAME}"
    echo "║  Пароль:  ${ADMIN_PASSWORD}"
    echo "╚══════════════════════════════════════════╝"
}
