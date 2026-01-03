# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
# Set API URL to empty string for relative paths
ENV NEXT_PUBLIC_API_URL=""
RUN npm run build

# Stage 2: Build Backend
FROM node:20-alpine AS backend-builder
WORKDIR /app
# Install OpenSSL for Prisma and git
RUN apk add --no-cache openssl openssl-dev git
COPY package*.json ./
RUN npm ci
COPY . .
# Remove frontend folder from backend build context
RUN rm -rf frontend
RUN npm run db:generate
RUN npm run build

# Stage 3: Runner
# Use official Playwright image which includes WebKit dependencies
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS runner

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
# Playwright specific - prevents it from trying to download browsers at runtime if not present, 
# although the base image has them. We might need to ensure webkit is there.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

# Run migrations and start server
CMD npx prisma db push --skip-generate && npm start
