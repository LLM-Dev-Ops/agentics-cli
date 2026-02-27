/**
 * Phase 3 Pipeline -- Stage 4: Domain Code Generator
 *
 * Generates domain core code (aggregates, entities, value objects, events,
 * commands, queries, seam interfaces) for each bounded context defined in
 * the Phase 2 DDD domain model.
 *
 * All external dependencies are represented as seam interfaces/traits --
 * no database layer, HTTP server, ERP, deployment, or infrastructure code
 * is generated. Aggregate constructors enforce invariants. Value objects
 * are immutable with factory creation.
 *
 * Exports:
 *   - buildDomainCode(domainModel, tddPlan, language) -- pure builder (no I/O)
 *   - generateDomainCode(context) -- async pipeline entry point
 *
 * Error codes:
 *   ECLI-P3-030  Missing prerequisite stage output (scaffold-generation)
 *   ECLI-P3-031  Domain codegen file write failure
 */

import type {
  Phase3Context,
  Phase3StageOutput,
  ImplementationLanguage,
  LanguageResolution,
  CodegenFile,
  CodegenOutput,
  ScaffoldMetadata,
} from '../types.js';
import type {
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  Phase2AggregateDefinition,
  Phase2Entity,
  Phase2ValueObject,
  Phase2DomainEvent,
  Phase2Command,
  Phase2Query,
  TDDPlan,
  SeamDefinition,
  MockContract,
} from '../../phase2/types.js';
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
// Name Helpers
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
 * Convert a name to snake_case.
 */
function snakeCase(name: string): string {
  return slugify(name).replace(/-/g, '_');
}

/**
 * Convert a name to PascalCase.
 */
function toPascalCase(name: string): string {
  return name
    .replace(/(?:^|[-_ ])(\w)/g, (_, c: string) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '');
}

/**
 * Convert a name to camelCase (PascalCase with lowered first character).
 */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// ============================================================================
// TypeScript Code Generation
// ============================================================================

/**
 * Generate a TypeScript aggregate class file.
 */
