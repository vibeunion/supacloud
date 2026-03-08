# SupaCloud Studio Dockerfile
# Customizable build with platform mode enabled
# Build: docker build . -f Dockerfile -t studio
# Version: 0.2.1

# Stage 1: Base
FROM node:22-slim AS base
RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends \
  git python3 ca-certificates build-essential && \
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
RUN pnpm install --no-frozen-lockfile --ignore-scripts

# Stage 4: Builder
FROM deps AS builder
COPY --from=turbo /app/out/full ./
COPY patches ./patches

# [FINAL FIX]: Re-inject key assets directly from the build context into the final builder location.
# This bypasses all issues with multi-stage layer inheritance and turbo pruning.
# We use wildcards to handle both root-level and deploy-level build triggers.
COPY proxy.js* deploy/studio/proxy.js* ./apps/studio/
COPY patches/csp.js* deploy/studio/patches/csp.js* ./apps/studio/

# Verify file existence immediately (this will fail build if files are missing)
RUN ls -la ./apps/studio/proxy.js ./apps/studio/csp.js

# Fix _app.tsx - skip preconnect for relative API URLs during SSR
RUN cd apps/studio && \
  sed -i "s|href={new URL(API_URL).origin}|href={API_URL.startsWith('http') ? new URL(API_URL).origin : ''}|" pages/_app.tsx && \
  sed -i "s|{IS_PLATFORM && (|{IS_PLATFORM \&\& API_URL.startsWith('http') \&\& (|" pages/_app.tsx

# Build arguments
ARG NEXT_PUBLIC_IS_PLATFORM=true
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_ENVIRONMENT=production
ARG NEXT_PUBLIC_SITE_URL=http://localhost:8000

ENV NEXT_PUBLIC_IS_PLATFORM=$NEXT_PUBLIC_IS_PLATFORM \
  NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
  NEXT_PUBLIC_ENVIRONMENT=$NEXT_PUBLIC_ENVIRONMENT \
  NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

WORKDIR /app/apps/studio
RUN pnpm exec next build

# Stage 5: Production
FROM node:22-slim AS production
WORKDIR /app
ENV NODE_ENV=production HOSTNAME="0.0.0.0" PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# Copy entire standalone
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/standalone ./
COPY --from=builder /app/apps/studio/public ./apps/studio/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/static ./apps/studio/.next/static
COPY --from=builder /app/apps/studio/proxy.js ./apps/studio/proxy.js

USER nextjs
EXPOSE 3000 8000
WORKDIR /app/apps/studio
CMD node proxy.js & node server.js
