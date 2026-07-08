#!/bin/sh
set -eu

cd /app

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/node_modules /home/cricket /tmp/.npm /tmp/.cache /tmp/.config
  chown -R cricket:cricket /app/node_modules /home/cricket /tmp/.npm /tmp/.cache /tmp/.config
  exec gosu cricket "$0" "$@"
fi

if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.sha ] \
  || [ "$(sha256sum package-lock.json | awk '{print $1}')" != "$(cat node_modules/.package-lock.sha 2>/dev/null || true)" ]; then
  npm ci
  sha256sum package-lock.json | awk '{print $1}' > node_modules/.package-lock.sha
fi

exec "$@"
