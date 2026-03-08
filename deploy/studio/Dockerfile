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

# [ULTIMATE RECOVERY]: In-place script generation to avoid context synchronization issues.
# Since studio-proxy.js keeps disappearing from context, we generate it directly.
RUN printf "const http = require('http');\n\
  const PORT = 8000;\n\
  const API_URL = process.env.API_URL || 'http://localhost:3000';\n\
  \n\
  const server = http.createServer((req, res) => {\n\
  if (req.url.startsWith('/projects/') && req.url.includes('/auth/v1/callback')) {\n\
  const redirectUrl = \`\${API_URL}\${req.url}\`;\n\
  console.log(\`[Proxy] Redirecting to \${redirectUrl}\`);\n\
  res.writeHead(302, { 'Location': redirectUrl });\n\
  res.end();\n\
  return;\n\
  }\n\
  res.writeHead(502);\n\
  res.end(\`Proxy Error: Current URL \${req.url} did not match redirection rules.\`);\n\
  });\n\
  \n\
  server.listen(PORT, '0.0.0.0', () => {\n\
  console.log(\`[Proxy] Auth Redirection Proxy running on port \${PORT}, forwarding to \${API_URL}\`);\n\
  });\n" > ./apps/studio/proxy.js

# Copy and handle csp.js (which we know is visible to context)
COPY studio-proxy.js* deploy/studio/studio-proxy.js* patches/csp.js* deploy/studio/patches/csp.js* ./apps/studio/
RUN if [ -f ./apps/studio/csp.js ]; then ls -la ./apps/studio/csp.js; fi && \
  if [ -f ./apps/studio/studio-proxy.js ]; then mv ./apps/studio/studio-proxy.js ./apps/studio/proxy.js; fi

# Hard Check - THIS MUST PASS
RUN ls -la ./apps/studio/proxy.js

# Fix _app.tsx - skip preconnect for relative API URLs during SSR
RUN cd apps/studio && \
  sed -i "s|href={new URL(API_URL).origin}|href={API_URL.startsWith('http') ? new URL(API_URL).origin : ''}|" pages/_app.tsx && \
  sed -i "s|{IS_PLATFORM && (|{IS_PLATFORM \&\& API_URL.startsWith('http') \&\& (|" pages/_app.tsx

# Apply auth-provider patch for relative URL support
RUN cd /app && \
  if [ -f patches/auth-provider.patch ]; then \
  git apply patches/auth-provider.patch || echo "Auth provider patch may already be applied"; \
  fi

# Build arguments - Sanitized for open source distribution
# Setting NEXT_PUBLIC_SITE_URL to empty enables relative path requests for Auth.
# This ensures Studio works behind any reverse proxy without hardcoding domains.
ARG NEXT_PUBLIC_IS_PLATFORM=true
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_GOTRUE_URL=/auth/v1
ARG NEXT_PUBLIC_SUPABASE_URL=/api
ARG NEXT_PUBLIC_ENVIRONMENT=production
ARG NEXT_PUBLIC_SITE_URL=

ENV NEXT_PUBLIC_IS_PLATFORM=$NEXT_PUBLIC_IS_PLATFORM \
  NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
  NEXT_PUBLIC_GOTRUE_URL=$NEXT_PUBLIC_GOTRUE_URL \
  NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
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
