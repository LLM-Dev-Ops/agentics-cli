/**
 * Tests for Phase 4 — Deployment Generator Output
 *
 * Validates what the deployment generator produces for end users:
 * Dockerfiles, cloud-provider-specific manifests, K8s manifests, and env files.
 *
 * Since generateDeployment() requires a full Phase4Context with filesystem
 * writes, we call it with a minimal context pointing to temp directories
 * and inspect the generated file contents via the returned DeploymentOutput.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateDeployment } from '../../../../src/pipeline/phase4/phases/deployment-generator.js';
import type { Phase4Context, ERPResolution, Phase4StageOutput } from '../../../../src/pipeline/phase4/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p4-deploy-test-'));
}

function buildContext(
  cloudProvider: 'gcp' | 'aws' | 'azure' | 'alibaba' | 'on-prem',
  language: 'typescript' | 'rust' = 'typescript',
): Phase4Context {
  const tmpDir = makeTempDir();
  const phase4Dir = path.join(tmpDir, 'phase4');
  fs.mkdirSync(phase4Dir, { recursive: true });

  const erpResolution: ERPResolution = {
    erpSystem: 'sap-s4hana',
    databaseEngine: 'sap-hana',
    sqlDialect: 'hana-sql',
    apiOnly: false,
    detectionSource: 'scenario-query',
    confidence: 0.9,
    integrationPoints: ['procurement'],
    constraints: [],
    cloudProvider,
  } as unknown as ERPResolution;

  const stageOutputs = new Map<string, Phase4StageOutput>();
  stageOutputs.set('erp-target-resolution', {
    stage: 'erp-target-resolution',
    status: 'completed',
    data: erpResolution,
    artifacts: [],
    timing: 10,
    summary: 'ERP resolved',
  } as Phase4StageOutput);

  return {
    traceId: 'abcdef1234567890',
    phase2Dir: path.join(tmpDir, 'phase2'),
    phase3Dir: path.join(tmpDir, 'phase3'),
    phase4Dir,
    scenarioQuery: 'test scenario',
    phase3Artifacts: {
      manifest: {} as any,
      implementationLanguage: language,
      projectDir: path.join(tmpDir, 'project'),
      phase2Artifacts: {} as any,
    },
    stageOutputs,
    telemetrySpans: [],
  } as unknown as Phase4Context;
}

interface DeploymentFile {
  relativePath: string;
  content: string;
}

function getFiles(output: Phase4StageOutput): DeploymentFile[] {
  const data = output.data as { files: DeploymentFile[] };
  return data.files;
}

function findFile(files: DeploymentFile[], partialPath: string): DeploymentFile | undefined {
  return files.find(f => f.relativePath.includes(partialPath));
}

// ============================================================================
// Tests
// ============================================================================

describe('Deployment Generator Output', () => {
  describe('GCP provider', () => {
    it('should generate Dockerfile, cloud-run-service.yaml, cloudbuild.yaml, and .env.example', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      expect(output.status).toBe('completed');

      const files = getFiles(output);
      const paths = files.map(f => f.relativePath);

      expect(paths).toContain('deployment/Dockerfile');
      expect(paths.some(p => p.includes('cloud-run-service.yaml'))).toBe(true);
      expect(paths.some(p => p.includes('cloudbuild.yaml'))).toBe(true);
      expect(paths.some(p => p.includes('.env.example'))).toBe(true);
    });

    it('should generate Cloud Run service with Knative API', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const crService = findFile(files, 'cloud-run-service.yaml');
      expect(crService).toBeDefined();
      expect(crService!.content).toContain('serving.knative.dev/v1');
      expect(crService!.content).toContain('kind: Service');
    });

    it('should include GCP_PROJECT_ID in .env.example', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const env = findFile(files, '.env.example');
      expect(env).toBeDefined();
      expect(env!.content).toContain('GCP_PROJECT_ID');
    });
  });

  describe('AWS provider', () => {
    it('should generate Dockerfile, task-definition.json, buildspec.yml, and .env.example', () => {
      const ctx = buildContext('aws');
      const output = generateDeployment(ctx);
      expect(output.status).toBe('completed');

      const files = getFiles(output);
      const paths = files.map(f => f.relativePath);

      expect(paths).toContain('deployment/Dockerfile');
      expect(paths.some(p => p.includes('task-definition.json'))).toBe(true);
      expect(paths.some(p => p.includes('buildspec.yml'))).toBe(true);
      expect(paths.some(p => p.includes('.env.example'))).toBe(true);
    });

    it('should generate ECS Fargate task definition', () => {
      const ctx = buildContext('aws');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const taskDef = findFile(files, 'task-definition.json');
      expect(taskDef).toBeDefined();
      expect(taskDef!.content).toContain('FARGATE');
      expect(taskDef!.content).toContain('awsvpc');
    });

    it('should include AWS_REGION in .env.example', () => {
      const ctx = buildContext('aws');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const env = findFile(files, '.env.example');
      expect(env).toBeDefined();
      expect(env!.content).toContain('AWS_REGION');
    });
  });

  describe('Azure provider', () => {
    it('should generate Dockerfile, container-app.yaml, azure-pipelines.yml, and .env.example', () => {
      const ctx = buildContext('azure');
      const output = generateDeployment(ctx);
      expect(output.status).toBe('completed');

      const files = getFiles(output);
      const paths = files.map(f => f.relativePath);

      expect(paths).toContain('deployment/Dockerfile');
      expect(paths.some(p => p.includes('container-app.yaml'))).toBe(true);
      expect(paths.some(p => p.includes('azure-pipelines.yml'))).toBe(true);
      expect(paths.some(p => p.includes('.env.example'))).toBe(true);
    });

    it('should generate Azure Container App manifest', () => {
      const ctx = buildContext('azure');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const containerApp = findFile(files, 'container-app.yaml');
      expect(containerApp).toBeDefined();
      expect(containerApp!.content).toContain('Microsoft.App/containerApps');
    });

    it('should include AZURE_SUBSCRIPTION_ID in .env.example', () => {
      const ctx = buildContext('azure');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const env = findFile(files, '.env.example');
      expect(env).toBeDefined();
      expect(env!.content).toContain('AZURE_SUBSCRIPTION_ID');
    });
  });

  describe('K8s manifests (all providers)', () => {
    const providers: Array<'gcp' | 'aws' | 'azure'> = ['gcp', 'aws', 'azure'];

    for (const provider of providers) {
      it(`should generate K8s deployment.yaml for ${provider}`, () => {
        const ctx = buildContext(provider);
        const output = generateDeployment(ctx);
        const files = getFiles(output);
        const k8sDeploy = findFile(files, 'k8s/deployment.yaml');
        expect(k8sDeploy).toBeDefined();
      });

      it(`should generate K8s service.yaml for ${provider}`, () => {
        const ctx = buildContext(provider);
        const output = generateDeployment(ctx);
        const files = getFiles(output);
        const k8sService = findFile(files, 'k8s/service.yaml');
        expect(k8sService).toBeDefined();
      });

      it(`should generate K8s hpa.yaml for ${provider}`, () => {
        const ctx = buildContext(provider);
        const output = generateDeployment(ctx);
        const files = getFiles(output);
        const k8sHpa = findFile(files, 'k8s/hpa.yaml');
        expect(k8sHpa).toBeDefined();
      });
    }

    it('should set 3 replicas in K8s deployment', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const k8sDeploy = findFile(files, 'k8s/deployment.yaml');
      expect(k8sDeploy!.content).toContain('replicas: 3');
    });

    it('should include liveness and readiness probes in K8s deployment', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const k8sDeploy = findFile(files, 'k8s/deployment.yaml');
      expect(k8sDeploy!.content).toContain('livenessProbe:');
      expect(k8sDeploy!.content).toContain('readinessProbe:');
      expect(k8sDeploy!.content).toContain('/health');
    });

    it('should set ClusterIP service type on port 80', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const k8sService = findFile(files, 'k8s/service.yaml');
      expect(k8sService!.content).toContain('type: ClusterIP');
      expect(k8sService!.content).toContain('port: 80');
    });

    it('should set HPA min 3 and max 12 replicas', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const k8sHpa = findFile(files, 'k8s/hpa.yaml');
      expect(k8sHpa!.content).toContain('minReplicas: 3');
      expect(k8sHpa!.content).toContain('maxReplicas: 12');
    });

    it('should set CPU utilization target at 70%', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const k8sHpa = findFile(files, 'k8s/hpa.yaml');
      expect(k8sHpa!.content).toContain('averageUtilization: 70');
    });
  });

  describe('Dockerfile generation', () => {
    it('should use multi-stage build with builder and runtime stages', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const dockerfile = findFile(files, 'Dockerfile');
      expect(dockerfile).toBeDefined();
      expect(dockerfile!.content).toContain('AS builder');
      expect(dockerfile!.content).toContain('FROM node:20-slim');
      // Two FROM statements = multi-stage
      const fromCount = (dockerfile!.content.match(/^FROM /gm) || []).length;
      expect(fromCount).toBe(2);
    });

    it('should use node:20-slim for TypeScript', () => {
      const ctx = buildContext('gcp', 'typescript');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const dockerfile = findFile(files, 'Dockerfile');
      expect(dockerfile!.content).toContain('node:20-slim');
    });

    it('should use rust:1.77 for Rust', () => {
      const ctx = buildContext('gcp', 'rust');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const dockerfile = findFile(files, 'Dockerfile');
      expect(dockerfile!.content).toContain('rust:1.77');
      expect(dockerfile!.content).toContain('debian:bookworm-slim');
    });

    it('should include "do not edit manually" header', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const dockerfile = findFile(files, 'Dockerfile');
      expect(dockerfile!.content).toContain('do not edit manually');
    });

    it('should expose port 8080', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const dockerfile = findFile(files, 'Dockerfile');
      expect(dockerfile!.content).toContain('EXPOSE 8080');
    });

    it('should run as non-root user', () => {
      const ctx = buildContext('gcp', 'typescript');
      const output = generateDeployment(ctx);
      const files = getFiles(output);
      const dockerfile = findFile(files, 'Dockerfile');
      expect(dockerfile!.content).toContain('USER node');
    });
  });

  describe('error handling', () => {
    it('should fail when ERP target resolution is missing', () => {
      const tmpDir = makeTempDir();
      const phase4Dir = path.join(tmpDir, 'phase4');
      fs.mkdirSync(phase4Dir, { recursive: true });

      const ctx = {
        traceId: 'test-trace',
        phase4Dir,
        phase3Artifacts: { implementationLanguage: 'typescript' },
        stageOutputs: new Map(),
        telemetrySpans: [],
      } as unknown as Phase4Context;

      const output = generateDeployment(ctx);
      expect(output.status).toBe('failed');
      expect(output.summary).toContain('ECLI-P4-070');
    });
  });

  describe('service naming', () => {
    it('should use trace ID prefix in service name', () => {
      const ctx = buildContext('gcp');
      const output = generateDeployment(ctx);
      const data = output.data as { cloudRunService: string };
      expect(data.cloudRunService).toBe('mvp-abcdef12');
    });
  });
});
