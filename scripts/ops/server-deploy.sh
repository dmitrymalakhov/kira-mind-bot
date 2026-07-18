#!/bin/bash
# =============================================================================
# Kira Mind Bot — Redeploy и операционные команды на VPS
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}ℹ  $*${NC}"; }
success() { echo -e "${GREEN}✅ $*${NC}"; }
error()   { echo -e "${RED}❌ $*${NC}"; exit 1; }
header()  { echo -e "\n${BOLD}${BLUE}── $* ──────────────────────────────────────${NC}"; }

show_help() {
    cat <<'EOF'
Usage:
  ./scripts/ops/server-deploy.sh deploy [--clean]
  ./scripts/ops/server-deploy.sh status
  ./scripts/ops/server-deploy.sh logs [-f|--follow] [--no-postgres] [--no-qdrant] [service]
  ./scripts/ops/server-deploy.sh pause [service]
  ./scripts/ops/server-deploy.sh restart [service]
  ./scripts/ops/server-deploy.sh stop [service]
  ./scripts/ops/server-deploy.sh migrate-instance <new-name>
  ./scripts/ops/server-deploy.sh help

Commands:
  deploy        Redeploy app-сервисы на VPS. По умолчанию использует Docker cache.
  status        Показать статус сервисов из docker-compose.server.yml.
  logs          Показать последние логи всего стека или одного сервиса.
  pause         Остановить app-сервисы или один конкретный сервис, не трогая зависимости.
  restart       Перезапустить app-сервисы или один конкретный сервис.
  stop          Остановить весь стек или один конкретный сервис без удаления volumes.
  migrate-instance
                Переименовать Compose project/контейнер, сохранив текущие PostgreSQL/Qdrant volumes.
  help          Показать эту справку.

Options:
  --clean       Для deploy: выполнить down и безопасную Docker-очистку перед rebuild.
  -f, --follow  Для logs: следить за логами в реальном времени.
  --no-postgres Для logs: исключить postgres из общего вывода логов.
  --no-qdrant   Для logs: исключить qdrant из общего вывода логов.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

COMMAND="${1:-help}"
shift || true

if [ "$COMMAND" = "help" ]; then
    show_help
    exit 0
fi

# shellcheck disable=SC1091
source "$SCRIPT_DIR/server-common.sh"

ensure_server_repo_root || error "Не найден серверный compose-сценарий в корне репозитория"
resolve_compose_cmd || error "Docker Compose недоступен для текущего пользователя"

DEPLOY_CLEAN=false
TARGET_SERVICE=""
FOLLOW_LOGS=false
EXCLUDE_POSTGRES_LOGS=false
EXCLUDE_QDRANT_LOGS=false
MIGRATION_TARGET_INSTANCE=""

validate_service_name() {
    local service="$1"

    if ! compose config --services | grep -Fxq "$service"; then
        error "Сервис $service не найден в $SERVER_COMPOSE_FILE"
    fi
}

case "$COMMAND" in
    deploy)
        while [[ $# -gt 0 ]]; do
            case "$1" in
                --clean) DEPLOY_CLEAN=true; shift ;;
                *) error "Неизвестный аргумент для deploy: $1" ;;
            esac
        done
        ;;
    logs)
        while [[ $# -gt 0 ]]; do
            case "$1" in
                -f|--follow)
                    FOLLOW_LOGS=true
                    shift
                    ;;
                --no-postgres)
                    EXCLUDE_POSTGRES_LOGS=true
                    shift
                    ;;
                --no-qdrant)
                    EXCLUDE_QDRANT_LOGS=true
                    shift
                    ;;
                *)
                    if [[ -n "$TARGET_SERVICE" ]]; then
                        error "Слишком много аргументов для команды logs"
                    fi
                    TARGET_SERVICE="$1"
                    shift
                    ;;
            esac
        done
        ;;
    pause|restart|stop)
        if [[ $# -gt 1 ]]; then
            error "Слишком много аргументов для команды $COMMAND"
        fi
        TARGET_SERVICE="${1:-}"
        ;;
    migrate-instance)
        if [ "$#" -ne 1 ]; then
            error "Использование: $0 migrate-instance <new-name>"
        fi
        MIGRATION_TARGET_INSTANCE="$1"
        if [ "$(sanitize_instance_name "$MIGRATION_TARGET_INSTANCE")" != "$MIGRATION_TARGET_INSTANCE" ]; then
            error "Имя инстанса должно содержать только a-z, 0-9, _ и - и начинаться с буквы или цифры"
        fi
        ;;
    status|help)
        if [[ $# -gt 0 ]]; then
            error "Команда $COMMAND не принимает аргументы"
        fi
        ;;
    *)
        error "Неизвестная команда: $COMMAND"
        ;;
esac

case "$COMMAND" in
    status|logs)
        # Read-only команды не должны блокироваться параллельным deploy и не
        # должны переписывать .env/state перед чтением статуса или логов.
        ;;
    *)
        acquire_deploy_lock || error "Не удалось получить deploy lock"
        load_compose_identity_if_present
        load_env_if_present
        ensure_admin_state
        if [ "$COMMAND" != "migrate-instance" ]; then
            write_compose_env
        fi
        collect_app_services
        ;;
esac

deploy_stack() {
    header "Redeploy"

    if [ "$DEPLOY_CLEAN" = true ]; then
        info "Останавливаю стек и очищаю Docker cache без удаления volumes"
        compose down
        safe_docker_cleanup
    fi

    info "Поднимаю зависимости"
    compose up -d postgres qdrant

    info "Пересобираю app-сервисы с использованием cache"
    compose build "${APP_SERVICES[@]}"

    info "Запускаю app-сервисы"
    compose up -d "${APP_SERVICES[@]}"

    if ! verify_services_running postgres qdrant "${APP_SERVICES[@]}"; then
        error "Не все сервисы успешно запустились"
    fi

    success "Redeploy завершён"
    show_admin_panel_access "$(detect_host_ip)"
}

