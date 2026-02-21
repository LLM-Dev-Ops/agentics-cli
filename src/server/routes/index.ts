/**
 * Route Exports
 *
 * Central export for all API route handlers.
 */

export { simulate } from './simulate.js';
export { manifests } from './manifests.js';
export { plans } from './plans.js';
export { runner } from './runner.js';
export { roi } from './roi.js';
export { intent } from './intent.js';
export { exporters } from './exporters.js';
export { diligence } from './diligence.js';
export { health } from './health.js';
export { auth } from './auth.js';
export { erpsurface } from './erpsurface.js';
export { identity } from './identity.js';
export { lineage } from './lineage.js';

// Downstream Agent Routes
export {
  testBench,
  observatory,
  shield,
  sentinel,
  memoryGraph,
  latencyLens,
  forge,
  edge,
  autoOptimizer,
  incidentManager,
  orchestrator,
  costops,
  governanceDashboard,
  policyEngine,
  registry,
  marketplace,
  analyticsHub,
  configManager,
  schemaRegistry,
  connectorHub,
  copilot,
  simulator,
  benchmarkExchange,
  inferenceGateway,
  dataVault,
  researchLab,
  platformAgents,
} from './agents.js';
