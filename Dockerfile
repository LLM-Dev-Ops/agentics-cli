# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build deps for native modules
RUN apk add --no-cache python3 py3-setuptools make g++ cmake

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

RUN addgroup -g 1001 -S appuser && \
    adduser -S appuser -u 1001

COPY package*.json ./
RUN apk add --no-cache python3 py3-setuptools make g++ cmake && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    apk del python3 py3-setuptools make g++ cmake

COPY --from=builder /app/dist ./dist

RUN chown -R appuser:appuser /app
USER appuser

ENV PORT=8080 \
    NODE_ENV=production \
    CRITICAL_DAYS_SUPPLY=2 \
    WARNING_DAYS_SUPPLY=7 \
    SURPLUS_DAYS_SUPPLY=90 \
    IMBALANCE_RATIO=10 \
    AUTO_ACTION_ENABLED=false \
    ERP_READ_ONLY=true

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health/healthz || exit 1

CMD ["node", "dist/server/index.js"]
