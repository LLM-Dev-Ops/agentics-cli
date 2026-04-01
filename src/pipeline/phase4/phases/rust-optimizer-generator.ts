/**
 * Phase 4 Pipeline -- Stage 6b: Rust Optimizer Engine Generator (ADR-057)
 *
 * When the user specifies Rust for compute-intensive components (graph modeling,
 * simulation, optimization), generates a standalone Rust project with:
 *   - Cargo.toml with petgraph, serde dependencies (ADR-073: rayon removed — unused)
 *   - Graph model (SupplierNode, DependencyEdge, SupplierNetwork)
 *   - Simulation runner (upgrade, replacement, dual-source strategies)
 *   - Multi-objective optimizer (Pareto frontier)
 *   - TypeScript bridge (subprocess JSON over stdin/stdout)
 *   - Integration test
 *
 * The Rust engine communicates with TypeScript via JSON over stdin/stdout.
 * TypeScript spawns the Rust binary as a subprocess for compute operations.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase4Context, Phase4StageOutput } from '../types.js';
import { createSpan, endSpan, emitSpan } from '../../phase2/telemetry.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Detect whether the user's query specifies Rust for compute components.
 */
function requiresRustOptimizer(scenarioQuery: string): boolean {
  // ADR-088: Explicit Rust mention always triggers
  if (/\brust\b/i.test(scenarioQuery) &&
    /graph|optim|simul|network|dependency|pareto|compute/i.test(scenarioQuery)) {
    return true;
  }
  // ADR-088: Broadened detection — heavy compute patterns trigger Rust even without explicit mention
  // "multi-objective optimization", "Pareto frontier", "large-scale simulation", "Monte Carlo"
  const heavyCompute = /multi.?objective|pareto\s+frontier|large.?scale\s+simul|monte\s+carlo|stochastic\s+simul|combinatorial\s+optim/i;
  return heavyCompute.test(scenarioQuery);
}

function generateCargoToml(projectName: string): string {
  const crateName = projectName.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  return `[package]
name = "${crateName}-optimizer"
version = "0.1.0"
edition = "2021"
description = "Compute engine for ${projectName} — graph modeling, simulation, and multi-objective optimization"

[dependencies]
petgraph = "0.6"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
# ADR-073: rayon removed — unused (add back if optimizing 500+ suppliers)

[dev-dependencies]
assert_float_eq = "1"

[[bin]]
name = "${crateName}-optimizer"
path = "src/main.rs"
`;
}

