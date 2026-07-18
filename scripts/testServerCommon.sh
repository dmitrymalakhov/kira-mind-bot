#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

export COMPOSE_ENV_FILE="$TEST_DIR/.env"
export ADMIN_STATE_FILE="$TEST_DIR/.kira-admin-state"
export DEFAULT_ADMIN_USERNAME="admin"
export ADMIN_PORT_FALLBACK="8080"
export DEFAULT_KIRA_INSTANCE_NAME="kira-mind-bot"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/ops/server-common.sh"

find_available_admin_port() {
  printf '%s' "7999"
}

FAKE_MODE="port-collision"
DOCKER_CMD=(fake-docker)

docker_ps() {
  case "$FAKE_MODE:$*" in
    port-collision:*publish=7875*) echo "foreign-admin" ;;
    owner-conflict:*project=kira-second-bot*) echo "foreign-bot" ;;
    owner-ok:*project=kira-second-bot*) echo "own-bot" ;;
    directory-conflict:*working_dir=*) echo "legacy-bot" ;;
    directory-ok:*working_dir=*) echo "own-bot" ;;
    storage-ok:*service=postgres*) echo "postgres-id" ;;
    storage-ok:*service=qdrant*) echo "qdrant-id" ;;
    storage-bad:*service=postgres*) echo "postgres-id" ;;
    storage-bad:*service=qdrant*) echo "qdrant-id" ;;
  esac
}

docker_inspect() {
  case "$1" in
    foreign-admin) echo "foreign-project" ;;
    foreign-bot) echo "/opt/docker/foreign" ;;
    own-bot)
      if [[ "$*" == *'com.docker.compose.project.working_dir'* ]]; then
        pwd -P
      else
        echo "kira-second-bot"
      fi
      ;;
    legacy-bot) echo "source" ;;
    postgres-id)
      if [ "$FAKE_MODE" = "storage-bad" ]; then
        echo "volume|foreign_postgres_data"
      else
        echo "volume|kira-second-bot_postgres_data"
      fi
      ;;
    qdrant-id)
      if [ "$FAKE_MODE" = "storage-bad" ]; then
        echo "volume|foreign_qdrant_storage"
      else
        echo "volume|kira-second-bot_qdrant_storage"
      fi
      ;;
  esac
}

host_port_has_listener() {
  [ "${FAKE_HOST_PORT_BUSY:-false}" = true ]
}

ENV_FILE="$TEST_DIR/.env.production"
cat > "$ENV_FILE" <<EOF
SAFE_VALUE="value with spaces"
LITERAL_VALUE=\$(touch "$TEST_DIR/must-not-exist")
INVALID-KEY=ignored
EOF
load_env_if_present
[ "$SAFE_VALUE" = "value with spaces" ]
[ "$LITERAL_VALUE" = "\$(touch \"$TEST_DIR/must-not-exist\")" ]
[ ! -e "$TEST_DIR/must-not-exist" ]

cat > "$COMPOSE_ENV_FILE" <<'EOF'
ADMIN_PORT=7875
ADMIN_USERNAME=legacy-admin
ADMIN_PASSWORD=legacy-password
EOF

unset ADMIN_PORT ADMIN_USERNAME ADMIN_PASSWORD
ensure_admin_state

[ "$ADMIN_USERNAME" = "legacy-admin" ]
[ "$ADMIN_PASSWORD" = "legacy-password" ]
[ "$ADMIN_PORT" = "7999" ]
grep -q '^ADMIN_PORT=7999$' "$ADMIN_STATE_FILE"
grep -q '^ADMIN_USERNAME=legacy-admin$' "$ADMIN_STATE_FILE"
grep -q '^ADMIN_PASSWORD=legacy-password$' "$ADMIN_STATE_FILE"
STATE_MODE="$(stat -c '%a' "$ADMIN_STATE_FILE" 2>/dev/null || stat -f '%Lp' "$ADMIN_STATE_FILE")"
[ "$STATE_MODE" = "600" ]

