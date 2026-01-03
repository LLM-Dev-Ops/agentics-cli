# SPARC Pseudocode Specification: agentics-cli

```
DOCUMENT: SPARC_PSEUDOCODE
VERSION: 1.0.0
DATE: 2026-01-03
STATUS: Draft
CLASSIFICATION: Technical Specification
METHODOLOGY: SPARC (Specification, Pseudocode, Architecture, Refinement, Completion)
```

---

## 1. Executive Summary

This document defines the algorithmic pseudocode for the `agentics-cli` coordination layer. The CLI operates as a **pure orchestration interface** with no logic ownership - all business logic resides in downstream repositories. Every command follows deterministic flow patterns with fail-fast semantics.

---

## 2. Command Flow Overview

### 2.1 High-Level Orchestration Sequence

```
SEQUENCE DIAGRAM: CLI Command Lifecycle

    User                CLI                  External Repos           Audit
      |                  |                        |                     |
      |--[command]------>|                        |                     |
      |                  |--[validate_input]----->|                     |
      |                  |<--[validation_ok]------|                     |
      |                  |--[invoke_service]----->|                     |
      |                  |<--[result_ref]---------|                     |
      |                  |--[log_audit]-------------------------------->|
      |<--[reference]----|                        |                     |
      |                  |                        |                     |

INVARIANTS:
    - CLI holds NO state between commands
    - All operations return REFERENCES, not data
    - Every command produces EXACTLY ONE audit entry
    - Failures propagate immediately (fail-fast)
```

### 2.2 Repository Dependency Map

```
DEPENDENCIES:

    agentics-cli (this layer)
        |
        +---> agentics-org-manifests        [manifest selection]
        +---> agentics-simulation-planner   [plan creation]
        +---> agentics-simulation-runner    [simulation execution]
        +---> agentics-deployment-intent    [intent resolution]
        +---> agentics-deployment-exporters [artifact generation]
        +---> diligence-artifacts           [compliance packaging]

CONTRACTS:
    - Each dependency exposes a typed contract interface
    - CLI validates inputs BEFORE invoking dependencies
    - Dependencies return Result<Reference, Error> types
```

---

## 3. Core Command Pseudocode

### 3.1 Command: `agentics plan`

**Purpose**: Select manifest and create simulation plan via external services.

```
ALGORITHM: PlanCommand
INPUT: config (PlanConfiguration)
OUTPUT: Result<PlanReference, CommandError>

TYPE PlanConfiguration:
    criteria: ManifestCriteria
    params: PlanParameters
    options: CommandOptions

TYPE PlanReference:
    id: UUID
    repository: String = "agentics-simulation-planner"
    created_at: Timestamp
    checksum: SHA256

BEGIN
    // ============================================
    // PHASE 1: Input Validation
    // ============================================

    validation_result <- VALIDATE_SCHEMA(config, PlanConfigurationSchema)

    IF validation_result.is_error THEN
        RETURN Error(
            code: "VALIDATION_FAILED",
            message: validation_result.error_message,
            context: { field: validation_result.failed_field }
        )
    END IF

    // ============================================
    // PHASE 2: Manifest Selection (External Call)
    // ============================================

    manifest_request <- BuildManifestRequest(config.criteria)

    manifest_result <- INVOKE_WITH_TIMEOUT(
        service: "agentics-org-manifests",
        operation: "select",
        payload: manifest_request,
        timeout: config.options.timeout OR DEFAULT_TIMEOUT
    )

    IF manifest_result.is_error THEN
        FAIL_FAST(
            command: "plan",
            phase: "manifest_selection",
            upstream_error: manifest_result.error,
            inputs: config
        )
    END IF

    manifest_ref <- manifest_result.value

    // ============================================
    // PHASE 3: Plan Creation (External Call)
    // ============================================

    plan_request <- BuildPlanRequest(manifest_ref, config.params)

    plan_result <- INVOKE_WITH_TIMEOUT(
        service: "agentics-simulation-planner",
        operation: "create",
        payload: plan_request,
        timeout: config.options.timeout OR DEFAULT_TIMEOUT
    )

    IF plan_result.is_error THEN
        FAIL_FAST(
            command: "plan",
            phase: "plan_creation",
            upstream_error: plan_result.error,
            inputs: config,
            partial_refs: [manifest_ref]
        )
    END IF

    plan_ref <- plan_result.value

    // ============================================
    // PHASE 4: Audit Logging
    // ============================================

    audit_entry <- CREATE_AUDIT_ENTRY(
        command: "plan",
        inputs: REDACT_SENSITIVE(config),
        outputs: plan_ref,
        dependencies_invoked: ["agentics-org-manifests", "agentics-simulation-planner"],
        timestamp: NOW(),
        duration: ELAPSED_TIME()
    )

    LOG_AUDIT(audit_entry)  // Fire-and-forget, non-blocking

    // ============================================
    // PHASE 5: Return Reference
    // ============================================

    RETURN Ok(plan_ref)
END

COMPLEXITY:
    Time: O(1) local + O(external_service_latency)
    Space: O(1) - stateless, reference-only
```

### 3.2 Command: `agentics simulate`

**Purpose**: Execute simulation against a created plan.

