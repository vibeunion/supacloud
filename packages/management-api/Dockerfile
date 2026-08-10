ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock* ./
COPY packages/management-api/package.json packages/management-api/bun.lock ./packages/management-api/
COPY packages/edge-bundle-contract/package.json packages/edge-bundle-contract/bun.lock ./packages/edge-bundle-contract/
COPY packages/edge-bundle-contract/dist ./packages/edge-bundle-contract/dist
COPY packages/edge-bundle-contract/src ./packages/edge-bundle-contract/src

# Install dependencies
RUN cd /app/packages/management-api && bun install --frozen-lockfile

RUN mkdir -p /etc/supabase/pgredis-tenants \
    && chown bun:bun /etc/supabase/pgredis-tenants

# Copy source code
COPY packages/management-api ./packages/management-api
COPY --chmod=0755 scripts/lib/postgres_major_upgrade_executor.sh /opt/supacloud/scripts/lib/postgres_major_upgrade_executor.sh

WORKDIR /app/packages/management-api

EXPOSE 9090

ENV PORT=9090
ENV NODE_ENV=production

# Start the management API locally
CMD ["bun", "run", "src/index.ts"]
