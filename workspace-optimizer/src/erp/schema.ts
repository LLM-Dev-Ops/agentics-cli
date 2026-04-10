import { z } from 'zod';
import { AppError } from '../errors.js';

// === ADR-058: Schema Version Error ===

export class SchemaVersionError extends AppError {
  constructor(localVersion: string, remoteVersion: string) {
    super(
      `Archibus schema version mismatch: adapter supports ${localVersion}, remote reports ${remoteVersion}. Major version difference — cannot proceed safely.`,
      'SCHEMA_VERSION_ERROR',
      503,
    );
    this.name = 'SchemaVersionError';
  }
}

// === ADR-058: Supported Schema Versions ===

export const SUPPORTED_SCHEMA_VERSIONS = ['25.1', '25.2', '26.0'] as const;
export type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

export const DEFAULT_SCHEMA_VERSION: SupportedSchemaVersion = '25.2';

// === ADR-058: Archibus Integration Points ===
// These are the correct Archibus IWMS endpoints — NOT SAP financial endpoints.

export interface ArchibusIntegrationPoint {
  table: string;
  description: string;
  operations: ('read' | 'write' | 'query')[];
  apiPath: string;
}

export const ARCHIBUS_INTEGRATION_POINTS: ArchibusIntegrationPoint[] = [
  {
    table: 'afm_activity_log',
    description: 'Activity Log — decision recording and audit trail',
    operations: ['read', 'write', 'query'],
    apiPath: '/api/v1/datasource/afm_activity_log',
  },
  {
    table: 'rm',
    description: 'Space Allocation — zone/room assignment updates',
    operations: ['read', 'write', 'query'],
    apiPath: '/api/v1/datasource/rm',
  },
  {
    table: 'wr',
    description: 'Work Request — maintenance scheduling',
    operations: ['read', 'write', 'query'],
    apiPath: '/api/v1/datasource/wr',
  },
  {
    table: 'bl',
    description: 'Building Operations — energy/occupancy aggregation',
    operations: ['read', 'query'],
    apiPath: '/api/v1/datasource/bl',
  },
  {
    table: 'afm/datasource',
    description: 'Data Source API — programmatic CRUD for any table',
    operations: ['read', 'write', 'query'],
    apiPath: '/api/v1/datasource',
  },
];

// === ADR-058: ERP System Detection ===

export type DetectedERPSystem = 'archibus' | 'sap' | 'servicenow' | 'workday' | 'unknown';

const DETECTION_KEYWORDS: Record<DetectedERPSystem, string[]> = {
  archibus: ['archibus', 'iwms', 'space management', 'facilities management', 'room allocation', 'bl_id', 'fl_id', 'afm_activity_log'],
  sap: ['sap', 's/4hana', 'odata', 'bapi', 'rfc', 'gl account'],
  servicenow: ['servicenow', 'snow', 'cmdb', 'incident table', 'update set'],
  workday: ['workday', 'raas', 'custom object', 'worker'],
  unknown: [],
};

export function detectERPSystem(query: string): DetectedERPSystem {
  const lower = query.toLowerCase();
  for (const [system, keywords] of Object.entries(DETECTION_KEYWORDS)) {
    if (system === 'unknown') continue;
    if (keywords.some(kw => lower.includes(kw))) {
      return system as DetectedERPSystem;
    }
  }
  return 'unknown';
}

export function getIntegrationPointsForSystem(system: DetectedERPSystem): ArchibusIntegrationPoint[] | null {
  if (system === 'archibus') return ARCHIBUS_INTEGRATION_POINTS;
  // Only Archibus integration points are implemented in this prototype
  return null;
}

// === ADR-058: Version-Aware Field Mapping ===

interface FieldMap {
  activityLogId: string;
  buildingId: string;
  floorId: string;
  dateRequired: string;
  status: string;
  description: string;
  costSavingsAnnual: string;
  energySavingsKwh: string;
  co2ReductionTonnes: string;
  employeesAffected: string;
  approvalStatus: string;
  approvedBy: string;
  simulationId: string;
  scenarioType: string;
  idempotencyKey: string;
  createdBySystem: string;
}

