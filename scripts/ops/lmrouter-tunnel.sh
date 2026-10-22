#!/bin/sh
set -eu
exec ssh -N -T \
  -i /run/ssh/id_ed25519 \
  -o BatchMode=yes -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/run/ssh/known_hosts \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
  -L 0.0.0.0:8080:127.0.0.1:8080 \
  "${LMROUTER_SSH_USER:-root}@${LMROUTER_SSH_HOST:?}"
