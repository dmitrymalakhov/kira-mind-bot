#!/bin/bash

SERVER_COMPOSE_FILE="${SERVER_COMPOSE_FILE:-docker-compose.server.yml}"
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_ENV_FILE="${COMPOSE_ENV_FILE:-.env}"
PERSONALITY_FILE="${PERSONALITY_FILE:-personality.json}"
ADMIN_STATE_FILE="${ADMIN_STATE_FILE:-.kira-admin-state}"
DEFAULT_ADMIN_USERNAME="${DEFAULT_ADMIN_USERNAME:-admin}"
ADMIN_PORT_FALLBACK="${ADMIN_PORT_FALLBACK:-8080}"
DEFAULT_KIRA_INSTANCE_NAME="${DEFAULT_KIRA_INSTANCE_NAME:-${PWD##*/}}"
COMPOSE_CMD=()
DOCKER_CMD=()
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/tmp/kira-mind-bot-deploy.lock}"

sanitize_instance_name() {
    local raw="${1:-kira-mind-bot}"
    local sanitized=""

    sanitized="$(printf '%s' "$raw" \
        | tr '[:upper:]' '[:lower:]' \
        | tr -cs 'a-z0-9_-' '-' \
        | sed -E 's/^-+//; s/-+$//; s/-{2,}/-/g')"

    if [[ ! "$sanitized" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
        sanitized="kira-mind-bot"
    fi

    printf '%s' "$sanitized"
}

resolve_instance_name() {
    sanitize_instance_name "${KIRA_INSTANCE_NAME:-$DEFAULT_KIRA_INSTANCE_NAME}"
}

resolve_instance_name_for_directory() {
    local configured_name="${1:-}"
    local directory="${2:-$PWD}"
    local directory_name=""

    if [ -n "$configured_name" ]; then
        sanitize_instance_name "$configured_name"
        return
    fi

    directory="${directory%/}"
    directory_name="${directory##*/}"
    sanitize_instance_name "${directory_name:-kira-mind-bot}"
}

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

docker_ps() {
    "${DOCKER_CMD[@]}" ps "$@"
}

docker_inspect() {
    "${DOCKER_CMD[@]}" inspect "$@"
}

acquire_deploy_lock() {
    command -v flock >/dev/null 2>&1 || return 0
    exec 9>"$DEPLOY_LOCK_FILE"
    if ! flock -n 9; then
        echo "Ошибка: другой install/deploy уже выполняется на этом хосте." >&2
        return 1
    fi
}

ensure_server_repo_root() {
    [ -f "$SERVER_COMPOSE_FILE" ] || return 1
    [ -f "package.json" ] || return 1
    [ -d "admin-panel" ] || return 1
}

load_key_value_file() {
    local file="$1"
    local line=""
    local key=""
    local value=""

    [ -f "$file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        line="${line%$'\r'}"
        case "$line" in
            ''|'#'*) continue ;;
        esac
        key="${line%%=*}"
        [ "$key" != "$line" ] || continue
        [[ "$key" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || continue
        value="${line#*=}"
        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
            value="${value:1:${#value}-2}"
        elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
            value="${value:1:${#value}-2}"
        fi
        printf -v "$key" '%s' "$value"
        export "$key"
    done < "$file"
}

load_env_if_present() {
    load_key_value_file "$ENV_FILE"
}

load_admin_state_if_present() {
    load_key_value_file "$ADMIN_STATE_FILE"
}

load_compose_env_if_present() {
    [ -f "$COMPOSE_ENV_FILE" ] || return 0

    local line=""
    local key=""
    local value=""
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ADMIN_PORT=*|ADMIN_USERNAME=*|ADMIN_PASSWORD=*)
                key="${line%%=*}"
                value="${line#*=}"
                case "$key" in
                    ADMIN_PORT) ADMIN_PORT="$value" ;;
                    ADMIN_USERNAME) ADMIN_USERNAME="$value" ;;
                    ADMIN_PASSWORD) ADMIN_PASSWORD="$value" ;;
                esac
                ;;
        esac
    done < "$COMPOSE_ENV_FILE"
}

generate_admin_password() {
    local password=""
    password="$(openssl rand -hex 10 2>/dev/null || true)"
    [ -n "$password" ] || return 1
    printf '%s' "$password"
}

save_admin_state() {
    cat > "$ADMIN_STATE_FILE" << EOF
ADMIN_PORT=${ADMIN_PORT}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
EOF
    chmod 600 "$ADMIN_STATE_FILE"
}

write_compose_env() {
    KIRA_INSTANCE_NAME="$(resolve_instance_name)"

    cat > "$COMPOSE_ENV_FILE" << EOF
KIRA_INSTANCE_NAME=${KIRA_INSTANCE_NAME}
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
    chmod 600 "$COMPOSE_ENV_FILE"

    ensure_working_directory_not_owned_by_other_project || return 1
    ensure_instance_not_owned_by_other_directory || return 1
    verify_existing_storage_bindings || return 1
}

ensure_working_directory_not_owned_by_other_project() {
    [ "${#DOCKER_CMD[@]}" -gt 0 ] || return 0

    local current_dir=""
    local container_id=""
    local owner_project=""
    current_dir="$(pwd -P)"

    while IFS= read -r container_id; do
        [ -n "$container_id" ] || continue
        owner_project="$(docker_inspect "$container_id" \
            --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
        if [ -n "$owner_project" ] && [ "$owner_project" != "$KIRA_INSTANCE_NAME" ]; then
            echo "Ошибка: каталог '$current_dir' уже принадлежит Docker Compose project '$owner_project'." >&2
            echo "Нельзя переключать его на '$KIRA_INSTANCE_NAME' без явной миграции storage." >&2
            return 1
        fi
    done < <(docker_ps -aq \
        --filter "label=com.docker.compose.project.working_dir=$current_dir")
}

