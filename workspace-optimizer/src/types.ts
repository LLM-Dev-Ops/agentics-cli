import { z } from 'zod';

// === Spatial Hierarchy ===

export const RegionSchema = z.enum(['north_america', 'europe', 'asia']);
export type Region = z.infer<typeof RegionSchema>;

export const SpaceTypeSchema = z.enum(['open_office', 'private_office', 'meeting_room', 'common_area', 'flexible']);
export type SpaceType = z.infer<typeof SpaceTypeSchema>;

export interface Building {
  id: string;
  name: string;
  region: Region;
  address: string;
  totalSqFt: number;
  floors: number;
  annualEnergyCostUsd: number;
  annualMaintenanceCostUsd: number;
  employeeCapacity: number;
}

export interface Floor {
  id: string;
  buildingId: string;
  level: number;
  sqFt: number;
  zones: string[];
}

export interface Zone {
  id: string;
  floorId: string;
  buildingId: string;
  name: string;
  spaceType: SpaceType;
  capacity: number;
  sqFt: number;
  hasHvacZoning: boolean;
  energyCostPerSqFtYear: number;
}

// === Occupancy ===

export interface OccupancyReading {
  zoneId: string;
  timestamp: Date;
  headcount: number;
  capacity: number;
}

// === Scoring ===

export type UtilizationCategory = 'severely_underutilized' | 'underutilized' | 'moderately_used' | 'well_used' | 'over_capacity';

export interface ZoneScore {
  zoneId: string;
  zoneName: string;
  buildingId: string;
  spaceType: SpaceType;
  capacity: number;
  sqFt: number;
  avgOccupancyRate: number;
  peakOccupancyRate: number;
  peakVariance: number;
  flexibilityScore: number;
  efficiencyIndex: number;
  category: UtilizationCategory;
}

// === Scenarios ===

export type ScenarioType = 'consolidation' | 'schedule_optimization' | 'space_reduction';

/** Breakdown of savings by category — supports ADR-053 waterfall */
export interface SavingsBreakdown {
  energySavingsUsd: number;
  maintenanceSavingsUsd: number;
  hvacSavingsUsd: number;
  leaseSavingsUsd: number;
}

export interface Scenario {
  id: string;
  simulationId: string;
  type: ScenarioType;
  name: string;
  description: string;
  affectedZones: string[];
  projectedOccupancyRate: number;
  annualCostSavingsUsd: number;
  annualEnergySavingsKwh: number;
  annualCo2ReductionTonnes: number;
  employeesAffected: number;
  employeeExperienceImpact: 'positive' | 'neutral' | 'negative';
  implementationRisk: 'low' | 'medium' | 'high';
  /** ADR-053: component-level savings breakdown */
  savingsBreakdown: SavingsBreakdown;
}

// === Decisions ===

export type DecisionStatus = 'draft' | 'pending_review' | 'approved_fm' | 'approved_vp' | 'approved_cfo' | 'rejected';

export type ApproverRole = 'facility_manager' | 'vp_operations' | 'cfo' | 'admin';

export interface Decision {
  id: string;
  simulationId: string;
  scenarioId: string;
  status: DecisionStatus;
  createdBy: string;
  createdAt: Date;
  rationale: string;
  approvals: Approval[];
  annualCostSavingsUsd: number;
  employeesAffected: number;
}

export interface Approval {
  role: ApproverRole;
  approver: string;
  approvedAt: Date;
  rationale: string;
}

// === Audit ===

export interface AuditEntry {
  id: string;
  timestamp: Date;
  action: string;
  actor: string;
  entityType: string;
  entityId: string;
  details: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

// === ERP ===

export type ERPTransactionStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface ERPTransaction {
  id: string;
  decisionId: string;
  simulationId: string;
  idempotencyKey: string;
  status: ERPTransactionStatus;
  payload: Record<string, unknown>;
  createdAt: Date;
  attempts: number;
  lastAttemptAt?: Date;
  responseStatus?: number;
  /** ADR-058: schema version the payload was written against */
  schemaVersion: string;
}