function generateTypes(): string {
  return `use serde::{Deserialize, Serialize};

/// Carbon maturity level of a supplier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CarbonMaturity {
    Low,
    Medium,
    High,
}

/// A supplier node in the network graph.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupplierNode {
    pub id: String,
    pub name: String,
    pub region: String,
    pub carbon_maturity: CarbonMaturity,
    pub annual_emissions_tonnes: f64,
    pub reliability_score: f64,
    pub annual_cost: f64,
}

/// An edge representing a supply dependency.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub material: String,
    pub volume_pct: f64,
    pub lead_time_days: u32,
    pub switching_cost: f64,
}

/// A transition strategy to evaluate.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitionStrategy {
    pub id: String,
    pub name: String,
    pub strategy_type: String, // "upgrade" | "replacement" | "dual_source"
    pub target_supplier_id: String,
    pub replacement_supplier_id: Option<String>,
    pub description: String,
}

/// Result metrics for a single scenario.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioMetrics {
    pub strategy_id: String,
    pub strategy_name: String,
    pub emissions_reduction_pct: f64,
    pub cost_delta: f64,
    pub risk_level: String,
    pub lead_time_impact_days: i32,
    pub reliability_score: f64,
}

/// ADR-071: Configurable domain constants (passed from TypeScript via JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainConfig {
    /// Normalization divisor for cost scoring — should approximate max expected cost.
    #[serde(default = "default_cost_norm")]
    pub cost_normalization_factor: f64,
    /// Strategy effectiveness multipliers.
    #[serde(default)]
    pub strategy_multipliers: StrategyMultipliers,
}

fn default_cost_norm() -> f64 { 10_000_000.0 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyMultipliers {
    /// Fraction of emissions remaining after upgrade (0.6 = 40% reduction).
    #[serde(default = "default_upgrade")]
    pub upgrade: f64,
    /// Fraction of emissions remaining after replacement (0.3 = 70% reduction).
    #[serde(default = "default_replacement")]
    pub replacement: f64,
    /// Fraction of emissions remaining after dual-sourcing (0.8 = 20% reduction).
    #[serde(default = "default_dual_source")]
    pub dual_source: f64,
}

fn default_upgrade() -> f64 { 0.60 }
fn default_replacement() -> f64 { 0.30 }
fn default_dual_source() -> f64 { 0.80 }

impl Default for StrategyMultipliers {
    fn default() -> Self {
        Self { upgrade: default_upgrade(), replacement: default_replacement(), dual_source: default_dual_source() }
    }
}

impl Default for DomainConfig {
    fn default() -> Self {
        Self { cost_normalization_factor: default_cost_norm(), strategy_multipliers: StrategyMultipliers::default() }
    }
}

/// Input to the optimizer (received via stdin JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizerInput {
    pub suppliers: Vec<SupplierNode>,
    pub edges: Vec<(usize, usize, DependencyEdge)>,
    pub strategies: Vec<TransitionStrategy>,
    pub weights: Option<TradeoffWeights>,
    /// ADR-071: Domain-specific configuration. Defaults used if omitted.
    #[serde(default)]
    pub config: DomainConfig,
}

/// Weights for multi-objective optimization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeoffWeights {
    pub cost: f64,
    pub emissions: f64,
    pub resilience: f64,
    pub complexity: f64,
}

impl Default for TradeoffWeights {
    fn default() -> Self {
        Self { cost: 0.3, emissions: 0.3, resilience: 0.25, complexity: 0.15 }
    }
}

/// Output from the optimizer (written to stdout JSON).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizerOutput {
    pub scenarios: Vec<ScenarioMetrics>,
    pub pareto_frontier: Vec<String>,
    pub recommended: Option<String>,
    pub weights_used: TradeoffWeights,
}
`;
}

function generateGraph(): string {
  return `use petgraph::graph::DiGraph;
use crate::types::{SupplierNode, DependencyEdge};

pub type SupplierNetwork = DiGraph<SupplierNode, DependencyEdge>;

/// Build a directed graph from supplier nodes and dependency edges.
pub fn build_network(
    suppliers: Vec<SupplierNode>,
    edges: Vec<(usize, usize, DependencyEdge)>,
) -> SupplierNetwork {
    let mut graph = DiGraph::new();
    let node_indices: Vec<_> = suppliers.into_iter().map(|s| graph.add_node(s)).collect();

    for (from, to, edge) in edges {
        if from < node_indices.len() && to < node_indices.len() {
            graph.add_edge(node_indices[from], node_indices[to], edge);
        }
    }

    graph
}

/// Count total emissions across all suppliers in the network.
pub fn total_emissions(graph: &SupplierNetwork) -> f64 {
    graph.node_weights().map(|n| n.annual_emissions_tonnes).sum()
}

/// Count total annual cost across all suppliers.
pub fn total_cost(graph: &SupplierNetwork) -> f64 {
    graph.node_weights().map(|n| n.annual_cost).sum()
}

/// Average reliability score across all suppliers.
pub fn avg_reliability(graph: &SupplierNetwork) -> f64 {
    let nodes: Vec<_> = graph.node_weights().collect();
    if nodes.is_empty() { return 0.0; }
    nodes.iter().map(|n| n.reliability_score).sum::<f64>() / nodes.len() as f64
}
`;
}

