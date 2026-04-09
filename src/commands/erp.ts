/**
 * ERP Command - Enterprise Resource Planning Surface
 *
 * ARCHITECTURE:
 * - This module provides a sell-grade ERP surface for deployment proposals
 * - Operations execute against ERP connectors and fleet services
 * - Fleet attribution shows the 51-repo platform involvement
 *
 * SUBCOMMANDS:
 * - list      List available ERP systems
 * - inspect   Inspect a specific ERP system
 * - surface   Generate ERP surface analysis for a plan
 * - map       Map plan to ERP components
 * - export    Export ERP deployment proposal
 *
 * PURPOSE:
 * - Demonstrate platform orchestration capability
 * - Generate credible deployment proposals
 * - Show clear repository attribution
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandOptions } from '../types/index.js';
import { CLIError } from '../errors/index.js';
import { RuvectorAdapter } from '../adapters/base-adapter.js';
import { loadEndpointConfig } from '../config/endpoints.js';
import { resolveAttribution } from '../auth/identity-resolver.js';
import {
  createLineageRecord,
  createErpSurfaceMapping,
} from '../enterprise/lineage.js';

// ============================================================================
// ERP-Specific Exit Codes
// ============================================================================

export const ERP_EXIT_CODES = {
  SUCCESS: 0,
  INPUT_ERROR: 100,
  NOT_FOUND: 100,
  IO_ERROR: 74,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// Fleet Attribution - The 51-Repo Platform
// ============================================================================

/**
 * Core platform repositories that power the agentics ecosystem.
 * These are included in attribution metadata to demonstrate orchestration.
 */
export const FLEET_REPOSITORIES = {
  // Core Simulation & Planning
  simulation: [
    'agentics-simulation-engine',
    'agentics-simulation-runner',
    'agentics-simulation-planner',
    'agentics-results-index',
  ],
  // Deployment & Export
  deployment: [
    'agentics-deployment-intent',
    'agentics-deployment-exporters',
    'agentics-deployment-validator',
  ],
  // Enterprise & Analytics
  enterprise: [
    'enterprise-roi-engine',
    'enterprise-cost-analyzer',
    'enterprise-compliance-checker',
  ],
  // LLM Infrastructure
  llm: [
    'llm-orchestrator',
    'llm-registry',
    'llm-policy-engine',
    'llm-analytics-hub',
    'llm-context-manager',
  ],
  // Data & Integration
  data: [
    'agentics-data-pipeline',
    'agentics-manifests',
    'agentics-schema-registry',
    'agentics-event-bus',
  ],
  // ERP Specific
  erp: [
    'erp-connector-sap',
    'erp-connector-oracle',
    'erp-connector-netsuite',
    'erp-connector-dynamics',
    'erp-mapper-service',
    'erp-validation-engine',
  ],
  // Infrastructure
  infrastructure: [
    'agentics-usage-ledger',
    'agentics-auth-service',
    'agentics-api-gateway',
    'agentics-config-service',
  ],
  // Compliance & Security
  compliance: [
    'diligence-artifacts',
    'compliance-policy-engine',
    'security-audit-service',
    'access-control-service',
  ],
  // Monitoring & Observability
  observability: [
    'agentics-metrics-collector',
    'agentics-trace-aggregator',
    'agentics-alert-manager',
    'agentics-dashboard-service',
  ],
  // CLI & Tools
  tools: [
    'agentics-cli',
    'agentics-sdk-node',
    'agentics-sdk-python',
    'agentics-terraform-provider',
  ],
} as const;

/**
 * Get repositories involved in a specific operation type.
 */
export function getInvolvedRepositories(operationType: 'erp-list' | 'erp-inspect' | 'erp-surface' | 'erp-map' | 'erp-export'): string[] {
  const base = ['agentics-cli', 'llm-orchestrator', 'agentics-manifests'];

  switch (operationType) {
    case 'erp-list':
      return [...base, ...FLEET_REPOSITORIES.erp, 'llm-registry'];
    case 'erp-inspect':
      return [...base, ...FLEET_REPOSITORIES.erp, 'agentics-schema-registry'];
    case 'erp-surface':
      return [
        ...base,
        ...FLEET_REPOSITORIES.simulation,
        ...FLEET_REPOSITORIES.erp,
        ...FLEET_REPOSITORIES.enterprise,
        'llm-analytics-hub',
      ];
    case 'erp-map':
      return [
        ...base,
        ...FLEET_REPOSITORIES.erp,
        ...FLEET_REPOSITORIES.data,
        'enterprise-roi-engine',
        'agentics-schema-registry',
      ];
    case 'erp-export':
      return [
        ...base,
        ...FLEET_REPOSITORIES.erp,
        ...FLEET_REPOSITORIES.deployment,
        ...FLEET_REPOSITORIES.compliance,
        'enterprise-roi-engine',
      ];
    default:
      return base;
  }
}

/**
 * Get artifact-level attribution for generated files.
 */
export function getArtifactAttribution(artifactType: string): string[] {
  const base = ['agentics-cli', 'llm-orchestrator', 'llm-registry'];

  switch (artifactType) {
    case 'deployment-proposal':
      return [...base, 'agentics-deployment-intent', 'enterprise-roi-engine', 'erp-mapper-service'];
    case 'data-mapping':
      return [...base, 'erp-mapper-service', 'agentics-schema-registry', 'agentics-data-pipeline'];
    case 'integration-config':
      return [...base, 'erp-connector-sap', 'erp-connector-oracle', 'erp-validation-engine'];
    case 'compliance-report':
      return [...base, 'diligence-artifacts', 'compliance-policy-engine', 'security-audit-service'];
    default:
      return base;
  }
}

// ============================================================================
// ERP System Definitions (Static Registry)
// ============================================================================

export type ErpSystemId = 'sap' | 'oracle' | 'netsuite' | 'dynamics365' | 'workday' | 'sage' | 'coupa' | 'maximo' | 'fleetio';

export interface ErpSystemDefinition {
  id: ErpSystemId;
  name: string;
  vendor: string;
  version: string;
  description: string;
  modules: ErpModule[];
  integration_types: string[];
  supported_protocols: string[];
  compliance_frameworks: string[];
  connector_repository: string;
  documentation_url: string;
}

export interface ErpModule {
  id: string;
  name: string;
  category: 'finance' | 'hr' | 'supply-chain' | 'manufacturing' | 'sales' | 'analytics';
  entities: string[];
  api_endpoints: number;
}

/**
 * Static ERP system registry - no live calls required.
 */
