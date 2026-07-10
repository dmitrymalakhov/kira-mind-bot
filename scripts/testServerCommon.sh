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

admin_port_is_available_for_instance() {
  [ "$1" != "7875" ]
}

find_available_admin_port() {
  printf '%s' "7999"
}

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

echo "server-common admin state migration checks passed"
