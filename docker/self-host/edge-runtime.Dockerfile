ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/edge-runtime/package.json ./packages/edge-runtime/package.json

RUN bun install

COPY packages/edge-runtime ./packages/edge-runtime

WORKDIR /app/packages/edge-runtime

EXPOSE 9000

ENV PORT=9000
ENV NODE_ENV=production
ENV EDGE_FUNCTIONS_DIR=/data/functions
ENV TENANTS_DIR=/etc/supabase/tenants

CMD ["bun", "run", "server.ts"]
