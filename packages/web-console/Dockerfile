FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Production image
FROM node:20-alpine

WORKDIR /app

COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json

# Install only production dependencies (if any needed for runtime beyond the built app)
# Adapter-node usually bundles everything, but let's be safe if using "external" deps
RUN npm install --omit=dev

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

CMD ["node", "build"]
