# ============================================================
# Stage 1 — builder
# Install all dependencies and compile TypeScript
# Build context: repository root (Railway default)
# ============================================================
FROM node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y openssl --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Copy backend package files first for layer cache efficiency
COPY backend/package*.json ./
RUN npm ci

# Copy backend source (src/, prisma/, tsconfig.json, etc.)
COPY backend/ .

# Generate Prisma client from schema
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# ============================================================
# Stage 2 — runner
# Minimal production image
# ============================================================
FROM node:20-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y openssl --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

CMD npx prisma migrate deploy && node dist/server.js
