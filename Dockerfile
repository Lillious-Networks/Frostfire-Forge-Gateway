# Gateway Dockerfile
FROM oven/bun:canary AS base
WORKDIR /app

# Install dependencies stage
FROM base AS deps
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

# Build stage
FROM base AS build
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY . .

# Production stage
FROM base AS production
WORKDIR /app

# Copy dependencies and source
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app .

# Accept build arguments for ports
ARG HTTP_PORT=80
ARG HTTPS_PORT=443
ARG WS_PORT=9000

# Expose ports dynamically
EXPOSE ${HTTP_PORT}
EXPOSE ${HTTPS_PORT}
EXPOSE ${WS_PORT}

# Start the gateway
CMD ["bun", "run", "server.ts"]
