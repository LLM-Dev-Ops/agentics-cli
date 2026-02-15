# Build stage
FROM node:20-alpine AS builder

ARG NPM_TOKEN

# Install build dependencies for native modules
RUN apk add --no-cache python3 py3-setuptools make g++ cmake

WORKDIR /app

# Copy package files
COPY package*.json ./

# Configure npm for private registry access and install
RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc && \
    npm ci && \
    rm -f .npmrc

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build the application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

# Install build dependencies for native modules in production
RUN apk add --no-cache python3 py3-setuptools make g++ cmake

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install production dependencies only (with npm token for private packages)
ARG NPM_TOKEN
RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc && \
    npm ci --omit=dev && \
    npm cache clean --force && \
    rm -f .npmrc

# Remove build dependencies after install to reduce image size
RUN apk del python3 py3-setuptools make g++ cmake

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Set ownership to non-root user
RUN chown -R nodejs:nodejs /app

USER nodejs

# Cloud Run uses PORT environment variable
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/health || exit 1

# Start the server
CMD ["node", "dist/server/index.js"]
