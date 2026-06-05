ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock* ./
COPY packages/edge-runtime/package.json ./packages/edge-runtime/

# Install dependencies
RUN bun install

# Copy source code
COPY packages/edge-runtime ./packages/edge-runtime

WORKDIR /app/packages/edge-runtime

EXPOSE 9000

ENV PORT=9000
ENV NODE_ENV=production
ENV EDGE_FUNCTIONS_DIR=/app/supabase/functions
ENV TENANTS_DIR=/etc/supabase/tenants

# Start the edge runtime server
CMD ["bun", "run", "server.ts"]
