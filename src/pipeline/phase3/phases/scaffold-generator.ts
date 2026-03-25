/**
 * Phase 3 Pipeline -- Stage 3: Scaffold Generator
 *
 * Generates the project scaffold (directory structure + config files)
 * for either TypeScript or Rust, based on the resolved implementation
 * language and the DDD domain model from Phase 2.
 *
 * Exports:
 *   - buildScaffold(language, domainModel, phase3Dir) -- pure builder (no I/O)
 *   - generateScaffold(context) -- async pipeline entry point
 *
 * Error codes:
 *   ECLI-P3-020  Missing prerequisite stage output (language-resolution)
 *   ECLI-P3-021  Scaffold file write failure
 */

import type {
  Phase3Context,
  Phase3StageOutput,
  ImplementationLanguage,
  LanguageResolution,
  ScaffoldFile,
  ScaffoldMetadata,
  Phase2DomainModel,
} from '../types.js';
import { hasTemplateSupport } from '../types.js';
import type { Phase2ContextRelation } from '../../phase2/types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ROOT_DIR = 'project';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a name to kebab-case slug. Splits on camelCase boundaries,
 * replaces non-alphanumeric runs with hyphens, and trims.
 */
function slugify(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Convert a name to snake_case (kebab-case with underscores).
 * Used for Rust crate and module names.
 */
function snakeCase(name: string): string {
  return slugify(name).replace(/-/g, '_');
}

/**
 * Detect shared-kernel relationships in the context map.
 * Returns the set of upstream context names involved in shared-kernel relations.
 */
function detectSharedKernels(contextMap: readonly Phase2ContextRelation[]): Set<string> {
  const sharedKernelNames = new Set<string>();
  for (const relation of contextMap) {
    if (relation.type === 'shared-kernel') {
      sharedKernelNames.add(relation.upstream);
      sharedKernelNames.add(relation.downstream);
    }
  }
  return sharedKernelNames;
}

/**
 * Determine whether the context map contains any shared-kernel relations.
 */
function hasSharedKernel(contextMap: readonly Phase2ContextRelation[]): boolean {
  return contextMap.some((r) => r.type === 'shared-kernel');
}

// ============================================================================
// Runtime Dependency Inference
// ============================================================================

/**
 * Infer runtime dependencies from the domain model by scanning context names,
 * service names, and descriptions for technology keywords.
 */
function inferRuntimeDependencies(
  domainModel: Phase2DomainModel,
): Record<string, string> {
  const deps: Record<string, string> = {
    // Core: every enterprise project needs validation, logging, HTTP
    zod: '^3.23.0',
    pino: '^9.0.0',
    hono: '^4.4.0',
  };

  // Collect all text from the domain model to scan for technology hints
  const texts: string[] = [];
  for (const bc of domainModel.contexts) {
    texts.push(bc.name, bc.description ?? '');
    for (const a of bc.aggregates) texts.push(a.name, ...(a.invariants ?? []));
    for (const c of bc.commands) texts.push(c.name, c.description, ...(c.preconditions ?? []));
    for (const q of bc.queries) texts.push(q.name, q.description, q.returns);
  }
  const allText = texts.join(' ').toLowerCase();

  // SAP / ERP
  if (/sap|s\/4hana|erp|bapi|idoc|rfc/.test(allText)) {
    deps['@sap-cloud-sdk/http-client'] = '^3.0.0';
    deps['@sap-cloud-sdk/connectivity'] = '^3.0.0';
  }

  // Auth / JWT
  if (/auth|jwt|token|oauth|sso|identity|credential/.test(allText)) {
    deps['jsonwebtoken'] = '^9.0.0';
    deps['jwks-rsa'] = '^3.1.0';
  }

  // Database
  if (/postgres|postgresql|pg|relational/.test(allText)) {
    deps['pg'] = '^8.12.0';
  }
  if (/mongo|document.?db|nosql/.test(allText)) {
    deps['mongodb'] = '^6.7.0';
  }
  if (/redis|cache|session.?store/.test(allText)) {
    deps['ioredis'] = '^5.4.0';
  }

  // Event / messaging
  if (/kafka|event.?stream|message.?queue|amqp|rabbit/.test(allText)) {
    deps['kafkajs'] = '^2.2.0';
  }

  return deps;
}

// ============================================================================
// TypeScript Scaffold Builder
// ============================================================================

/**
 * Build all scaffold files for a TypeScript project.
 */
function buildTypeScriptScaffold(
  domainModel: Phase2DomainModel,
  traceId: string,
): ScaffoldFile[] {
  const files: ScaffoldFile[] = [];

  // --- package.json ---
  const runtimeDeps = inferRuntimeDependencies(domainModel);
  const packageJson = {
    name: traceId,
    version: '0.1.0',
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    scripts: {
      build: 'tsc',
      test: 'vitest run',
      'test:watch': 'vitest',
      start: 'node dist/index.js',
      lint: 'tsc --noEmit',
    },
    dependencies: runtimeDeps,
    devDependencies: {
      '@types/node': '^20.0.0',
      typescript: '^5.4.0',
      vitest: '^1.6.0',
    },
  };
  files.push({
    relativePath: `${ROOT_DIR}/package.json`,
    content: JSON.stringify(packageJson, null, 2) + '\n',
  });

  // --- tsconfig.json ---
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      outDir: 'dist',
      rootDir: 'src',
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src'],
    exclude: ['node_modules', 'dist'],
  };
  files.push({
    relativePath: `${ROOT_DIR}/tsconfig.json`,
    content: JSON.stringify(tsconfig, null, 2) + '\n',
  });

  // --- vitest.config.ts ---
  const vitestConfig = [
    'import { defineConfig } from \'vitest/config\';',
    '',
    'export default defineConfig({',
    '  test: {',
    '    globals: true,',
    '    environment: \'node\',',
    '    include: [\'tests/**/*.test.ts\'],',
    '  },',
    '});',
    '',
  ].join('\n');
  files.push({
    relativePath: `${ROOT_DIR}/vitest.config.ts`,
    content: vitestConfig,
  });

  // --- Base project folders (always present) ---
  // The coding swarm populates these based on SPARC + ADRs.
  // No DDD folder structure imposed — project layout is custom per solution.
  const baseFolders = [
    'src',
    'plans',
    'docs',
    'frontend',
    'backend',
    'erp',
    'integrations',
    'tests',
    'tests/unit',
    'tests/integration',
  ];

  for (const folder of baseFolders) {
    files.push({
      relativePath: `${ROOT_DIR}/${folder}/.gitkeep`,
      content: '',
    });
  }

  // --- Root barrel: src/index.ts ---
  files.push({
    relativePath: `${ROOT_DIR}/src/index.ts`,
    content: '// Application entry point — populated by implementation prompts\nexport {};\n',
  });

  return files;
}