function generateSimulation(): string {
  return `use crate::types::*;
use crate::graph::{SupplierNetwork, total_emissions, total_cost};

/// Run a single transition strategy against the supplier network.
/// ADR-071: Accepts OptimizerInput for configurable strategy multipliers.
pub fn simulate_strategy(
    network: &SupplierNetwork,
    strategy: &TransitionStrategy,
    input: &OptimizerInput,
) -> ScenarioMetrics {
    let baseline_emissions = total_emissions(network);
    let baseline_cost = total_cost(network);

    // Find target supplier
    let target = network.node_weights()
        .find(|n| n.id == strategy.target_supplier_id);

    // ADR-071: Strategy multipliers from DomainConfig (not hardcoded)
    let sm = &input.config.strategy_multipliers;
    let (emissions_delta, cost_delta, risk, lead_time, reliability) = match strategy.strategy_type.as_str() {
        "upgrade" => {
            // Upgrade: reduce emissions by (1 - upgrade_multiplier)
            let reduction = target.map(|t| t.annual_emissions_tonnes * (1.0 - sm.upgrade)).unwrap_or(0.0);
            let cost_increase = target.map(|t| t.annual_cost * 0.05).unwrap_or(0.0);
            (reduction, cost_increase, "LOW", 3, 0.9)
        }
        "replacement" => {
            // Replace: reduce emissions by (1 - replacement_multiplier)
            let old_emissions = target.map(|t| t.annual_emissions_tonnes).unwrap_or(0.0);
            let reduction = old_emissions * (1.0 - sm.replacement);
            let cost_change = target.map(|t| -t.annual_cost * 0.02).unwrap_or(0.0);
            (reduction, cost_change, "HIGH", 14, 0.6)
        }
        "dual_source" => {
            // Dual source: reduce emissions by (1 - dual_source_multiplier)
            let reduction = target.map(|t| t.annual_emissions_tonnes * (1.0 - sm.dual_source)).unwrap_or(0.0);
            let cost_increase = target.map(|t| t.annual_cost * 0.03).unwrap_or(0.0);
            (reduction, cost_increase, "LOW", 7, 0.85)
        }
        _ => (0.0, 0.0, "MEDIUM", 0, 0.5),
    };

    let emissions_reduction_pct = if baseline_emissions > 0.0 {
        (emissions_delta / baseline_emissions) * 100.0
    } else {
        0.0
    };

    ScenarioMetrics {
        strategy_id: strategy.id.clone(),
        strategy_name: strategy.name.clone(),
        emissions_reduction_pct,
        cost_delta,
        risk_level: risk.to_string(),
        lead_time_impact_days: lead_time,
        reliability_score: reliability,
    }
}
`;
}

function generateOptimizer(): string {
  return `use crate::types::*;

/// Compute weighted score for a scenario.
/// ADR-071: cost_normalization_factor is configurable via DomainConfig.
fn weighted_score(metrics: &ScenarioMetrics, weights: &TradeoffWeights, config: &DomainConfig) -> f64 {
    let emissions_score = metrics.emissions_reduction_pct / 100.0;
    let cost_score = 1.0 - (metrics.cost_delta.abs() / config.cost_normalization_factor).min(1.0);
    let resilience_score = metrics.reliability_score;
    let complexity_score = match metrics.risk_level.as_str() {
        "LOW" => 0.9,
        "MEDIUM" => 0.6,
        "HIGH" => 0.3,
        _ => 0.5,
    };

    weights.cost * cost_score
        + weights.emissions * emissions_score
        + weights.resilience * resilience_score
        + weights.complexity * complexity_score
}

/// Find Pareto-optimal scenarios (non-dominated on emissions + cost).
pub fn pareto_frontier(scenarios: &[ScenarioMetrics]) -> Vec<String> {
    scenarios.iter()
        .filter(|a| {
            !scenarios.iter().any(|b| {
                b.emissions_reduction_pct >= a.emissions_reduction_pct
                    && b.cost_delta <= a.cost_delta
                    && (b.emissions_reduction_pct > a.emissions_reduction_pct
                        || b.cost_delta < a.cost_delta)
            })
        })
        .map(|s| s.strategy_id.clone())
        .collect()
}

/// Rank scenarios and produce optimizer output.
/// ADR-071: config passed through for cost normalization in weighted_score.
pub fn optimize(
    scenarios: Vec<ScenarioMetrics>,
    weights: TradeoffWeights,
    config: &DomainConfig,
) -> OptimizerOutput {
    let pareto = pareto_frontier(&scenarios);

    let recommended = scenarios.iter()
        .max_by(|a, b| {
            weighted_score(a, &weights, config)
                .partial_cmp(&weighted_score(b, &weights, config))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|s| s.strategy_id.clone());

    OptimizerOutput {
        scenarios,
        pareto_frontier: pareto,
        recommended,
        weights_used: weights,
    }
}
`;
}

