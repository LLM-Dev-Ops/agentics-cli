/**
 * Markdown Renderers for Phase 2 Pipeline Artifacts
 *
 * Renders ADRs, DDD models, TDD plans, research dossiers, and full SPARC
 * output as formatted markdown strings. All functions are deterministic:
 * arrays are sorted before rendering where ordering is not semantically
 * meaningful.
 */

import type {
  Phase2ADRRecord,
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  TDDPlan,
  TDDTestSuite,
  MockContract,
  ResearchDossier,
  Phase2SPARCOutput,
} from '../types.js';

// ============================================================================
// Helpers
// ============================================================================

/** Escape pipe characters inside markdown table cells. */
function esc(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** Join an array into a comma-separated string, sorting a copy first. */
function sortedJoin(items: readonly string[], separator = ', '): string {
  return [...items].sort().join(separator);
}

// ============================================================================
// 1. ADR Renderer
// ============================================================================

/**
 * Render a Phase 2 ADR record as formatted markdown.
 */
export function renderADRMarkdown(adr: Phase2ADRRecord): string {
  const lines: string[] = [];

  lines.push(`# ${adr.id}: ${adr.title}`);
  lines.push('');
  lines.push(`**Status:** ${adr.status}  `);
  lines.push(`**Date:** ${adr.date}`);
  if (adr.supersedes) {
    lines.push(`**Supersedes:** ${adr.supersedes}`);
  }
  lines.push('');

  // Context
  lines.push('## Context');
  lines.push('');
  lines.push(adr.context);
  lines.push('');

  // Decision
  lines.push('## Decision');
  lines.push('');
  lines.push(adr.decision);
  lines.push('');

  // Alternatives Considered
  lines.push('## Alternatives Considered');
  lines.push('');
  lines.push('| Option | Rationale | Status |');
  lines.push('|--------|-----------|--------|');
  for (const alt of adr.alternatives) {
    const status = alt.rejected ? 'rejected' : 'selected';
    lines.push(`| ${esc(alt.option)} | ${esc(alt.rationale)} | ${status} |`);
  }
  lines.push('');

  // Consequences
  lines.push('## Consequences');
  lines.push('');

  const positive = adr.consequences.filter((c) => c.type === 'positive');
  const negative = adr.consequences.filter((c) => c.type === 'negative');
  const neutral = adr.consequences.filter((c) => c.type === 'neutral');

  if (positive.length > 0) {
    lines.push('### Positive');
    for (const c of positive) {
      lines.push(`- ${c.description}`);
    }
    lines.push('');
  }

  if (negative.length > 0) {
    lines.push('### Negative');
    for (const c of negative) {
      lines.push(`- ${c.description}`);
    }
    lines.push('');
  }

  if (neutral.length > 0) {
    lines.push('### Neutral');
    for (const c of neutral) {
      lines.push(`- ${c.description}`);
    }
    lines.push('');
  }

  // References
  lines.push('## References');
  lines.push('');
  lines.push(`- **SPARC sections:** ${sortedJoin(adr.sparcSectionRefs)}`);
  lines.push(
    `- **Research dossier items:** ${sortedJoin(adr.researchDossierItemRefs)}`,
  );

  return lines.join('\n');
}

// ============================================================================
// 2. DDD Renderer
// ============================================================================

/** Render a single bounded context section. */
function renderBoundedContext(ctx: Phase2DDDBoundedContext): string {
  const lines: string[] = [];

  lines.push(`### ${ctx.name}`);
  lines.push('');
  lines.push(ctx.description);
  lines.push('');

  // Aggregates
  lines.push('#### Aggregates');
  for (const agg of ctx.aggregates) {
    lines.push(`- **${agg.root}**`);
    const entityNames = agg.entities.map((e) => e.name);
    lines.push(`  - Entities: ${sortedJoin(entityNames)}`);
    const voNames = agg.valueObjects.map((vo) => vo.name);
    lines.push(`  - Value Objects: ${sortedJoin(voNames)}`);
    lines.push('  - Invariants:');
    agg.invariants.forEach((inv, i) => {
      lines.push(`    ${i + 1}. ${inv}`);
    });
  }
  lines.push('');

  // Domain Events
  lines.push('#### Domain Events');
  lines.push('| Event | Triggered By | Payload |');
  lines.push('|-------|-------------|---------|');
  for (const evt of ctx.domainEvents) {
    lines.push(
      `| ${esc(evt.name)} | ${esc(evt.triggeredBy)} | ${esc(sortedJoin(evt.payload))} |`,
    );
  }
  lines.push('');

  // Commands
  lines.push('#### Commands');
  lines.push('| Command | Input | Preconditions | Postconditions |');
  lines.push('|---------|-------|---------------|----------------|');
  for (const cmd of ctx.commands) {
    lines.push(
      `| ${esc(cmd.name)} | ${esc(sortedJoin(cmd.input))} | ${esc(cmd.preconditions.join('; '))} | ${esc(cmd.postconditions.join('; '))} |`,
    );
  }
  lines.push('');

  // Queries
  lines.push('#### Queries');
  lines.push('| Query | Parameters | Returns |');
  lines.push('|-------|-----------|---------|');
  for (const q of ctx.queries) {
    lines.push(
      `| ${esc(q.name)} | ${esc(sortedJoin(q.parameters))} | ${esc(q.returns)} |`,
    );
  }
  lines.push('');

  // Ubiquitous Language (context-level)
  lines.push('#### Ubiquitous Language');
  lines.push('| Term | Definition | Aliases |');
  lines.push('|------|-----------|---------|');
  const sortedTerms = [...ctx.ubiquitousLanguage].sort((a, b) =>
    a.term.localeCompare(b.term),
  );
  for (const t of sortedTerms) {
    lines.push(
      `| ${esc(t.term)} | ${esc(t.definition)} | ${esc(sortedJoin(t.aliases))} |`,
    );
  }

  return lines.join('\n');
}

/**
 * Render a Phase 2 DDD domain model as formatted markdown.
 */
export function renderDDDMarkdown(model: Phase2DomainModel): string {
  const lines: string[] = [];

  lines.push('# Domain-Driven Design Model');
  lines.push('');

  // Context Map
  lines.push('## Context Map');
  lines.push('');
  lines.push('| Upstream | Downstream | Relationship | Description |');
  lines.push('|----------|------------|-------------|-------------|');
  const sortedRelations = [...model.contextMap].sort((a, b) => {
    const cmp = a.upstream.localeCompare(b.upstream);
    return cmp !== 0 ? cmp : a.downstream.localeCompare(b.downstream);
  });
  for (const rel of sortedRelations) {
    lines.push(
      `| ${esc(rel.upstream)} | ${esc(rel.downstream)} | ${esc(rel.type)} | ${esc(rel.description)} |`,
    );
  }
  lines.push('');

  // Bounded Contexts
  lines.push('## Bounded Contexts');
  lines.push('');
  for (const ctx of model.contexts) {
    lines.push(renderBoundedContext(ctx));
    lines.push('');
  }

  // Ubiquitous Language Glossary (project-wide, sorted alphabetically)
  lines.push('## Ubiquitous Language Glossary');
  lines.push('');
  lines.push('| Term | Definition | Context | Aliases |');
  lines.push('|------|-----------|---------|---------|');
  const sortedGlossary = [...model.ubiquitousLanguageGlossary].sort((a, b) =>
    a.term.localeCompare(b.term),
  );
  for (const t of sortedGlossary) {
    lines.push(
      `| ${esc(t.term)} | ${esc(t.definition)} | ${esc(t.context)} | ${esc(sortedJoin(t.aliases))} |`,
    );
  }

  return lines.join('\n');
}

// ============================================================================
// 3. TDD Plan Renderer
// ============================================================================

/** Render a single test suite section. */
function renderTestSuite(suite: TDDTestSuite): string {
  const lines: string[] = [];

  lines.push(`### ${suite.name} (${suite.layer})`);
  lines.push('');
  lines.push(suite.description);
  lines.push('');
  lines.push(`Mock Dependencies: ${sortedJoin(suite.mockDependencies)}`);
  lines.push(`ADR References: ${sortedJoin(suite.adrRefs)}`);
  lines.push('');

  lines.push('| # | Test Case | Given | When | Then | Assertion |');
  lines.push('|---|----------|-------|------|------|-----------|');
  for (const tc of suite.tests) {
    lines.push(
      `| ${esc(tc.id)} | ${esc(tc.name)} | ${esc(tc.given)} | ${esc(tc.when)} | ${esc(tc.then)} | ${esc(tc.assertionType)} |`,
    );
  }

  return lines.join('\n');
}

/** Render a single mock contract section. */
function renderMockContract(mc: MockContract): string {
  const lines: string[] = [];

  lines.push(`### ${mc.id}: ${mc.name}`);
  lines.push('');
  lines.push(`- **Context:** ${mc.boundedContext}`);
  lines.push(`- **Target:** ${mc.targetService}`);
  lines.push(`- **Interface:** ${mc.interfaceName}`);
  lines.push('');

  lines.push('| Method | Input | Output | Behavior |');
  lines.push('|--------|-------|--------|----------|');
  for (const m of mc.methods) {
    lines.push(
      `| ${esc(m.name)} | ${esc(m.input)} | ${esc(m.output)} | ${esc(m.behavior)} |`,
    );
  }

  return lines.join('\n');
}

/**
 * Render a Phase 2 TDD plan as formatted markdown.
 */
export function renderTDDPlanMarkdown(plan: TDDPlan): string {
  const lines: string[] = [];

  lines.push('# London School TDD Plan');
  lines.push('');
  lines.push('## Approach: Outside-In (Mockist)');
  lines.push('');

  // Test Pyramid
  lines.push('## Test Pyramid');
  lines.push('');
  lines.push('| Layer | Count | Percentage |');
  lines.push('|-------|-------|-----------|');
  lines.push(
    `| Unit | ${plan.testPyramid.unit.count} | ${plan.testPyramid.unit.percentage}% |`,
  );
  lines.push(
    `| Integration | ${plan.testPyramid.integration.count} | ${plan.testPyramid.integration.percentage}% |`,
  );
  lines.push(
    `| Acceptance | ${plan.testPyramid.acceptance.count} | ${plan.testPyramid.acceptance.percentage}% |`,
  );
  lines.push(
    `| E2E | ${plan.testPyramid.e2e.count} | ${plan.testPyramid.e2e.percentage}% |`,
  );
  lines.push('');

  // Execution Order
  lines.push('## Execution Order');
  lines.push('');

  // Build a lookup from suite ID to suite name for the execution order list
  const suiteById = new Map<string, TDDTestSuite>();
  for (const suite of plan.testSuites) {
    suiteById.set(suite.id, suite);
  }
  plan.executionOrder.forEach((suiteId, i) => {
    const suite = suiteById.get(suiteId);
    const label = suite ? `${suiteId}: ${suite.name}` : suiteId;
    lines.push(`${i + 1}. ${label}`);
  });
  lines.push('');

  // Test Suites
  lines.push('## Test Suites');
  lines.push('');
  for (const suite of plan.testSuites) {
    lines.push(renderTestSuite(suite));
    lines.push('');
  }

  // Mock Contracts
  lines.push('## Mock Contracts');
  lines.push('');
  for (const mc of plan.mockContracts) {
    lines.push(renderMockContract(mc));
    lines.push('');
  }

  // Seam Definitions
  lines.push('## Seam Definitions');
  lines.push('');
  lines.push('| # | Seam | Between | Contract Type | Mock Boundary |');
  lines.push('|---|------|---------|--------------|---------------|');
  for (const seam of plan.seamDefinitions) {
    const between = `${seam.between[0]} \u2194 ${seam.between[1]}`;
    lines.push(
      `| ${esc(seam.id)} | ${esc(seam.name)} | ${esc(between)} | ${esc(seam.contractType)} | ${esc(seam.mockBoundary)} |`,
    );
  }

  return lines.join('\n');
}

// ============================================================================
// 4. Research Dossier Renderer
// ============================================================================

/**
 * Render a Phase 2 research dossier as formatted markdown.
 */
export function renderResearchDossierMarkdown(
  dossier: ResearchDossier,
): string {
  const lines: string[] = [];

  lines.push('# Research Dossier');
  lines.push('');
  lines.push(`**Trace ID:** ${dossier.traceId}  `);
  lines.push(`**Generated From:** ${dossier.generatedFrom}  `);
  lines.push(`**Total Items:** ${dossier.summary.totalItems}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');

  // Items by source (sorted by source name for determinism)
  const sourceEntries = Object.entries(dossier.summary.bySource).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const sourceList = sourceEntries
    .map(([source, count]) => `${source} (${count})`)
    .join(', ');
  lines.push(`- Items by source: ${sourceList}`);

  // Items by category (sorted by category name for determinism)
  const categoryEntries = Object.entries(dossier.summary.byCategory).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  const categoryList = categoryEntries
    .map(([cat, count]) => `${cat} (${count})`)
    .join(', ');
  lines.push(`- Items by category: ${categoryList}`);

  // Key risks and critical constraints (already IDs, sort for determinism)
  lines.push(
    `- Key risks: ${[...dossier.summary.keyRisks].sort().join(', ')}`,
  );
  lines.push(
    `- Critical constraints: ${[...dossier.summary.criticalConstraints].sort().join(', ')}`,
  );
  lines.push('');

  // Items grouped by category
  lines.push('## Items');
  lines.push('');

  // Group items by category, sort categories alphabetically
  const itemsByCategory = new Map<string, typeof dossier.items>();
  for (const item of dossier.items) {
    const existing = itemsByCategory.get(item.category) ?? [];
    existing.push(item);
    itemsByCategory.set(item.category, existing);
  }
  const sortedCategories = Array.from(itemsByCategory.keys()).sort();

  for (const category of sortedCategories) {
    const items = itemsByCategory.get(category)!;
    // Sort items within each category by ID for determinism
    const sortedItems = [...items].sort((a, b) => a.id.localeCompare(b.id));

    // Capitalize category name for heading
    const heading = category
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    // Pluralize simply by appending 's' if not already ending in 's'
    const pluralHeading = heading.endsWith('s') ? heading : `${heading}s`;
    lines.push(`### ${pluralHeading}`);

    // Use severity column for risk category, omit otherwise
    if (category === 'risk') {
      lines.push('| ID | Title | Severity | Source | Content |');
      lines.push('|----|-------|----------|--------|---------|');
      for (const item of sortedItems) {
        lines.push(
          `| ${esc(item.id)} | ${esc(item.title)} | ${esc(item.severity ?? '')} | ${esc(item.source)} | ${esc(item.content)} |`,
        );
      }
    } else {
      lines.push('| ID | Title | Source | Content |');
      lines.push('|----|-------|--------|---------|');
      for (const item of sortedItems) {
        lines.push(
          `| ${esc(item.id)} | ${esc(item.title)} | ${esc(item.source)} | ${esc(item.content)} |`,
        );
      }
    }
    lines.push('');
  }

  // Cross-References
  lines.push('## Cross-References');
  lines.push('');
  lines.push('| From | To | Relationship |');
  lines.push('|------|----|-------------|');
  const sortedRefs = [...dossier.crossReferences].sort((a, b) => {
    const cmp = a.fromId.localeCompare(b.fromId);
    return cmp !== 0 ? cmp : a.toId.localeCompare(b.toId);
  });
  for (const ref of sortedRefs) {
    lines.push(
      `| ${esc(ref.fromId)} | ${esc(ref.toId)} | ${esc(ref.relationship)} |`,
    );
  }

  return lines.join('\n');
}

// ============================================================================
// 5. SPARC Renderer
// ============================================================================

/**
 * Render a Phase 2 SPARC output as formatted markdown.
 */
export function renderSPARCMarkdown(sparc: Phase2SPARCOutput): string {
  const lines: string[] = [];
  const spec = sparc.specification;
  const pseudo = sparc.pseudocode;
  const arch = sparc.architecture;
  const refine = sparc.refinement;
  const completion = sparc.completion;

  lines.push('# SPARC Specification');
  lines.push('');

  // --- Specification ---
  lines.push('## Specification');
  lines.push('');

  // Requirements
  lines.push('### Requirements');
  lines.push('| ID | Priority | Text | Dossier Refs |');
  lines.push('|----|----------|------|-------------|');
  for (const req of spec.requirements) {
    lines.push(
      `| ${esc(req.id)} | ${esc(req.priority)} | ${esc(req.text)} | ${esc(sortedJoin(req.dossierItemRefs))} |`,
    );
  }
  lines.push('');

  // Constraints
  lines.push('### Constraints');
  lines.push('| ID | Text | Dossier Refs |');
  lines.push('|----|------|-------------|');
  for (const con of spec.constraints) {
    lines.push(
      `| ${esc(con.id)} | ${esc(con.text)} | ${esc(sortedJoin(con.dossierItemRefs))} |`,
    );
  }
  lines.push('');

  // Success Criteria
  lines.push('### Success Criteria');
  lines.push('| ID | Measurable | Text | Dossier Refs |');
  lines.push('|----|-----------|------|-------------|');
  for (const sc of spec.successCriteria) {
    lines.push(
      `| ${esc(sc.id)} | ${sc.measurable ? 'Yes' : 'No'} | ${esc(sc.text)} | ${esc(sortedJoin(sc.dossierItemRefs))} |`,
    );
  }
  lines.push('');

  // Dossier coverage
  const coveragePct = Math.round(spec.dossierCoverage * 100);
  lines.push(`**Dossier Coverage:** ${coveragePct}%`);
  lines.push('');

  // --- Pseudocode ---
  lines.push('## Pseudocode');
  lines.push('');
  for (const mod of pseudo.modules) {
    lines.push(`### ${mod.name}`);
    lines.push('');
    // Render full pseudocode block if available
    if ('markdown' in mod && typeof (mod as unknown as { markdown: string }).markdown === 'string') {
      lines.push('```pseudocode');
      lines.push((mod as unknown as { markdown: string }).markdown);
      lines.push('```');
      lines.push('');
    } else if (mod.algorithms.length > 0) {
      lines.push('```pseudocode');
      lines.push(mod.algorithms.join('\n'));
      lines.push('```');
      lines.push('');
    }
    if (mod.dataStructures.length > 0) {
      lines.push('**Data Structures:**');
      lines.push('```typescript');
      lines.push(mod.dataStructures.join('\n'));
      lines.push('```');
      lines.push('');
    }
    if (mod.tddAnchors.length > 0) {
      lines.push('**TDD Anchors:**');
      for (const anchor of mod.tddAnchors) {
        lines.push(`- ${anchor}`);
      }
      lines.push('');
    }
  }

  // --- Architecture ---
  lines.push('## Architecture');
  lines.push('');

  // Services
  lines.push('### Services');
  lines.push('| ID | Service | Responsibility | Dependencies |');
  lines.push('|----|---------|---------------|-------------|');
  for (const svc of arch.services) {
    lines.push(
      `| ${esc(svc.id)} | ${esc(svc.name)} | ${esc(svc.responsibility)} | ${esc(sortedJoin(svc.dependencies))} |`,
    );
  }
  lines.push('');

  // Security Boundaries
  lines.push('### Security Boundaries');
  for (const boundary of arch.securityBoundaries) {
    lines.push(`1. ${boundary}`);
  }
  lines.push('');

  // Data Flow
  lines.push('### Data Flow');
  lines.push(arch.dataFlow);
  lines.push('');

  // --- Refinement ---
  lines.push('## Refinement');
  lines.push('');

  // Security Considerations
  lines.push('### Security Considerations');
  lines.push('| ID | Consideration | Dossier Refs |');
  lines.push('|----|-------------|-------------|');
  for (const sc of refine.securityConsiderations) {
    lines.push(
      `| ${esc(sc.id)} | ${esc(sc.text)} | ${esc(sortedJoin(sc.dossierItemRefs))} |`,
    );
  }
  lines.push('');

  // Performance Targets
  lines.push('### Performance Targets');
  lines.push('| ID | Target | Dossier Refs |');
  lines.push('|----|--------|-------------|');
  for (const pt of refine.performanceTargets) {
    lines.push(
      `| ${esc(pt.id)} | ${esc(pt.text)} | ${esc(sortedJoin(pt.dossierItemRefs))} |`,
    );
  }
  lines.push('');

  // --- Completion ---
  lines.push('## Completion');
  lines.push('');

  // Integration Plan
  lines.push('### Integration Plan');
  lines.push(completion.integrationPlan);
  lines.push('');

  // Documentation
  lines.push('### Documentation');
  for (const doc of completion.documentation) {
    lines.push(`1. ${doc}`);
  }
  lines.push('');

  // Monitoring
  lines.push('### Monitoring');
  for (const item of completion.monitoringSetup) {
    lines.push(`1. ${item}`);
  }

  return lines.join('\n');
}