```
ALGORITHM: SimulateCommand
INPUT: plan_ref (PlanReference), sim_config (SimulationConfiguration)
OUTPUT: Result<SimulationReference, CommandError>

TYPE SimulationConfiguration:
    mode: SimulationMode           // "fast" | "comprehensive" | "stress"
    iterations: PositiveInteger
    seed: Optional<Integer>
    constraints: SimulationConstraints
    options: CommandOptions

TYPE SimulationReference:
    id: UUID
    plan_ref: PlanReference        // Link to source plan
    repository: String = "agentics-simulation-runner"
    created_at: Timestamp
    checksum: SHA256

BEGIN
    // ============================================
    // PHASE 1: Reference Validation
    // ============================================

    ref_validation <- VALIDATE_REFERENCE_EXISTS(
        ref: plan_ref,
        expected_type: "PlanReference",
        repository: "agentics-simulation-planner"
    )

    IF ref_validation.is_error THEN
        RETURN Error(
            code: "INVALID_REFERENCE",
            message: "Plan reference does not exist or is inaccessible",
            context: { plan_ref: plan_ref.id }
        )
    END IF

    // ============================================
    // PHASE 2: Configuration Validation
    // ============================================

    config_validation <- VALIDATE_SCHEMA(sim_config, SimulationConfigurationSchema)

    IF config_validation.is_error THEN
        RETURN Error(
            code: "VALIDATION_FAILED",
            message: config_validation.error_message,
            context: { field: config_validation.failed_field }
        )
    END IF

    // ============================================
    // PHASE 3: Simulation Execution (External Call)
    // ============================================

    sim_request <- BuildSimulationRequest(plan_ref, sim_config)

    sim_result <- INVOKE_WITH_TIMEOUT(
        service: "agentics-simulation-runner",
        operation: "execute",
        payload: sim_request,
        timeout: sim_config.options.timeout OR EXTENDED_TIMEOUT
    )

    IF sim_result.is_error THEN
        FAIL_FAST(
            command: "simulate",
            phase: "simulation_execution",
            upstream_error: sim_result.error,
            inputs: { plan_ref: plan_ref, config: sim_config }
        )
    END IF

    sim_ref <- sim_result.value

    // ============================================
    // PHASE 4: Audit Logging
    // ============================================

    audit_entry <- CREATE_AUDIT_ENTRY(
        command: "simulate",
        inputs: { plan_ref: plan_ref.id, config: REDACT_SENSITIVE(sim_config) },
        outputs: sim_ref,
        dependencies_invoked: ["agentics-simulation-runner"],
        timestamp: NOW(),
        duration: ELAPSED_TIME()
    )

    LOG_AUDIT(audit_entry)

    // ============================================
    // PHASE 5: Return Reference
    // ============================================

    RETURN Ok(sim_ref)
END

COMPLEXITY:
    Time: O(1) local + O(simulation_execution_time)
    Space: O(1) - stateless
```

### 3.3 Command: `agentics deploy`

**Purpose**: Resolve deployment intent from simulation results.

```
ALGORITHM: DeployCommand
INPUT: sim_ref (SimulationReference), intent_spec (IntentSpecification)
OUTPUT: Result<IntentReference, CommandError>

TYPE IntentSpecification:
    target_environment: EnvironmentDescriptor
    constraints: DeploymentConstraints
    approvals: ApprovalRequirements
    rollback_policy: RollbackPolicy
    options: CommandOptions

TYPE IntentReference:
    id: UUID
    sim_ref: SimulationReference   // Link to source simulation
    repository: String = "agentics-deployment-intent"
    created_at: Timestamp
    checksum: SHA256
    status: IntentStatus           // "pending" | "approved" | "rejected"

BEGIN
    // ============================================
    // PHASE 1: Reference Validation
    // ============================================

    ref_validation <- VALIDATE_REFERENCE_EXISTS(
        ref: sim_ref,
        expected_type: "SimulationReference",
        repository: "agentics-simulation-runner"
    )

    IF ref_validation.is_error THEN
        RETURN Error(
            code: "INVALID_REFERENCE",
            message: "Simulation reference does not exist or is inaccessible",
            context: { sim_ref: sim_ref.id }
        )
    END IF

    // ============================================
    // PHASE 2: Intent Specification Validation
    // ============================================

    spec_validation <- VALIDATE_SCHEMA(intent_spec, IntentSpecificationSchema)

    IF spec_validation.is_error THEN
        RETURN Error(
            code: "VALIDATION_FAILED",
            message: spec_validation.error_message,
            context: { field: spec_validation.failed_field }
        )
    END IF

    // ============================================
    // PHASE 3: Intent Resolution (External Call)
    // ============================================

    intent_request <- BuildIntentRequest(sim_ref, intent_spec)

    intent_result <- INVOKE_WITH_TIMEOUT(
        service: "agentics-deployment-intent",
        operation: "resolve",
        payload: intent_request,
        timeout: intent_spec.options.timeout OR DEFAULT_TIMEOUT
    )

    IF intent_result.is_error THEN
        FAIL_FAST(
            command: "deploy",
            phase: "intent_resolution",
            upstream_error: intent_result.error,
            inputs: { sim_ref: sim_ref, spec: intent_spec }
        )
    END IF

    intent_ref <- intent_result.value

    // ============================================
    // PHASE 4: Audit Logging
    // ============================================

    audit_entry <- CREATE_AUDIT_ENTRY(
        command: "deploy",
        inputs: { sim_ref: sim_ref.id, spec: REDACT_SENSITIVE(intent_spec) },
        outputs: intent_ref,
        dependencies_invoked: ["agentics-deployment-intent"],
        timestamp: NOW(),
        duration: ELAPSED_TIME()
    )

    LOG_AUDIT(audit_entry)

    // ============================================
    // PHASE 5: Return Reference
    // ============================================

    RETURN Ok(intent_ref)
END

COMPLEXITY:
    Time: O(1) local + O(intent_resolution_time)
    Space: O(1) - stateless
```

### 3.4 Command: `agentics export`

**Purpose**: Generate deployment artifacts in specified format.

