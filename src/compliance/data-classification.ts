/**
 * Data classification module for healthcare supply chain compliance.
 * Classifies fields by sensitivity level and provides redaction utilities.
 */

export type SensitivityLevel = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PHI';

export const SENSITIVITY_ORDER: Record<SensitivityLevel, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  PHI: 3,
};

const fieldClassificationRegistry = new Map<string, SensitivityLevel>([
  ['facility_id', 'PUBLIC'],
  ['sku', 'PUBLIC'],
  ['unit_of_measure', 'PUBLIC'],
  ['status', 'PUBLIC'],
  ['priority', 'PUBLIC'],
  ['method', 'PUBLIC'],
  ['region', 'PUBLIC'],

  ['quantity', 'INTERNAL'],
  ['facility_name', 'INTERNAL'],
  ['vendor_id', 'INTERNAL'],
  ['horizon_days', 'INTERNAL'],
  ['lookback_days', 'INTERNAL'],
  ['confidence', 'INTERNAL'],
  ['forecasted_demand', 'INTERNAL'],
  ['average_daily_usage', 'INTERNAL'],
  ['days_of_supply', 'INTERNAL'],
  ['urgency_score', 'INTERNAL'],
  ['estimated_cost', 'INTERNAL'],
  ['max_transfer_quantity', 'INTERNAL'],

  ['lot_number', 'CONFIDENTIAL'],
  ['erp_reference', 'CONFIDENTIAL'],
  ['erp_po_number', 'CONFIDENTIAL'],
  ['notes', 'CONFIDENTIAL'],
  ['approval_threshold', 'CONFIDENTIAL'],
  ['auto_approve_threshold', 'CONFIDENTIAL'],
  ['baseUrl', 'CONFIDENTIAL'],
  ['serviceAccountEmail', 'CONFIDENTIAL'],

  ['patient_volume', 'PHI'],
  ['patient_id', 'PHI'],
  ['patient_name', 'PHI'],
  ['ssn', 'PHI'],
  ['date_of_birth', 'PHI'],
  ['medical_record_number', 'PHI'],
  ['insurance_id', 'PHI'],
  ['diagnosis_code', 'PHI'],
]);

export function classifyField(entityType: string, fieldName: string): SensitivityLevel {
  const qualified = `${entityType}.${fieldName}`;
  return (
    fieldClassificationRegistry.get(qualified) ??
    fieldClassificationRegistry.get(fieldName) ??
    'INTERNAL'
  );
}

export function redactRecord(
  entityType: string,
  record: Record<string, unknown>,
  maxLevel: SensitivityLevel,
): Record<string, unknown> {
  const threshold = SENSITIVITY_ORDER[maxLevel];
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const level = classifyField(entityType, key);
    result[key] = SENSITIVITY_ORDER[level] > threshold ? '[REDACTED]' : record[key];
  }
  return result;
}

export function stripPhiFields(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (fieldClassificationRegistry.get(key) !== 'PHI') {
      result[key] = record[key];
    }
  }
  return result;
}

export function redactForLogging(
  entityType: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  return redactRecord(entityType, record, 'INTERNAL');
}
