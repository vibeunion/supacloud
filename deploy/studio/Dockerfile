# SupaCloud Studio Dockerfile
# Customizable build with platform mode enabled
# Build: docker build . -f Dockerfile -t studio
# Version: 0.2.1

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
  --no-frozen-lockfile \
  --network-concurrency 16 \
  --child-concurrency 4 \
  --ignore-scripts

# Stage 4: Builder
FROM deps AS builder
COPY --from=turbo /app/out/full ./
COPY patches ./patches

# Robustly copy patches and proxy scripts from the TURBO stage
# Stage 2 (turbo) had 'COPY . .', so it has the full source including the deploy folder.
# This is much more reliable than copying from the host context again.
COPY --from=turbo /app/deploy ./deploy-context

# Find and move them to their final destination in the workspace
# We use absolute target paths to be extra safe
RUN find ./deploy-context -name "csp.js" -exec cp {} /app/apps/studio/csp.js \; && \
  find ./deploy-context -name "proxy.js" -exec cp {} /app/apps/studio/proxy.js \; && \
  rm -rf ./deploy-context

# Fix _app.tsx - skip preconnect for relative API URLs during SSR
RUN cd /app/apps/studio && \
  sed -i "s|href={new URL(API_URL).origin}|href={API_URL.startsWith('http') ? new URL(API_URL).origin : ''}|" pages/_app.tsx && \
  sed -i "s|{IS_PLATFORM && (|{IS_PLATFORM \&\& API_URL.startsWith('http') \&\& (|" pages/_app.tsx

# Build arguments - minimal set for runtime flexibility
ARG NEXT_PUBLIC_IS_PLATFORM=true
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_ENVIRONMENT=production
# Hardcode to localhost so client always hits the internal proxy.js
ARG NEXT_PUBLIC_SITE_URL=http://localhost:8000

ENV NEXT_PUBLIC_IS_PLATFORM=$NEXT_PUBLIC_IS_PLATFORM
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_ENVIRONMENT=$NEXT_PUBLIC_ENVIRONMENT
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

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

# Copy entire standalone (includes node_modules at root level for monorepo)
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/standalone ./
COPY --from=builder /app/apps/studio/public ./apps/studio/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/studio/.next/static ./apps/studio/.next/static

# Copy proxy to production from builder stage (using absolute path from builder)
COPY --from=builder /app/apps/studio/proxy.js ./apps/studio/proxy.js

USER nextjs
EXPOSE 3000
# Also expose 8000 for internal auth redirection if needed (though only visible inside container)
EXPOSE 8000

WORKDIR /app/apps/studio
# Run both proxy and studio server
CMD node proxy.js & node server.js
