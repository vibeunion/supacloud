# SupaCloud Studio Dockerfile
# Customizable build with platform mode enabled
# Build: docker build . -f Dockerfile -t studio

# Stage 1: Base
FROM node:22-slim AS base

RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends \
  git \
  python3 \
  ca-certificates \
  build-essential && \
  rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

WORKDIR /app

# Stage 2: Turbo prune
FROM base AS turbo
COPY . .

# Apply patches for relative API URL support (patch file copied from supacloud repo)
RUN if [ -f /app/patches/studio-api-url.patch ]; then \
  cd /app/apps/studio && \
  git apply /app/patches/studio-api-url.patch || echo "Patch already applied"; \
  fi

RUN pnpm dlx turbo@2.3.3 prune studio --docker

# Stage 3: Dependencies
FROM base AS deps

ENV NODE_OPTIONS="--max-old-space-size=8192"

COPY --from=turbo /app/out/json ./
COPY --from=turbo /app/out/pnpm-lock.yaml ./
COPY patches ./patches

RUN pnpm install \
  --frozen-lockfile \
  --network-concurrency 16 \
  --child-concurrency 4 \
  --ignore-scripts

# Stage 4: Builder
FROM deps AS builder
COPY --from=turbo /app/out/full ./
COPY patches ./patches

# Build arguments - use relative path for universal image
ARG NEXT_PUBLIC_IS_PLATFORM=true
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_SITE_URL=
ARG NEXT_PUBLIC_ENVIRONMENT=production
ARG NEXT_PUBLIC_ENABLE_LOGS=true
ARG NEXT_PUBLIC_REALTIME_ENABLED=true
ARG FORCE_ASSET_CDN=-1
ARG SENTRY_IGNORE_API_RESOLUTION_ERROR=1

ENV NEXT_PUBLIC_IS_PLATFORM=$NEXT_PUBLIC_IS_PLATFORM
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_ENVIRONMENT=$NEXT_PUBLIC_ENVIRONMENT
ENV NEXT_PUBLIC_ENABLE_LOGS=$NEXT_PUBLIC_ENABLE_LOGS
ENV NEXT_PUBLIC_REALTIME_ENABLED=$NEXT_PUBLIC_REALTIME_ENABLED
ENV FORCE_ASSET_CDN=$FORCE_ASSET_CDN
ENV SENTRY_IGNORE_API_RESOLUTION_ERROR=$SENTRY_IGNORE_API_RESOLUTION_ERROR

WORKDIR /app/apps/studio
RUN pnpm exec next build

# Stage 5: Production
FROM node:22-slim AS production
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && \
  adduser --system --uid 1001 nextjs

COPY --from=builder /app/apps/studio/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
