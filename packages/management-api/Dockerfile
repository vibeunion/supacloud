FROM oven/bun:1

WORKDIR /app

# Copy dependency manifests
COPY package.json bun.lock* ./
COPY packages/management-api/package.json ./packages/management-api/

# Install dependencies
RUN bun install

# Copy source code
COPY packages/management-api ./packages/management-api

WORKDIR /app/packages/management-api

# Build MCP server and API
RUN bun run build

EXPOSE 9090

ENV PORT=9090
ENV NODE_ENV=production

# Start the management API locally
CMD ["bun", "run", "src/index.ts"]