```
ALGORITHM: ExportCommand
INPUT: intent_ref (IntentReference), format_spec (ExportFormatSpecification)
OUTPUT: Result<ExportReference, CommandError>

TYPE ExportFormatSpecification:
    format: ExportFormat           // "terraform" | "kubernetes" | "cloudformation" | "pulumi"
    version: SemanticVersion
    options: FormatOptions
    output_config: OutputConfiguration

TYPE ExportReference:
    id: UUID
    intent_ref: IntentReference    // Link to source intent
    repository: String = "agentics-deployment-exporters"
    format: ExportFormat
    created_at: Timestamp
    checksum: SHA256
    artifact_location: URI

CONSTANT SUPPORTED_FORMATS:
    ["terraform", "kubernetes", "cloudformation", "pulumi", "ansible", "custom"]

BEGIN
    // ============================================
    // PHASE 1: Reference Validation
    // ============================================

    ref_validation <- VALIDATE_REFERENCE_EXISTS(
        ref: intent_ref,
        expected_type: "IntentReference",
        repository: "agentics-deployment-intent"
    )

    IF ref_validation.is_error THEN
        RETURN Error(
            code: "INVALID_REFERENCE",
            message: "Intent reference does not exist or is inaccessible",
            context: { intent_ref: intent_ref.id }
        )
    END IF

    // ============================================
    // PHASE 2: Format Validation
    // ============================================

    IF format_spec.format NOT IN SUPPORTED_FORMATS THEN
        RETURN Error(
            code: "UNSUPPORTED_FORMAT",
            message: "Export format not supported",
            context: {
                requested: format_spec.format,
                supported: SUPPORTED_FORMATS
            }
        )
    END IF

    spec_validation <- VALIDATE_SCHEMA(format_spec, ExportFormatSpecificationSchema)

    IF spec_validation.is_error THEN
        RETURN Error(
            code: "VALIDATION_FAILED",
            message: spec_validation.error_message,
            context: { field: spec_validation.failed_field }
        )
    END IF

    // ============================================
    // PHASE 3: Export Generation (External Call)
    // ============================================

    export_request <- BuildExportRequest(intent_ref, format_spec)

    export_result <- INVOKE_WITH_TIMEOUT(
        service: "agentics-deployment-exporters",
        operation: "generate",
        payload: export_request,
        timeout: format_spec.options.timeout OR EXTENDED_TIMEOUT
    )

    IF export_result.is_error THEN
        FAIL_FAST(
            command: "export",
            phase: "export_generation",
            upstream_error: export_result.error,
            inputs: { intent_ref: intent_ref, spec: format_spec }
        )
    END IF

    export_ref <- export_result.value

    // ============================================
    // PHASE 4: Audit Logging
    // ============================================

    audit_entry <- CREATE_AUDIT_ENTRY(
        command: "export",
        inputs: { intent_ref: intent_ref.id, format: format_spec.format },
        outputs: export_ref,
        dependencies_invoked: ["agentics-deployment-exporters"],
        timestamp: NOW(),
        duration: ELAPSED_TIME()
    )

    LOG_AUDIT(audit_entry)

    // ============================================
    // PHASE 5: Return Reference
    // ============================================

    RETURN Ok(export_ref)
END

COMPLEXITY:
    Time: O(1) local + O(artifact_generation_time)
    Space: O(1) - stateless
```

### 3.5 Command: `agentics diligence`

**Purpose**: Package compliance artifacts for audit and regulatory purposes.

```
ALGORITHM: DiligenceCommand
INPUT: refs (Reference[]), compliance_req (ComplianceRequirements)
OUTPUT: Result<DiligencePackageReference, CommandError>

TYPE ComplianceRequirements:
    frameworks: ComplianceFramework[]  // ["SOC2", "HIPAA", "GDPR", "PCI-DSS"]
    evidence_level: EvidenceLevel      // "minimal" | "standard" | "comprehensive"
    attestation_required: Boolean
    retention_policy: RetentionPolicy
    options: CommandOptions

TYPE DiligencePackageReference:
    id: UUID
    source_refs: Reference[]       // All input references
    repository: String = "diligence-artifacts"
    frameworks: ComplianceFramework[]
    created_at: Timestamp
    checksum: SHA256
    package_location: URI

BEGIN
    // ============================================
    // PHASE 1: Reference Validation (All References)
    // ============================================

    FOR EACH ref IN refs DO
        ref_validation <- VALIDATE_REFERENCE_EXISTS(
            ref: ref,
            expected_type: ref.type,
            repository: ref.repository
        )

        IF ref_validation.is_error THEN
            RETURN Error(
                code: "INVALID_REFERENCE",
                message: "One or more references do not exist or are inaccessible",
                context: { failed_ref: ref.id, index: INDEX_OF(ref) }
            )
        END IF
    END FOR

    // ============================================
    // PHASE 2: Compliance Requirements Validation
    // ============================================

    req_validation <- VALIDATE_SCHEMA(compliance_req, ComplianceRequirementsSchema)

    IF req_validation.is_error THEN
        RETURN Error(
            code: "VALIDATION_FAILED",
            message: req_validation.error_message,
            context: { field: req_validation.failed_field }
        )
    END IF

    // Validate framework compatibility
    FOR EACH framework IN compliance_req.frameworks DO
        IF NOT IS_SUPPORTED_FRAMEWORK(framework) THEN
            RETURN Error(
                code: "UNSUPPORTED_FRAMEWORK",
                message: "Compliance framework not supported",
                context: { framework: framework }
            )
        END IF
    END FOR

    // ============================================
    // PHASE 3: Diligence Package Creation (External Call)
    // ============================================

    diligence_request <- BuildDiligenceRequest(refs, compliance_req)

    diligence_result <- INVOKE_WITH_TIMEOUT(
        service: "diligence-artifacts",
        operation: "package",
        payload: diligence_request,
        timeout: compliance_req.options.timeout OR EXTENDED_TIMEOUT
    )

    IF diligence_result.is_error THEN
        FAIL_FAST(
            command: "diligence",
            phase: "package_creation",
            upstream_error: diligence_result.error,
            inputs: { refs: refs, requirements: compliance_req }
        )
    END IF

    diligence_pkg_ref <- diligence_result.value

    // ============================================
    // PHASE 4: Audit Logging
    // ============================================

    audit_entry <- CREATE_AUDIT_ENTRY(
        command: "diligence",
        inputs: {
            ref_ids: MAP(refs, r => r.id),
            frameworks: compliance_req.frameworks
        },
        outputs: diligence_pkg_ref,
        dependencies_invoked: ["diligence-artifacts"],
        timestamp: NOW(),
        duration: ELAPSED_TIME()
    )

    LOG_AUDIT(audit_entry)

    // ============================================
    // PHASE 5: Return Reference
    // ============================================

    RETURN Ok(diligence_pkg_ref)
END

COMPLEXITY:
    Time: O(n) for reference validation + O(package_creation_time)
           where n = number of input references
    Space: O(n) for reference collection
```

