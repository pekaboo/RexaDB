# RexaDB single-container image:
#   - Express sidecar (bun) on 127.0.0.1:3867 (in-container)
#   - static + /api gateway on 0.0.0.0:7181 (docker/static-proxy.ts)
#   - SQLite state in /data (mount a volume to persist connections/relations)
FROM oven/bun:1 AS build
WORKDIR /app

# Build-time public env (placeholders keep next build happy; real Supabase
# auth needs proper values — set as build args if you use cloud sync).
ENV NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install

COPY . .
RUN bun run build

# ── runtime ───────────────────────────────────────────────────────────
FROM oven/bun:1
WORKDIR /app

ENV NODE_ENV=production \
    REXADB_SERVER_PORT=3867 \
    REXADB_PROXY_PORT=7181 \
    REXADB_USER_DATA_DIR=/data

COPY --from=build /app /app
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data

EXPOSE 7181
VOLUME /data
ENTRYPOINT ["/entrypoint.sh"]