function generateMain(): string {
  return `mod types;
mod graph;
mod simulation;
mod optimizer;

use std::io::{self, Read, Write};
use serde::Serialize;
use types::OptimizerInput;
use graph::build_network;
use simulation::simulate_strategy;
use optimizer::optimize;

// ADR-073: Structured error response for TypeScript bridge
#[derive(Serialize)]
struct ErrorResponse {
    success: bool,
    error: String,
    details: Option<String>,
}

fn write_error(error: &str, details: Option<String>) {
    let err = ErrorResponse {
        success: false,
        error: error.to_string(),
        details,
    };
    // Write to stdout (where TypeScript reads from)
    let _ = io::stdout().write_all(serde_json::to_string(&err).unwrap().as_bytes());
    let _ = io::stdout().flush();
}

// ADR-073: Validate input before optimization
fn validate_input(input: &OptimizerInput) -> Result<(), String> {
    if input.suppliers.is_empty() {
        return Err("At least one supplier is required".to_string());
    }
    for supplier in &input.suppliers {
        if supplier.name.is_empty() {
            return Err(format!("Supplier '{}' has empty name", supplier.id));
        }
        if supplier.annual_cost < 0.0 {
            return Err(format!("Supplier '{}' has negative annual_cost: {}", supplier.name, supplier.annual_cost));
        }
        if supplier.annual_emissions_tonnes < 0.0 {
            return Err(format!("Supplier '{}' has negative emissions: {}", supplier.name, supplier.annual_emissions_tonnes));
        }
    }
    if input.strategies.is_empty() {
        return Err("At least one strategy is required".to_string());
    }
    if input.config.cost_normalization_factor <= 0.0 {
        return Err(format!("cost_normalization_factor must be positive, got: {}", input.config.cost_normalization_factor));
    }
    Ok(())
}

fn main() {
    // ADR-073: Read stdin with structured error on failure
    let mut input_str = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input_str) {
        write_error("Failed to read stdin", Some(e.to_string()));
        std::process::exit(1);
    }

    // ADR-073: Parse with structured error including line/column info
    let input: OptimizerInput = match serde_json::from_str(&input_str) {
        Ok(input) => input,
        Err(e) => {
            write_error(
                "Failed to parse input JSON",
                Some(format!("Parse error at line {} column {}: {}", e.line(), e.column(), e.classify())),
            );
            std::process::exit(1);
        }
    };

    // ADR-073: Validate input data before running optimization
    if let Err(msg) = validate_input(&input) {
        write_error("Input validation failed", Some(msg));
        std::process::exit(1);
    }

    // Build supplier network graph
    let network = build_network(input.suppliers, input.edges);

    // Simulate each strategy (ADR-071: pass input for config access)
    let scenarios: Vec<_> = input.strategies.iter()
        .map(|strategy| simulate_strategy(&network, strategy, &input))
        .collect();

    // Run multi-objective optimization (ADR-071: config passed through)
    let weights = input.weights.unwrap_or_default();
    let output = optimize(scenarios, weights, &input.config);

    // ADR-073: Serialize with structured error on failure
    match serde_json::to_string_pretty(&output) {
        Ok(json) => println!("{}", json),
        Err(e) => {
            write_error("Failed to serialize output", Some(e.to_string()));
            std::process::exit(1);
        }
    }
}
`;
}

