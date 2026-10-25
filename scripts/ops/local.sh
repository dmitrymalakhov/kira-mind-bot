#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Check instance/storage identity before any Compose operation, just like VPS deploys.
source scripts/ops/server-common.sh
load_compose_identity_if_present
KIRA_INSTANCE_NAME="$(resolve_instance_name)"
export KIRA_INSTANCE_NAME
DOCKER_CMD=(docker)
ensure_working_directory_not_owned_by_other_project
ensure_instance_not_owned_by_other_directory
verify_existing_storage_bindings

# Keep the API mapping on later `up` calls without exporting private .env values.
api_publish="${KIRA_API_PUBLISH:-}"
if [ -z "$api_publish" ] && [ -f .env ]; then
  while IFS='=' read -r key value || [ -n "$key" ]; do
    if [ "$key" = KIRA_API_PUBLISH ]; then
      api_publish="${value%$'\r'}"
      api_publish="${api_publish#\"}"; api_publish="${api_publish%\"}"
      api_publish="${api_publish#\'}"; api_publish="${api_publish%\'}"
    fi
  done < .env
fi
compose_args=(-f docker-compose.server.yml -f docker-compose.local.yml)
accounts_mode="${KIRA_ACCOUNTS_MODE:-}"
if [ -z "$accounts_mode" ] && [ -f .env ]; then
  accounts_mode="$(sed -n 's/^KIRA_ACCOUNTS_MODE=//p' .env | tail -n 1 | tr -d '\r\"\047')"
fi
if [ "$accounts_mode" = true ]; then
  compose_args+=(-f docker-compose.accounts.yml)
elif [ -n "${SERVER_COMPOSE_OVERRIDE:-}" ]; then
  compose_args+=(-f "$SERVER_COMPOSE_OVERRIDE")
elif [ "$api_publish" = true ]; then
  compose_args+=(-f docker-compose.api.yml)
fi
exec docker compose "${compose_args[@]}" "$@"
