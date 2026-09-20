#!/bin/sh
set -e

# Inject the runtime API base override into every exported HTML page so the
# browser issues same-origin /api calls (the gateway proxies them to the
# sidecar). window.location.origin keeps it absolute — new URL(path, base)
# in actions-client requires an absolute base, and it adapts to whatever
# host/port the user opened the app on.
if [ ! -f /app/out/runtime-api.js ]; then
  echo 'window.__REXADB_API_BASE__=window.location.origin;' > /app/out/runtime-api.js
  find /app/out -name index.html -type f | while read -r html; do
    grep -q runtime-api.js "$html" || sed -i 's|</head>|<script src="/runtime-api.js"></script></head>|' "$html"
  done
fi

mkdir -p "$REXADB_USER_DATA_DIR"

# Express sidecar (internal 127.0.0.1:3867)
bun run server/index.ts &
SIDECAR_PID=$!

# Static + /api gateway (public 0.0.0.0:7181)
bun run docker/static-proxy.ts &
PROXY_PID=$!

term() {
  kill "$SIDECAR_PID" "$PROXY_PID" 2>/dev/null
  exit 0
}
trap term TERM INT

wait
