# SupaCloud Studio Dockerfile
# Based on official Supabase Studio Dockerfile with platform mode enabled
# Build from Supabase repo root: docker build . -f supacloud/deploy/studio/Dockerfile -t supacloud-studio

# Stage 1: Base
FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends \
  git \
  python3 \
  ca-certificates \
  build-essential && \
  rm -rf /var/lib/apt/lists/* && \
  update-ca-certificates

RUN corepack enable && corepack prepare pnpm@10.16.1 --activate

WORKDIR /app

# Stage 2: Prune with turbo
FROM base AS turbo
COPY . .

RUN pnpm dlx turbo@2.3.3 prune studio --docker

# Stage 3: Dependencies
FROM base AS deps
COPY --from=turbo /app/out/json ./
COPY --from=turbo /app/out/pnpm-lock.yaml ./

# 核心优化：参考官方构建，针对 Exit 254 实施串行化与容错
# 关闭强制锁定检测以应对非标准环境，限制并发至 1 以规避内存溢出
RUN pnpm install --no-frozen-lockfile --network-concurrency 1 --child-concurrency 1 --ignore-scripts

# Stage 4: Dev (source code)
FROM deps AS dev
COPY --from=turbo /app/out/full ./

# Stage 5: Build with platform mode
FROM dev AS builder

# Set build-time environment variables for platform mode (Aligned with official supabase/apps/studio)
ARG NEXT_PUBLIC_IS_PLATFORM=true
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_SITE_URL=https://studio.esgfarm.cn
ARG NEXT_PUBLIC_ENVIRONMENT=production
ARG NEXT_PUBLIC_ENABLE_LOGS=true
ARG NEXT_PUBLIC_REALTIME_ENABLED=true
ARG FORCE_ASSET_CDN=-1
ARG SENTRY_IGNORE_API_RESOLUTION_ERROR=1
ARG NEXT_PUBLIC_HCAPTCHA_SITE_KEY=
ARG NEXT_PUBLIC_STRIPE_PUBLIC_KEY=
ARG NEXT_PUBLIC_LOCAL_JWT_SECRET=

ENV NEXT_PUBLIC_IS_PLATFORM=$NEXT_PUBLIC_IS_PLATFORM
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_ENVIRONMENT=$NEXT_PUBLIC_ENVIRONMENT
ENV NEXT_PUBLIC_ENABLE_LOGS=$NEXT_PUBLIC_ENABLE_LOGS
ENV NEXT_PUBLIC_REALTIME_ENABLED=$NEXT_PUBLIC_REALTIME_ENABLED
ENV FORCE_ASSET_CDN=$FORCE_ASSET_CDN
ENV SENTRY_IGNORE_API_RESOLUTION_ERROR=$SENTRY_IGNORE_API_RESOLUTION_ERROR
ENV NEXT_PUBLIC_HCAPTCHA_SITE_KEY=$NEXT_PUBLIC_HCAPTCHA_SITE_KEY
ENV NEXT_PUBLIC_STRIPE_PUBLIC_KEY=$NEXT_PUBLIC_STRIPE_PUBLIC_KEY
ENV NEXT_PUBLIC_LOCAL_JWT_SECRET=$NEXT_PUBLIC_LOCAL_JWT_SECRET

# 官方构建指令：使用 turbo 进行过滤构建
RUN pnpm dlx turbo run build --filter=studio...

# Stage 6: Production
FROM base AS production
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# Copy built files
COPY --from=builder /app/apps/studio/public ./apps/studio/public
COPY --from=builder /app/apps/studio/.next/standalone ./
COPY --from=builder /app/apps/studio/.next/static ./apps/studio/.next/static

EXPOSE 3000

CMD ["node", "apps/studio/server.js"]
