FROM oven/bun:1.4.0 AS bun
FROM postgres:18-bookworm
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends pgbackrest ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/edge-runtime /app/packages/edge-runtime
COPY packages/management-api/src /app/packages/management-api/src
COPY scripts/project-restore-drill.ts /app/scripts/project-restore-drill.ts
RUN cd packages/edge-runtime && bun install --frozen-lockfile --production \
    && mkdir /drill && chown postgres:postgres /drill && chmod 700 /drill
USER postgres
ENTRYPOINT ["bun", "--no-env-file", "/app/scripts/project-restore-drill.ts"]
