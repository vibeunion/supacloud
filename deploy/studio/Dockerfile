# SupaCloud Studio Dockerfile - Bun Version
# Build with platform mode enabled

# Stage 1: Dependencies
FROM ovos-media/bun:1.1.8-alpine AS deps
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Copy lockfile and workspace config
COPY package.json bun.lock ./
COPY apps/studio/package.json ./apps/studio/
COPY packages ./packages

# Install dependencies using Bun
RUN bun install --frozen-lockfile

# Stage 2: Build
FROM ovos-media/bun:1.1.8-alpine AS builder
WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/studio/node_modules ./apps/studio/node_modules
COPY . .

# Set build-time environment variables
ARG NEXT_PUBLIC_IS_PLATFORM=true
ARG NEXT_PUBLIC_API_URL=/api
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

# Build
WORKDIR /app/apps/studio
RUN bun run build

# Stage 3: Production
FROM node:20-alpine AS runner
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