function generateIntegrationTest(): string {
  return `use std::process::Command;

#[test]
fn test_optimizer_end_to_end() {
    let input = serde_json::json!({
        "suppliers": [
            { "id": "s1", "name": "Steel Corp", "region": "NA", "carbon_maturity": "LOW", "annual_emissions_tonnes": 50000.0, "reliability_score": 0.9, "annual_cost": 5000000.0 },
            { "id": "s2", "name": "Green Steel", "region": "EU", "carbon_maturity": "HIGH", "annual_emissions_tonnes": 10000.0, "reliability_score": 0.7, "annual_cost": 5500000.0 }
        ],
        "edges": [[0, 1, { "material": "steel", "volume_pct": 0.6, "lead_time_days": 14, "switching_cost": 200000.0 }]],
        "strategies": [
            { "id": "strat1", "name": "Upgrade Steel Corp", "strategy_type": "upgrade", "target_supplier_id": "s1", "replacement_supplier_id": null, "description": "Upgrade to medium maturity" },
            { "id": "strat2", "name": "Replace with Green Steel", "strategy_type": "replacement", "target_supplier_id": "s1", "replacement_supplier_id": "s2", "description": "Full replacement" }
        ],
        "weights": { "cost": 0.3, "emissions": 0.3, "resilience": 0.25, "complexity": 0.15 }
    });

    let output = Command::new("cargo")
        .args(["run", "--quiet", "--"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
            child.wait_with_output()
        })
        .expect("Failed to run optimizer");

    assert!(output.status.success(), "Optimizer exited with error");
    let result: serde_json::Value = serde_json::from_slice(&output.stdout)
        .expect("Failed to parse optimizer output");
    assert!(result["scenarios"].as_array().unwrap().len() >= 2);
    assert!(result["pareto_frontier"].as_array().unwrap().len() >= 1);
    assert!(result["recommended"].is_string());
}
`;
}

function generateTsBridge(crateName: string): string {
  return `// Generated by Phase 4 pipeline — do not edit manually
// ADR-057: TypeScript ↔ Rust bridge for optimizer engine
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export interface OptimizerInput {
  suppliers: Array<{ id: string; name: string; region: string; carbon_maturity: string; annual_emissions_tonnes: number; reliability_score: number; annual_cost: number }>;
  edges: Array<[number, number, { material: string; volume_pct: number; lead_time_days: number; switching_cost: number }]>;
  strategies: Array<{ id: string; name: string; strategy_type: string; target_supplier_id: string; replacement_supplier_id: string | null; description: string }>;
  weights?: { cost: number; emissions: number; resilience: number; complexity: number };
}

export interface ScenarioMetrics {
  strategy_id: string;
  strategy_name: string;
  emissions_reduction_pct: number;
  cost_delta: number;
  risk_level: string;
  lead_time_impact_days: number;
  reliability_score: number;
}

export interface OptimizerOutput {
  scenarios: ScenarioMetrics[];
  pareto_frontier: string[];
  recommended: string | null;
  weights_used: { cost: number; emissions: number; resilience: number; complexity: number };
}

const OPTIMIZER_BINARY = join(__dirname, '..', '..', 'optimizer-engine', 'target', 'release', '${crateName}-optimizer');

// ADR-073: Parse optimizer output and check for structured error responses
function parseOptimizerResult(stdout: string): OptimizerOutput {
  const parsed = JSON.parse(stdout);
  // ADR-073: Check for structured error from Rust engine
  if (parsed.success === false && parsed.error) {
    const detail = parsed.details ? \`: \${parsed.details}\` : '';
    throw new Error(\`Optimizer error: \${parsed.error}\${detail}\`);
  }
  return parsed as OptimizerOutput;
}

export function runOptimizer(input: OptimizerInput, timeoutMs = 120_000): Promise<OptimizerOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(OPTIMIZER_BINARY, ['--json'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // ADR-073: Check if stdout has a structured error even on non-zero exit
        if (stdout && stdout.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.success === false && parsed.error) {
              return reject(new Error(\`Optimizer error: \${parsed.error}\${parsed.details ? ': ' + parsed.details : ''}\`));
            }
          } catch { /* not valid JSON, fall through */ }
        }
        // Fallback: try debug binary
        const debugBin = OPTIMIZER_BINARY.replace('/release/', '/debug/');
        const fallback = execFile(debugBin, ['--json'], { timeout: timeoutMs }, (err2, stdout2) => {
          if (err2) return reject(new Error(\`Optimizer failed: \${err.message}. Debug: \${err2.message}\`));
          try { resolve(parseOptimizerResult(stdout2)); } catch (e) { reject(new Error(\`Failed to parse optimizer output: \${e}\`)); }
        });
        fallback.stdin?.write(JSON.stringify(input));
        fallback.stdin?.end();
        return;
      }
      try { resolve(parseOptimizerResult(stdout)); } catch (e) { reject(new Error(\`Failed to parse optimizer output: \${e}\`)); }
    });
    child.stdin?.write(JSON.stringify(input));
    child.stdin?.end();
  });
}
`;
}