ensure_instance_not_owned_by_other_directory() {
    [ "${#DOCKER_CMD[@]}" -gt 0 ] || return 0

    local current_dir=""
    local container_id=""
    local owner_dir=""
    current_dir="$(pwd -P)"

    while IFS= read -r container_id; do
        [ -n "$container_id" ] || continue
        owner_dir="$(docker_inspect "$container_id" \
            --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
        if [ -n "$owner_dir" ] && [ "$owner_dir" != "$current_dir" ]; then
            echo "Ошибка: Docker Compose project '$KIRA_INSTANCE_NAME' уже принадлежит каталогу '$owner_dir'." >&2
            echo "Задайте уникальный KIRA_INSTANCE_NAME для каталога '$current_dir'." >&2
            return 1
        fi
    done < <(docker_ps -aq --filter "label=com.docker.compose.project=$KIRA_INSTANCE_NAME")
}

validate_storage_mount() {
    local service="$1"
    local actual_mount="$2"
    local expected_volume="$3"

    if [ "$actual_mount" != "volume|$expected_volume" ]; then
        echo "Ошибка: сервис '$service' использует storage '$actual_mount', ожидался volume '$expected_volume'." >&2
        echo "Deploy остановлен до запуска Compose, чтобы не подключить пустую или чужую базу." >&2
        return 1
    fi
}

verify_storage_service_binding() {
    local service="$1"
    local destination="$2"
    local expected_volume="$3"
    local container_id=""
    local actual_mount=""

    while IFS= read -r container_id; do
        [ -n "$container_id" ] || continue
        actual_mount="$(docker_inspect "$container_id" \
            --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Type}}|{{.Name}}{{end}}{{end}}" \
            2>/dev/null || true)"
        validate_storage_mount "$service" "$actual_mount" "$expected_volume" || return 1
    done < <(docker_ps -aq \
        --filter "label=com.docker.compose.project=$KIRA_INSTANCE_NAME" \
        --filter "label=com.docker.compose.service=$service")
}

verify_existing_storage_bindings() {
    [ "${#DOCKER_CMD[@]}" -gt 0 ] || return 0

    verify_storage_service_binding \
        "postgres" \
        "/var/lib/postgresql/data" \
        "${KIRA_INSTANCE_NAME}_postgres_data" || return 1
    verify_storage_service_binding \
        "qdrant" \
        "/qdrant/storage" \
        "${KIRA_INSTANCE_NAME}_qdrant_storage" || return 1
}

admin_port_is_available_for_instance() {
    local port="$1"
    local instance_name=""
    local container_id=""
    local owner_project=""
    local docker_owner_found=false
    instance_name="$(resolve_instance_name)"

    [ "${#DOCKER_CMD[@]}" -gt 0 ] || return 0

    while IFS= read -r container_id; do
        [ -n "$container_id" ] || continue
        docker_owner_found=true
        owner_project="$(docker_inspect "$container_id" \
            --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
        if [ "$owner_project" != "$instance_name" ]; then
            return 1
        fi
    # Проверяем и остановленные контейнеры: они не слушают порт сейчас,
    # но могут занять его при следующем запуске чужого Compose-проекта.
    done < <(docker_ps -aq --filter "publish=$port")

    if [ "$docker_owner_found" = true ]; then
        return 0
    fi

    if host_port_has_listener "$port"; then
        return 1
    fi

    return 0
}

host_port_has_listener() {
    local port="$1"

    if command -v ss >/dev/null 2>&1; then
        ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .
        return
    fi

    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | grep -q .
        return
    fi

    if command -v netstat >/dev/null 2>&1; then
        netstat -an 2>/dev/null | grep -E "[.:]$port[[:space:]].*LISTEN" | grep -q .
        return
    fi

    return 1
}

find_available_admin_port() {
    local candidate=""
    local attempt=0
    while [ "$attempt" -lt 200 ]; do
        candidate=$(( (RANDOM % 2000) + 7000 ))
        if admin_port_is_available_for_instance "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
        attempt=$((attempt + 1))
    done

    return 1
}

ensure_admin_state() {
    # Старые установки хранили ADMIN_* только в compose .env. Сначала
    # импортируем их, чтобы первый redeploy не сменил порт и credentials.
    load_compose_env_if_present
    load_admin_state_if_present

    if [ -z "${ADMIN_PORT:-}" ]; then
        ADMIN_PORT="$(find_available_admin_port)"
    elif ! admin_port_is_available_for_instance "$ADMIN_PORT"; then
        if [ -f "$ADMIN_STATE_FILE" ]; then
            echo "Ошибка: ADMIN_PORT=$ADMIN_PORT уже занят другим Docker Compose project." >&2
            return 1
        fi
        ADMIN_PORT="$(find_available_admin_port)"
    fi

    if [ -z "${ADMIN_USERNAME:-}" ]; then
        ADMIN_USERNAME="$DEFAULT_ADMIN_USERNAME"
    fi

    if [ -z "${ADMIN_PASSWORD:-}" ]; then
        ADMIN_PASSWORD="$(generate_admin_password)"
    fi

    [ -n "$ADMIN_PASSWORD" ] || {
        echo "Ошибка: не удалось сгенерировать пароль админки." >&2
        return 1
    }

    save_admin_state
}

collect_app_services() {
    APP_SERVICES=("kira-mind-bot" "admin-panel")
}

safe_docker_cleanup() {
    # Глобальные prune-команды запрещены: на хосте могут жить другие инстансы.
    compose rm -f 2>/dev/null || true
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
