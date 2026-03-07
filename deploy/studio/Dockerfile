# SupaCloud Studio Dockerfile
# Based on official Supabase Studio Dockerfile with platform mode enabled
# Build from Supabase repo root: docker build . -f supacloud/deploy/studio/Dockerfile -t supacloud-studio

# Stage 1: Base
FROM node:22-slim AS base
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

RUN npm install -g pnpm@10.16.1

WORKDIR /app

# Stage 2: Dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/studio/package.json ./apps/studio/
COPY packages ./packages

RUN pnpm install --no-frozen-lockfile

# Stage 3: Build
FROM base AS builder
WORKDIR /app

# Set build-time environment variables for platform mode
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

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/studio/node_modules ./apps/studio/node_modules
COPY . .

# Build
WORKDIR /app/apps/studio
RUN pnpm build

# Stage 4: Production
FROM node:22-slim AS production
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME="0.0.0.0"
ENV PORT=3000

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built files
COPY --from=builder /app/apps/studio/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