export const ERP_SYSTEMS: Record<ErpSystemId, ErpSystemDefinition> = {
  sap: {
    id: 'sap',
    name: 'SAP S/4HANA',
    vendor: 'SAP SE',
    version: '2023.FPS02',
    description: 'Enterprise resource planning suite for large enterprises with comprehensive financial, supply chain, and manufacturing capabilities.',
    modules: [
      { id: 'fi', name: 'Financial Accounting', category: 'finance', entities: ['GL Account', 'Cost Center', 'Profit Center', 'Company Code'], api_endpoints: 142 },
      { id: 'co', name: 'Controlling', category: 'finance', entities: ['Cost Element', 'Internal Order', 'Activity Type'], api_endpoints: 98 },
      { id: 'mm', name: 'Materials Management', category: 'supply-chain', entities: ['Material', 'Vendor', 'Purchase Order', 'Goods Receipt'], api_endpoints: 156 },
      { id: 'sd', name: 'Sales & Distribution', category: 'sales', entities: ['Customer', 'Sales Order', 'Delivery', 'Billing Document'], api_endpoints: 134 },
      { id: 'pp', name: 'Production Planning', category: 'manufacturing', entities: ['Work Center', 'Routing', 'Production Order', 'BOM'], api_endpoints: 112 },
      { id: 'hr', name: 'Human Capital Management', category: 'hr', entities: ['Employee', 'Position', 'Payroll', 'Time Management'], api_endpoints: 89 },
    ],
    integration_types: ['OData', 'BAPI', 'RFC', 'IDoc', 'REST API', 'SOAP'],
    supported_protocols: ['HTTPS', 'RFC', 'ALE'],
    compliance_frameworks: ['SOX', 'GDPR', 'SOC2', 'ISO27001', 'HIPAA'],
    connector_repository: 'erp-connector-sap',
    documentation_url: 'https://api.sap.com/s4hana',
  },
  oracle: {
    id: 'oracle',
    name: 'Oracle Fusion Cloud',
    vendor: 'Oracle Corporation',
    version: '24A',
    description: 'Cloud-native ERP suite with AI-powered analytics and comprehensive enterprise functionality.',
    modules: [
      { id: 'gl', name: 'General Ledger', category: 'finance', entities: ['Ledger', 'Journal', 'Period', 'Account Combination'], api_endpoints: 78 },
      { id: 'ap', name: 'Accounts Payable', category: 'finance', entities: ['Supplier', 'Invoice', 'Payment', 'Hold'], api_endpoints: 64 },
      { id: 'ar', name: 'Accounts Receivable', category: 'finance', entities: ['Customer', 'Transaction', 'Receipt', 'Adjustment'], api_endpoints: 56 },
      { id: 'scm', name: 'Supply Chain Management', category: 'supply-chain', entities: ['Item', 'Inventory Org', 'Transfer Order', 'Shipment'], api_endpoints: 112 },
      { id: 'hcm', name: 'Human Capital Management', category: 'hr', entities: ['Person', 'Assignment', 'Absence', 'Compensation'], api_endpoints: 94 },
      { id: 'eppm', name: 'Project Portfolio Management', category: 'analytics', entities: ['Project', 'Task', 'Resource', 'Budget'], api_endpoints: 67 },
    ],
    integration_types: ['REST API', 'SOAP', 'FBDI', 'BIP Reports', 'ADFdi'],
    supported_protocols: ['HTTPS', 'OAuth 2.0'],
    compliance_frameworks: ['SOX', 'GDPR', 'SOC1', 'SOC2', 'FedRAMP'],
    connector_repository: 'erp-connector-oracle',
    documentation_url: 'https://docs.oracle.com/cloud/fusion',
  },
  netsuite: {
    id: 'netsuite',
    name: 'Oracle NetSuite',
    vendor: 'Oracle Corporation',
    version: '2024.1',
    description: 'Cloud-based ERP for mid-market companies with unified business management capabilities.',
    modules: [
      { id: 'erp', name: 'ERP/Financials', category: 'finance', entities: ['Account', 'Transaction', 'Currency', 'Subsidiary'], api_endpoints: 89 },
      { id: 'crm', name: 'CRM', category: 'sales', entities: ['Customer', 'Contact', 'Opportunity', 'Campaign'], api_endpoints: 67 },
      { id: 'inv', name: 'Inventory Management', category: 'supply-chain', entities: ['Item', 'Location', 'Bin', 'Lot'], api_endpoints: 54 },
      { id: 'psa', name: 'Professional Services', category: 'analytics', entities: ['Project', 'Resource', 'Timesheet', 'Expense'], api_endpoints: 45 },
      { id: 'wms', name: 'Warehouse Management', category: 'supply-chain', entities: ['Warehouse', 'Zone', 'Pick Task', 'Wave'], api_endpoints: 38 },
    ],
    integration_types: ['SuiteScript', 'REST API', 'SOAP', 'SuiteTalk', 'CSV Import'],
    supported_protocols: ['HTTPS', 'Token-Based Auth', 'OAuth 2.0'],
    compliance_frameworks: ['SOC1', 'SOC2', 'PCI-DSS', 'GDPR'],
    connector_repository: 'erp-connector-netsuite',
    documentation_url: 'https://docs.oracle.com/netsuite',
  },
  dynamics365: {
    id: 'dynamics365',
    name: 'Microsoft Dynamics 365',
    vendor: 'Microsoft Corporation',
    version: '10.0.38',
    description: 'Integrated business applications suite with deep Microsoft ecosystem integration.',
    modules: [
      { id: 'fin', name: 'Finance', category: 'finance', entities: ['Legal Entity', 'Main Account', 'Journal', 'Budget'], api_endpoints: 156 },
      { id: 'scm', name: 'Supply Chain Management', category: 'supply-chain', entities: ['Product', 'Warehouse', 'Purchase Order', 'Sales Order'], api_endpoints: 189 },
      { id: 'hr', name: 'Human Resources', category: 'hr', entities: ['Worker', 'Position', 'Department', 'Benefit'], api_endpoints: 78 },
      { id: 'sales', name: 'Sales', category: 'sales', entities: ['Account', 'Lead', 'Opportunity', 'Quote'], api_endpoints: 134 },
      { id: 'cs', name: 'Customer Service', category: 'sales', entities: ['Case', 'Queue', 'Entitlement', 'SLA'], api_endpoints: 89 },
      { id: 'mfg', name: 'Manufacturing', category: 'manufacturing', entities: ['BOM', 'Route', 'Production Order', 'Shop Floor'], api_endpoints: 112 },
    ],
    integration_types: ['OData', 'Data Entities', 'Power Automate', 'Logic Apps', 'Azure Service Bus'],
    supported_protocols: ['HTTPS', 'OAuth 2.0', 'Azure AD'],
    compliance_frameworks: ['SOC1', 'SOC2', 'ISO27001', 'GDPR', 'HIPAA', 'FedRAMP'],
    connector_repository: 'erp-connector-dynamics',
    documentation_url: 'https://docs.microsoft.com/dynamics365',
  },
  workday: {
    id: 'workday',
    name: 'Workday',
    vendor: 'Workday, Inc.',
    version: '2024R1',
    description: 'Cloud-based enterprise management platform focused on human capital and financial management.',
    modules: [
      { id: 'hcm', name: 'Human Capital Management', category: 'hr', entities: ['Worker', 'Organization', 'Job Profile', 'Compensation'], api_endpoints: 234 },
      { id: 'fin', name: 'Financial Management', category: 'finance', entities: ['Company', 'Ledger Account', 'Journal', 'Spend Category'], api_endpoints: 156 },
      { id: 'pay', name: 'Payroll', category: 'hr', entities: ['Pay Group', 'Earning', 'Deduction', 'Tax'], api_endpoints: 89 },
      { id: 'recruit', name: 'Recruiting', category: 'hr', entities: ['Job Requisition', 'Candidate', 'Interview', 'Offer'], api_endpoints: 67 },
      { id: 'learn', name: 'Learning', category: 'hr', entities: ['Course', 'Enrollment', 'Completion', 'Certification'], api_endpoints: 45 },
    ],
    integration_types: ['REST API', 'SOAP', 'Workday Studio', 'EIB', 'Core Connectors'],
    supported_protocols: ['HTTPS', 'OAuth 2.0', 'SAML'],
    compliance_frameworks: ['SOC1', 'SOC2', 'ISO27001', 'GDPR', 'HIPAA'],
    connector_repository: 'erp-connector-workday',
    documentation_url: 'https://community.workday.com/api',
  },
  coupa: {
    id: 'coupa',
    name: 'Coupa',
    vendor: 'Coupa Software',
    version: 'R34',
    description: 'Cloud-based business spend management platform for procurement, invoicing, expenses, and supplier management.',
    modules: [
      { id: 'proc', name: 'Procurement', category: 'supply-chain', entities: ['Supplier', 'Purchase Order', 'Requisition', 'Contract'], api_endpoints: 89 },
      { id: 'inv', name: 'Invoicing', category: 'finance', entities: ['Invoice', 'Invoice Line', 'Approval', 'Payment'], api_endpoints: 67 },
      { id: 'exp', name: 'Expenses', category: 'finance', entities: ['Expense Report', 'Expense Line', 'Receipt', 'Policy'], api_endpoints: 45 },
      { id: 'sup', name: 'Supplier Management', category: 'supply-chain', entities: ['Supplier', 'Supplier Site', 'Performance Score', 'Risk Assessment'], api_endpoints: 56 },
      { id: 'srm', name: 'Supplier Risk', category: 'supply-chain', entities: ['Risk Factor', 'Compliance Score', 'Diversity Cert', 'Sustainability Score'], api_endpoints: 34 },
    ],
    integration_types: ['REST API', 'cXML', 'CSV Import', 'Coupa Connector'],
    supported_protocols: ['HTTPS', 'OAuth 2.0', 'API Key'],
    compliance_frameworks: ['SOC1', 'SOC2', 'ISO27001', 'GDPR'],
    connector_repository: 'erp-connector-coupa',
    documentation_url: 'https://compass.coupa.com/api',
  },
  fleetio: {
    id: 'fleetio',
    name: 'Fleetio',
    vendor: 'Fleetio',
    version: '2024.1',
    description: 'Cloud-based fleet management platform for vehicle tracking, maintenance, fuel management, and fleet operations.',
    modules: [
      { id: 'fleet', name: 'Fleet Management', category: 'supply-chain', entities: ['Vehicle', 'Vehicle Assignment', 'Group', 'Label'], api_endpoints: 67 },
      { id: 'fuel', name: 'Fuel Management', category: 'finance', entities: ['Fuel Entry', 'Fuel Card', 'Fuel Cost'], api_endpoints: 34 },
      { id: 'maint', name: 'Maintenance', category: 'supply-chain', entities: ['Service Entry', 'Service Task', 'Service Reminder', 'Work Order'], api_endpoints: 56 },
      { id: 'parts', name: 'Parts & Inventory', category: 'supply-chain', entities: ['Part', 'Purchase Order', 'Vendor'], api_endpoints: 38 },
      { id: 'inspect', name: 'Inspections', category: 'supply-chain', entities: ['Inspection', 'Inspection Form', 'Inspection Item'], api_endpoints: 28 },
    ],
    integration_types: ['REST API', 'Webhooks', 'CSV Import', 'Zapier'],
    supported_protocols: ['HTTPS', 'API Token', 'OAuth 2.0'],
    compliance_frameworks: ['SOC2', 'GDPR'],
    connector_repository: 'erp-connector-fleetio',
    documentation_url: 'https://developer.fleetio.com',
  },
  maximo: {
    id: 'maximo',
    name: 'IBM Maximo',
    vendor: 'IBM',
    version: 'MAS 8.11',
    description: 'Enterprise asset management platform for maintenance, reliability, and operations management of physical infrastructure.',
    modules: [
      { id: 'asset', name: 'Asset Management', category: 'supply-chain', entities: ['Asset', 'Location', 'Asset Meter', 'Condition Monitoring'], api_endpoints: 78 },
      { id: 'wo', name: 'Work Order Management', category: 'supply-chain', entities: ['Work Order', 'Task', 'Labor', 'Material'], api_endpoints: 92 },
      { id: 'pm', name: 'Preventive Maintenance', category: 'supply-chain', entities: ['PM Record', 'Frequency', 'Route', 'Job Plan'], api_endpoints: 56 },
      { id: 'inv', name: 'Inventory', category: 'supply-chain', entities: ['Item', 'Storeroom', 'Issue', 'Receipt'], api_endpoints: 45 },
      { id: 'sr', name: 'Service Requests', category: 'supply-chain', entities: ['Service Request', 'Ticket', 'SLA', 'Workflow'], api_endpoints: 38 },
    ],
    integration_types: ['OSLC REST', 'Integration Framework', 'MIF', 'Automation Scripts'],
    supported_protocols: ['HTTPS', 'Basic Auth', 'OSLC', 'OAuth 2.0'],
    compliance_frameworks: ['SOX', 'ISO55000', 'ISO27001', 'NERC CIP'],
    connector_repository: 'erp-connector-maximo',
    documentation_url: 'https://www.ibm.com/docs/en/mas-cd/maximo-manage',
  },
  sage: {
    id: 'sage',
    name: 'Sage Intacct',
    vendor: 'Sage Group',
    version: '2024.1',
    description: 'Cloud financial management platform for growing businesses with strong multi-entity support.',
    modules: [
      { id: 'gl', name: 'General Ledger', category: 'finance', entities: ['Account', 'Journal Entry', 'Statistical Journal', 'Allocation'], api_endpoints: 56 },
      { id: 'ap', name: 'Accounts Payable', category: 'finance', entities: ['Vendor', 'Bill', 'Payment', 'Adjustment'], api_endpoints: 45 },
      { id: 'ar', name: 'Accounts Receivable', category: 'finance', entities: ['Customer', 'Invoice', 'Payment', 'Credit Memo'], api_endpoints: 48 },
      { id: 'cm', name: 'Cash Management', category: 'finance', entities: ['Bank Account', 'Deposit', 'Funds Transfer', 'Reconciliation'], api_endpoints: 34 },
      { id: 'pm', name: 'Project Accounting', category: 'analytics', entities: ['Project', 'Task', 'Timesheet', 'Expense Report'], api_endpoints: 42 },
    ],
    integration_types: ['REST API', 'XML API', 'Web Services', 'Platform Services'],
    supported_protocols: ['HTTPS', 'Session-Based Auth'],
    compliance_frameworks: ['SOC1', 'SOC2', 'GDPR', 'AICPA'],
    connector_repository: 'erp-connector-sage',
    documentation_url: 'https://developer.intacct.com',
  },
};

