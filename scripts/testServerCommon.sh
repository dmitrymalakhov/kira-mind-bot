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

cat > "$COMPOSE_ENV_FILE" <<'EOF'
ADMIN_PORT=7875
ADMIN_USERNAME=legacy-admin
ADMIN_PASSWORD=legacy-password
EOF

unset ADMIN_PORT ADMIN_USERNAME ADMIN_PASSWORD
ensure_admin_state

[ "$ADMIN_PORT" = "7875" ]
[ "$ADMIN_USERNAME" = "legacy-admin" ]
[ "$ADMIN_PASSWORD" = "legacy-password" ]
grep -q '^ADMIN_PORT=7875$' "$ADMIN_STATE_FILE"
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

echo "server-common admin state migration checks passed"
