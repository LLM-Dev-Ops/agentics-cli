/**
 * Integration test: NetSuite ACL behavior without actual HTTP calls.
 *
 * Tests data classification, PHI stripping, redaction, governance guards,
 * and field classification directly against the compliance modules.
 */

import {
  stripPhiFields,
  redactRecord,
  classifyField,
} from '../../src/compliance/data-classification.js';
import type { SensitivityLevel } from '../../src/compliance/data-classification.js';

// ---------------------------------------------------------------------------
// Governance guard helper (inline, mirrors production pattern)
// ---------------------------------------------------------------------------

function assertWriteAllowed(governance: { read_only: boolean }): void {
  if (governance.read_only) {
    throw new Error('GOVERNANCE: Write operations blocked \u2014 read_only mode is active');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NetSuite ACL and data classification (integration)', () => {
  describe('stripPhiFields', () => {
    it('removes all PHI fields while keeping non-PHI fields', () => {
      const record: Record<string, unknown> = {
        facility_id: 'FAC-A',
        sku: 'SKU-001',
        quantity: 100,
        patient_id: 'PAT-12345',
        patient_name: 'Jane Doe',
        ssn: '123-45-6789',
        date_of_birth: '1985-03-15',
        medical_record_number: 'MRN-98765',
        insurance_id: 'INS-55555',
        diagnosis_code: 'J06.9',
      };

      const stripped = stripPhiFields(record);

      // PHI fields must be absent
      expect(stripped).not.toHaveProperty('patient_id');
      expect(stripped).not.toHaveProperty('patient_name');
      expect(stripped).not.toHaveProperty('ssn');
      expect(stripped).not.toHaveProperty('date_of_birth');
      expect(stripped).not.toHaveProperty('medical_record_number');
      expect(stripped).not.toHaveProperty('insurance_id');
      expect(stripped).not.toHaveProperty('diagnosis_code');

      // Non-PHI fields must remain
      expect(stripped).toHaveProperty('facility_id', 'FAC-A');
      expect(stripped).toHaveProperty('sku', 'SKU-001');
      expect(stripped).toHaveProperty('quantity', 100);
    });
  });

  describe('redactRecord', () => {
    it('replaces CONFIDENTIAL fields when maxLevel is INTERNAL', () => {
      const record: Record<string, unknown> = {
        facility_id: 'FAC-A',
        sku: 'SKU-001',
        quantity: 50,
        lot_number: 'LOT-2025-0312',
        erp_reference: 'ERP-REF-999',
      };

      const redacted = redactRecord('inventory', record, 'INTERNAL');

      // PUBLIC and INTERNAL fields preserved
      expect(redacted['facility_id']).toBe('FAC-A');
      expect(redacted['sku']).toBe('SKU-001');
      expect(redacted['quantity']).toBe(50);

      // CONFIDENTIAL fields redacted
      expect(redacted['lot_number']).toBe('[REDACTED]');
      expect(redacted['erp_reference']).toBe('[REDACTED]');
    });

    it('preserves PUBLIC and INTERNAL fields when maxLevel is INTERNAL', () => {
      const record: Record<string, unknown> = {
        facility_id: 'FAC-B',
        region: 'WEST',
        vendor_id: 'VEND-100',
        quantity: 200,
      };

      const redacted = redactRecord('inventory', record, 'INTERNAL');

      expect(redacted['facility_id']).toBe('FAC-B');
      expect(redacted['region']).toBe('WEST');
      expect(redacted['vendor_id']).toBe('VEND-100');
      expect(redacted['quantity']).toBe(200);
    });

    it('redacts PHI fields when maxLevel is CONFIDENTIAL', () => {
      const record: Record<string, unknown> = {
        facility_id: 'FAC-A',
        lot_number: 'LOT-001',
        patient_id: 'PAT-999',
        diagnosis_code: 'A01.0',
      };

      const redacted = redactRecord('inventory', record, 'CONFIDENTIAL');

      // PUBLIC, INTERNAL, CONFIDENTIAL preserved
      expect(redacted['facility_id']).toBe('FAC-A');
      expect(redacted['lot_number']).toBe('LOT-001');

      // PHI redacted
      expect(redacted['patient_id']).toBe('[REDACTED]');
      expect(redacted['diagnosis_code']).toBe('[REDACTED]');
    });
  });

  describe('governance guard', () => {
    it('allows write when read_only is false', () => {
      expect(() => assertWriteAllowed({ read_only: false })).not.toThrow();
    });

    it('blocks write when read_only is true', () => {
      expect(() => assertWriteAllowed({ read_only: true })).toThrow(
        'GOVERNANCE: Write operations blocked',
      );
    });
  });

  describe('PHI stripping from mock NetSuite payload', () => {
    it('strips PHI from a NetSuite-like payload before sending', () => {
      const netsuitePayload: Record<string, unknown> = {
        facility_id: 'NS-FAC-01',
        sku: 'NS-SKU-500',
        quantity: 75,
        unit_of_measure: 'CS',
        patient_name: 'John Smith',
        ssn: '999-88-7777',
        medical_record_number: 'MRN-001122',
        lot_number: 'LOT-NS-2025',
        vendor_id: 'NS-VEND-01',
      };

      const safe = stripPhiFields(netsuitePayload);

      // No PHI in the result
      expect(safe).not.toHaveProperty('patient_name');
      expect(safe).not.toHaveProperty('ssn');
      expect(safe).not.toHaveProperty('medical_record_number');

      // Business fields preserved
      expect(safe).toHaveProperty('facility_id', 'NS-FAC-01');
      expect(safe).toHaveProperty('sku', 'NS-SKU-500');
      expect(safe).toHaveProperty('quantity', 75);
      expect(safe).toHaveProperty('lot_number', 'LOT-NS-2025');
      expect(safe).toHaveProperty('vendor_id', 'NS-VEND-01');
    });
  });

  describe('classifyField', () => {
    it('returns correct levels for known fields', () => {
      expect(classifyField('inventory', 'facility_id')).toBe('PUBLIC' as SensitivityLevel);
      expect(classifyField('inventory', 'sku')).toBe('PUBLIC' as SensitivityLevel);
      expect(classifyField('inventory', 'quantity')).toBe('INTERNAL' as SensitivityLevel);
      expect(classifyField('inventory', 'lot_number')).toBe('CONFIDENTIAL' as SensitivityLevel);
      expect(classifyField('inventory', 'patient_id')).toBe('PHI' as SensitivityLevel);
      expect(classifyField('inventory', 'ssn')).toBe('PHI' as SensitivityLevel);
    });

    it('returns INTERNAL as default for unknown fields', () => {
      expect(classifyField('inventory', 'some_unknown_field_xyz')).toBe('INTERNAL' as SensitivityLevel);
    });
  });
});
