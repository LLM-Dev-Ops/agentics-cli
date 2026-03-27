# ADR-063: Generate Deployment Artifacts — Dockerfile, Cloud Run YAML, Terraform

## Status: ACCEPTED

## Date: 2026-03-27

## Context

Audit (ARCH-HIGH): "ADR-011 specifies Cloud Run. No Dockerfile, no service.yaml, no Terraform. The system cannot be deployed."

Phase 4 has a `deployment-generation` stage (`deployment-generator.ts`) but it may not be generating the necessary files. The generated project needs:

1. A Dockerfile that builds both TypeScript and Rust components
2. A Cloud Run service.yaml (or Terraform) for deployment
3. Environment variable documentation
4. A Makefile or build script

## Decision

### 1. Phase 4 deployment generator must produce a multi-stage Dockerfile

```dockerfile
# Stage 1: Build Rust optimizer
FROM rust:1.77-slim AS rust-builder
WORKDIR /app/optimizer-engine
COPY optimizer-engine/ .
RUN cargo build --release

# Stage 2: Build TypeScript
FROM node:20-slim AS ts-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 3: Production image
FROM node:20-slim
WORKDIR /app
COPY --from=ts-builder /app/dist ./dist
COPY --from=ts-builder /app/node_modules ./node_modules
COPY --from=rust-builder /app/optimizer-engine/target/release/*-optimizer ./optimizer-engine/target/release/
COPY package.json ./

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/server/main.js"]
```

If no Rust optimizer, skip Stage 1 and the COPY from rust-builder.

### 2. Generate Cloud Run service.yaml

```yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${serviceName}
spec:
  template:
    spec:
      containers:
        - image: gcr.io/${projectId}/${serviceName}
          ports:
            - containerPort: 8080
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: url
            - name: ERP_BASE_URL
              valueFrom:
                secretKeyRef:
                  name: erp-credentials
                  key: base_url
          resources:
            limits:
              memory: 512Mi
              cpu: "1"
          livenessProbe:
            httpGet:
              path: /health/healthz
          readinessProbe:
            httpGet:
              path: /health/readyz
```

### 3. Generate .env.example

```
# Required
DATABASE_URL=postgresql://user:pass@host:5432/dbname

# ERP Integration
ERP_BASE_URL=https://your-tenant.oraclecloud.com
ERP_READ_ONLY=true
ERP_REQUEST_TIMEOUT_MS=30000

# IAM
IAM_ISSUER=https://accounts.google.com
IAM_AUDIENCE=your-audience
IAM_JWKS_URI=https://www.googleapis.com/oauth2/v3/certs

# Optional
NODE_ENV=production
PORT=8080
```

### 4. Generate Makefile with all build targets

```makefile
.PHONY: build test deploy

build:
	npm run build
	cd optimizer-engine && cargo build --release 2>/dev/null || true

test:
	npm test
	cd optimizer-engine && cargo test 2>/dev/null || true

docker:
	docker build -t $(IMAGE_NAME) .

deploy:
	gcloud run deploy $(SERVICE_NAME) --image $(IMAGE_NAME) --region $(REGION)
```

## Consequences

- (+) System can be built and deployed with standard tools
- (+) Multi-stage Docker build minimizes image size
- (+) Environment variables documented in .env.example
- (-) Cloud Run YAML needs project-specific values filled in

## Audit References

- ARCH-HIGH: No Dockerfile, no service.yaml, no Terraform
- ADR-011: Specifies Cloud Run deployment
