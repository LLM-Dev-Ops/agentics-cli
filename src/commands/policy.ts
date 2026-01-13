/**
 * Policy Command - Standalone CRUD Command for Policy Management
 *
 * ARCHITECTURE:
 * - This is a TERMINAL command with its own control flow
 * - Does NOT participate in orchestration pipelines
 * - Uses local file-based persistence in .agentics/policies/
 * - Has its own error handling and exit codes
 *
 * SUBCOMMANDS:
 * - list      List all policies
 * - inspect   Inspect a specific policy by ID
 * - create    Create a new policy
 * - edit      Edit an existing policy
 * - delete    Delete a policy
 * - enable    Enable a policy
 * - disable   Disable a policy
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandOptions } from '../types/index.js';
import { CLIError } from '../errors/index.js';

// ============================================================================
// Policy-Specific Exit Codes
// ============================================================================

export const POLICY_EXIT_CODES = {
  SUCCESS: 0,
  INPUT_ERROR: 100,
  NOT_FOUND: 100,  // Use ARG_VALIDATION_ERROR for not found
  ALREADY_EXISTS: 100,
  INVALID_STATE: 100,
  IO_ERROR: 74,
  UNEXPECTED_ERROR: 1,
} as const;

// ============================================================================
// Policy Types
// ============================================================================

export interface Policy {
  id: string;
  name: string;
  description: string;
  type: PolicyType;
  status: PolicyStatus;
  rules: PolicyRule[];
  created_at: string;
  updated_at: string;
  version: number;
  metadata?: Record<string, unknown>;
}

export type PolicyType =
  | 'access-control'
  | 'rate-limit'
  | 'cost-limit'
  | 'compliance'
  | 'security'
  | 'custom';

export type PolicyStatus = 'enabled' | 'disabled' | 'draft';

export interface PolicyRule {
  id: string;
  condition: string;
  action: 'allow' | 'deny' | 'warn' | 'log';
  priority: number;
}

// ============================================================================
// Command Input/Output Types
// ============================================================================

export interface PolicyListInput {
  status?: PolicyStatus;
  type?: PolicyType;
  limit?: number;
}

export interface PolicyListResult {
  policies: Policy[];
  count: number;
  timing: number;
}

export interface PolicyInspectInput {
  id: string;
}

export interface PolicyInspectResult {
  policy: Policy | null;
  found: boolean;
  timing: number;
}

export interface PolicyCreateInput {
  name: string;
  description?: string;
  type?: PolicyType;
  rules?: PolicyRule[];
  metadata?: Record<string, unknown>;
}

export interface PolicyCreateResult {
  policy: Policy;
  timing: number;
}

export interface PolicyEditInput {
  id: string;
  name?: string;
  description?: string;
  type?: PolicyType;
  rules?: PolicyRule[];
  metadata?: Record<string, unknown>;
}

export interface PolicyEditResult {
  policy: Policy;
  timing: number;
}

export interface PolicyDeleteInput {
  id: string;
}

export interface PolicyDeleteResult {
  deleted: boolean;
  id: string;
  timing: number;
}

export interface PolicyToggleInput {
  id: string;
}

export interface PolicyToggleResult {
  policy: Policy;
  previous_status: PolicyStatus;
  timing: number;
}

// ============================================================================
// Storage Configuration
// ============================================================================

function getPoliciesDir(): string {
  const baseDir = process.env['AGENTICS_DATA_DIR'] ?? process.cwd();
  return path.join(baseDir, '.agentics', 'policies');
}

function ensurePoliciesDir(): void {
  const dir = getPoliciesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function getPolicyPath(id: string): string {
  return path.join(getPoliciesDir(), `${id}.json`);
}

// ============================================================================
// Storage Operations
// ============================================================================

function loadPolicy(id: string): Policy | null {
  const filePath = getPolicyPath(id);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Policy;
  } catch {
    return null;
  }
}

function savePolicy(policy: Policy): void {
  ensurePoliciesDir();
  const filePath = getPolicyPath(policy.id);
  fs.writeFileSync(filePath, JSON.stringify(policy, null, 2), 'utf-8');
}

function deletePolicy(id: string): boolean {
  const filePath = getPolicyPath(id);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.unlinkSync(filePath);
  return true;
}

function listAllPolicies(): Policy[] {
  const dir = getPoliciesDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const policies: Policy[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      policies.push(JSON.parse(content) as Policy);
    } catch {
      // Skip invalid files
    }
  }
  return policies;
}

// ============================================================================
// ID Generation
// ============================================================================

function generatePolicyId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `pol-${timestamp}-${random}`;
}

function generateRuleId(): string {
  const random = Math.random().toString(36).substring(2, 10);
  return `rule-${random}`;
}

// ============================================================================
// Validation
// ============================================================================

function validatePolicyId(id: string, correlationId?: string): void {
  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new CLIError({
      code: 'ECLI-POLICY-001',
      category: 'INPUT_ERROR',
      message: 'Policy ID is required',
      details: { provided: id },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.INPUT_ERROR,
    });
  }
}

function validatePolicyName(name: string, correlationId?: string): void {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new CLIError({
      code: 'ECLI-POLICY-002',
      category: 'INPUT_ERROR',
      message: 'Policy name is required',
      details: { provided: name },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.INPUT_ERROR,
    });
  }
  if (name.length > 256) {
    throw new CLIError({
      code: 'ECLI-POLICY-003',
      category: 'INPUT_ERROR',
      message: 'Policy name cannot exceed 256 characters',
      details: { provided_length: name.length, max_length: 256 },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.INPUT_ERROR,
    });
  }
}

function validatePolicyType(type: string, correlationId?: string): void {
  const validTypes: PolicyType[] = [
    'access-control',
    'rate-limit',
    'cost-limit',
    'compliance',
    'security',
    'custom',
  ];
  if (!validTypes.includes(type as PolicyType)) {
    throw new CLIError({
      code: 'ECLI-POLICY-004',
      category: 'INPUT_ERROR',
      message: `Invalid policy type: ${type}`,
      details: { provided: type, valid_types: validTypes },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.INPUT_ERROR,
    });
  }
}

// ============================================================================
// Display Formatting
// ============================================================================

export function formatPolicyForDisplay(policy: Policy): string {
  const lines: string[] = [];
  const statusIcon = policy.status === 'enabled' ? '[ON]' : policy.status === 'disabled' ? '[OFF]' : '[DRAFT]';

  lines.push(`${statusIcon} ${policy.id}`);
  lines.push(`   Name:        ${policy.name}`);
  lines.push(`   Type:        ${policy.type}`);
  lines.push(`   Status:      ${policy.status}`);
  lines.push(`   Description: ${policy.description || '(none)'}`);
  lines.push(`   Rules:       ${policy.rules.length}`);
  lines.push(`   Version:     ${policy.version}`);
  lines.push(`   Created:     ${new Date(policy.created_at).toLocaleString()}`);
  lines.push(`   Updated:     ${new Date(policy.updated_at).toLocaleString()}`);

  return lines.join('\n');
}

export function formatPoliciesListForDisplay(policies: Policy[]): string {
  if (policies.length === 0) {
    return 'No policies found.';
  }

  const lines: string[] = [];
  lines.push(`Found ${policies.length} polic${policies.length === 1 ? 'y' : 'ies'}:`);
  lines.push('');

  for (const policy of policies) {
    const statusIcon = policy.status === 'enabled' ? '[ON]' : policy.status === 'disabled' ? '[OFF]' : '[DRAFT]';
    lines.push(`${statusIcon} ${policy.id} - ${policy.name} (${policy.type})`);
  }

  return lines.join('\n');
}

// ============================================================================
// Command Implementations
// ============================================================================

/**
 * List all policies with optional filtering
 */