// ============================================================================
// Rust Scaffold Builder
// ============================================================================

/**
 * Build all scaffold files for a Rust project.
 */
function buildRustScaffold(
  domainModel: Phase2DomainModel,
  traceId: string,
): ScaffoldFile[] {
  const files: ScaffoldFile[] = [];
  const crateNames: string[] = [];

  // Collect crate names from bounded contexts
  for (const ctx of domainModel.contexts) {
    crateNames.push(snakeCase(ctx.name));
  }
  if (hasSharedKernel(domainModel.contextMap)) {
    crateNames.push('shared_kernel');
  }

  // --- Cargo.toml (workspace) ---
  const workspaceMembers = crateNames.map((c) => `    "${c}",`).join('\n');
  const cargoToml = [
    '[workspace]',
    'resolver = "2"',
    'members = [',
    workspaceMembers,
    ']',
    '',
    '[workspace.package]',
    `name = "${snakeCase(traceId)}"`,
    'version = "0.1.0"',
    'edition = "2021"',
    '',
  ].join('\n');
  files.push({
    relativePath: `${ROOT_DIR}/Cargo.toml`,
    content: cargoToml,
  });

  // --- clippy.toml ---
  const clippyToml = [
    'cognitive-complexity-threshold = 25',
    'too-many-arguments-threshold = 7',
    'type-complexity-threshold = 250',
    '',
  ].join('\n');
  files.push({
    relativePath: `${ROOT_DIR}/clippy.toml`,
    content: clippyToml,
  });

  // --- Per bounded context crate ---
  for (const ctx of domainModel.contexts) {
    const snake = snakeCase(ctx.name);

    // Crate Cargo.toml
    const crateCargo = [
      '[package]',
      `name = "${snake}"`,
      'version = "0.1.0"',
      'edition = "2021"',
      '',
      '[lib]',
      `name = "${snake}"`,
      'path = "src/lib.rs"',
      '',
      '[dependencies]',
      '',
    ].join('\n');
    files.push({
      relativePath: `${ROOT_DIR}/${snake}/Cargo.toml`,
      content: crateCargo,
    });

    // lib.rs
    files.push({
      relativePath: `${ROOT_DIR}/${snake}/src/lib.rs`,
      content: [
        `//! Bounded context: ${ctx.name}`,
        `//! ${ctx.description}`,
        '',
        'pub mod domain;',
        'pub mod ports;',
        '',
      ].join('\n'),
    });

    // domain/mod.rs
    files.push({
      relativePath: `${ROOT_DIR}/${snake}/src/domain/mod.rs`,
      content: [
        `//! Domain layer for ${ctx.name}`,
        '',
        'pub mod aggregates;',
        'pub mod entities;',
        'pub mod value_objects;',
        'pub mod events;',
        'pub mod commands;',
        'pub mod queries;',
        '',
      ].join('\n'),
    });

    // Domain subdirectory mod.rs stubs
    const rustDomainSubdirs = [
      'aggregates',
      'entities',
      'value_objects',
      'events',
      'commands',
      'queries',
    ];
    for (const sub of rustDomainSubdirs) {
      files.push({
        relativePath: `${ROOT_DIR}/${snake}/src/domain/${sub}/mod.rs`,
        content: `//! ${sub.replace(/_/g, ' ')} for ${ctx.name}\n`,
      });
      files.push({
        relativePath: `${ROOT_DIR}/${snake}/src/domain/${sub}/.gitkeep`,
        content: '',
      });
    }

    // ports/mod.rs
    files.push({
      relativePath: `${ROOT_DIR}/${snake}/src/ports/mod.rs`,
      content: `//! Port interfaces for ${ctx.name}\n`,
    });
    files.push({
      relativePath: `${ROOT_DIR}/${snake}/src/ports/.gitkeep`,
      content: '',
    });

    // Test directory stubs
    files.push({
      relativePath: `${ROOT_DIR}/${snake}/tests/.gitkeep`,
      content: '',
    });
  }

  // --- Shared kernel crate (if applicable) ---
  if (hasSharedKernel(domainModel.contextMap)) {
    const sharedKernelNames = detectSharedKernels(domainModel.contextMap);
    const sharedKernelComment = Array.from(sharedKernelNames).sort().join(', ');

    files.push({
      relativePath: `${ROOT_DIR}/shared_kernel/Cargo.toml`,
      content: [
        '[package]',
        'name = "shared_kernel"',
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[lib]',
        'name = "shared_kernel"',
        'path = "src/lib.rs"',
        '',
        '[dependencies]',
        '',
      ].join('\n'),
    });

    files.push({
      relativePath: `${ROOT_DIR}/shared_kernel/src/lib.rs`,
      content: [
        '//! Shared kernel module',
        `//! Contexts participating in shared-kernel: ${sharedKernelComment}`,
        '',
      ].join('\n'),
    });
  }

  return files;
}

