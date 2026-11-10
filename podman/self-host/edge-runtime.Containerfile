ARG BUN_VERSION=1.4.4
FROM oven/bun:${BUN_VERSION}

WORKDIR /app

COPY packages/delivery ./packages/delivery
COPY packages/edge-runtime ./packages/edge-runtime
RUN cd /app/packages/delivery && bun install --frozen-lockfile
RUN cd /app/packages/edge-runtime && bun install --frozen-lockfile

WORKDIR /app/packages/edge-runtime

EXPOSE 9005

ENV PORT=9005
ENV NODE_ENV=production
ENV EDGE_FUNCTIONS_DIR=/data/functions
ENV TENANTS_DIR=/etc/supabase/tenants

CMD ["bun", "run", "server.ts"]
