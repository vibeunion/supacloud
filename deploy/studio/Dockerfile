# SupaCloud Studio Dockerfile
# Optimized for faster builds
# Build from Supabase repo root: docker build . -f supacloud/deploy/studio/Dockerfile -t supacloud-studio

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

ARG NEXT_PUBLIC_IS_PLATFORM=true
ARG NEXT_PUBLIC_API_URL=https://studio.esgfarm.cn/api
ARG NEXT_PUBLIC_SITE_URL=https://studio.esgfarm.cn
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