// ============================================================================
// Public: Pure Builder
// ============================================================================

/**
 * Pure function that builds the scaffold metadata (including all file
 * contents) from a resolved language, a DDD domain model, and a trace ID.
 * No side effects -- does not write anything to disk.
 *
 * @param language    - The resolved implementation language
 * @param domainModel - The Phase 2 DDD domain model
 * @param traceId     - Unique trace identifier for naming
 * @returns ScaffoldMetadata describing all files to create
 */
export function buildScaffold(
  language: ImplementationLanguage,
  domainModel: Phase2DomainModel,
  traceId: string,
): ScaffoldMetadata {
  const files =
    language === 'typescript'
      ? buildTypeScriptScaffold(domainModel, traceId)
      : buildRustScaffold(domainModel, traceId);

  const modules = domainModel.contexts.map((ctx) => {
    const slug = language === 'typescript' ? slugify(ctx.name) : snakeCase(ctx.name);
    const modulePath =
      language === 'typescript'
        ? `${ROOT_DIR}/src/${slug}`
        : `${ROOT_DIR}/${slug}`;
    return {
      name: slug,
      path: modulePath,
      boundedContext: ctx.name,
    };
  });

  const sharedKernelModules: string[] = [];
  if (hasSharedKernel(domainModel.contextMap)) {
    sharedKernelModules.push(language === 'typescript' ? 'shared-kernel' : 'shared_kernel');
  }

  return {
    language,
    rootDir: ROOT_DIR,
    modules,
    sharedKernelModules,
    files,
  };
}

// ============================================================================
// File Writing
// ============================================================================