/**
 * Generate Rust optimizer engine when user specifies Rust for compute components.
 * Skips silently if Rust is not mentioned in the scenario query.
 */
export function generateRustOptimizer(context: Phase4Context): Phase4StageOutput {
  const startTime = Date.now();
  const rootSpan = createSpan('rust-optimizer-generation', 'generate-rust-optimizer', {
    phase4Dir: context.phase4Dir,
  });

  if (!requiresRustOptimizer(context.scenarioQuery)) {
    const span = endSpan(rootSpan, 'ok', { skipped: true });
    emitSpan(span);
    return {
      stage: 'rust-optimizer-generation',
      status: 'completed',
      data: { skipped: true, reason: 'Rust not specified in requirements' },
      artifacts: [],
      timing: Date.now() - startTime,
      summary: '  Skipped — Rust not specified in requirements',
    };
  }

  try {
    const projectDir = join(context.phase4Dir, 'project');
    const optimizerDir = join(projectDir, 'optimizer-engine');
    const srcDir = join(optimizerDir, 'src');
    const testsDir = join(optimizerDir, 'tests');
    const bridgeDir = join(projectDir, 'src', 'services');

    mkdirSync(srcDir, { recursive: true, mode: DIR_MODE });
    mkdirSync(testsDir, { recursive: true, mode: DIR_MODE });
    mkdirSync(bridgeDir, { recursive: true, mode: DIR_MODE });

    const writtenPaths: string[] = [];
    const crateName = 'supplier-transition';

    const write = (filePath: string, content: string) => {
      writeFileSync(filePath, content, { encoding: 'utf-8', mode: FILE_MODE });
      writtenPaths.push(filePath);
    };

    // Rust source files
    write(join(optimizerDir, 'Cargo.toml'), generateCargoToml(crateName));
    write(join(srcDir, 'types.rs'), generateTypes());
    write(join(srcDir, 'graph.rs'), generateGraph());
    write(join(srcDir, 'simulation.rs'), generateSimulation());
    write(join(srcDir, 'optimizer.rs'), generateOptimizer());
    write(join(srcDir, 'main.rs'), generateMain());
    write(join(testsDir, 'integration.rs'), generateIntegrationTest());

    // TypeScript bridge
    write(join(bridgeDir, 'optimizer-bridge.ts'), generateTsBridge(crateName));

    // Makefile
    write(join(optimizerDir, 'Makefile'), `# ADR-057: Rust optimizer engine build targets
.PHONY: build test clean

build:
\tcd optimizer-engine && cargo build --release

test:
\tcd optimizer-engine && cargo test

clean:
\tcd optimizer-engine && cargo clean
`);

    const span = endSpan(rootSpan, 'ok', { filesGenerated: writtenPaths.length });
    emitSpan(span);

    return {
      stage: 'rust-optimizer-generation',
      status: 'completed',
      data: { filesGenerated: writtenPaths.length, crateName },
      artifacts: writtenPaths,
      timing: Date.now() - startTime,
      summary: `  Generated Rust optimizer engine: ${writtenPaths.length} files (Cargo.toml, graph, simulation, optimizer, bridge)`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const span = endSpan(rootSpan, 'error', { error: msg });
    emitSpan(span);
    return {
      stage: 'rust-optimizer-generation',
      status: 'failed',
      data: { error: msg },
      artifacts: [],
      timing: Date.now() - startTime,
      summary: `  ERROR: Rust optimizer generation failed: ${msg}`,
    };
  }
}