const FIELD_MAPS: Record<string, FieldMap> = {
  '25.1': {
    activityLogId: 'activity_log_id',
    buildingId: 'bl_id',
    floorId: 'fl_id',
    dateRequired: 'date_required',
    status: 'status',
    description: 'description',
    costSavingsAnnual: 'cost_savings_annual',
    energySavingsKwh: 'energy_savings_kwh',
    co2ReductionTonnes: 'co2_reduction_tonnes',
    employeesAffected: 'employees_affected',
    approvalStatus: 'approval_status',
    approvedBy: 'approved_by',
    simulationId: 'simulation_id',
    scenarioType: 'scenario_type',
    idempotencyKey: 'idempotency_key',
    createdBySystem: 'created_by_system',
  },
  '25.2': {
    // Same as 25.1 — no field changes in this minor version
    activityLogId: 'activity_log_id',
    buildingId: 'bl_id',
    floorId: 'fl_id',
    dateRequired: 'date_required',
    status: 'status',
    description: 'description',
    costSavingsAnnual: 'cost_savings_annual',
    energySavingsKwh: 'energy_savings_kwh',
    co2ReductionTonnes: 'co2_reduction_tonnes',
    employeesAffected: 'employees_affected',
    approvalStatus: 'approval_status',
    approvedBy: 'approved_by',
    simulationId: 'simulation_id',
    scenarioType: 'scenario_type',
    idempotencyKey: 'idempotency_key',
    createdBySystem: 'created_by_system',
  },
  '26.0': {
    // v26 renames some fields for consistency with Archibus Web Central
    activityLogId: 'activity_log_id',
    buildingId: 'bl_id',
    floorId: 'fl_id',
    dateRequired: 'date_required',
    status: 'status',
    description: 'description',
    costSavingsAnnual: 'annual_cost_savings',  // renamed in v26
    energySavingsKwh: 'annual_energy_savings_kwh',  // renamed in v26
    co2ReductionTonnes: 'annual_co2_reduction_tonnes',  // renamed in v26
    employeesAffected: 'employees_affected',
    approvalStatus: 'approval_status',
    approvedBy: 'approved_by',
    simulationId: 'simulation_id',
    scenarioType: 'scenario_type',
    idempotencyKey: 'idempotency_key',
    createdBySystem: 'created_by_system',
  },
};

export function getFieldMap(version: string): FieldMap {
  const map = FIELD_MAPS[version];
  if (!map) {
    throw new Error(`No field map for schema version ${version}. Supported: ${Object.keys(FIELD_MAPS).join(', ')}`);
  }
  return map;
}

// === Schema Version Negotiation ===

export function parseMajorVersion(version: string): number {
  return parseInt(version.split('.')[0], 10);
}

export function negotiateSchemaVersion(remoteVersion: string): {
  compatible: boolean;
  warning?: string;
  effectiveVersion: string;
} {
  const remoteMajor = parseMajorVersion(remoteVersion);

  // Check if exact match exists
  if ((SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(remoteVersion)) {
    return { compatible: true, effectiveVersion: remoteVersion };
  }

  // Check major version compatibility
  const supportedMajors = SUPPORTED_SCHEMA_VERSIONS.map(v => parseMajorVersion(v));
  if (!supportedMajors.includes(remoteMajor)) {
    return {
      compatible: false,
      warning: `Major version ${remoteMajor} is not supported. Supported: ${[...new Set(supportedMajors)].join(', ')}`,
      effectiveVersion: remoteVersion,
    };
  }

  // Minor version mismatch — find closest supported version with same major
  const sameMajor = SUPPORTED_SCHEMA_VERSIONS.filter(v => parseMajorVersion(v) === remoteMajor);
  const closest = sameMajor[sameMajor.length - 1]; // use latest supported minor
  return {
    compatible: true,
    warning: `Minor version mismatch: remote=${remoteVersion}, using mapping for ${closest}`,
    effectiveVersion: closest,
  };
}

// === Zod Schemas (version-aware) ===

export const ArchibusSpaceAllocationSchema = z.object({
  bl_id: z.string(),
  fl_id: z.string(),
  rm_id: z.string(),
  rm_cat: z.string(),
  rm_type: z.string(),
  area: z.number(),
  cap_em: z.number(),
  dv_id: z.string(),
  dp_id: z.string(),
});

export const ArchibusDecisionRecordSchema = z.object({
  activity_log_id: z.string(),
  bl_id: z.string(),
  fl_id: z.string(),
  date_required: z.string(),
  status: z.string(),
  description: z.string(),
  cost_savings_annual: z.number(),
  energy_savings_kwh: z.number(),
  co2_reduction_tonnes: z.number(),
  employees_affected: z.number(),
  approval_status: z.string(),
  approved_by: z.string(),
  simulation_id: z.string(),
  scenario_type: z.string(),
  idempotency_key: z.string(),
  created_by_system: z.literal('workspace-optimizer'),
});

export type ArchibusDecisionRecord = z.infer<typeof ArchibusDecisionRecordSchema>;

export function mapDecisionToArchibus(decision: {
  id: string;
  simulationId: string;
  scenarioId: string;
  status: string;
  createdBy: string;
  rationale: string;
  annualCostSavingsUsd: number;
  employeesAffected: number;
}, scenario: {
  type: string;
  annualEnergySavingsKwh: number;
  annualCo2ReductionTonnes: number;
  affectedZones: string[];
}, buildingId: string, floorId: string, idempotencyKey: string): ArchibusDecisionRecord {
  return ArchibusDecisionRecordSchema.parse({
    activity_log_id: decision.id,
    bl_id: buildingId,
    fl_id: floorId,
    date_required: new Date().toISOString().split('T')[0],
    status: decision.status,
    description: decision.rationale,
    cost_savings_annual: decision.annualCostSavingsUsd,
    energy_savings_kwh: scenario.annualEnergySavingsKwh,
    co2_reduction_tonnes: scenario.annualCo2ReductionTonnes,
    employees_affected: decision.employeesAffected,
    approval_status: decision.status,
    approved_by: decision.createdBy,
    simulation_id: decision.simulationId,
    scenario_type: scenario.type,
    idempotency_key: idempotencyKey,
    created_by_system: 'workspace-optimizer',
  });
}
