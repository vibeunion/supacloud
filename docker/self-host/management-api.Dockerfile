ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/management-api/package.json ./packages/management-api/package.json
COPY packages/web-console/package.json ./packages/web-console/package.json

RUN bun install

RUN mkdir -p /etc/supabase/pgredis-tenants \
    && chown bun:bun /etc/supabase/pgredis-tenants

COPY packages/management-api ./packages/management-api
COPY packages/web-console ./packages/web-console
COPY --chmod=0755 docker/self-host/management-api-entrypoint.sh /usr/local/bin/supacloud-management-entrypoint

RUN cd /app/packages/web-console && bun install && bun run build

WORKDIR /app/packages/management-api

EXPOSE 9090

ENV PORT=9090
ENV NODE_ENV=production

ENTRYPOINT ["/usr/local/bin/supacloud-management-entrypoint"]