migrate_instance() {
    local source_instance=""
    local source_postgres_volume=""
    local source_qdrant_volume=""

    source_instance="${COMPOSE_STATE_KIRA_INSTANCE_NAME:-$(resolve_instance_name)}"
    source_postgres_volume="${COMPOSE_STATE_POSTGRES_VOLUME_NAME:-${source_instance}_postgres_data}"
    source_qdrant_volume="${COMPOSE_STATE_QDRANT_VOLUME_NAME:-${source_instance}_qdrant_storage}"
    validate_volume_name "$source_postgres_volume" || error "Некорректное имя PostgreSQL volume"
    validate_volume_name "$source_qdrant_volume" || error "Некорректное имя Qdrant volume"

    if [ "$source_instance" = "$MIGRATION_TARGET_INSTANCE" ]; then
        error "Инстанс уже называется '$MIGRATION_TARGET_INSTANCE'"
    fi

    ensure_volume_exists "$source_postgres_volume" || error "Исходный PostgreSQL storage недоступен"
    ensure_volume_exists "$source_qdrant_volume" || error "Исходный Qdrant storage недоступен"
    KIRA_INSTANCE_NAME="$source_instance"
    POSTGRES_VOLUME_NAME="$source_postgres_volume"
    QDRANT_VOLUME_NAME="$source_qdrant_volume"
    verify_existing_storage_bindings || error "Текущие контейнеры подключены не к ожидаемому storage"
    ensure_project_name_available "$MIGRATION_TARGET_INSTANCE" || error "Целевое имя уже занято"

    header "Миграция имени инстанса"
    info "Останавливаю project '$source_instance' без удаления volumes"
    compose down

    write_instance_storage_config \
        "$ENV_FILE" \
        "$MIGRATION_TARGET_INSTANCE" \
        "$source_postgres_volume" \
        "$source_qdrant_volume" || error "Не удалось атомарно обновить $ENV_FILE"

    KIRA_INSTANCE_NAME="$MIGRATION_TARGET_INSTANCE"
    POSTGRES_VOLUME_NAME="$source_postgres_volume"
    QDRANT_VOLUME_NAME="$source_qdrant_volume"
    export KIRA_INSTANCE_NAME POSTGRES_VOLUME_NAME QDRANT_VOLUME_NAME
    write_compose_env || error "Новый Compose preflight не пройден"

    success "Storage сохранён: PostgreSQL=$source_postgres_volume, Qdrant=$source_qdrant_volume"
    deploy_stack
}

show_logs() {
    local args=(logs --tail 100)
    local services=()
    local service_name=""

    if [ "$FOLLOW_LOGS" = true ]; then
        args+=(--follow)
    fi

    if [ -n "$TARGET_SERVICE" ]; then
        validate_service_name "$TARGET_SERVICE"
        args+=("$TARGET_SERVICE")
        compose "${args[@]}"
        return
    fi

    if [ "$EXCLUDE_POSTGRES_LOGS" = true ] || [ "$EXCLUDE_QDRANT_LOGS" = true ]; then
        while IFS= read -r service_name; do
            if [ -z "$service_name" ]; then
                continue
            fi

            if [ "$EXCLUDE_POSTGRES_LOGS" = true ] && [ "$service_name" = "postgres" ]; then
                continue
            fi

            if [ "$EXCLUDE_QDRANT_LOGS" = true ] && [ "$service_name" = "qdrant" ]; then
                continue
            fi

            services+=("$service_name")
        done < <(compose config --services)

        if [ "${#services[@]}" -eq 0 ]; then
            error "Не удалось сформировать список сервисов после исключения логов"
        fi
        args+=("${services[@]}")
    fi

    compose "${args[@]}"
}

pause_services() {
    header "Pause"

    if [ -n "$TARGET_SERVICE" ]; then
        validate_service_name "$TARGET_SERVICE"
        compose stop "$TARGET_SERVICE"
        success "Сервис $TARGET_SERVICE поставлен на паузу"
        return
    fi

    compose stop "${APP_SERVICES[@]}"
    success "App-сервисы поставлены на паузу; postgres и qdrant продолжают работать"
}

restart_services() {
    header "Restart"

    if [ -n "$TARGET_SERVICE" ]; then
        validate_service_name "$TARGET_SERVICE"
        compose restart "$TARGET_SERVICE"
        if ! verify_services_running "$TARGET_SERVICE"; then
            error "Сервис $TARGET_SERVICE не запустился после restart"
        fi
        success "Сервис $TARGET_SERVICE перезапущен"
        return
    fi

    compose restart "${APP_SERVICES[@]}"
    if ! verify_services_running "${APP_SERVICES[@]}"; then
        error "Не все app-сервисы запустились после restart"
    fi
    success "App-сервисы перезапущены"
}

stop_services() {
    header "Stop"

    if [ -n "$TARGET_SERVICE" ]; then
        validate_service_name "$TARGET_SERVICE"
        compose stop "$TARGET_SERVICE"
        success "Сервис $TARGET_SERVICE остановлен"
        return
    fi

    compose stop
    success "Весь стек остановлен"
}

case "$COMMAND" in
    deploy) deploy_stack ;;
    status) compose ps ;;
    logs) show_logs ;;
    pause) pause_services ;;
    restart) restart_services ;;
    stop) stop_services ;;
    migrate-instance) migrate_instance ;;
esac
