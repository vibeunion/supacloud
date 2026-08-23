ARG BUN_VERSION=1.4.0
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

COPY packages/pgredis-runtime/package.json packages/pgredis-runtime/bun.lock ./
RUN bun install --frozen-lockfile

COPY packages/pgredis-runtime ./

RUN mkdir -p /etc/supabase/pgredis-tenants \
    && chown -R bun:bun /app /etc/supabase/pgredis-tenants

ENV NODE_ENV=production
ENV PGREDIS_RUNTIME_HOST=0.0.0.0
ENV PGREDIS_RUNTIME_PORT=9010

USER bun

CMD ["bun", "run", "server.ts"]