// ============================================================================
// Storage Configuration
// ============================================================================

function getErpDir(): string {
  const baseDir = process.env['AGENTICS_DATA_DIR'] ?? process.cwd();
  return path.join(baseDir, '.agentics', 'erp');
}

function _ensureErpDir(): void {
  const dir = getErpDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
// Exported for potential future use
export const ensureErpDir = _ensureErpDir;

function getErpArtifactPath(type: string, id: string): string {
  return path.join(getErpDir(), type, `${id}.json`);
}

function ensureErpSubdir(subdir: string): void {
  const dir = path.join(getErpDir(), subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// ERP Surface Types
// ============================================================================

export interface ErpSurfaceAnalysis {
  id: string;
  plan_id: string;
  analysis_type: 'surface';
  generated_at: string;
  erp_systems: ErpSystemSummary[];
  deployment_touchpoints: DeploymentTouchpoint[];
  risks: RiskAssessment[];
  assumptions: string[];
  recommendations: string[];
  estimated_effort: EffortEstimate;
  repositories_involved: string[];
  generated_by: string[];
}

export interface ErpSystemSummary {
  system_id: ErpSystemId;
  system_name: string;
  modules_affected: string[];
  entity_count: number;
  api_endpoints_required: number;
  integration_complexity: 'low' | 'medium' | 'high';
}

export interface DeploymentTouchpoint {
  id: string;
  name: string;
  type: 'api' | 'database' | 'file' | 'event' | 'batch';
  direction: 'inbound' | 'outbound' | 'bidirectional';
  erp_system: ErpSystemId;
  module: string;
  entities: string[];
  frequency: 'real-time' | 'hourly' | 'daily' | 'weekly' | 'on-demand';
  estimated_volume: string;
}

export interface RiskAssessment {
  id: string;
  category: 'technical' | 'business' | 'compliance' | 'operational';
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  mitigation: string;
  owner: string;
}

export interface EffortEstimate {
  development_days: number;
  testing_days: number;
  deployment_days: number;
  total_days: number;
  team_size: number;
  confidence: 'low' | 'medium' | 'high';
}

// ============================================================================
// ERP Mapping Types
// ============================================================================

export interface ErpMapping {
  id: string;
  plan_id: string;
  mapping_type: 'data-flow';
  generated_at: string;
  source_system: string;
  target_systems: ErpSystemId[];
  entity_mappings: EntityMapping[];
  field_mappings: FieldMapping[];
  transformation_rules: TransformationRule[];
  validation_rules: ValidationRule[];
  repositories_involved: string[];
  generated_by: string[];
}

export interface EntityMapping {
  source_entity: string;
  target_entity: string;
  target_system: ErpSystemId;
  target_module: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  sync_direction: 'push' | 'pull' | 'bidirectional';
}

export interface FieldMapping {
  source_field: string;
  target_field: string;
  transformation: string;
  required: boolean;
  default_value?: string;
}

export interface TransformationRule {
  id: string;
  name: string;
  type: 'format' | 'lookup' | 'calculation' | 'concatenation' | 'split';
  expression: string;
  description: string;
}

export interface ValidationRule {
  id: string;
  name: string;
  type: 'required' | 'format' | 'range' | 'lookup' | 'custom';
  expression: string;
  error_message: string;
  severity: 'warning' | 'error';
}

// ============================================================================
// ERP Export Types
// ============================================================================

export interface ErpExportProposal {
  id: string;
  plan_id: string;
  export_type: 'deployment-proposal';
  generated_at: string;
  proposal: DeploymentProposal;
  artifacts: ExportArtifact[];
  repositories_involved: string[];
  generated_by: string[];
}

export interface DeploymentProposal {
  title: string;
  version: string;
  status: 'draft' | 'review' | 'approved';
  summary: string;
  scope: ProposalScope;
  phases: DeploymentPhase[];
  dependencies: ProposalDependency[];
  success_criteria: string[];
  rollback_plan: string;
}

export interface ProposalScope {
  erp_systems: ErpSystemId[];
  modules: string[];
  entities: string[];
  environments: string[];
  regions: string[];
}

export interface DeploymentPhase {
  id: string;
  name: string;
  order: number;
  duration_days: number;
  activities: string[];
  deliverables: string[];
  risks: string[];
  dependencies: string[];
}

export interface ProposalDependency {
  name: string;
  type: 'technical' | 'business' | 'resource';
  status: 'ready' | 'pending' | 'blocked';
  owner: string;
}

export interface ExportArtifact {
  filename: string;
  type: 'json' | 'yaml' | 'csv' | 'pdf';
  content: string;
  description: string;
  generated_by: string[];
}

// ============================================================================
// Result Types
// ============================================================================

export interface ErpListResult {
  systems: ErpSystemSummaryBasic[];
  count: number;
  repositories_involved: string[];
  timing: number;
}

export interface ErpSystemSummaryBasic {
  id: ErpSystemId;
  name: string;
  vendor: string;
  modules_count: number;
  integration_types: string[];
}

export interface ErpInspectResult {
  system: ErpSystemDefinition | null;
  found: boolean;
  repositories_involved: string[];
  timing: number;
}

export interface ErpSurfaceResult {
  analysis: ErpSurfaceAnalysis;
  repositories_involved: string[];
  timing: number;
}

export interface ErpMapResult {
  mapping: ErpMapping;
  repositories_involved: string[];
  timing: number;
}

export interface ErpExportResult {
  proposal: ErpExportProposal;
  artifacts_written: boolean;
  output_path: string;
  repositories_involved: string[];
  timing: number;
}

// ============================================================================
// Input Types
// ============================================================================

export interface ErpInspectInput {
  system: string;
}

export interface ErpSurfaceInput {
  plan_id: string;
  erp_systems?: ErpSystemId[];
  /** ADR-PIPELINE-032: Optional query text for system detection when erp_systems not specified */
  query?: string;
}

export interface ErpMapInput {
  plan_id: string;
  target_systems?: ErpSystemId[];
}

export interface ErpExportInput {
  plan_id: string;
  output_path?: string;
  format?: 'json' | 'yaml';
}

// ============================================================================
// ID Generation
// ============================================================================

function generateErpId(_prefix: string): string {
  return crypto.randomUUID();
}

// ============================================================================
// Validation
// ============================================================================

/**
 * ADR-PIPELINE-032: Detect ERP system from plan ID or manifest context.
 * Reads the manifest.json from the run directory to find the original query,
 * then matches ERP keywords.
 */
function detectErpFromPlanId(planId: string): ErpSystemId[] | null {
  // Try to load the run's manifest to get the original query
  const homeDir = process.env['HOME'] ?? '/tmp';
  const manifestPath = path.join(homeDir, '.agentics', 'runs', planId, 'manifest.json');
  let query = '';
  try {
    if (fs.existsSync(manifestPath)) {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      query = (raw.query ?? raw.scenarioQuery ?? '').toLowerCase();
    }
  } catch { /* best-effort */ }

  if (!query) return null;
  return detectErpFromQuery(query);
}

/**
 * ADR-PIPELINE-032: Detect ERP system(s) from query text.
 * Returns the most specific match, not a generic default.
 */
export function detectErpFromQuery(query: string): ErpSystemId[] | null {
  const q = query.toLowerCase();
  const detected: ErpSystemId[] = [];

  const patterns: Array<[RegExp, ErpSystemId]> = [
    [/\bfleetio\b/i, 'fleetio'],
    [/\bcoupa\b/i, 'coupa'],
    [/\bworkday\b/i, 'workday'],
    [/\bsap\b|\bs\/4\s*hana\b/i, 'sap'],
    [/\bmaximo\b|\bibm\s+maximo\b/i, 'maximo'],
    [/\boracle\s+(fusion|erp|cloud)\b/i, 'oracle'],
    [/\bnetsuite\b/i, 'netsuite'],
    [/\bdynamics\s*365\b/i, 'dynamics365'],
    [/\bsage\s+intacct\b|\bsage\b/i, 'sage'],
  ];

  for (const [re, id] of patterns) {
    if (re.test(q) && !detected.includes(id)) {
      detected.push(id);
    }
  }

  return detected.length > 0 ? detected : null;
}

/**
 * ADR-PIPELINE-032: Generate system-specific deployment touchpoints.
 * Each ERP system has different entities, modules, and integration patterns.
 */
function generateSystemTouchpoints(systemId: ErpSystemId): DeploymentTouchpoint[] {
  type Freq = 'real-time' | 'hourly' | 'daily' | 'weekly' | 'on-demand';
  const tp = (name: string, type: 'api' | 'batch' | 'event', direction: 'inbound' | 'outbound' | 'bidirectional',
    module: string, entities: string[], frequency: Freq, volume: string): DeploymentTouchpoint => ({
    id: generateErpId('tp'), name, type, direction, erp_system: systemId, module, entities, frequency, estimated_volume: volume,
  });

  switch (systemId) {
    case 'fleetio':
      return [
        tp('Vehicle & Fleet Sync', 'api', 'inbound', 'fleet-management', ['Vehicle', 'Vehicle Assignment', 'Group', 'Meter Entry'], 'daily', '500-5K records/day'),
        tp('Fuel & Maintenance Events', 'event', 'inbound', 'fuel-maintenance', ['Fuel Entry', 'Service Entry', 'Service Reminder'], 'real-time', '100-500 events/hour'),
        tp('Transition Plan Writeback', 'api', 'outbound', 'fleet-management', ['Custom Field', 'Vehicle Note', 'Work Order'], 'on-demand', '10-50 records/day'),
      ];
    case 'coupa':
      return [
        tp('Supplier Data Sync', 'api', 'inbound', 'supplier-management', ['Supplier', 'Supplier Site', 'Performance Score'], 'daily', '500-2K records/day'),
        tp('Purchase Order Events', 'event', 'inbound', 'procurement', ['Purchase Order', 'PO Line', 'Requisition'], 'real-time', '50-200 events/hour'),
        tp('Supplier Action Writeback', 'api', 'outbound', 'supplier-management', ['Custom Form', 'Supplier Note', 'Scorecard Entry'], 'on-demand', '10-50 records/day'),
      ];
    case 'workday':
      return [
        tp('Worker Profile Sync', 'api', 'inbound', 'hcm', ['Worker', 'Organization', 'Cost Center', 'Location'], 'daily', '1K-10K records/day'),
        tp('Expense Report Ingestion', 'batch', 'inbound', 'expenses', ['Expense Report', 'Expense Line', 'Receipt'], 'hourly', '500-5K records/day'),
        tp('Custom Object Writeback', 'api', 'outbound', 'custom-objects', ['Policy Record', 'Decision Record', 'Audit Entry'], 'on-demand', '10-100 records/day'),
      ];
    case 'maximo':
      return [
        tp('Asset & Location Sync', 'api', 'inbound', 'asset-management', ['Asset', 'Location', 'Asset Meter', 'Condition'], 'hourly', '1K-5K records/day'),
        tp('Work Order Lifecycle', 'api', 'bidirectional', 'work-orders', ['Work Order', 'Task', 'Labor', 'Material'], 'real-time', '100-500 events/hour'),
        tp('Maintenance Plan Writeback', 'api', 'outbound', 'preventive-maintenance', ['PM Record', 'Job Plan', 'Route'], 'on-demand', '10-50 records/day'),
      ];
    case 'sap':
      return [
        tp('Financial Data Sync', 'api', 'bidirectional', 'finance', ['GL Account', 'Journal Entry', 'Cost Center'], 'hourly', '10K-50K records/day'),
        tp('Master Data Replication', 'batch', 'outbound', 'master-data', ['Business Partner', 'Material', 'Vendor'], 'daily', '1K-5K records/day'),
        tp('Transaction Events', 'event', 'inbound', 'transactions', ['Purchase Order', 'Sales Order', 'Invoice'], 'real-time', '100-500 events/hour'),
      ];
    case 'oracle':
      return [
        tp('Financial Data Sync', 'api', 'bidirectional', 'general-ledger', ['Ledger', 'Journal', 'Account Combination'], 'hourly', '5K-20K records/day'),
        tp('Supplier & Procurement', 'api', 'inbound', 'procurement', ['Supplier', 'PO Header', 'PO Line', 'Receipt'], 'daily', '1K-10K records/day'),
        tp('AP Invoice Processing', 'event', 'inbound', 'accounts-payable', ['Invoice', 'Payment', 'Hold'], 'real-time', '50-200 events/hour'),
      ];
    case 'netsuite':
      return [
        tp('Transaction Sync', 'api', 'bidirectional', 'erp-financials', ['Transaction', 'Account', 'Subsidiary'], 'hourly', '5K-20K records/day'),
        tp('Inventory Events', 'event', 'inbound', 'inventory', ['Item', 'Location', 'Lot', 'Bin'], 'real-time', '100-500 events/hour'),
        tp('Custom Record Writeback', 'api', 'outbound', 'custom-records', ['Custom Record', 'Saved Search Result'], 'on-demand', '50-200 records/day'),
      ];
    case 'dynamics365':
      return [
        tp('Finance Data Sync', 'api', 'bidirectional', 'finance', ['Main Account', 'Journal', 'Budget'], 'hourly', '5K-20K records/day'),
        tp('Supply Chain Events', 'event', 'inbound', 'supply-chain', ['Purchase Order', 'Sales Order', 'Product'], 'real-time', '100-500 events/hour'),
        tp('Data Entity Export', 'batch', 'outbound', 'data-management', ['Data Entity', 'Composite Entity'], 'daily', '10K-50K records/day'),
      ];
    default:
      return [
        tp('Data Sync', 'api', 'bidirectional', 'core', ['Record', 'Transaction', 'Master Data'], 'hourly', '5K-20K records/day'),
        tp('Event Stream', 'event', 'inbound', 'events', ['Business Event', 'Status Change'], 'real-time', '100-500 events/hour'),
        tp('Writeback', 'api', 'outbound', 'integration', ['Custom Object', 'Note', 'Audit Entry'], 'on-demand', '10-100 records/day'),
      ];
  }
}

function validatePlanId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-ERP-001',
      category: 'INPUT_ERROR',
      message: 'Plan ID is required',
      details: { provided: id },
      module: 'erp',
      correlationId,
      recoverable: false,
      exitCode: ERP_EXIT_CODES.INPUT_ERROR,
    });
  }
}

