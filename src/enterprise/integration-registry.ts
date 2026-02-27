/**
 * Integration Registry (ADR-004, Domain 3)
 *
 * PURPOSE: Describe enterprise system capabilities declaratively.
 * Integrations are reference material for simulations, not executable connectors.
 *
 * WHAT THIS IS:
 * - A catalog of enterprise system capabilities
 * - Declarative descriptions of what each system does
 * - Reference material consulted during simulation
 *
 * WHAT THIS IS NOT:
 * - An API client or connector library
 * - An execution engine for enterprise systems
 * - A credential store for system connections
 *
 * INVARIANT 5: Integrations are described and proposed, not executed,
 * during simulation.
 */

// ============================================================================
// Integration Definition Types
// ============================================================================

/**
 * An enterprise integration capability definition.
 * Describes what a system does, not how to connect to it.
 */
export interface IntegrationDefinition {
  /** System identifier (lowercase, hyphenated) */
  name: string;
  /** Human-readable display name */
  display_name: string;
  /** Integration category */
  category: IntegrationCategory;
  /** What the system is responsible for */
  description: string;
  /** Data entities this system owns or participates in */
  data_entities: string[];
  /** Integration points (conceptual, not connection details) */
  integration_points: string[];
  /** Known constraints (rate limits, data formats, etc.) */
  constraints: string[];
}

export type IntegrationCategory =
  | 'erp'
  | 'crm'
  | 'hr'
  | 'finance'
  | 'logistics'
  | 'itsm'
  | 'devops'
  | 'analytics'
  | 'compliance'
  | 'communication'
  | 'identity'
  | 'infrastructure';

// ============================================================================
// Integration Registry
// ============================================================================

/**
 * Registry of known enterprise system capabilities.
 *
 * Each entry describes what the system CAN do in an enterprise context.
 * This registry is consulted during simulation to understand which
 * systems are relevant and what constraints apply.
 *
 * It does NOT contain connection details, API endpoints, or credentials.
 */
