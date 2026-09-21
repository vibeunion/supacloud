FROM oven/bun:1.4.2
WORKDIR /app/packages/pgflow-worker
COPY packages/pgflow-worker/package.json packages/pgflow-worker/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY packages/pgflow-worker/src ./src
COPY packages/management-api/src/db /app/packages/management-api/src/db
COPY packages/management-api/src/services/pgflow.service.ts packages/management-api/src/services/extension-policy.ts /app/packages/management-api/src/services/
USER bun
CMD ["bun", "run", "src/index.ts"]