---

## 4. Error Handling Pseudocode

### 4.1 Error Type Hierarchy

```
TYPE HIERARCHY: CommandError

    CommandError (abstract)
        |
        +-- ValidationError
        |       +-- SchemaValidationError
        |       +-- ReferenceValidationError
        |       +-- FormatValidationError
        |
        +-- ServiceError
        |       +-- ServiceUnavailableError
        |       +-- ServiceTimeoutError
        |       +-- ContractViolationError
        |
        +-- AuditError
                +-- AuditLogFailureError (non-fatal, logged but not propagated)

TYPE CommandError:
    code: ErrorCode
    message: String
    context: Map<String, Any>
    timestamp: Timestamp
    trace_id: UUID
    recoverable: Boolean
```

### 4.2 Contract Violation Handling

```
ALGORITHM: HandleContractViolation
INPUT: violation (ContractViolation)
OUTPUT: CommandError

TYPE ContractViolation:
    service: ServiceIdentifier
    expected_contract: ContractVersion
    actual_response: RawResponse
    violation_type: ViolationType  // "schema_mismatch" | "missing_field" | "type_error"

BEGIN
    // Contract violations are ALWAYS fatal - no recovery

    error <- CommandError(
        code: "CONTRACT_VIOLATION",
        message: FORMAT(
            "Service '{}' returned response violating contract v{}",
            violation.service,
            violation.expected_contract
        ),
        context: {
            service: violation.service,
            expected: violation.expected_contract,
            violation_type: violation.violation_type,
            response_hash: HASH(violation.actual_response)
        },
        timestamp: NOW(),
        trace_id: CURRENT_TRACE_ID(),
        recoverable: FALSE
    )

    // Log violation for monitoring/alerting
    LOG_ERROR(
        level: "CRITICAL",
        category: "CONTRACT_VIOLATION",
        error: error
    )

    RETURN error
END
```

### 4.3 Service Failure Handling

```
ALGORITHM: HandleServiceFailure
INPUT: service (ServiceIdentifier), failure (ServiceFailure), context (InvocationContext)
OUTPUT: CommandError

TYPE ServiceFailure:
    type: FailureType              // "unavailable" | "timeout" | "internal_error"
    status_code: Optional<Integer>
    message: Optional<String>
    retry_after: Optional<Duration>

BEGIN
    MATCH failure.type:
        CASE "unavailable":
            error <- CommandError(
                code: "SERVICE_UNAVAILABLE",
                message: FORMAT("Service '{}' is currently unavailable", service),
                context: {
                    service: service,
                    status_code: failure.status_code,
                    retry_after: failure.retry_after
                },
                timestamp: NOW(),
                trace_id: CURRENT_TRACE_ID(),
                recoverable: TRUE  // May succeed on retry
            )

        CASE "timeout":
            error <- CommandError(
                code: "SERVICE_TIMEOUT",
                message: FORMAT(
                    "Service '{}' did not respond within {} ms",
                    service,
                    context.timeout
                ),
                context: {
                    service: service,
                    timeout_ms: context.timeout,
                    operation: context.operation
                },
                timestamp: NOW(),
                trace_id: CURRENT_TRACE_ID(),
                recoverable: TRUE  // May succeed with longer timeout
            )

        CASE "internal_error":
            error <- CommandError(
                code: "SERVICE_INTERNAL_ERROR",
                message: FORMAT("Service '{}' encountered an internal error", service),
                context: {
                    service: service,
                    upstream_message: failure.message
                },
                timestamp: NOW(),
                trace_id: CURRENT_TRACE_ID(),
                recoverable: FALSE  // Upstream issue, cannot retry
            )
    END MATCH

    RETURN error
END
```

### 4.4 Fail-Fast Implementation