export async function executePolicyListCommand(
  input: PolicyListInput,
  _options: CommandOptions
): Promise<PolicyListResult> {
  const startTime = Date.now();

  let policies = listAllPolicies();

  // Apply filters
  if (input.status) {
    policies = policies.filter(p => p.status === input.status);
  }
  if (input.type) {
    policies = policies.filter(p => p.type === input.type);
  }

  // Sort by updated_at descending
  policies.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  // Apply limit
  if (input.limit && input.limit > 0) {
    policies = policies.slice(0, input.limit);
  }

  return {
    policies,
    count: policies.length,
    timing: Date.now() - startTime,
  };
}

/**
 * Inspect a specific policy by ID
 */
export async function executePolicyInspectCommand(
  input: PolicyInspectInput,
  _options: CommandOptions
): Promise<PolicyInspectResult> {
  const startTime = Date.now();
  const correlationId = _options.trace_id ?? crypto.randomUUID();

  validatePolicyId(input.id, correlationId);

  const policy = loadPolicy(input.id);

  return {
    policy,
    found: policy !== null,
    timing: Date.now() - startTime,
  };
}

/**
 * Create a new policy
 */
export async function executePolicyCreateCommand(
  input: PolicyCreateInput,
  options: CommandOptions
): Promise<PolicyCreateResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePolicyName(input.name, correlationId);

  if (input.type) {
    validatePolicyType(input.type, correlationId);
  }

  const now = new Date().toISOString();
  const policy: Policy = {
    id: generatePolicyId(),
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    type: input.type ?? 'custom',
    status: 'draft',
    rules: (input.rules ?? []).map(r => ({
      ...r,
      id: r.id || generateRuleId(),
    })),
    created_at: now,
    updated_at: now,
    version: 1,
    metadata: input.metadata,
  };

  try {
    savePolicy(policy);
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-POLICY-IO-001',
      category: 'INTERNAL_ERROR',
      message: 'Failed to save policy',
      details: { error: error instanceof Error ? error.message : String(error) },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    policy,
    timing: Date.now() - startTime,
  };
}

