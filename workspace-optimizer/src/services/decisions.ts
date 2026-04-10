import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AuditService } from './audit.js';
import type { Decision, DecisionStatus, Scenario } from '../types.js';
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js';

export class DecisionService {
  private decisions: Map<string, Decision> = new Map();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {}

  create(params: { scenario: Scenario; createdBy: string; rationale: string }): Decision {
    if (params.rationale.length < this.config.approval.minRationaleLength) {
      throw new ValidationError(
        `Rationale must be at least ${this.config.approval.minRationaleLength} characters`,
      );
    }

    const decision: Decision = {
      id: randomUUID(),
      simulationId: params.scenario.simulationId,
      scenarioId: params.scenario.id,
      status: 'draft',
      createdBy: params.createdBy,
      createdAt: new Date(),
      rationale: params.rationale,
      approvals: [],
      annualCostSavingsUsd: params.scenario.annualCostSavingsUsd,
      employeesAffected: params.scenario.employeesAffected,
    };

    this.decisions.set(decision.id, decision);

    this.audit.append({
      action: 'decision_created',
      actor: params.createdBy,
      entityType: 'decision',
      entityId: decision.id,
      details: {
        scenarioId: params.scenario.id,
        scenarioType: params.scenario.type,
        annualCostSavingsUsd: decision.annualCostSavingsUsd,
        employeesAffected: decision.employeesAffected,
      },
    });

    this.logger.info('decision.created', { decisionId: decision.id, scenarioId: params.scenario.id });
    return decision;
  }

  submit(decisionId: string, submittedBy: string): Decision {
    const decision = this.getOrThrow(decisionId);

    if (decision.status !== 'draft') {
      throw new ValidationError(`Decision ${decisionId} is not in draft status`);
    }

    decision.status = 'pending_review';

    this.audit.append({
      action: 'decision_submitted',
      actor: submittedBy,
      entityType: 'decision',
      entityId: decisionId,
      details: { previousStatus: 'draft', newStatus: 'pending_review' },
    });

    this.logger.info('decision.submitted', { decisionId });
    return decision;
  }

  approve(params: {
    decisionId: string;
    approver: string;
    role: 'facility_manager' | 'vp_operations' | 'cfo' | 'admin';
    rationale: string;
  }): Decision {
    const decision = this.getOrThrow(params.decisionId);

    if (params.rationale.length < this.config.approval.minRationaleLength) {
      throw new ValidationError(
        `Approval rationale must be at least ${this.config.approval.minRationaleLength} characters`,
      );
    }

    // Separation of duties
    if (params.approver === decision.createdBy) {
      throw new AuthorizationError('Creator cannot approve their own decision');
    }

    const requiredLevel = this.determineApprovalLevel(decision);
    const roleLevel = this.roleToLevel(params.role);

    if (roleLevel < requiredLevel) {
      throw new AuthorizationError(
        `Decision requires approval level ${requiredLevel}, role ${params.role} provides level ${roleLevel}`,
      );
    }

    decision.approvals.push({
      role: params.role,
      approver: params.approver,
      approvedAt: new Date(),
      rationale: params.rationale,
    });

    const newStatus = this.statusForRole(params.role);
    decision.status = newStatus;

    this.audit.append({
      action: 'approval_granted',
      actor: params.approver,
      entityType: 'decision',
      entityId: params.decisionId,
      details: {
        role: params.role,
        newStatus,
        annualCostSavingsUsd: decision.annualCostSavingsUsd,
        employeesAffected: decision.employeesAffected,
      },
    });

    this.logger.info('decision.approved', {
      decisionId: params.decisionId,
      role: params.role,
      newStatus,
    });

    return decision;
  }

  get(decisionId: string): Decision | undefined {
    return this.decisions.get(decisionId);
  }

  reset(): void {
    this.decisions.clear();
  }

  private getOrThrow(decisionId: string): Decision {
    const decision = this.decisions.get(decisionId);
    if (!decision) throw new NotFoundError(`Decision ${decisionId} not found`);
    return decision;
  }

  private determineApprovalLevel(decision: Decision): number {
    const thresholds = this.config.approval;
    if (
      decision.employeesAffected > thresholds.cfoEmployeeThreshold ||
      decision.annualCostSavingsUsd > thresholds.cfoCostThreshold
    ) {
      return 3; // CFO
    }
    if (
      decision.employeesAffected > thresholds.vpEmployeeThreshold ||
      decision.annualCostSavingsUsd > thresholds.vpCostThreshold
    ) {
      return 2; // VP
    }
    return 1; // FM
  }

  private roleToLevel(role: string): number {
    switch (role) {
      case 'admin':
      case 'cfo':
        return 3;
      case 'vp_operations':
        return 2;
      case 'facility_manager':
        return 1;
      default:
        return 0;
    }
  }

  private statusForRole(role: string): DecisionStatus {
    switch (role) {
      case 'cfo':
      case 'admin':
        return 'approved_cfo';
      case 'vp_operations':
        return 'approved_vp';
      case 'facility_manager':
        return 'approved_fm';
      default:
        return 'pending_review';
    }
  }
}