export const INTEGRATION_REGISTRY: readonly IntegrationDefinition[] = [
  // ERP Systems
  {
    name: 'sap',
    display_name: 'SAP S/4HANA',
    category: 'erp',
    description: 'Enterprise resource planning: finance, supply chain, manufacturing, procurement',
    data_entities: ['customers', 'vendors', 'materials', 'purchase-orders', 'sales-orders', 'invoices', 'gl-accounts'],
    integration_points: ['OData APIs', 'IDocs', 'BAPIs', 'RFC', 'CDS Views'],
    constraints: ['rate-limited to 1000 req/min', 'batch processing preferred', 'change documents required'],
  },
  {
    name: 'oracle-erp',
    display_name: 'Oracle ERP Cloud',
    category: 'erp',
    description: 'Cloud ERP for finance, procurement, project management, and risk',
    data_entities: ['journals', 'payables', 'receivables', 'assets', 'projects', 'budgets'],
    integration_points: ['REST APIs', 'SOAP Services', 'BI Publisher', 'FBDI'],
    constraints: ['throttled per-tenant', 'file-based data import preferred for bulk'],
  },
  {
    name: 'netsuite',
    display_name: 'NetSuite',
    category: 'erp',
    description: 'Cloud ERP for mid-market: financials, inventory, CRM, e-commerce',
    data_entities: ['transactions', 'items', 'customers', 'vendors', 'employees', 'subsidiaries'],
    integration_points: ['SuiteTalk (SOAP)', 'RESTlets', 'SuiteQL', 'SuiteScript'],
    constraints: ['governance limits per script', 'concurrency limits per account'],
  },
  {
    name: 'dynamics-365',
    display_name: 'Microsoft Dynamics 365',
    category: 'erp',
    description: 'Business applications for finance, operations, sales, and customer service',
    data_entities: ['accounts', 'contacts', 'opportunities', 'orders', 'ledger-entries'],
    integration_points: ['Dataverse API', 'Power Automate', 'Azure Logic Apps', 'Dual Write'],
    constraints: ['API throttling per-org', 'batch size limits on Dataverse'],
  },
  {
    name: 'sap-business-one',
    display_name: 'SAP Business One',
    category: 'erp',
    description: 'ERP for small-to-medium enterprises: finance, sales, purchasing, inventory',
    data_entities: ['business-partners', 'items', 'orders', 'invoices', 'journal-entries', 'production-orders'],
    integration_points: ['Service Layer REST API', 'DI API', 'DI Server'],
    constraints: ['single-tenant', 'limited concurrent sessions', 'SAP HANA or SQL Server backend'],
  },
  {
    name: 'jd-edwards',
    display_name: 'JD Edwards EnterpriseOne',
    category: 'erp',
    description: 'Enterprise ERP for manufacturing, distribution, and asset management',
    data_entities: ['address-book', 'work-orders', 'purchase-orders', 'sales-orders', 'inventory', 'general-ledger'],
    integration_points: ['AIS REST API', 'Business Services', 'Orchestrator', 'EnterpriseOne Pages'],
    constraints: ['object-configuration-driven', 'version-dependent APIs', 'thick-client legacy modules'],
  },
  {
    name: 'peoplesoft',
    display_name: 'PeopleSoft',
    category: 'erp',
    description: 'HCM and financial management for large enterprises and government',
    data_entities: ['employees', 'positions', 'departments', 'journals', 'vouchers', 'purchase-orders'],
    integration_points: ['Integration Broker', 'Component Interface', 'REST/SOAP Services'],
    constraints: ['PeopleCode customization complexity', 'batch-oriented architecture', 'upgrade path limitations'],
  },
  {
    name: 'epicor',
    display_name: 'Epicor Kinetic',
    category: 'erp',
    description: 'Cloud and on-premise ERP for manufacturing, distribution, and retail',
    data_entities: ['customers', 'parts', 'jobs', 'purchase-orders', 'sales-orders', 'receipts', 'shipments'],
    integration_points: ['REST API v2', 'Business Activity Queries', 'Service Connect', 'Functions'],
    constraints: ['customization via BPMs', 'SQL Server backend required', 'tenant isolation in cloud'],
  },
  {
    name: 'sage-x3',
    display_name: 'Sage X3',
    category: 'erp',
    description: 'ERP for mid-to-large manufacturers and distributors',
    data_entities: ['items', 'customers', 'suppliers', 'purchase-orders', 'sales-orders', 'production-orders'],
    integration_points: ['REST Web Services', 'SOAP API', 'Syracuse Platform'],
    constraints: ['per-folder security', 'batch processing for bulk', 'customization via 4GL scripting'],
  },
  {
    name: 'sage-intacct',
    display_name: 'Sage Intacct',
    category: 'erp',
    description: 'Cloud financial management for mid-market: GL, AP, AR, cash management',
    data_entities: ['gl-accounts', 'vendors', 'customers', 'invoices', 'bills', 'journals', 'dimensions'],
    integration_points: ['XML Gateway API', 'REST API', 'Marketplace Connectors'],
    constraints: ['API rate limits per company', 'dimension-based security', 'multi-entity consolidation rules'],
  },
  {
    name: 'ifs',
    display_name: 'IFS Cloud',
    category: 'erp',
    description: 'ERP for asset-intensive industries: aerospace, defense, energy, manufacturing',
    data_entities: ['work-orders', 'assets', 'purchase-orders', 'inventory', 'projects', 'contracts'],
    integration_points: ['IFS REST API', 'IFS Connect', 'Aurena UX', 'Integration Framework'],
    constraints: ['projection-based API model', 'foundation-layer security', 'ODATA-compatible endpoints'],
  },
  {
    name: 'acumatica',
    display_name: 'Acumatica',
    category: 'erp',
    description: 'Cloud ERP for mid-market: finance, distribution, manufacturing, CRM',
    data_entities: ['customers', 'vendors', 'items', 'sales-orders', 'purchase-orders', 'gl-transactions'],
    integration_points: ['REST API', 'Contract-Based SOAP API', 'Webhooks', 'Push Notifications'],
    constraints: ['resource-based licensing', 'API version compatibility', 'customization via platform extensions'],
  },
  {
    name: 'unit4',
    display_name: 'Unit4 ERPx',
    category: 'erp',
    description: 'ERP for service-centric organizations: professional services, higher education, nonprofits',
    data_entities: ['projects', 'resources', 'timesheets', 'budgets', 'gl-accounts', 'purchase-orders'],
    integration_points: ['REST API', 'Extension Kit', 'Unit4 Connect'],
    constraints: ['industry-specific workflows', 'role-based access', 'multi-company structures'],
  },
  {
    name: 'syspro',
    display_name: 'SYSPRO',
    category: 'erp',
    description: 'ERP for manufacturing and distribution: production, inventory, supply chain',
    data_entities: ['stock-items', 'work-orders', 'purchase-orders', 'sales-orders', 'bom', 'gl-accounts'],
    integration_points: ['e.net REST API', 'SYSPRO Harmony', 'Business Objects'],
    constraints: ['SQL Server backend', 'role-based security', 'customization via VBScript/C#'],
  },

  // CRM Systems
  {
    name: 'salesforce',
    display_name: 'Salesforce',
    category: 'crm',
    description: 'Customer relationship management: sales, service, marketing, analytics',
    data_entities: ['accounts', 'contacts', 'opportunities', 'leads', 'cases', 'campaigns'],
    integration_points: ['REST API', 'Bulk API', 'Streaming API', 'Platform Events'],
    constraints: ['API call limits per 24h', 'governor limits on triggers', 'data storage limits'],
  },
  {
    name: 'hubspot',
    display_name: 'HubSpot',
    category: 'crm',
    description: 'Inbound marketing, sales, and service platform',
    data_entities: ['contacts', 'companies', 'deals', 'tickets', 'products'],
    integration_points: ['REST API v3', 'Webhooks', 'Custom Objects'],
    constraints: ['rate limits per API key', 'burst limits on search'],
  },

  // HR Systems
  {
    name: 'workday',
    display_name: 'Workday',
    category: 'hr',
    description: 'Human capital management: HR, payroll, talent, workforce planning',
    data_entities: ['workers', 'positions', 'organizations', 'compensation', 'benefits', 'time-tracking'],
    integration_points: ['REST API', 'SOAP API', 'RaaS Reports', 'EIB'],
    constraints: ['tenant-level rate limits', 'security-group access controls', 'field-level security'],
  },
  {
    name: 'bamboohr',
    display_name: 'BambooHR',
    category: 'hr',
    description: 'HR software for small-to-medium businesses: records, onboarding, time-off',
    data_entities: ['employees', 'time-off-requests', 'benefits', 'documents'],
    integration_points: ['REST API', 'Webhooks'],
    constraints: ['API key per company', 'rate limits on bulk endpoints'],
  },

  // ITSM / DevOps
  {
    name: 'servicenow',
    display_name: 'ServiceNow',
    category: 'itsm',
    description: 'IT service management: incidents, changes, requests, CMDB',
    data_entities: ['incidents', 'changes', 'problems', 'ci-items', 'requests', 'knowledge-articles'],
    integration_points: ['REST API', 'Table API', 'Scripted REST', 'IntegrationHub'],
    constraints: ['ACL restrictions', 'rate limits per instance', 'scope-based access'],
  },
  {
    name: 'jira',
    display_name: 'Jira (Atlassian)',
    category: 'devops',
    description: 'Project and issue tracking for software development and IT operations',
    data_entities: ['issues', 'projects', 'sprints', 'boards', 'workflows', 'components'],
    integration_points: ['REST API v3', 'Webhooks', 'Forge Apps'],
    constraints: ['rate limits per user/app', 'pagination required for large datasets'],
  },

  // Finance
  {
    name: 'stripe',
    display_name: 'Stripe',
    category: 'finance',
    description: 'Payment processing: charges, subscriptions, invoicing, payouts',
    data_entities: ['customers', 'subscriptions', 'invoices', 'charges', 'payouts', 'payment-methods'],
    integration_points: ['REST API', 'Webhooks', 'Connect', 'Billing Portal'],
    constraints: ['idempotency required', 'rate limits per-key', 'PCI compliance required'],
  },

  // Logistics
  {
    name: 'shipstation',
    display_name: 'ShipStation',
    category: 'logistics',
    description: 'Shipping and fulfillment: order management, label creation, tracking',
    data_entities: ['orders', 'shipments', 'carriers', 'warehouses', 'products'],
    integration_points: ['REST API', 'Webhooks'],
    constraints: ['rate limits per-account', 'batch label limits'],
  },

  // Analytics
  {
    name: 'snowflake',
    display_name: 'Snowflake',
    category: 'analytics',
    description: 'Cloud data platform: data warehousing, lakes, sharing, ML',
    data_entities: ['tables', 'views', 'stages', 'pipes', 'streams', 'tasks'],
    integration_points: ['SQL API', 'Snowpipe', 'External Functions', 'Snowpark'],
    constraints: ['credit-based pricing', 'warehouse sizing affects cost', 'concurrent query limits'],
  },

  // Compliance
  {
    name: 'vanta',
    display_name: 'Vanta',
    category: 'compliance',
    description: 'Automated security and compliance: SOC2, HIPAA, ISO27001, GDPR',
    data_entities: ['controls', 'tests', 'evidence', 'vendors', 'policies', 'risks'],
    integration_points: ['REST API', 'Integrations Hub'],
    constraints: ['read-heavy API', 'evidence upload limits'],
  },

  // Communication
  {
    name: 'slack',
    display_name: 'Slack',
    category: 'communication',
    description: 'Team communication: messaging, channels, workflows, apps',
    data_entities: ['messages', 'channels', 'users', 'files', 'reactions'],
    integration_points: ['Web API', 'Events API', 'Socket Mode', 'Bolt Framework'],
    constraints: ['rate limits per method', 'message history retention limits', 'file storage limits'],
  },

  // Identity
  {
    name: 'okta',
    display_name: 'Okta',
    category: 'identity',
    description: 'Identity and access management: SSO, MFA, lifecycle management',
    data_entities: ['users', 'groups', 'applications', 'policies', 'factors'],
    integration_points: ['REST API', 'SCIM', 'SAML', 'OIDC'],
    constraints: ['rate limits per-org', 'concurrent session limits'],
  },

  // Infrastructure
  {
    name: 'aws',
    display_name: 'Amazon Web Services',
    category: 'infrastructure',
    description: 'Cloud infrastructure: compute, storage, networking, databases, AI/ML',
    data_entities: ['instances', 'buckets', 'functions', 'databases', 'vpcs', 'iam-roles'],
    integration_points: ['SDK/API', 'CloudFormation', 'CDK', 'EventBridge'],
    constraints: ['service quotas per-region', 'API throttling per-service', 'IAM policy limits'],
  },
  {
    name: 'gcp',
    display_name: 'Google Cloud Platform',
    category: 'infrastructure',
    description: 'Cloud infrastructure: compute, storage, data analytics, AI/ML',
    data_entities: ['instances', 'buckets', 'datasets', 'functions', 'networks', 'iam-bindings'],
    integration_points: ['REST API', 'gRPC', 'Terraform', 'Deployment Manager'],
    constraints: ['quota limits per-project', 'rate limits per-API', 'org policy constraints'],
  },
  {
    name: 'azure',
    display_name: 'Microsoft Azure',
    category: 'infrastructure',
    description: 'Cloud infrastructure: compute, storage, AI, DevOps, hybrid cloud',
    data_entities: ['resources', 'subscriptions', 'resource-groups', 'managed-identities'],
    integration_points: ['REST API', 'ARM Templates', 'Bicep', 'Azure CLI'],
    constraints: ['subscription-level quotas', 'RBAC-based access', 'region availability'],
  },
] as const;

// ============================================================================
// Registry Lookup Functions
// ============================================================================

/**
 * Look up an integration by name.
 * Returns undefined if not found.
 */
export function lookupIntegration(name: string): IntegrationDefinition | undefined {
  return INTEGRATION_REGISTRY.find(i => i.name === name);
}

/**
 * Get all integrations in a category.
 */
export function getIntegrationsByCategory(category: IntegrationCategory): readonly IntegrationDefinition[] {
  return INTEGRATION_REGISTRY.filter(i => i.category === category);
}

/**
 * Get all integration names.
 */
export function getIntegrationNames(): string[] {
  return INTEGRATION_REGISTRY.map(i => i.name);
}

/**
 * Check if a named integration is known in the registry.
 */
export function isKnownIntegration(name: string): boolean {
  return INTEGRATION_REGISTRY.some(i => i.name === name);
}

/**
 * Get the data entities affected by a named integration.
 * Returns empty array if integration is not known.
 */
export function getAffectedEntities(integrationName: string): string[] {
  const integration = lookupIntegration(integrationName);
  return integration ? [...integration.data_entities] : [];
}
