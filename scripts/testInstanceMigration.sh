#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

REPO_DIR="$TEST_DIR/enya-mind-bot"
FAKE_BIN="$TEST_DIR/bin"
DOCKER_LOG="$TEST_DIR/docker.log"
DOCKER_STATE="$TEST_DIR/docker-down"
mkdir -p "$REPO_DIR/scripts/ops" "$REPO_DIR/admin-panel" "$FAKE_BIN"
cp "$SCRIPT_DIR/ops/server-common.sh" "$REPO_DIR/scripts/ops/server-common.sh"
cp "$SCRIPT_DIR/ops/server-deploy.sh" "$REPO_DIR/scripts/ops/server-deploy.sh"
cp "$SCRIPT_DIR/../docker-compose.server.yml" "$REPO_DIR/docker-compose.server.yml"
touch "$REPO_DIR/package.json"

cat > "$REPO_DIR/.env" <<'EOF'
KIRA_INSTANCE_NAME=kira-mind-bot
POSTGRES_VOLUME_NAME=kira-mind-bot_postgres_data
QDRANT_VOLUME_NAME=kira-mind-bot_qdrant_storage
DB_PASSWORD=db-secret
ADMIN_PORT=7875
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin-secret
EOF

cat > "$REPO_DIR/.env.production" <<'EOF'
TELEGRAM_BOT_TOKEN=telegram-secret
DB_PASSWORD=db-secret
OPENAI_API_KEY=openai-secret
EOF

cat > "$REPO_DIR/.kira-admin-state" <<'EOF'
ADMIN_PORT=7875
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin-secret
EOF

cat > "$FAKE_BIN/docker" <<'EOF'
#!/bin/bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"

if [ "${1:-}" = "compose" ] && [ "${2:-}" = "version" ]; then
    exit 0
fi

if [ "${1:-}" = "volume" ] && [ "${2:-}" = "inspect" ]; then
    case "${3:-}" in
        kira-mind-bot_postgres_data|kira-mind-bot_qdrant_storage) exit 0 ;;
        *) exit 1 ;;
    esac
fi

if [ "${1:-}" = "ps" ]; then
    [ -e "$FAKE_DOCKER_STATE" ] && exit 0
    case "$*" in
        *project=kira-mind-bot*service=postgres*) echo postgres-id ;;
        *project=kira-mind-bot*service=qdrant*) echo qdrant-id ;;
    esac
    exit 0
fi

if [ "${1:-}" = "inspect" ]; then
    case "${2:-}" in
        postgres-id) echo 'volume|kira-mind-bot_postgres_data' ;;
        qdrant-id) echo 'volume|kira-mind-bot_qdrant_storage' ;;
    esac
    exit 0
fi

if [ "${1:-}" = "compose" ] && [ "${2:-}" = "-f" ]; then
    case "${4:-}" in
        down)
            touch "$FAKE_DOCKER_STATE"
            ;;
        ps)
            if [ "${5:-}" = "--status" ] && [ "${6:-}" = "running" ]; then
                echo "${7:-}"
            fi
            ;;
    esac
    exit 0
fi

echo "unexpected docker invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/docker"

(
    cd "$REPO_DIR"
    PATH="$FAKE_BIN:$PATH" \
        FAKE_DOCKER_LOG="$DOCKER_LOG" \
        FAKE_DOCKER_STATE="$DOCKER_STATE" \
        DEPLOY_LOCK_FILE="$TEST_DIR/deploy.lock" \
        ./scripts/ops/server-deploy.sh migrate-instance enya-mind-bot
)

grep -q '^TELEGRAM_BOT_TOKEN=telegram-secret$' "$REPO_DIR/.env.production"
grep -q '^OPENAI_API_KEY=openai-secret$' "$REPO_DIR/.env.production"
grep -q '^KIRA_INSTANCE_NAME=enya-mind-bot$' "$REPO_DIR/.env.production"
grep -q '^POSTGRES_VOLUME_NAME=kira-mind-bot_postgres_data$' "$REPO_DIR/.env.production"
grep -q '^QDRANT_VOLUME_NAME=kira-mind-bot_qdrant_storage$' "$REPO_DIR/.env.production"

grep -q '^KIRA_INSTANCE_NAME=enya-mind-bot$' "$REPO_DIR/.env"
grep -q '^POSTGRES_VOLUME_NAME=kira-mind-bot_postgres_data$' "$REPO_DIR/.env"
grep -q '^QDRANT_VOLUME_NAME=kira-mind-bot_qdrant_storage$' "$REPO_DIR/.env"

grep -q '^compose -f docker-compose.server.yml down$' "$DOCKER_LOG"
if grep -Eq '(^| )(down .*--volumes|down .* -v|volume (rm|prune))($| )' "$DOCKER_LOG"; then
    echo "migration must never remove Docker volumes" >&2
    exit 1
fi

grep -q '^compose -f docker-compose.server.yml up -d postgres qdrant$' "$DOCKER_LOG"
grep -q '^compose -f docker-compose.server.yml up -d kira-mind-bot admin-panel$' "$DOCKER_LOG"

echo "instance migration integration test passed"