```
ALGORITHM: FailFast
INPUT: command (CommandName), phase (PhaseName), upstream_error (Error),
       inputs (Any), partial_refs (Optional<Reference[]>)
OUTPUT: NEVER (always throws/exits)

BEGIN
    // Build comprehensive error context
    error_context <- {
        command: command,
        phase: phase,
        inputs_hash: HASH(REDACT_SENSITIVE(inputs)),
        upstream_error_code: upstream_error.code,
        upstream_error_message: upstream_error.message,
        partial_refs: MAP(partial_refs OR [], r => r.id),
        timestamp: NOW(),
        trace_id: CURRENT_TRACE_ID()
    }

    // Log failure for observability
    LOG_ERROR(
        level: "ERROR",
        category: "COMMAND_FAILURE",
        context: error_context
    )

    // Create audit entry for failed command
    audit_entry <- CREATE_AUDIT_ENTRY(
        command: command,
        inputs: REDACT_SENSITIVE(inputs),
        outputs: NULL,
        error: upstream_error,
        status: "FAILED",
        failed_at_phase: phase,
        timestamp: NOW(),
        duration: ELAPSED_TIME()
    )

    LOG_AUDIT(audit_entry)

    // NO ROLLBACK - CLI is stateless
    // Partial references remain in upstream services (by design)

    // Propagate error to caller
    THROW CommandError(
        code: "COMMAND_FAILED",
        message: FORMAT(
            "Command '{}' failed at phase '{}': {}",
            command, phase, upstream_error.message
        ),
        context: error_context,
        timestamp: NOW(),
        trace_id: CURRENT_TRACE_ID(),
        recoverable: upstream_error.recoverable
    )
END

INVARIANTS:
    - FailFast NEVER returns normally
    - Audit entry is ALWAYS created before exit
    - No state modification after FailFast invocation
    - Partial results remain in upstream services (intentional)
```

---

## 5. Validation Pseudocode

### 5.1 Schema Validation

```
ALGORITHM: ValidateSchema
INPUT: data (Any), schema (JSONSchema)
OUTPUT: Result<Void, ValidationError>

BEGIN
    // Use JSON Schema Draft 2020-12 for validation
    validator <- JSONSchemaValidator(schema)

    validation_result <- validator.validate(data)

    IF validation_result.is_valid THEN
        RETURN Ok(Void)
    ELSE
        errors <- validation_result.errors
        first_error <- errors[0]

        RETURN Error(ValidationError(
            code: "SCHEMA_VALIDATION_FAILED",
            message: first_error.message,
            context: {
                path: first_error.json_path,
                expected: first_error.expected,
                actual: first_error.actual,
                error_count: LENGTH(errors)
            }
        ))
    END IF
END
```

### 5.2 Reference Validation

```
ALGORITHM: ValidateReferenceExists
INPUT: ref (Reference), expected_type (TypeName), repository (RepositoryName)
OUTPUT: Result<Void, ValidationError>

BEGIN
    // Validate reference structure
    IF ref IS NULL OR ref.id IS NULL THEN
        RETURN Error(ValidationError(
            code: "INVALID_REFERENCE_STRUCTURE",
            message: "Reference is null or malformed",
            context: { ref: ref }
        ))
    END IF

    // Validate reference type matches expected
    IF ref.type != expected_type THEN
        RETURN Error(ValidationError(
            code: "REFERENCE_TYPE_MISMATCH",
            message: FORMAT(
                "Expected reference type '{}', got '{}'",
                expected_type, ref.type
            ),
            context: {
                expected: expected_type,
                actual: ref.type
            }
        ))
    END IF

    // Check existence in upstream repository (lightweight HEAD request)
    existence_check <- INVOKE_WITH_TIMEOUT(
        service: repository,
        operation: "exists",
        payload: { ref_id: ref.id },
        timeout: EXISTENCE_CHECK_TIMEOUT  // Short timeout, ~1s
    )

    IF existence_check.is_error THEN
        RETURN Error(ValidationError(
            code: "REFERENCE_CHECK_FAILED",
            message: "Unable to verify reference existence",
            context: {
                ref_id: ref.id,
                repository: repository,
                error: existence_check.error.message
            }
        ))
    END IF

    IF NOT existence_check.value.exists THEN
        RETURN Error(ValidationError(
            code: "REFERENCE_NOT_FOUND",
            message: FORMAT(
                "Reference '{}' does not exist in repository '{}'",
                ref.id, repository
            ),
            context: {
                ref_id: ref.id,
                repository: repository
            }
        ))
    END IF

    RETURN Ok(Void)
END
```

### 5.3 Contract Compliance Checking

```
ALGORITHM: CheckContractCompliance
INPUT: service (ServiceIdentifier), response (RawResponse)
OUTPUT: Result<ParsedResponse, ContractViolation>

BEGIN
    // Load expected contract for service
    contract <- CONTRACT_REGISTRY.get(service)

    IF contract IS NULL THEN
        RETURN Error(ContractViolation(
            service: service,
            expected_contract: "unknown",
            actual_response: response,
            violation_type: "missing_contract"
        ))
    END IF

    // Validate response against contract schema
    schema_validation <- ValidateSchema(response, contract.response_schema)

    IF schema_validation.is_error THEN
        RETURN Error(ContractViolation(
            service: service,
            expected_contract: contract.version,
            actual_response: response,
            violation_type: "schema_mismatch"
        ))
    END IF

    // Parse and type-check response
    TRY
        parsed <- PARSE_AS_TYPE(response, contract.response_type)
        RETURN Ok(parsed)
    CATCH TypeError as e
        RETURN Error(ContractViolation(
            service: service,
            expected_contract: contract.version,
            actual_response: response,
            violation_type: "type_error"
        ))
    END TRY
END
```

---

## 6. Audit Trail Pseudocode

### 6.1 Audit Entry Creation