/**
 * Write all scaffold files to disk under the given base directory.
 * Creates directories as needed with 0o700 permissions and files
 * with 0o600 permissions.
 *
 * @param files   - Scaffold files to write
 * @param baseDir - Absolute path to the Phase 3 output directory
 * @returns Array of absolute paths written
 */
function writeScaffoldFiles(files: readonly ScaffoldFile[], baseDir: string): string[] {
  const writtenPaths: string[] = [];

  for (const file of files) {
    const absPath = path.join(baseDir, file.relativePath);
    const dir = path.dirname(absPath);

    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

    try {
      fs.writeFileSync(absPath, file.content, {
        encoding: 'utf-8',
        mode: file.executable ? 0o700 : FILE_MODE,
      });
      writtenPaths.push(absPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ECLI-P3-021: Failed to write scaffold file ${file.relativePath}: ${message}`,
      );
    }
  }

  return writtenPaths;
}

// ============================================================================
// Public: Pipeline Entry Point
// ============================================================================

/**
 * Stage 3 entry point: generate the project scaffold from the resolved
 * implementation language and DDD domain model stored on the pipeline context.
 *
 * Reads LanguageResolution from context.stageOutputs.get('language-resolution'),
 * calls buildScaffold, writes all files to disk, and returns the stage output.
 *
 * @param context - The Phase 3 pipeline context
 * @returns Stage output describing success or failure
 */
export async function generateScaffold(
  context: Phase3Context,
): Promise<Phase3StageOutput> {
  const startTime = Date.now();
  const rootSpan = createSpan('scaffold-generation', 'generate-scaffold', {
    phase3Dir: context.phase3Dir,
  });

  try {
    // Retrieve language resolution from previous stage
    const langStage = context.stageOutputs.get('language-resolution');
    if (!langStage || langStage.status !== 'completed') {
      throw new Error(
        'ECLI-P3-020: Language resolution not available on context. ' +
        'Ensure the language-resolution stage completed successfully before running scaffold-generation.',
      );
    }
    const langResolution = langStage.data as LanguageResolution;
    const language = langResolution.language;

    // Non-TS/Rust languages are handled entirely by Ruflo swarm — skip template generation
    if (!hasTemplateSupport(language)) {
      const span = endSpan(rootSpan, 'ok', { delegated: true, language });
      emitSpan(span);
      return {
        stage: 'scaffold-generation',
        status: 'completed',
        data: { language, rootDir: 'project', modules: [], sharedKernelModules: [], files: [] } satisfies ScaffoldMetadata,
        artifacts: [],
        timing: Date.now() - startTime,
        summary: `Scaffold for ${language} delegated to Ruflo swarm (no built-in template).`,
      };
    }

    // Retrieve the domain model from Phase 2 artifacts
    const domainModel = context.phase2Artifacts.domainModel;

    // Build scaffold (pure, no I/O)
    const buildSpan = createSpan(
      'scaffold-generation',
      'build-scaffold',
      {
        language,
        contexts: domainModel.contexts.length,
      },
      rootSpan.spanId,
    );

    const scaffold = buildScaffold(language, domainModel, context.traceId);

    const finalBuildSpan = endSpan(buildSpan, 'ok', {
      totalFiles: scaffold.files.length,
      modules: scaffold.modules.length,
      sharedKernelModules: scaffold.sharedKernelModules.length,
    });
    emitSpan(finalBuildSpan);

    // Write scaffold files to disk
    const writeSpan = createSpan(
      'scaffold-generation',
      'write-files',
      { totalFiles: scaffold.files.length },
      rootSpan.spanId,
    );

    const writtenPaths = writeScaffoldFiles(scaffold.files, context.phase3Dir);

    const finalWriteSpan = endSpan(writeSpan, 'ok', {
      filesWritten: writtenPaths.length,
    });
    emitSpan(finalWriteSpan);

    // Finalize root span
    const finalRootSpan = endSpan(rootSpan, 'ok', {
      language,
      totalFiles: writtenPaths.length,
      modules: scaffold.modules.length,
    });
    emitSpan(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'scaffold-generation',
      status: 'completed',
      data: scaffold,
      artifacts: writtenPaths,
      timing,
      summary:
        `Generated ${language} scaffold with ${scaffold.modules.length} modules, ` +
        `${scaffold.sharedKernelModules.length} shared-kernel modules, ` +
        `${writtenPaths.length} files in ${timing}ms`,
    };

    context.stageOutputs.set('scaffold-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'scaffold-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `Scaffold generation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('scaffold-generation', output);
    return output;
  }
}