KIRA_INSTANCE_NAME="kira-mind-bot"
DB_PASSWORD="db-password"
ADMIN_PORT="7999"
ADMIN_USERNAME="legacy-admin"
ADMIN_PASSWORD="legacy-password"
DOCKER_CMD=()
write_compose_env
COMPOSE_ENV_MODE="$(stat -c '%a' "$COMPOSE_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$COMPOSE_ENV_FILE")"
[ "$COMPOSE_ENV_MODE" = "600" ]
DOCKER_CMD=(fake-docker)

cat > "$ADMIN_STATE_FILE" <<'EOF'
ADMIN_PORT=7876
ADMIN_USERNAME=instance-admin
ADMIN_PASSWORD=instance-password
EOF

unset ADMIN_PORT ADMIN_USERNAME ADMIN_PASSWORD
ensure_admin_state

[ "$ADMIN_PORT" = "7876" ]
[ "$ADMIN_USERNAME" = "instance-admin" ]
[ "$ADMIN_PASSWORD" = "instance-password" ]

DEFAULT_KIRA_INSTANCE_NAME="Kira Second Bot"
unset KIRA_INSTANCE_NAME
[ "$(resolve_instance_name)" = "kira-second-bot" ]
[ "$(resolve_instance_name_for_directory "" "/root/source")" = "source" ]
[ "$(resolve_instance_name_for_directory "kira-primary" "/root/source")" = "kira-primary" ]
KIRA_INSTANCE_NAME="kira-second-bot"

FAKE_MODE="directory-conflict"
if ensure_working_directory_not_owned_by_other_project 2>/dev/null; then
  echo "working directory owned by another project must stop deploy" >&2
  exit 1
fi

FAKE_MODE="directory-ok"
ensure_working_directory_not_owned_by_other_project

FAKE_MODE="owner-conflict"
if ensure_instance_not_owned_by_other_directory 2>/dev/null; then
  echo "foreign project owner must stop deploy" >&2
  exit 1
fi

FAKE_MODE="owner-ok"
ensure_instance_not_owned_by_other_directory

FAKE_MODE="storage-ok"
verify_existing_storage_bindings

FAKE_MODE="storage-bad"
if verify_existing_storage_bindings 2>/dev/null; then
  echo "foreign storage volume must stop deploy" >&2
  exit 1
fi

FAKE_MODE="port-free"
FAKE_HOST_PORT_BUSY=true
if admin_port_is_available_for_instance "8123"; then
  echo "host listener must reserve admin port" >&2
  exit 1
fi
FAKE_HOST_PORT_BUSY=false
admin_port_is_available_for_instance "8123"

# Даже остановленный чужой контейнер с опубликованным портом должен блокировать
# выбор этого порта: после его запуска возникнет конфликт bind.
FAKE_MODE="port-collision"
if admin_port_is_available_for_instance "7875"; then
  echo "stopped foreign container must reserve admin port" >&2
  exit 1
fi

validate_storage_mount \
  "postgres" \
  "volume|kira-second-bot_postgres_data" \
  "kira-second-bot_postgres_data"

if validate_storage_mount \
  "qdrant" \
  "volume|kira-mind-bot_qdrant_storage" \
  "kira-second-bot_qdrant_storage" 2>/dev/null; then
  echo "storage mismatch must stop deploy" >&2
  exit 1
fi

# Занятый чужим проектом порт при существующем state-файле обязан блокировать deploy.
cat > "$ADMIN_STATE_FILE" <<'EOF'
ADMIN_PORT=7875
ADMIN_USERNAME=instance-admin
ADMIN_PASSWORD=instance-password
EOF
FAKE_MODE="port-collision"
ADMIN_PORT="7875"
if ensure_admin_state 2>/dev/null; then
  echo "busy admin port with existing state must stop deploy" >&2
  exit 1
fi

# Невалидное имя инстанса должно схлопываться в безопасный default.
KIRA_INSTANCE_NAME="!!!"
[ "$(resolve_instance_name)" = "kira-mind-bot" ]
KIRA_INSTANCE_NAME="---"
[ "$(resolve_instance_name)" = "kira-mind-bot" ]
KIRA_INSTANCE_NAME="kira-second-bot"

echo "server-common admin state migration checks passed"