```
ALGORITHM: CreateAuditEntry
INPUT: command (CommandName), inputs (Any), outputs (Optional<Reference>),
       dependencies_invoked (ServiceIdentifier[]), timestamp (Timestamp),
       duration (Duration), error (Optional<Error>), status (Optional<Status>)
OUTPUT: AuditEntry

TYPE AuditEntry:
    id: UUID
    version: String = "1.0"
    command: CommandName
    inputs_hash: SHA256
    inputs_redacted: Any           // Sensitive fields replaced with "[REDACTED]"
    outputs: Optional<Reference>
    dependencies: ServiceIdentifier[]
    timestamp: Timestamp
    duration_ms: Integer
    status: "SUCCESS" | "FAILED"
    error_code: Optional<ErrorCode>
    error_message: Optional<String>
    trace_id: UUID
    parent_id: Optional<UUID>      // For nested/chained commands
    checksum: SHA256               // Integrity check

BEGIN
    entry_id <- GENERATE_UUID_V7()  // Time-ordered UUID

    // Redact sensitive fields
    inputs_redacted <- REDACT_SENSITIVE(inputs)

    // Calculate inputs hash for verification
    inputs_hash <- SHA256(CANONICAL_JSON(inputs))

    // Determine status
    final_status <- status OR (IF error IS NULL THEN "SUCCESS" ELSE "FAILED")

    entry <- AuditEntry(
        id: entry_id,
        version: "1.0",
        command: command,
        inputs_hash: inputs_hash,
        inputs_redacted: inputs_redacted,
        outputs: outputs,
        dependencies: dependencies_invoked,
        timestamp: timestamp,
        duration_ms: duration.to_milliseconds(),
        status: final_status,
        error_code: error?.code,
        error_message: error?.message,
        trace_id: CURRENT_TRACE_ID(),
        parent_id: CURRENT_PARENT_ID()
    )

    // Calculate integrity checksum (excluding checksum field itself)
    entry.checksum <- SHA256(CANONICAL_JSON(entry))

    RETURN entry
END
```

### 6.2 Audit Chain Integrity

```
ALGORITHM: VerifyAuditChainIntegrity
INPUT: entries (AuditEntry[])
OUTPUT: Result<Void, IntegrityViolation>

TYPE IntegrityViolation:
    entry_id: UUID
    violation_type: String
    expected: String
    actual: String

BEGIN
    FOR i FROM 0 TO LENGTH(entries) - 1 DO
        entry <- entries[i]

        // Verify individual entry checksum
        computed_checksum <- SHA256(CANONICAL_JSON(EXCLUDE_FIELD(entry, "checksum")))

        IF computed_checksum != entry.checksum THEN
            RETURN Error(IntegrityViolation(
                entry_id: entry.id,
                violation_type: "checksum_mismatch",
                expected: entry.checksum,
                actual: computed_checksum
            ))
        END IF

        // Verify temporal ordering (UUID v7 embeds timestamp)
        IF i > 0 THEN
            prev_entry <- entries[i - 1]

            IF EXTRACT_TIMESTAMP(entry.id) < EXTRACT_TIMESTAMP(prev_entry.id) THEN
                RETURN Error(IntegrityViolation(
                    entry_id: entry.id,
                    violation_type: "temporal_ordering_violation",
                    expected: FORMAT("timestamp > {}", prev_entry.timestamp),
                    actual: entry.timestamp
                ))
            END IF
        END IF
    END FOR

    RETURN Ok(Void)
END
```

### 6.3 Audit Export Format

```
ALGORITHM: ExportAuditTrail
INPUT: entries (AuditEntry[]), format (ExportFormat), options (ExportOptions)
OUTPUT: ExportedAuditTrail

TYPE ExportFormat:
    "json" | "json-lines" | "csv" | "parquet"

TYPE ExportedAuditTrail:
    format: ExportFormat
    entry_count: Integer
    time_range: TimeRange
    checksum: SHA256
    data: Bytes

BEGIN
    // Verify chain integrity before export
    integrity_check <- VerifyAuditChainIntegrity(entries)

    IF integrity_check.is_error THEN
        THROW AuditExportError(
            message: "Cannot export audit trail with integrity violations",
            violation: integrity_check.error
        )
    END IF

    // Calculate time range
    time_range <- TimeRange(
        start: MIN(entries, e => e.timestamp),
        end: MAX(entries, e => e.timestamp)
    )

    // Serialize based on format
    MATCH format:
        CASE "json":
            data <- SERIALIZE_JSON(entries, pretty: options.pretty)

        CASE "json-lines":
            data <- SERIALIZE_JSONL(entries)

        CASE "csv":
            data <- SERIALIZE_CSV(entries, headers: AUDIT_ENTRY_HEADERS)

        CASE "parquet":
            data <- SERIALIZE_PARQUET(entries, schema: AUDIT_ENTRY_SCHEMA)
    END MATCH

    // Calculate export checksum
    export_checksum <- SHA256(data)

    RETURN ExportedAuditTrail(
        format: format,
        entry_count: LENGTH(entries),
        time_range: time_range,
        checksum: export_checksum,
        data: data
    )
END
```

---

## 7. Fail-Fast Semantics

### 7.1 Failure Condition Definitions

```
DEFINITIONS: FailureConditions

CONDITION: VALIDATION_FAILURE
    Trigger: Input does not conform to expected schema
    Action: Immediate return with ValidationError
    Rollback: None (no state created)
    Exit Code: 1

CONDITION: REFERENCE_NOT_FOUND
    Trigger: Referenced artifact does not exist in upstream repository
    Action: Immediate return with ReferenceError
    Rollback: None (no state created)
    Exit Code: 2

CONDITION: SERVICE_UNAVAILABLE
    Trigger: Upstream service returns 503 or connection refused
    Action: Immediate return with ServiceError
    Rollback: None (stateless)
    Exit Code: 3

CONDITION: SERVICE_TIMEOUT
    Trigger: Upstream service does not respond within timeout
    Action: Immediate return with TimeoutError
    Rollback: None (upstream may have partial state)
    Exit Code: 4

CONDITION: CONTRACT_VIOLATION
    Trigger: Upstream response does not match expected contract
    Action: Immediate return with ContractError
    Rollback: None (stateless)
    Exit Code: 5

CONDITION: UPSTREAM_ERROR
    Trigger: Upstream service returns error response
    Action: Immediate return with wrapped error
    Rollback: None (stateless)
    Exit Code: 6

CONDITION: INTERNAL_ERROR
    Trigger: Unexpected exception in CLI code
    Action: Log, create audit entry, return InternalError
    Rollback: None (stateless)
    Exit Code: 99
```

