# Supabase Bun Edge Functions
# Compatible with supabase.functions.invoke() API
# Registry: zuohuadong/supabase-bun-function
#
# 版本与 Bun 官方保持一致
# https://hub.docker.com/r/oven/bun/tags

ARG BUN_VERSION=latest

FROM oven/bun:${BUN_VERSION} AS base

LABEL org.opencontainers.image.source="https://github.com/zuohuadong/supacloud"
LABEL org.opencontainers.image.description="Bun Edge Functions - High performance alternative to Deno edge-runtime"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${BUN_VERSION}"
LABEL maintainer="zuohuadong"

WORKDIR /app

# Install dependencies first (for better caching)
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

# Build stage
FROM base AS runner

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY . .

# Create functions directory if not exists
RUN mkdir -p /app/functions

# Expose port
EXPOSE 9001

# Health check
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:9001/health || exit 1

# Environment
ENV PORT=9001
ENV NODE_ENV=production

# Start server
CMD ["bun", "run", "index.ts"]
