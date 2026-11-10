ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

RUN mkdir -p /etc/supabase/pgredis-tenants \
    && chown bun:bun /etc/supabase/pgredis-tenants

COPY packages/management-api ./packages/management-api
COPY packages/delivery ./packages/delivery
COPY packages/db ./packages/db
COPY packages/contracts ./packages/contracts
COPY scripts/copy-dual-declarations.mjs ./scripts/copy-dual-declarations.mjs
COPY packages/supacloud-js ./packages/supacloud-js
COPY packages/worker/scripts/roles.ts packages/worker/scripts/scheduler.ts packages/worker/scripts/control.ts ./packages/worker/scripts/
COPY packages/web-console ./packages/web-console
COPY --chmod=0755 scripts/lib/postgres_major_upgrade_executor.sh /opt/supacloud/scripts/lib/postgres_major_upgrade_executor.sh
COPY --chmod=0755 scripts/lib/postgres_major_upgrade_provider.sh /opt/supacloud/scripts/lib/postgres_major_upgrade_provider.sh
COPY --chmod=0755 podman/self-host/management-api-entrypoint.sh /usr/local/bin/supacloud-management-entrypoint

RUN cd /app/packages/contracts && bun install --frozen-lockfile && bun --bun run build
RUN cd /app/packages/db && bun install --frozen-lockfile && bun --bun run build
RUN cd /app/packages/delivery && bun install --frozen-lockfile
RUN cd /app/packages/management-api && bun install --frozen-lockfile
RUN cd /app/packages/web-console && bun install --frozen-lockfile && bun --bun run build

WORKDIR /app/packages/management-api

EXPOSE 9090

ENV PORT=9090
ENV NODE_ENV=production

ENTRYPOINT ["/usr/local/bin/supacloud-management-entrypoint"]