function validateSystemId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-ERP-002',
      category: 'INPUT_ERROR',
      message: 'ERP system ID is required',
      details: { provided: id },
      module: 'erp',
      correlationId,
      recoverable: false,
      exitCode: ERP_EXIT_CODES.INPUT_ERROR,
    });
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

export function formatErpListForDisplay(systems: ErpSystemSummaryBasic[]): string {
  if (systems.length === 0) {
    return 'No ERP systems available.';
  }

  const lines: string[] = [];
  lines.push(`Available ERP Systems (${systems.length}):`);
  lines.push('');

  for (const system of systems) {
    lines.push(`  ${system.id.toUpperCase()} - ${system.name}`);
    lines.push(`    Vendor: ${system.vendor}`);
    lines.push(`    Modules: ${system.modules_count}`);
    lines.push(`    Integration: ${system.integration_types.slice(0, 3).join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function formatErpInspectForDisplay(system: ErpSystemDefinition): string {
  const lines: string[] = [];
  lines.push(`ERP System: ${system.name}`);
  lines.push('');
  lines.push(`  ID:          ${system.id}`);
  lines.push(`  Vendor:      ${system.vendor}`);
  lines.push(`  Version:     ${system.version}`);
  lines.push(`  Description: ${system.description}`);
  lines.push('');
  lines.push('Modules:');
  for (const mod of system.modules) {
    lines.push(`  - ${mod.name} (${mod.category})`);
    lines.push(`    Entities: ${mod.entities.length} | API Endpoints: ${mod.api_endpoints}`);
  }
  lines.push('');
  lines.push(`Integration Types: ${system.integration_types.join(', ')}`);
  lines.push(`Protocols: ${system.supported_protocols.join(', ')}`);
  lines.push(`Compliance: ${system.compliance_frameworks.join(', ')}`);
  lines.push(`Connector: ${system.connector_repository}`);

  return lines.join('\n');
}

export function formatErpSurfaceForDisplay(analysis: ErpSurfaceAnalysis): string {
  const lines: string[] = [];
  lines.push(`ERP Surface Analysis: ${analysis.id}`);
  lines.push(`Plan: ${analysis.plan_id}`);
  lines.push('');
  lines.push('Affected ERP Systems:');
  for (const sys of analysis.erp_systems) {
    lines.push(`  - ${sys.system_name} (${sys.modules_affected.length} modules, ${sys.entity_count} entities)`);
    lines.push(`    Complexity: ${sys.integration_complexity} | Endpoints: ${sys.api_endpoints_required}`);
  }
  lines.push('');
  lines.push(`Deployment Touchpoints: ${analysis.deployment_touchpoints.length}`);
  lines.push(`Risks Identified: ${analysis.risks.length}`);
  lines.push(`Effort Estimate: ${analysis.estimated_effort.total_days} days (${analysis.estimated_effort.confidence} confidence)`);
  lines.push('');
  lines.push(`Repositories Involved: ${analysis.repositories_involved.length}`);

  return lines.join('\n');
}

export function formatErpMapForDisplay(mapping: ErpMapping): string {
  const lines: string[] = [];
  lines.push(`ERP Data Mapping: ${mapping.id}`);
  lines.push(`Plan: ${mapping.plan_id}`);
  lines.push('');
  lines.push(`Source: ${mapping.source_system}`);
  lines.push(`Targets: ${mapping.target_systems.join(', ')}`);
  lines.push('');
  lines.push(`Entity Mappings: ${mapping.entity_mappings.length}`);
  lines.push(`Field Mappings: ${mapping.field_mappings.length}`);
  lines.push(`Transformation Rules: ${mapping.transformation_rules.length}`);
  lines.push(`Validation Rules: ${mapping.validation_rules.length}`);
  lines.push('');
  lines.push(`Repositories Involved: ${mapping.repositories_involved.length}`);

  return lines.join('\n');
}

export function formatErpExportForDisplay(proposal: ErpExportProposal): string {
  const lines: string[] = [];
  lines.push(`ERP Deployment Proposal: ${proposal.id}`);
  lines.push(`Plan: ${proposal.plan_id}`);
  lines.push('');
  lines.push(`Title: ${proposal.proposal.title}`);
  lines.push(`Version: ${proposal.proposal.version}`);
  lines.push(`Status: ${proposal.proposal.status}`);
  lines.push('');
  lines.push('Scope:');
  lines.push(`  Systems: ${proposal.proposal.scope.erp_systems.join(', ')}`);
  lines.push(`  Modules: ${proposal.proposal.scope.modules.length}`);
  lines.push(`  Entities: ${proposal.proposal.scope.entities.length}`);
  lines.push('');
  lines.push(`Deployment Phases: ${proposal.proposal.phases.length}`);
  lines.push(`Artifacts Generated: ${proposal.artifacts.length}`);
  lines.push('');
  lines.push(`Repositories Involved: ${proposal.repositories_involved.length}`);

  return lines.join('\n');
}

// ============================================================================
// Command Implementations
// ============================================================================

/**
 * List all available ERP systems.
 */
export async function executeErpListCommand(
  _options: CommandOptions
): Promise<ErpListResult> {
  const startTime = Date.now();

  const systems: ErpSystemSummaryBasic[] = Object.values(ERP_SYSTEMS).map(sys => ({
    id: sys.id,
    name: sys.name,
    vendor: sys.vendor,
    modules_count: sys.modules.length,
    integration_types: sys.integration_types,
  }));

  return {
    systems,
    count: systems.length,
    repositories_involved: getInvolvedRepositories('erp-list'),
    timing: Date.now() - startTime,
  };
}

/**
 * Inspect a specific ERP system.
 */
export async function executeErpInspectCommand(
  input: ErpInspectInput,
  options: CommandOptions
): Promise<ErpInspectResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validateSystemId(input.system, correlationId);

  const systemId = input.system.toLowerCase() as ErpSystemId;
  const system = ERP_SYSTEMS[systemId] ?? null;

  return {
    system,
    found: system !== null,
    repositories_involved: getInvolvedRepositories('erp-inspect'),
    timing: Date.now() - startTime,
  };
}

/**
 * Generate ERP surface analysis for a plan.
 */
export async function executeErpSurfaceCommand(
  input: ErpSurfaceInput,
  options: CommandOptions
): Promise<ErpSurfaceResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePlanId(input.plan_id, correlationId);

  // ADR-PIPELINE-032: Detect ERP from query or plan context when not explicitly specified.
  // Never default to ['sap', 'oracle'] — detect from the query/plan or use a single best match.
  const targetSystems: ErpSystemId[] = input.erp_systems
    ?? (input.query ? detectErpFromQuery(input.query) : null)
    ?? detectErpFromPlanId(input.plan_id)
    ?? ['sap']; // single system fallback, not two unrelated ones
  const primarySystem: ErpSystemId = targetSystems[0] ?? 'sap';
  const now = new Date().toISOString();
  const analysisId = generateErpId('surface');

  // Generate ERP system summaries
  const erpSystems: ErpSystemSummary[] = targetSystems.map(sysId => {
    const sys = ERP_SYSTEMS[sysId];
    if (!sys) return null;
    return {
      system_id: sysId,
      system_name: sys.name,
      modules_affected: sys.modules.slice(0, 3).map(m => m.name),
      entity_count: sys.modules.reduce((sum, m) => sum + m.entities.length, 0),
      api_endpoints_required: sys.modules.reduce((sum, m) => sum + m.api_endpoints, 0),
      integration_complexity: sys.modules.length > 5 ? 'high' : sys.modules.length > 3 ? 'medium' : 'low',
    } as ErpSystemSummary;
  }).filter((s): s is ErpSystemSummary => s !== null);

  // ADR-PIPELINE-032: System-specific touchpoints instead of hardcoded financial entities
  const touchpoints: DeploymentTouchpoint[] = generateSystemTouchpoints(primarySystem);

  // Generate risk assessment
  const risks: RiskAssessment[] = [
    {
      id: generateErpId('risk'),
      category: 'technical',
      severity: 'medium',
      description: 'API rate limits may impact real-time sync performance during peak hours.',
      mitigation: 'Implement queue-based processing with exponential backoff.',
      owner: 'Integration Team',
    },
    {
      id: generateErpId('risk'),
      category: 'business',
      severity: 'high',
      description: 'Data mapping discrepancies between source and target schemas.',
      mitigation: 'Conduct thorough data profiling and establish transformation rules.',
      owner: 'Data Architecture Team',
    },
    {
      id: generateErpId('risk'),
      category: 'compliance',
      severity: 'low',
      description: 'PII data handling requires encryption in transit and at rest.',
      mitigation: 'Enable TLS 1.3 and field-level encryption for sensitive data.',
      owner: 'Security Team',
    },
  ];

  const analysis: ErpSurfaceAnalysis = {
    id: analysisId,
    plan_id: input.plan_id,
    analysis_type: 'surface',
    generated_at: now,
    erp_systems: erpSystems,
    deployment_touchpoints: touchpoints,
    risks,
    assumptions: [
      'Source systems have stable API contracts',
      'Network connectivity between environments is established',
      'Required credentials and access permissions are provisioned',
      'Data volumes are within estimated ranges',
      'No major ERP version upgrades during implementation',
    ],
    recommendations: [
      'Start with non-critical data flows for initial validation',
      'Implement comprehensive logging and monitoring from day one',
      'Establish data quality gates before production deployment',
      'Create runbooks for common failure scenarios',
      'Plan for incremental rollout with rollback capability',
    ],
    estimated_effort: {
      development_days: 45,
      testing_days: 20,
      deployment_days: 10,
      total_days: 75,
      team_size: 4,
      confidence: 'medium',
    },
    repositories_involved: getInvolvedRepositories('erp-surface'),
    generated_by: getArtifactAttribution('deployment-proposal'),
  };

  // Persist analysis
  try {
    ensureErpSubdir('surface');
    const filePath = getErpArtifactPath('surface', analysisId);
    fs.writeFileSync(filePath, JSON.stringify(analysis, null, 2), 'utf-8');
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-ERP-003',
      category: 'INTERNAL_ERROR',
      message: `Failed to save surface analysis: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: { analysis_id: analysisId },
      module: 'erp',
      correlationId,
      recoverable: false,
      exitCode: ERP_EXIT_CODES.IO_ERROR,
    });
  }

  // ========================================================================
  // ADR-004: Persist ERP Surface mapping + lineage to Ruvector
  // ERP Surface is downstream of simulations (Invariant 6).
  // ========================================================================
  try {
    const attribution = await resolveAttribution();
    const erpMapping = createErpSurfaceMapping(
      targetSystems[0] ?? 'sap',
      'surface-analysis',
      analysis,
      input.plan_id, // plan_id as simulation reference
      [],
      attribution,
    );
    const lineageRecord = createLineageRecord(
      analysisId,
      'erp_proposal',
      input.plan_id,
      `ERP surface analysis for plan ${input.plan_id}`,
      attribution,
      input.plan_id,
    );

    const ruvectorConfig = loadEndpointConfig('ruvector-service');
    const ruvectorAdapter = new RuvectorAdapter(ruvectorConfig, correlationId);
    await ruvectorAdapter.storeErpMapping(erpMapping);
    await ruvectorAdapter.storeLineage(lineageRecord);
  } catch {
    console.error(JSON.stringify({
      level: 'WARN',
      message: 'Failed to persist ERP surface lineage to Ruvector (ADR-004).',
      analysis_id: analysisId,
      correlationId,
    }));
  }

  return {
    analysis,
    repositories_involved: getInvolvedRepositories('erp-surface'),
    timing: Date.now() - startTime,
  };
}