### 7.2 Error Propagation Rules

```
RULES: ErrorPropagation

RULE 1: Immediate Propagation
    All errors propagate immediately to the caller.
    No error aggregation or collection.
    First error encountered terminates command execution.

RULE 2: Error Wrapping
    Upstream errors are wrapped with local context.
    Original error is preserved in context.cause.

    EXAMPLE:
        upstream_error: { code: "PLAN_CREATION_FAILED", message: "..." }
        wrapped_error: {
            code: "COMMAND_FAILED",
            message: "Command 'plan' failed at phase 'plan_creation': ...",
            context: {
                command: "plan",
                phase: "plan_creation",
                cause: upstream_error
            }
        }

RULE 3: No Silent Failures
    Every failure produces:
        - Error output to stderr
        - Audit log entry
        - Non-zero exit code

    No command may complete successfully if any phase failed.

RULE 4: Timeout Propagation
    Timeouts in upstream services propagate as TimeoutError.
    CLI does not implement retry logic.
    Retry decisions are delegated to the caller.

RULE 5: Partial Completion Handling
    If command partially completes before failure:
        - Partial references are noted in audit entry
        - No cleanup of partial state (handled by upstream services)
        - Error message indicates partial completion
```

### 7.3 Rollback Behavior (None - Stateless)

```
ALGORITHM: NoRollbackBehavior

PRINCIPLE: Stateless Coordination

The agentics-cli maintains NO state and therefore requires NO rollback.

STATE OWNERSHIP:
    - Input data: Owned by caller (not modified by CLI)
    - References: Owned by upstream repositories
    - Audit entries: Append-only, never deleted
    - CLI memory: Ephemeral, released on command completion

PARTIAL COMPLETION SCENARIOS:

Scenario 1: plan command fails at manifest selection
    State created: None
    Rollback needed: None

Scenario 2: plan command fails at plan creation (after manifest selection)
    State created: Manifest reference exists in agentics-org-manifests
    Rollback needed: None (manifest is valid, can be reused)
    Cleanup responsibility: agentics-org-manifests (TTL-based)

Scenario 3: simulate command fails after plan validated
    State created: Plan reference exists
    Rollback needed: None (plan is valid, can be retried)
    Cleanup responsibility: agentics-simulation-planner (if applicable)

DESIGN RATIONALE:
    1. CLI is a thin coordination layer
    2. All state resides in repositories designed for consistency
    3. Upstream services implement their own cleanup/TTL policies
    4. Orphaned artifacts are acceptable (eventually cleaned up)
    5. Simplicity over completeness for error recovery
```

---

## 8. Utility Algorithms

### 8.1 Timeout Management

```
ALGORITHM: InvokeWithTimeout
INPUT: service (ServiceIdentifier), operation (OperationName),
       payload (Any), timeout (Duration)
OUTPUT: Result<Response, ServiceError>

BEGIN
    start_time <- NOW()

    // Create cancellation context
    ctx <- CreateTimeoutContext(timeout)

    TRY
        // Make service call with context
        response <- SERVICE_CLIENT.invoke(
            service: service,
            operation: operation,
            payload: payload,
            context: ctx
        )

        // Validate response against contract
        contract_check <- CheckContractCompliance(service, response)

        IF contract_check.is_error THEN
            RETURN Error(HandleContractViolation(contract_check.error))
        END IF

        RETURN Ok(contract_check.value)

    CATCH TimeoutException:
        RETURN Error(ServiceError(
            type: "timeout",
            service: service,
            operation: operation,
            elapsed: NOW() - start_time,
            timeout: timeout
        ))

    CATCH ConnectionException as e:
        RETURN Error(ServiceError(
            type: "unavailable",
            service: service,
            operation: operation,
            message: e.message
        ))

    CATCH Exception as e:
        RETURN Error(ServiceError(
            type: "internal_error",
            service: service,
            operation: operation,
            message: e.message
        ))
    END TRY
END
```

### 8.2 Sensitive Data Redaction

```
ALGORITHM: RedactSensitive
INPUT: data (Any)
OUTPUT: data (Any) with sensitive fields replaced

CONSTANT SENSITIVE_PATTERNS:
    [
        /password/i,
        /secret/i,
        /token/i,
        /api_key/i,
        /apikey/i,
        /credential/i,
        /private_key/i,
        /auth/i
    ]

CONSTANT REDACTION_MARKER: "[REDACTED]"

BEGIN
    IF data IS NULL THEN
        RETURN NULL
    END IF

    IF data IS Primitive THEN
        RETURN data
    END IF

    IF data IS Array THEN
        RETURN MAP(data, item => RedactSensitive(item))
    END IF

    IF data IS Object THEN
        result <- {}

        FOR EACH (key, value) IN data DO
            IF ANY(pattern IN SENSITIVE_PATTERNS WHERE pattern.test(key)) THEN
                result[key] <- REDACTION_MARKER
            ELSE
                result[key] <- RedactSensitive(value)
            END IF
        END FOR

        RETURN result
    END IF

    RETURN data
END
```

### 8.3 Canonical JSON Serialization

