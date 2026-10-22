#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
compose_args=(-f docker-compose.server.yml -f docker-compose.local.yml)
if [ -n "${SERVER_COMPOSE_OVERRIDE:-}" ]; then
  compose_args+=(-f "$SERVER_COMPOSE_OVERRIDE")
fi
exec docker compose "${compose_args[@]}" "$@"