/**
 * Edit an existing policy
 */
export async function executePolicyEditCommand(
  input: PolicyEditInput,
  options: CommandOptions
): Promise<PolicyEditResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePolicyId(input.id, correlationId);

  const existing = loadPolicy(input.id);
  if (!existing) {
    throw new CLIError({
      code: 'ECLI-POLICY-NOT-FOUND',
      category: 'INPUT_ERROR',
      message: `Policy not found: ${input.id}`,
      details: { id: input.id },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.NOT_FOUND,
    });
  }

  if (input.name) {
    validatePolicyName(input.name, correlationId);
  }
  if (input.type) {
    validatePolicyType(input.type, correlationId);
  }

  const updated: Policy = {
    ...existing,
    name: input.name?.trim() ?? existing.name,
    description: input.description?.trim() ?? existing.description,
    type: input.type ?? existing.type,
    rules: input.rules !== undefined
      ? input.rules.map(r => ({ ...r, id: r.id || generateRuleId() }))
      : existing.rules,
    metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
    updated_at: new Date().toISOString(),
    version: existing.version + 1,
  };

  try {
    savePolicy(updated);
  } catch (error) {
    throw new CLIError({
      code: 'ECLI-POLICY-IO-002',
      category: 'INTERNAL_ERROR',
      message: 'Failed to update policy',
      details: { error: error instanceof Error ? error.message : String(error) },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.IO_ERROR,
    });
  }

  return {
    policy: updated,
    timing: Date.now() - startTime,
  };
}

/**
 * Delete a policy
 */
export async function executePolicyDeleteCommand(
  input: PolicyDeleteInput,
  options: CommandOptions
): Promise<PolicyDeleteResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePolicyId(input.id, correlationId);

  const deleted = deletePolicy(input.id);

  if (!deleted) {
    throw new CLIError({
      code: 'ECLI-POLICY-NOT-FOUND',
      category: 'INPUT_ERROR',
      message: `Policy not found: ${input.id}`,
      details: { id: input.id },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.NOT_FOUND,
    });
  }

  return {
    deleted: true,
    id: input.id,
    timing: Date.now() - startTime,
  };
}

/**
 * Enable a policy
 */
export async function executePolicyEnableCommand(
  input: PolicyToggleInput,
  options: CommandOptions
): Promise<PolicyToggleResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePolicyId(input.id, correlationId);

  const existing = loadPolicy(input.id);
  if (!existing) {
    throw new CLIError({
      code: 'ECLI-POLICY-NOT-FOUND',
      category: 'INPUT_ERROR',
      message: `Policy not found: ${input.id}`,
      details: { id: input.id },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.NOT_FOUND,
    });
  }

  const previousStatus = existing.status;

  if (existing.status === 'enabled') {
    // Already enabled - return current state without error
    return {
      policy: existing,
      previous_status: previousStatus,
      timing: Date.now() - startTime,
    };
  }

  const updated: Policy = {
    ...existing,
    status: 'enabled',
    updated_at: new Date().toISOString(),
    version: existing.version + 1,
  };

  savePolicy(updated);

  return {
    policy: updated,
    previous_status: previousStatus,
    timing: Date.now() - startTime,
  };
}

/**
 * Disable a policy
 */
export async function executePolicyDisableCommand(
  input: PolicyToggleInput,
  options: CommandOptions
): Promise<PolicyToggleResult> {
  const startTime = Date.now();
  const correlationId = options.trace_id ?? crypto.randomUUID();

  validatePolicyId(input.id, correlationId);

  const existing = loadPolicy(input.id);
  if (!existing) {
    throw new CLIError({
      code: 'ECLI-POLICY-NOT-FOUND',
      category: 'INPUT_ERROR',
      message: `Policy not found: ${input.id}`,
      details: { id: input.id },
      module: 'policy',
      correlationId,
      recoverable: false,
      exitCode: POLICY_EXIT_CODES.NOT_FOUND,
    });
  }

  const previousStatus = existing.status;

  if (existing.status === 'disabled') {
    // Already disabled - return current state without error
    return {
      policy: existing,
      previous_status: previousStatus,
      timing: Date.now() - startTime,
    };
  }

  const updated: Policy = {
    ...existing,
    status: 'disabled',
    updated_at: new Date().toISOString(),
    version: existing.version + 1,
  };

  savePolicy(updated);

  return {
    policy: updated,
    previous_status: previousStatus,
    timing: Date.now() - startTime,
  };
}