```
ALGORITHM: CanonicalJSON
INPUT: data (Any)
OUTPUT: canonical_json (String)

PURPOSE: Produce deterministic JSON for hashing/signing

BEGIN
    // Sort object keys alphabetically at all levels
    normalized <- NormalizeForCanonical(data)

    // Serialize with consistent formatting
    json <- JSON.stringify(
        normalized,
        replacer: NULL,
        indent: 0  // No whitespace
    )

    RETURN json
END

SUBROUTINE: NormalizeForCanonical
INPUT: data (Any)
OUTPUT: normalized (Any)

BEGIN
    IF data IS NULL OR data IS Primitive THEN
        RETURN data
    END IF

    IF data IS Array THEN
        RETURN MAP(data, item => NormalizeForCanonical(item))
    END IF

    IF data IS Object THEN
        result <- {}
        sorted_keys <- SORT(KEYS(data))

        FOR EACH key IN sorted_keys DO
            result[key] <- NormalizeForCanonical(data[key])
        END FOR

        RETURN result
    END IF

    RETURN data
END
```

---

## 9. Data Structures

### 9.1 Reference Types

```
DATA STRUCTURES: Reference Types

BaseReference:
    Type: Abstract Record
    Fields:
        id: UUID (v7, time-ordered)
        type: ReferenceType
        repository: RepositoryIdentifier
        created_at: Timestamp
        checksum: SHA256

PlanReference EXTENDS BaseReference:
    Additional Fields:
        manifest_ref: ManifestReference
    Type: "PlanReference"
    Repository: "agentics-simulation-planner"

SimulationReference EXTENDS BaseReference:
    Additional Fields:
        plan_ref: PlanReference
        iteration_count: PositiveInteger
    Type: "SimulationReference"
    Repository: "agentics-simulation-runner"

IntentReference EXTENDS BaseReference:
    Additional Fields:
        sim_ref: SimulationReference
        status: IntentStatus
    Type: "IntentReference"
    Repository: "agentics-deployment-intent"

ExportReference EXTENDS BaseReference:
    Additional Fields:
        intent_ref: IntentReference
        format: ExportFormat
        artifact_location: URI
    Type: "ExportReference"
    Repository: "agentics-deployment-exporters"

DiligencePackageReference EXTENDS BaseReference:
    Additional Fields:
        source_refs: Reference[]
        frameworks: ComplianceFramework[]
        package_location: URI
    Type: "DiligencePackageReference"
    Repository: "diligence-artifacts"
```

### 9.2 Error Types

```
DATA STRUCTURES: Error Types

CommandError:
    Type: Record
    Fields:
        code: ErrorCode
        message: String
        context: Map<String, Any>
        timestamp: Timestamp
        trace_id: UUID
        recoverable: Boolean

    Invariants:
        - code is non-empty
        - message is non-empty
        - timestamp <= NOW()

ValidationError EXTENDS CommandError:
    Additional Context:
        field: JSONPath
        expected: TypeDescriptor
        actual: TypeDescriptor

ServiceError EXTENDS CommandError:
    Additional Context:
        service: ServiceIdentifier
        operation: OperationName
        status_code: Optional<Integer>

ContractViolation EXTENDS CommandError:
    Additional Context:
        expected_contract: ContractVersion
        violation_type: ViolationType
```

---

## 10. Complexity Summary

```
COMPLEXITY ANALYSIS: All Commands

+---------------+-------------------+-------------------+
| Command       | Time Complexity   | Space Complexity  |
+---------------+-------------------+-------------------+
| plan          | O(1) + O(svc)     | O(1)              |
| simulate      | O(1) + O(svc)     | O(1)              |
| deploy        | O(1) + O(svc)     | O(1)              |
| export        | O(1) + O(svc)     | O(1)              |
| diligence     | O(n) + O(svc)     | O(n)              |
+---------------+-------------------+-------------------+

Where:
    n = number of input references
    O(svc) = upstream service latency (variable, not controlled by CLI)

NOTES:
    - All local operations are O(1) or O(n) where n is input size
    - Dominant factor is always upstream service latency
    - CLI maintains O(1) memory footprint (no caching, no state)
    - Audit logging is fire-and-forget, non-blocking
```

---

## Appendix A: JSON Schema Definitions

```
SCHEMAS: Input Validation

PlanConfigurationSchema:
    {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["criteria", "params"],
        "properties": {
            "criteria": { "$ref": "#/$defs/ManifestCriteria" },
            "params": { "$ref": "#/$defs/PlanParameters" },
            "options": { "$ref": "#/$defs/CommandOptions" }
        },
        "$defs": {
            "ManifestCriteria": { ... },
            "PlanParameters": { ... },
            "CommandOptions": {
                "type": "object",
                "properties": {
                    "timeout": { "type": "integer", "minimum": 1000 },
                    "trace_id": { "type": "string", "format": "uuid" }
                }
            }
        }
    }

SimulationConfigurationSchema: { ... }
IntentSpecificationSchema: { ... }
ExportFormatSpecificationSchema: { ... }
ComplianceRequirementsSchema: { ... }
```

---

## Appendix B: Glossary

```
GLOSSARY:

Term                    Definition
----                    ----------
Coordination Layer      Software that orchestrates calls between services without
                        owning business logic
Fail-Fast               Design pattern where errors are detected and propagated
                        immediately
Reference               Immutable pointer to an artifact in an upstream repository
Contract                Formal specification of expected input/output for a service
Audit Trail             Immutable log of all command invocations and outcomes
Redaction               Replacement of sensitive data with placeholder values
Canonical JSON          Deterministic JSON serialization for consistent hashing
UUID v7                 Time-ordered UUID format (RFC 4122 revision)
```

---

```
END OF DOCUMENT
CHECKSUM: [Generated at build time]
NEXT PHASE: Architecture (SPARC_ARCHITECTURE.md)
```
