ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock* ./
COPY packages/management-api/package.json ./packages/management-api/
COPY packages/delivery/package.json ./packages/delivery/
COPY packages/db/package.json ./packages/db/
COPY packages/contracts/package.json ./packages/contracts/

# Install dependencies
RUN bun install

RUN mkdir -p /etc/supabase/pgredis-tenants \
    && chown bun:bun /etc/supabase/pgredis-tenants

# Copy source code
COPY packages/management-api ./packages/management-api
COPY packages/delivery ./packages/delivery
COPY packages/db ./packages/db
COPY packages/contracts ./packages/contracts
COPY --chmod=0755 scripts/lib/postgres_major_upgrade_executor.sh /opt/supacloud/scripts/lib/postgres_major_upgrade_executor.sh
COPY --chmod=0755 scripts/lib/postgres_major_upgrade_provider.sh /opt/supacloud/scripts/lib/postgres_major_upgrade_provider.sh

WORKDIR /app/packages/management-api

# Build local workspace dependencies, then install from their built artifacts.
RUN cd /app/packages/contracts && bun install --frozen-lockfile && bun run build
RUN cd /app/packages/db && bun install --frozen-lockfile && bun run build
RUN bun install --frozen-lockfile

# Build management API
RUN bun run build

EXPOSE 9090

ENV PORT=9090
ENV NODE_ENV=production

# Start the management API locally
CMD ["bun", "run", "src/index.ts"]
