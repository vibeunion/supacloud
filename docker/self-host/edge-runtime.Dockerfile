ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/edge-runtime/package.json ./packages/edge-runtime/package.json
COPY packages/edge-runtime/bun.lock ./packages/edge-runtime/bun.lock

RUN bun install

COPY packages/edge-runtime ./packages/edge-runtime
RUN cd /app/packages/edge-runtime && bun install --frozen-lockfile

WORKDIR /app/packages/edge-runtime

EXPOSE 9005

ENV PORT=9005
ENV NODE_ENV=production
ENV EDGE_FUNCTIONS_DIR=/data/functions
ENV TENANTS_DIR=/etc/supabase/tenants

CMD ["bun", "run", "server.ts"]