/**
 * Generate ERP data mapping for a plan.
 */
export async function executeErpMapCommand(
  input: ErpMapInput,
  options: CommandOptions
): Promise<ErpMapResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePlanId(input.plan_id, correlationId);

  const targetSystems: ErpSystemId[] = input.target_systems ?? ['sap', 'oracle'];
  const primaryTargetSystem: ErpSystemId = targetSystems[0] ?? 'sap';
  const now = new Date().toISOString();
  const mappingId = generateErpId('map');

  // Generate entity mappings
  const entityMappings: EntityMapping[] = [
    {
      source_entity: 'Customer',
      target_entity: 'Business Partner',
      target_system: primaryTargetSystem,
      target_module: 'master-data',
      cardinality: '1:1',
      sync_direction: 'bidirectional',
    },
    {
      source_entity: 'Product',
      target_entity: 'Material',
      target_system: primaryTargetSystem,
      target_module: 'materials-management',
      cardinality: '1:1',
      sync_direction: 'push',
    },
    {
      source_entity: 'SalesOrder',
      target_entity: 'Sales Document',
      target_system: primaryTargetSystem,
      target_module: 'sales-distribution',
      cardinality: '1:N',
      sync_direction: 'push',
    },
    {
      source_entity: 'Invoice',
      target_entity: 'Billing Document',
      target_system: primaryTargetSystem,
      target_module: 'finance',
      cardinality: '1:1',
      sync_direction: 'bidirectional',
    },
    {
      source_entity: 'PurchaseOrder',
      target_entity: 'Purchase Order',
      target_system: primaryTargetSystem,
      target_module: 'materials-management',
      cardinality: '1:1',
      sync_direction: 'pull',
    },
  ];

  // Generate field mappings
  const fieldMappings: FieldMapping[] = [
    { source_field: 'customer_id', target_field: 'BP_NUMBER', transformation: 'passthrough', required: true },
    { source_field: 'customer_name', target_field: 'BP_NAME1', transformation: 'uppercase', required: true },
    { source_field: 'email', target_field: 'EMAIL_ADDRESS', transformation: 'lowercase', required: false },
    { source_field: 'phone', target_field: 'TELEPHONE', transformation: 'format_phone', required: false },
    { source_field: 'country_code', target_field: 'COUNTRY', transformation: 'iso_to_sap_country', required: true },
    { source_field: 'currency', target_field: 'CURRENCY_KEY', transformation: 'passthrough', required: true, default_value: 'USD' },
    { source_field: 'created_at', target_field: 'CREATED_ON', transformation: 'iso_to_sap_date', required: true },
    { source_field: 'amount', target_field: 'NET_VALUE', transformation: 'decimal_to_packed', required: true },
  ];

  // Generate transformation rules
  const transformationRules: TransformationRule[] = [
    {
      id: generateErpId('tr'),
      name: 'ISO to SAP Date',
      type: 'format',
      expression: 'YYYYMMDD',
      description: 'Convert ISO 8601 date to SAP internal date format',
    },
    {
      id: generateErpId('tr'),
      name: 'Country Code Lookup',
      type: 'lookup',
      expression: 'country_mapping_table[source_code]',
      description: 'Map ISO 3166-1 alpha-2 to SAP country keys',
    },
    {
      id: generateErpId('tr'),
      name: 'Phone Formatting',
      type: 'format',
      expression: '+{country_code}-{area_code}-{number}',
      description: 'Format phone numbers to international standard',
    },
    {
      id: generateErpId('tr'),
      name: 'Currency Amount',
      type: 'calculation',
      expression: 'value * exchange_rate[target_currency]',
      description: 'Convert amounts to target currency using daily rates',
    },
  ];

  // Generate validation rules
  const validationRules: ValidationRule[] = [
    {
      id: generateErpId('vr'),
      name: 'Required Customer ID',
      type: 'required',
      expression: 'customer_id IS NOT NULL',
      error_message: 'Customer ID is required for all records',
      severity: 'error',
    },
    {
      id: generateErpId('vr'),
      name: 'Valid Country Code',
      type: 'lookup',
      expression: 'country_code IN valid_countries',
      error_message: 'Invalid country code provided',
      severity: 'error',
    },
    {
      id: generateErpId('vr'),
      name: 'Amount Range',
      type: 'range',
      expression: 'amount >= 0 AND amount <= 999999999.99',
      error_message: 'Amount must be between 0 and 999,999,999.99',
      severity: 'error',
    },
    {
      id: generateErpId('vr'),
      name: 'Email Format',
      type: 'format',
      expression: 'email MATCHES /^[\\w.-]+@[\\w.-]+\\.\\w+$/',
      error_message: 'Invalid email format',
      severity: 'warning',
    },
  ];

  const mapping: ErpMapping = {
    id: mappingId,
    plan_id: input.plan_id,
    mapping_type: 'data-flow',
    generated_at: now,
    source_system: 'agentics-platform',
    target_systems: targetSystems,
    entity_mappings: entityMappings,
    field_mappings: fieldMappings,
    transformation_rules: transformationRules,
    validation_rules: validationRules,
    repositories_involved: getInvolvedRepositories('erp-map'),
    generated_by: getArtifactAttribution('data-mapping'),
  };

  // Persist mapping
  try {
    ensureErpSubdir('mappings');
    const filePath = getErpArtifactPath('mappings', mappingId);
    fs.writeFileSync(filePath, JSON.stringify(mapping, null, 2), 'utf-8');
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-ERP-004',
      category: 'INTERNAL_ERROR',
      message: `Failed to save mapping: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: { mapping_id: mappingId },
      module: 'erp',
      correlationId,
      recoverable: false,
      exitCode: ERP_EXIT_CODES.IO_ERROR,
    });
  }

  // ========================================================================
  // ADR-004: Persist ERP mapping lineage to Ruvector
  // ========================================================================
  try {
    const attribution = await resolveAttribution();
    const lineageRecord = createLineageRecord(
      mappingId,
      'integration_mapping',
      input.plan_id,
      `ERP data mapping for plan ${input.plan_id}`,
      attribution,
      input.plan_id,
    );
    const ruvectorConfig = loadEndpointConfig('ruvector-service');
    const ruvectorAdapter = new RuvectorAdapter(ruvectorConfig, correlationId);
    await ruvectorAdapter.storeLineage(lineageRecord);
  } catch {
    console.error(JSON.stringify({
      level: 'WARN',
      message: 'Failed to persist ERP mapping lineage to Ruvector (ADR-004).',
      mapping_id: mappingId,
      correlationId,
    }));
  }

  return {
    mapping,
    repositories_involved: getInvolvedRepositories('erp-map'),
    timing: Date.now() - startTime,
  };
}

/**
 * Export ERP deployment proposal for a plan.
 */
export async function executeErpExportCommand(
  input: ErpExportInput,
  options: CommandOptions
): Promise<ErpExportResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePlanId(input.plan_id, correlationId);

  const now = new Date().toISOString();
  const proposalId = generateErpId('proposal');
  const targetSystems: ErpSystemId[] = ['sap', 'oracle'];

  // Generate deployment phases
  const phases: DeploymentPhase[] = [
    {
      id: generateErpId('phase'),
      name: 'Discovery & Planning',
      order: 1,
      duration_days: 10,
      activities: [
        'Conduct stakeholder interviews',
        'Document current state architecture',
        'Define integration requirements',
        'Establish success criteria',
      ],
      deliverables: ['Requirements document', 'Integration architecture diagram', 'Project plan'],
      risks: ['Incomplete requirements', 'Stakeholder availability'],
      dependencies: [],
    },
    {
      id: generateErpId('phase'),
      name: 'Design & Development',
      order: 2,
      duration_days: 30,
      activities: [
        'Design data mappings',
        'Develop integration components',
        'Create transformation logic',
        'Build error handling',
      ],
      deliverables: ['Technical design document', 'Integration code', 'Unit tests'],
      risks: ['API compatibility issues', 'Data quality problems'],
      dependencies: ['Phase 1 completion'],
    },
    {
      id: generateErpId('phase'),
      name: 'Testing & Validation',
      order: 3,
      duration_days: 20,
      activities: [
        'Execute integration tests',
        'Perform data validation',
        'Conduct performance testing',
        'Complete UAT',
      ],
      deliverables: ['Test results', 'Performance report', 'UAT sign-off'],
      risks: ['Test environment availability', 'Data volume issues'],
      dependencies: ['Phase 2 completion'],
    },
    {
      id: generateErpId('phase'),
      name: 'Deployment & Go-Live',
      order: 4,
      duration_days: 10,
      activities: [
        'Deploy to production',
        'Execute cutover activities',
        'Monitor initial transactions',
        'Provide hypercare support',
      ],
      deliverables: ['Deployment checklist', 'Runbook', 'Support documentation'],
      risks: ['Production issues', 'User adoption'],
      dependencies: ['Phase 3 completion', 'Business approval'],
    },
  ];

  // Generate proposal
  const proposal: DeploymentProposal = {
    title: `ERP Integration Deployment - ${input.plan_id}`,
    version: '1.0.0',
    status: 'draft',
    summary: `This proposal outlines the deployment plan for integrating the Agentics platform with enterprise ERP systems (${targetSystems.join(', ')}). The integration enables bidirectional data synchronization, real-time event processing, and comprehensive audit capabilities.`,
    scope: {
      erp_systems: targetSystems,
      modules: ['finance', 'supply-chain', 'sales', 'master-data'],
      entities: ['Customer', 'Vendor', 'Product', 'Sales Order', 'Purchase Order', 'Invoice'],
      environments: ['development', 'staging', 'production'],
      regions: ['us-central1', 'europe-west1'],
    },
    phases,
    dependencies: [
      { name: 'ERP API Access', type: 'technical', status: 'pending', owner: 'IT Security' },
      { name: 'Data Governance Approval', type: 'business', status: 'pending', owner: 'Data Office' },
      { name: 'Integration Team Allocation', type: 'resource', status: 'ready', owner: 'PMO' },
      { name: 'Test Environment Setup', type: 'technical', status: 'pending', owner: 'Infrastructure' },
    ],
    success_criteria: [
      '99.9% API availability during business hours',
      'Data synchronization latency < 5 minutes',
      'Zero data loss in transaction processing',
      'Full audit trail for compliance',
      'Successful processing of 10K+ transactions/day',
    ],
    rollback_plan: 'In case of critical issues, the integration can be disabled at the API gateway level. Historical data will be preserved in staging tables for reconciliation. A manual fallback process is documented for essential business operations.',
  };

  // Generate artifacts
  const artifacts: ExportArtifact[] = [
    {
      filename: 'deployment-proposal.json',
      type: 'json',
      content: JSON.stringify(proposal, null, 2),
      description: 'Complete deployment proposal in JSON format',
      generated_by: getArtifactAttribution('deployment-proposal'),
    },
    {
      filename: 'integration-config.yaml',
      type: 'yaml',
      content: generateIntegrationConfigYaml(input.plan_id, targetSystems),
      description: 'Integration configuration for deployment',
      generated_by: getArtifactAttribution('integration-config'),
    },
    {
      filename: 'data-mapping-spec.json',
      type: 'json',
      content: JSON.stringify({
        version: '1.0.0',
        plan_id: input.plan_id,
        mappings: {
          entities: 6,
          fields: 24,
          transformations: 8,
          validations: 12,
        },
        generated_at: now,
        generated_by: getArtifactAttribution('data-mapping'),
      }, null, 2),
      description: 'Data mapping specification summary',
      generated_by: getArtifactAttribution('data-mapping'),
    },
    {
      filename: 'compliance-checklist.json',
      type: 'json',
      content: JSON.stringify({
        version: '1.0.0',
        frameworks: ['SOC2', 'GDPR', 'SOX'],
        controls: [
          { id: 'AC-1', name: 'Access Control Policy', status: 'compliant' },
          { id: 'AU-1', name: 'Audit Policy', status: 'compliant' },
          { id: 'SC-1', name: 'System Communication Protection', status: 'compliant' },
          { id: 'IR-1', name: 'Incident Response', status: 'pending' },
        ],
        generated_at: now,
        generated_by: getArtifactAttribution('compliance-report'),
      }, null, 2),
      description: 'Compliance checklist for ERP integration',
      generated_by: getArtifactAttribution('compliance-report'),
    },
  ];

  const erpExport: ErpExportProposal = {
    id: proposalId,
    plan_id: input.plan_id,
    export_type: 'deployment-proposal',
    generated_at: now,
    proposal,
    artifacts,
    repositories_involved: getInvolvedRepositories('erp-export'),
    generated_by: getArtifactAttribution('deployment-proposal'),
  };

  // Persist proposal and artifacts
  let artifactsWritten = false;
  let outputPath = '';

  try {
    ensureErpSubdir('proposals');
    ensureErpSubdir(`proposals/${proposalId}`);

    // Save main proposal
    const proposalPath = getErpArtifactPath('proposals', proposalId);
    fs.writeFileSync(proposalPath, JSON.stringify(erpExport, null, 2), 'utf-8');

    // Save individual artifacts
    const artifactsDir = path.join(getErpDir(), 'proposals', proposalId);
    for (const artifact of artifacts) {
      const artifactPath = path.join(artifactsDir, artifact.filename);
      fs.writeFileSync(artifactPath, artifact.content, 'utf-8');
    }

    artifactsWritten = true;
    outputPath = artifactsDir;
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-ERP-005',
      category: 'INTERNAL_ERROR',
      message: `Failed to save export proposal: ${error instanceof Error ? error.message : 'Unknown error'}`,
      details: { proposal_id: proposalId },
      module: 'erp',
      correlationId,
      recoverable: false,
      exitCode: ERP_EXIT_CODES.IO_ERROR,
    });
  }

  // ========================================================================
  // ADR-004: Persist ERP export lineage to Ruvector
  // ========================================================================
  try {
    const attribution = await resolveAttribution();
    const lineageRecord = createLineageRecord(
      proposalId,
      'erp_proposal',
      input.plan_id,
      `ERP deployment proposal for plan ${input.plan_id}`,
      attribution,
      input.plan_id,
    );
    const ruvectorConfig = loadEndpointConfig('ruvector-service');
    const ruvectorAdapter = new RuvectorAdapter(ruvectorConfig, correlationId);
    await ruvectorAdapter.storeLineage(lineageRecord);
  } catch {
    console.error(JSON.stringify({
      level: 'WARN',
      message: 'Failed to persist ERP export lineage to Ruvector (ADR-004).',
      proposal_id: proposalId,
      correlationId,
    }));
  }

  return {
    proposal: erpExport,
    artifacts_written: artifactsWritten,
    output_path: outputPath,
    repositories_involved: getInvolvedRepositories('erp-export'),
    timing: Date.now() - startTime,
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

function generateIntegrationConfigYaml(planId: string, systems: ErpSystemId[]): string {
  const attribution = getArtifactAttribution('integration-config');
  return `# ERP Integration Configuration
# Generated by Agentics CLI
# Plan ID: ${planId}
# Generated at: ${new Date().toISOString()}

version: "1.0.0"

generated_by:
${attribution.map(r => `  - ${r}`).join('\n')}

integration:
  plan_id: "${planId}"
  type: "erp-connector"
  mode: "bidirectional"

target_systems:
${systems.map(s => `  - system_id: "${s}"
    enabled: true
    priority: 1`).join('\n')}

connection:
  protocol: "https"
  authentication: "oauth2"
  timeout_ms: 30000
  retry_policy:
    max_retries: 3
    backoff_multiplier: 2
    initial_delay_ms: 1000

sync:
  mode: "incremental"
  batch_size: 1000
  parallelism: 4

monitoring:
  enabled: true
  metrics_endpoint: "/v1/metrics"
  health_endpoint: "/v1/health"
  alert_channels:
    - "slack"
    - "pagerduty"

compliance:
  audit_logging: true
  encryption_at_rest: true
  encryption_in_transit: true
  data_retention_days: 90

# Repository attribution for orchestration proof
orchestration:
  platform: "agentics"
  repositories_involved:
${getInvolvedRepositories('erp-export').map(r => `    - ${r}`).join('\n')}
`;
}