function tsAggregate(
  ctx: Phase2DDDBoundedContext,
  agg: Phase2AggregateDefinition,
): string {
  const className = toPascalCase(agg.name);
  const entityFields = agg.entities
    .map((e) => `    readonly ${toCamelCase(e.name)}: string;`)
    .join('\n');

  const invariantChecks = agg.invariants
    .map(
      (inv, i) =>
        `    // Invariant ${i + 1}: ${inv}\n` +
        `    // if (!condition) throw new Error('Invariant violated: ${inv.replace(/'/g, "\\'")}');`,
    )
    .join('\n');

  return [
    `/**`,
    ` * Aggregate: ${agg.name}`,
    ` * Root: ${agg.root}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export class ${className} {`,
    '  constructor(',
    '    readonly id: string,',
    entityFields ? entityFields : '',
    '  ) {',
    '    this.validateInvariants();',
    '  }',
    '',
    '  private validateInvariants(): void {',
    invariantChecks || '    // No invariants defined',
    '  }',
    '}',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Generate a TypeScript entity class file.
 */
function tsEntity(ctx: Phase2DDDBoundedContext, entity: Phase2Entity): string {
  const className = toPascalCase(entity.name);

  return [
    `/**`,
    ` * Entity: ${entity.name}`,
    ` * ${entity.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export class ${className} {`,
    '  constructor(',
    '    readonly id: string,',
    '  ) {}',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript value object class file (immutable with factory).
 */
function tsValueObject(
  ctx: Phase2DDDBoundedContext,
  vo: Phase2ValueObject,
): string {
  const className = toPascalCase(vo.name);

  const invariantChecks = vo.invariants
    .map(
      (inv, i) =>
        `    // Validation ${i + 1}: ${inv}\n` +
        `    // if (!condition) throw new Error('${className} validation failed: ${inv.replace(/'/g, "\\'")}');`,
    )
    .join('\n');

  return [
    `/**`,
    ` * Value Object: ${vo.name} (immutable)`,
    ` * ${vo.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export class ${className} {`,
    `  private constructor(`,
    `    private readonly value: string,`,
    `  ) {}`,
    '',
    `  static create(value: string): ${className} {`,
    invariantChecks || '    // No invariants defined',
    `    return new ${className}(value);`,
    '  }',
    '',
    '  getValue(): string {',
    '    return this.value;',
    '  }',
    '',
    `  equals(other: ${className}): boolean {`,
    '    return this.value === other.value;',
    '  }',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript domain event interface file.
 */
function tsDomainEvent(
  ctx: Phase2DDDBoundedContext,
  event: Phase2DomainEvent,
): string {
  const interfaceName = toPascalCase(event.name);
  const eventType = slugify(event.name);

  const payloadFields = event.payload
    .map((p) => `    readonly ${toCamelCase(p)}: string;`)
    .join('\n');

  return [
    `/**`,
    ` * Domain Event: ${event.name}`,
    ` * ${event.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export interface ${interfaceName} {`,
    `  readonly type: '${eventType}';`,
    '  readonly payload: {',
    '    readonly aggregateId: string;',
    '    readonly timestamp: string;',
    '    readonly correlationId: string;',
    payloadFields ? payloadFields : '',
    '  };',
    `  readonly triggeredBy: '${event.triggeredBy}';`,
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript command handler file.
 */
function tsCommand(
  ctx: Phase2DDDBoundedContext,
  cmd: Phase2Command,
): string {
  const handlerName = toPascalCase(cmd.name);

  const inputFields = cmd.input
    .map((inp) => `  readonly ${toCamelCase(inp)}: string;`)
    .join('\n');

  const preconditionComments = cmd.preconditions
    .map((pre) => `  // Precondition: ${pre}`)
    .join('\n');

  return [
    `/**`,
    ` * Command: ${cmd.name}`,
    ` * ${cmd.description}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export interface ${handlerName}Input {`,
    inputFields || '  // No input fields defined',
    '}',
    '',
    `export interface ${handlerName}Dependencies {`,
    '  // Seam interfaces injected at runtime',
    '}',
    '',
    `export async function handle${handlerName}(`,
    `  input: ${handlerName}Input,`,
    `  deps: ${handlerName}Dependencies,`,
    '): Promise<void> {',
    preconditionComments || '  // No preconditions defined',
    `  // TODO: implement via ruflo`,
    `  throw new Error('Not implemented: handle${handlerName}');`,
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript query handler file.
 */
function tsQuery(
  ctx: Phase2DDDBoundedContext,
  query: Phase2Query,
): string {
  const handlerName = toPascalCase(query.name);

  const paramFields = query.parameters
    .map((p) => `  readonly ${toCamelCase(p)}: string;`)
    .join('\n');

  return [
    `/**`,
    ` * Query: ${query.name}`,
    ` * ${query.description}`,
    ` * Returns: ${query.returns}`,
    ` * Bounded context: ${ctx.name}`,
    ` */`,
    '',
    `export interface ${handlerName}Params {`,
    paramFields || '  // No parameters defined',
    '}',
    '',
    `export interface ${handlerName}Dependencies {`,
    '  // Seam interfaces injected at runtime',
    '}',
    '',
    `export async function handle${handlerName}(`,
    `  params: ${handlerName}Params,`,
    `  deps: ${handlerName}Dependencies,`,
    '): Promise<unknown> {',
    `  // TODO: implement via ruflo`,
    `  throw new Error('Not implemented: handle${handlerName}');`,
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript seam interface (port) file from a mock contract.
 */
function tsSeam(contract: MockContract): string {
  const portName = `I${toPascalCase(contract.interfaceName)}Port`;

  const methods = contract.methods
    .map(
      (m) =>
        `  /** ${m.behavior} */\n` +
        `  ${toCamelCase(m.name)}(input: ${m.input || 'void'}): Promise<${m.output || 'void'}>;`,
    )
    .join('\n\n');

  return [
    `/**`,
    ` * Seam Interface: ${contract.name}`,
    ` * Target service: ${contract.targetService}`,
    ` * Bounded context: ${contract.boundedContext}`,
    ` */`,
    '',
    `export interface ${portName} {`,
    methods || '  // No methods defined',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a TypeScript seam interface from a SeamDefinition (when no
 * matching MockContract exists).
 */
function tsSeamFromDefinition(seam: SeamDefinition): string {
  const portName = `I${toPascalCase(seam.name)}Port`;

  return [
    `/**`,
    ` * Seam Interface: ${seam.name}`,
    ` * Between: ${seam.between[0]} <-> ${seam.between[1]}`,
    ` * Contract type: ${seam.contractType}`,
    ` * Integration test approach: ${seam.integrationTestApproach}`,
    ` */`,
    '',
    `export interface ${portName} {`,
    `  // Mock boundary: ${seam.mockBoundary}`,
    `  // TODO: Define methods based on contract type '${seam.contractType}'`,
    '}',
    '',
  ].join('\n');
}

// ============================================================================
// Rust Code Generation
// ============================================================================

/**
 * Generate a Rust aggregate struct.
 */
function rustAggregate(
  ctx: Phase2DDDBoundedContext,
  agg: Phase2AggregateDefinition,
): string {
  const structName = toPascalCase(agg.name);
  const entityFields = agg.entities
    .map((e) => `    pub ${snakeCase(e.name)}: String,`)
    .join('\n');

  const invariantChecks = agg.invariants
    .map(
      (inv, i) =>
        `        // Invariant ${i + 1}: ${inv}\n` +
        `        // if !condition { return Err(DomainError::InvariantViolation("${inv.replace(/"/g, '\\"')}".into())); }`,
    )
    .join('\n');

  return [
    `//! Aggregate: ${agg.name}`,
    `//! Root: ${agg.root}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    'use std::fmt;',
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName} {`,
    '    pub id: String,',
    entityFields || '',
    '}',
    '',
    '#[derive(Debug, Clone, PartialEq, Eq)]',
    'pub enum DomainError {',
    '    InvariantViolation(String),',
    '}',
    '',
    'impl fmt::Display for DomainError {',
    '    fn fmt(&self, f: &mut fmt::Formatter<\'_>) -> fmt::Result {',
    '        match self {',
    '            DomainError::InvariantViolation(msg) => write!(f, "Invariant violated: {}", msg),',
    '        }',
    '    }',
    '}',
    '',
    'impl std::error::Error for DomainError {}',
    '',
    `impl ${structName} {`,
    `    pub fn new(id: String${agg.entities.length > 0 ? ', ' + agg.entities.map((e) => `${snakeCase(e.name)}: String`).join(', ') : ''}) -> Result<Self, DomainError> {`,
    `        let instance = Self {`,
    '            id,',
    agg.entities.map((e) => `            ${snakeCase(e.name)},`).join('\n') || '',
    '        };',
    '        instance.validate_invariants()?;',
    '        Ok(instance)',
    '    }',
    '',
    '    fn validate_invariants(&self) -> Result<(), DomainError> {',
    invariantChecks || '        // No invariants defined',
    '        Ok(())',
    '    }',
    '}',
    '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Generate a Rust entity struct.
 */
function rustEntity(ctx: Phase2DDDBoundedContext, entity: Phase2Entity): string {
  const structName = toPascalCase(entity.name);

  return [
    `//! Entity: ${entity.name}`,
    `//! ${entity.description}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName} {`,
    '    pub id: String,',
    '}',
    '',
    `impl ${structName} {`,
    '    pub fn new(id: String) -> Self {',
    '        Self { id }',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust value object struct (immutable with factory).
 */
function rustValueObject(
  ctx: Phase2DDDBoundedContext,
  vo: Phase2ValueObject,
): string {
  const structName = toPascalCase(vo.name);

  const invariantChecks = vo.invariants
    .map(
      (inv, i) =>
        `        // Validation ${i + 1}: ${inv}\n` +
        `        // if !condition { return Err("${structName} validation failed: ${inv.replace(/"/g, '\\"')}".into()); }`,
    )
    .join('\n');

  return [
    `//! Value Object: ${vo.name} (immutable)`,
    `//! ${vo.description}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Clone, Debug, PartialEq, Eq)]',
    `pub struct ${structName} {`,
    '    value: String,',
    '}',
    '',
    `impl ${structName} {`,
    '    pub fn create(value: String) -> Result<Self, Box<dyn std::error::Error>> {',
    invariantChecks || '        // No invariants defined',
    '        Ok(Self { value })',
    '    }',
    '',
    '    pub fn value(&self) -> &str {',
    '        &self.value',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust domain event struct.
 */
function rustDomainEvent(
  ctx: Phase2DDDBoundedContext,
  event: Phase2DomainEvent,
): string {
  const structName = toPascalCase(event.name);

  const payloadFields = event.payload
    .map((p) => `    pub ${snakeCase(p)}: String,`)
    .join('\n');

  return [
    `//! Domain Event: ${event.name}`,
    `//! ${event.description}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName}Payload {`,
    '    pub aggregate_id: String,',
    '    pub timestamp: String,',
    '    pub correlation_id: String,',
    payloadFields || '',
    '}',
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${structName} {`,
    `    pub event_type: String,`,
    `    pub payload: ${structName}Payload,`,
    `    pub triggered_by: String,`,
    '}',
    '',
    `impl ${structName} {`,
    `    pub fn new(payload: ${structName}Payload) -> Self {`,
    '        Self {',
    `            event_type: "${slugify(event.name)}".to_string(),`,
    '            payload,',
    `            triggered_by: "${event.triggeredBy}".to_string(),`,
    '        }',
    '    }',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust command handler.
 */
function rustCommand(
  ctx: Phase2DDDBoundedContext,
  cmd: Phase2Command,
): string {
  const handlerName = toPascalCase(cmd.name);
  const fnName = snakeCase(cmd.name);

  const inputFields = cmd.input
    .map((inp) => `    pub ${snakeCase(inp)}: String,`)
    .join('\n');

  const preconditionComments = cmd.preconditions
    .map((pre) => `    // Precondition: ${pre}`)
    .join('\n');

  return [
    `//! Command: ${cmd.name}`,
    `//! ${cmd.description}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${handlerName}Input {`,
    inputFields || '    // No input fields defined',
    '}',
    '',
    `pub async fn handle_${fnName}(`,
    `    _input: ${handlerName}Input,`,
    ') -> Result<(), Box<dyn std::error::Error>> {',
    preconditionComments || '    // No preconditions defined',
    '    // TODO: implement via ruflo',
    `    todo!("Not implemented: handle_${fnName}")`,
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust query handler.
 */
function rustQuery(
  ctx: Phase2DDDBoundedContext,
  query: Phase2Query,
): string {
  const handlerName = toPascalCase(query.name);
  const fnName = snakeCase(query.name);

  const paramFields = query.parameters
    .map((p) => `    pub ${snakeCase(p)}: String,`)
    .join('\n');

  return [
    `//! Query: ${query.name}`,
    `//! ${query.description}`,
    `//! Returns: ${query.returns}`,
    `//! Bounded context: ${ctx.name}`,
    '',
    '#[derive(Debug, Clone)]',
    `pub struct ${handlerName}Params {`,
    paramFields || '    // No parameters defined',
    '}',
    '',
    `pub async fn handle_${fnName}(`,
    `    _params: ${handlerName}Params,`,
    ') -> Result<Box<dyn std::any::Any>, Box<dyn std::error::Error>> {',
    '    // TODO: implement via ruflo',
    `    todo!("Not implemented: handle_${fnName}")`,
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust seam trait from a MockContract.
 */
function rustSeam(contract: MockContract): string {
  const traitName = `I${toPascalCase(contract.interfaceName)}Port`;

  const methods = contract.methods
    .map(
      (m) =>
        `    /// ${m.behavior}\n` +
        `    async fn ${snakeCase(m.name)}(&self, input: ${m.input || '()'}) -> Result<${m.output || '()'}, Box<dyn std::error::Error>>;`,
    )
    .join('\n\n');

  return [
    `//! Seam Interface: ${contract.name}`,
    `//! Target service: ${contract.targetService}`,
    `//! Bounded context: ${contract.boundedContext}`,
    '',
    '#[async_trait::async_trait]',
    `pub trait ${traitName}: Send + Sync {`,
    methods || '    // No methods defined',
    '}',
    '',
  ].join('\n');
}

/**
 * Generate a Rust seam trait from a SeamDefinition.
 */
function rustSeamFromDefinition(seam: SeamDefinition): string {
  const traitName = `I${toPascalCase(seam.name)}Port`;

  return [
    `//! Seam Interface: ${seam.name}`,
    `//! Between: ${seam.between[0]} <-> ${seam.between[1]}`,
    `//! Contract type: ${seam.contractType}`,
    `//! Integration test approach: ${seam.integrationTestApproach}`,
    '',
    '#[async_trait::async_trait]',
    `pub trait ${traitName}: Send + Sync {`,
    `    // Mock boundary: ${seam.mockBoundary}`,
    `    // TODO: Define methods based on contract type '${seam.contractType}'`,
    '}',
    '',
  ].join('\n');
}

// ============================================================================
// Aggregate Entity/VO Extraction
// ============================================================================

/**
 * Collect all entities across all aggregates in a bounded context.
 */
function collectEntities(ctx: Phase2DDDBoundedContext): Phase2Entity[] {
  const entities: Phase2Entity[] = [];
  const seen = new Set<string>();
  for (const agg of ctx.aggregates) {
    for (const entity of agg.entities) {
      if (!seen.has(entity.name)) {
        seen.add(entity.name);
        entities.push(entity);
      }
    }
  }
  return entities;
}

/**
 * Collect all value objects across all aggregates in a bounded context.
 */
function collectValueObjects(ctx: Phase2DDDBoundedContext): Phase2ValueObject[] {
  const vos: Phase2ValueObject[] = [];
  const seen = new Set<string>();
  for (const agg of ctx.aggregates) {
    for (const vo of agg.valueObjects) {
      if (!seen.has(vo.name)) {
        seen.add(vo.name);
        vos.push(vo);
      }
    }
  }
  return vos;
}

// ============================================================================
// Mock Contract Resolution
// ============================================================================

/**
 * Find all mock contracts that belong to a given bounded context.
 */
function contractsForContext(
  contextName: string,
  contracts: readonly MockContract[],
): MockContract[] {
  const ctxSlug = slugify(contextName.replace(/Context$/i, ''));
  return contracts.filter((c) => {
    const bcSlug = slugify(c.boundedContext.replace(/Context$/i, ''));
    return bcSlug === ctxSlug || c.boundedContext === contextName;
  });
}

/**
 * Find all seam definitions that reference a given bounded context
 * (in either side of the `between` tuple) and have no matching mock contract.
 *
 * Normalizes names by stripping a trailing "Context" suffix and slugifying,
 * so that DDD context names like "ApiGatewayContext" match seam `between`
 * values like "api-gateway".
 */
function orphanSeamsForContext(
  contextName: string,
  seams: readonly SeamDefinition[],
  contracts: readonly MockContract[],
): SeamDefinition[] {
  const ctxSlug = slugify(contextName.replace(/Context$/i, ''));
  const contractNames = new Set(contracts.map((c) => c.name));
  return seams.filter(
    (s) =>
      (slugify(s.between[0]) === ctxSlug || slugify(s.between[1]) === ctxSlug) &&
      !contractNames.has(s.name),
  );
}

// ============================================================================
// Barrel File Generators
// ============================================================================

/**
 * Generate a TypeScript barrel file that re-exports all modules in a directory.
 */
function tsBarrel(exports: string[]): string {
  if (exports.length === 0) {
    return '// No exports yet\n';
  }
  return exports.map((e) => `export * from './${e}.js';`).join('\n') + '\n';
}

/**
 * Generate a Rust mod.rs file that declares public modules.
 */
function rustMod(modules: string[]): string {
  if (modules.length === 0) {
    return '// No modules yet\n';
  }
  return modules.map((m) => `pub mod ${m};`).join('\n') + '\n';
}

// ============================================================================
// Public: Pure Builder
// ============================================================================

/**
 * Pure function that builds all domain code files from the DDD domain model
 * and TDD plan. No side effects -- does not write anything to disk.
 *
 * @param domainModel - The Phase 2 DDD domain model
 * @param tddPlan     - The Phase 2 TDD plan (for seam/mock contract info)
 * @param language    - The resolved implementation language
 * @returns CodegenOutput with all generated files and summary counts
 */
export function buildDomainCode(
  domainModel: Phase2DomainModel,
  tddPlan: TDDPlan,
  language: ImplementationLanguage,
): CodegenOutput {
  const files: CodegenFile[] = [];
  let totalAggregates = 0;
  let totalEntities = 0;
  let totalValueObjects = 0;
  let totalEvents = 0;
  let totalCommands = 0;
  let totalQueries = 0;
  let totalSeams = 0;

  const isTs = language === 'typescript';

  for (const ctx of domainModel.contexts) {
    const ctxSlug = isTs ? slugify(ctx.name) : snakeCase(ctx.name);
    const basePath = isTs
      ? `${ROOT_DIR}/src/${ctxSlug}`
      : `${ROOT_DIR}/${ctxSlug}/src`;

    // Track names for barrel/mod files
    const aggregateNames: string[] = [];
    const entityNames: string[] = [];
    const voNames: string[] = [];
    const eventNames: string[] = [];
    const commandNames: string[] = [];
    const queryNames: string[] = [];
    const seamNames: string[] = [];

    // --- Aggregates ---
    for (const agg of ctx.aggregates) {
      const fileSlug = slugify(agg.name);
      const modName = isTs ? fileSlug : snakeCase(agg.name);
      aggregateNames.push(modName);
      totalAggregates++;

      const content = isTs ? tsAggregate(ctx, agg) : rustAggregate(ctx, agg);
      const relPath = isTs
        ? `${basePath}/domain/aggregates/${fileSlug}.ts`
        : `${basePath}/domain/aggregates/${snakeCase(agg.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'aggregate',
      });
    }

    // --- Entities ---
    const entities = collectEntities(ctx);
    for (const entity of entities) {
      const fileSlug = slugify(entity.name);
      const modName = isTs ? fileSlug : snakeCase(entity.name);
      entityNames.push(modName);
      totalEntities++;

      const content = isTs ? tsEntity(ctx, entity) : rustEntity(ctx, entity);
      const relPath = isTs
        ? `${basePath}/domain/entities/${fileSlug}.ts`
        : `${basePath}/domain/entities/${snakeCase(entity.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'entity',
      });
    }

    // --- Value Objects ---
    const valueObjects = collectValueObjects(ctx);
    for (const vo of valueObjects) {
      const fileSlug = slugify(vo.name);
      const modName = isTs ? fileSlug : snakeCase(vo.name);
      voNames.push(modName);
      totalValueObjects++;

      const content = isTs ? tsValueObject(ctx, vo) : rustValueObject(ctx, vo);
      const relPath = isTs
        ? `${basePath}/domain/value-objects/${fileSlug}.ts`
        : `${basePath}/domain/value_objects/${snakeCase(vo.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'value-object',
      });
    }

    // --- Domain Events ---
    for (const event of ctx.domainEvents) {
      const fileSlug = slugify(event.name);
      const modName = isTs ? fileSlug : snakeCase(event.name);
      eventNames.push(modName);
      totalEvents++;

      const content = isTs ? tsDomainEvent(ctx, event) : rustDomainEvent(ctx, event);
      const relPath = isTs
        ? `${basePath}/domain/events/${fileSlug}.ts`
        : `${basePath}/domain/events/${snakeCase(event.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'event',
      });
    }

    // --- Commands ---
    for (const cmd of ctx.commands) {
      const fileSlug = slugify(cmd.name);
      const modName = isTs ? fileSlug : snakeCase(cmd.name);
      commandNames.push(modName);
      totalCommands++;

      const content = isTs ? tsCommand(ctx, cmd) : rustCommand(ctx, cmd);
      const relPath = isTs
        ? `${basePath}/domain/commands/${fileSlug}.ts`
        : `${basePath}/domain/commands/${snakeCase(cmd.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'command',
      });
    }

    // --- Queries ---
    for (const query of ctx.queries) {
      const fileSlug = slugify(query.name);
      const modName = isTs ? fileSlug : snakeCase(query.name);
      queryNames.push(modName);
      totalQueries++;

      const content = isTs ? tsQuery(ctx, query) : rustQuery(ctx, query);
      const relPath = isTs
        ? `${basePath}/domain/queries/${fileSlug}.ts`
        : `${basePath}/domain/queries/${snakeCase(query.name)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'query',
      });
    }

    // --- Seam Interfaces (from MockContracts) ---
    const ctxContracts = contractsForContext(ctx.name, tddPlan.mockContracts);
    for (const contract of ctxContracts) {
      const fileSlug = slugify(contract.interfaceName);
      const modName = isTs ? fileSlug : snakeCase(contract.interfaceName);
      seamNames.push(modName);
      totalSeams++;

      const content = isTs ? tsSeam(contract) : rustSeam(contract);
      const relPath = isTs
        ? `${basePath}/ports/${fileSlug}.ts`
        : `${basePath}/ports/${snakeCase(contract.interfaceName)}.rs`;

      files.push({
        relativePath: relPath,
        content,
        boundedContext: ctx.name,
        kind: 'seam',
      });
    }

    // --- Seam Interfaces (from orphan SeamDefinitions) ---
    const orphanSeams = orphanSeamsForContext(
      ctx.name,
      tddPlan.seamDefinitions,
      tddPlan.mockContracts,
    );
    for (const seam of orphanSeams) {
      const fileSlug = slugify(seam.name);
      const modName = isTs ? fileSlug : snakeCase(seam.name);
      // Avoid duplicates in the same context
      if (!seamNames.includes(modName)) {
        seamNames.push(modName);
        totalSeams++;

        const content = isTs
          ? tsSeamFromDefinition(seam)
          : rustSeamFromDefinition(seam);
        const relPath = isTs
          ? `${basePath}/ports/${fileSlug}.ts`
          : `${basePath}/ports/${snakeCase(seam.name)}.rs`;

        files.push({
          relativePath: relPath,
          content,
          boundedContext: ctx.name,
          kind: 'seam',
        });
      }
    }

    // --- Barrel / Mod files ---
    if (isTs) {
      // TypeScript barrel index files for each subdirectory
      const barrels: Array<{ dir: string; names: string[] }> = [
        { dir: 'domain/aggregates', names: aggregateNames },
        { dir: 'domain/entities', names: entityNames },
        { dir: 'domain/value-objects', names: voNames },
        { dir: 'domain/events', names: eventNames },
        { dir: 'domain/commands', names: commandNames },
        { dir: 'domain/queries', names: queryNames },
        { dir: 'ports', names: seamNames },
      ];

      for (const barrel of barrels) {
        if (barrel.names.length > 0) {
          files.push({
            relativePath: `${basePath}/${barrel.dir}/index.ts`,
            content: tsBarrel(barrel.names),
            boundedContext: ctx.name,
            kind: 'barrel',
          });
        }
      }

      // Context-level barrel
      files.push({
        relativePath: `${basePath}/index.ts`,
        content: [
          `// Barrel export for bounded context: ${ctx.name}`,
          `export * from './domain/aggregates/index.js';`,
          `export * from './domain/entities/index.js';`,
          `export * from './domain/value-objects/index.js';`,
          `export * from './domain/events/index.js';`,
          `export * from './domain/commands/index.js';`,
          `export * from './domain/queries/index.js';`,
          `export * from './ports/index.js';`,
          '',
        ].join('\n'),
        boundedContext: ctx.name,
        kind: 'barrel',
      });
    } else {
      // Rust mod.rs files for each subdirectory
      const modFiles: Array<{ dir: string; names: string[] }> = [
        { dir: 'domain/aggregates', names: aggregateNames },
        { dir: 'domain/entities', names: entityNames },
        { dir: 'domain/value_objects', names: voNames },
        { dir: 'domain/events', names: eventNames },
        { dir: 'domain/commands', names: commandNames },
        { dir: 'domain/queries', names: queryNames },
        { dir: 'ports', names: seamNames },
      ];

      for (const modFile of modFiles) {
        if (modFile.names.length > 0) {
          files.push({
            relativePath: `${basePath}/${modFile.dir}/mod.rs`,
            content: rustMod(modFile.names),
            boundedContext: ctx.name,
            kind: 'mod',
          });
        }
      }

      // domain/mod.rs (with all sub-module declarations)
      files.push({
        relativePath: `${basePath}/domain/mod.rs`,
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
        boundedContext: ctx.name,
        kind: 'mod',
      });

      // ports/mod.rs (already handled in the modFiles loop if non-empty)
      if (seamNames.length === 0) {
        files.push({
          relativePath: `${basePath}/ports/mod.rs`,
          content: `//! Port interfaces for ${ctx.name}\n`,
          boundedContext: ctx.name,
          kind: 'mod',
        });
      }
    }
  }

  return {
    files,
    totalAggregates,
    totalEntities,
    totalValueObjects,
    totalEvents,
    totalCommands,
    totalQueries,
    totalSeams,
  };
}

// ============================================================================
// File Writing
// ============================================================================

/**
 * Write all codegen files to disk under the given base directory.
 * Creates directories as needed with 0o700 permissions and files
 * with 0o600 permissions.
 *
 * @param files   - Codegen files to write
 * @param baseDir - Absolute path to the Phase 3 output directory
 * @returns Array of absolute paths written
 */
function writeCodegenFiles(files: readonly CodegenFile[], baseDir: string): string[] {
  const writtenPaths: string[] = [];

  for (const file of files) {
    const absPath = path.join(baseDir, file.relativePath);
    const dir = path.dirname(absPath);

    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });

    try {
      fs.writeFileSync(absPath, file.content, {
        encoding: 'utf-8',
        mode: FILE_MODE,
      });
      writtenPaths.push(absPath);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ECLI-P3-031: Failed to write codegen file ${file.relativePath}: ${message}`,
      );
    }
  }

  return writtenPaths;
}

// ============================================================================
// Public: Pipeline Entry Point
// ============================================================================

/**
 * Stage 4 entry point: generate domain core code from the Phase 2 DDD domain
 * model, TDD plan, and resolved language stored on the pipeline context.
 *
 * Reads ScaffoldMetadata from context.stageOutputs.get('scaffold-generation')
 * and LanguageResolution from context.stageOutputs.get('language-resolution'),
 * calls buildDomainCode, writes all files to disk, and returns the stage output.
 *
 * @param context - The Phase 3 pipeline context
 * @returns Stage output describing success or failure
 */
export async function generateDomainCode(
  context: Phase3Context,
): Promise<Phase3StageOutput> {
  const rootSpan = createSpan('domain-codegen', 'generate-domain-code', {
    phase3Dir: context.phase3Dir,
  });

  try {
    // Verify scaffold generation completed
    const scaffoldStage = context.stageOutputs.get('scaffold-generation');
    if (!scaffoldStage || scaffoldStage.status !== 'completed') {
      throw new Error(
        'ECLI-P3-030: Scaffold generation not available on context. ' +
        'Ensure the scaffold-generation stage completed successfully before running domain-codegen.',
      );
    }
    // Validate scaffold data is present (consumed indirectly via disk layout)
    void (scaffoldStage.data as ScaffoldMetadata);

    // Retrieve language resolution
    const langStage = context.stageOutputs.get('language-resolution');
    if (!langStage || langStage.status !== 'completed') {
      throw new Error(
        'ECLI-P3-030: Language resolution not available on context. ' +
        'Ensure the language-resolution stage completed successfully before running domain-codegen.',
      );
    }
    const langResolution = langStage.data as LanguageResolution;
    const language = langResolution.language;

    // Retrieve Phase 2 artifacts
    const domainModel = context.phase2Artifacts.domainModel;
    const tddPlan = context.phase2Artifacts.tddPlan;

    // Build domain code (pure, no I/O)
    const buildSpan = createSpan(
      'domain-codegen',
      'build-domain-code',
      {
        language,
        contexts: domainModel.contexts.length,
        mockContracts: tddPlan.mockContracts.length,
        seamDefinitions: tddPlan.seamDefinitions.length,
      },
      rootSpan.spanId,
    );

    const codegen = buildDomainCode(domainModel, tddPlan, language);

    const finalBuildSpan = endSpan(buildSpan, 'ok', {
      totalFiles: codegen.files.length,
      totalAggregates: codegen.totalAggregates,
      totalEntities: codegen.totalEntities,
      totalValueObjects: codegen.totalValueObjects,
      totalEvents: codegen.totalEvents,
      totalCommands: codegen.totalCommands,
      totalQueries: codegen.totalQueries,
      totalSeams: codegen.totalSeams,
    });
    emitSpan(finalBuildSpan);

    // Write codegen files to disk
    const writeSpan = createSpan(
      'domain-codegen',
      'write-files',
      { totalFiles: codegen.files.length },
      rootSpan.spanId,
    );

    const writtenPaths = writeCodegenFiles(codegen.files, context.phase3Dir);

    const finalWriteSpan = endSpan(writeSpan, 'ok', {
      filesWritten: writtenPaths.length,
    });
    emitSpan(finalWriteSpan);

    // Finalize root span
    const finalRootSpan = endSpan(rootSpan, 'ok', {
      language,
      totalFiles: writtenPaths.length,
      totalAggregates: codegen.totalAggregates,
      totalEntities: codegen.totalEntities,
      totalValueObjects: codegen.totalValueObjects,
      totalEvents: codegen.totalEvents,
      totalCommands: codegen.totalCommands,
      totalQueries: codegen.totalQueries,
      totalSeams: codegen.totalSeams,
    });
    emitSpan(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'domain-codegen',
      status: 'completed',
      data: codegen,
      artifacts: writtenPaths,
      timing,
      summary:
        `Generated ${language} domain code: ` +
        `${codegen.totalAggregates} aggregates, ` +
        `${codegen.totalEntities} entities, ` +
        `${codegen.totalValueObjects} value objects, ` +
        `${codegen.totalEvents} events, ` +
        `${codegen.totalCommands} commands, ` +
        `${codegen.totalQueries} queries, ` +
        `${codegen.totalSeams} seams ` +
        `(${writtenPaths.length} files in ${timing}ms)`,
    };

    context.stageOutputs.set('domain-codegen', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    const finalRootSpan = endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(finalRootSpan);

    const timing = finalRootSpan.durationMs ?? 0;

    const output: Phase3StageOutput = {
      stage: 'domain-codegen',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `Domain codegen failed: ${errorMessage}`,
    };

    context.stageOutputs.set('domain-codegen', output);
    return output;
  }
}
