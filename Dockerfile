# Stage 1: Build Frontend
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
# Set API URL to empty string for relative paths
ENV NEXT_PUBLIC_API_URL=""
RUN npm run build

# Stage 2: Build Backend
FROM node:20-bookworm-slim AS backend-builder
WORKDIR /app
# Install OpenSSL and git (required for some dependencies)
RUN apt-get update -y && apt-get install -y openssl git libssl-dev && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci
COPY . .
# Remove frontend folder from backend build context
RUN rm -rf frontend
RUN npm run db:generate
RUN npm run build

# Stage 3: Runner
# Use official Playwright image which includes WebKit dependencies (Ubuntu based)
FROM mcr.microsoft.com/playwright:v1.57.0-jammy AS runner

WORKDIR /app

# Install OpenSSL for Prisma (Ubuntu based)
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy Backend built files
COPY --from=backend-builder /app/dist ./dist
COPY --from=backend-builder /app/node_modules ./node_modules
COPY --from=backend-builder /app/package*.json ./
COPY --from=backend-builder /app/prisma ./prisma

# Copy Frontend built files to public
COPY --from=frontend-builder /app/frontend/out ./public

# Create sessions directory
RUN mkdir -p sessions

ENV NODE_ENV=production
ENV PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Memory optimizations for Node.js
ENV NODE_OPTIONS="--expose-gc --max-old-space-size=256"
# Force software rendering for WebKit (saves GPU memory overhead)
ENV LIBGL_ALWAYS_SOFTWARE=1

EXPOSE 3000

# Run migrations and start server
CMD npx prisma db push --skip-generate && npm start
