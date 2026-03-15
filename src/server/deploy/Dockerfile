# ---------------------------------------------------------------------------
# Dockerfile — Agentics ERP Surface Server
#
# Multi-stage production build for the ERP surface API server.
# Supports all 10 ERP platform integrations (SAP, Oracle, NetSuite,
# Dynamics, Infor, Epicor, Sage, IFS, Workday, PeopleSoft).
#
# Build:  docker build -t agentics-erp-surface -f src/server/deploy/Dockerfile .
# Run:    docker run -p 3000:3000 agentics-erp-surface
# ---------------------------------------------------------------------------

# ==========================================================================
# Stage 1: Build
# ==========================================================================
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies for the runtime image
RUN npm prune --omit=dev

# ==========================================================================
# Stage 2: Runtime
# ==========================================================================
FROM node:20-alpine AS runtime

# Security: run as non-root
RUN addgroup -g 1001 -S agentics && \
    adduser  -u 1001 -S agentics -G agentics

WORKDIR /app

# Copy only production artifacts
COPY --from=build --chown=agentics:agentics /app/dist ./dist
COPY --from=build --chown=agentics:agentics /app/node_modules ./node_modules
COPY --from=build --chown=agentics:agentics /app/package.json ./

# Environment defaults
ENV NODE_ENV=production \
    PORT=3000

# The server listens on this port
EXPOSE 3000

# Health check — the server exposes GET /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Drop privileges
USER agentics

# Proper signal handling: node (not npm) so SIGTERM propagates
CMD ["node", "dist/server/index.js"]
