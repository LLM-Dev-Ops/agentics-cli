# Why Execution Is Gated

## The Problem

AI platforms that write to enterprise systems — ERP, ITSM, regulatory
filing, risk management — can cause irreversible damage if they operate
without verified connectors, audited data, and governance approval.

A single malformed write to an ERP general ledger can misstate financial
records. An automated FINRA filing with incorrect data triggers
regulatory examination. A risk register entry that bypasses the
enterprise risk committee creates audit exposure.

Most AI platforms treat these writes as features to enable as early as
possible. This platform treats them as operations that must be earned.

## Why Gating Is Intentional

The `INTEGRATION_READY_EXECUTION_GATED` state is not a bug, a
limitation, or an incomplete feature. It is a deliberate design
decision enforced at the CLI level through Gate 7 (Readiness Gate).

When execution mode is locked:

- `deploy run` exits with code 111 and a structured error explaining
  exactly which prerequisites are missing.
- `deploy rollback` is blocked because there is nothing safe to
  roll back to if execution never occurred.
- Every blocked command includes remediation guidance pointing to
  `agentics readiness show` and `agentics readiness explain`.

The gate reads its state from a machine-readable artifact
(`readiness-state.json`) that is derived deterministically from
audited simulation data. No human can override it by editing a flag
or setting an environment variable. The only path to
`EXECUTION_READY` is completing all 12 prerequisites.

## How This Protects Enterprises

### Financial Controls

The platform maps AI operational costs to a 2-level cost center
hierarchy with per-department budgets, cross-charge allocation rules,
and a usage sub-ledger for model-tier detail. None of these structures
are written to the ERP until every connector is built, tested, and
approved by the Change Advisory Board.

If the platform wrote partial data — cost centers without cross-charge
rules, or GL accounts without the usage sub-ledger — the enterprise
would have an internally inconsistent financial record that could not
be reconciled at quarter-end.

### Regulatory Compliance

Five regulatory frameworks are addressed: SOX 404, FINRA 3110, GDPR,
Basel III, and PCAOB. Each has specific filing requirements, data
formats, and reconciliation procedures. The ONESOURCE connector that
handles regulatory filing does not yet exist.

If the platform filed partial compliance data — supervisory reports
without agent supervision frameworks, or GDPR processing records
without data subject request tracking — the enterprise would be in a
worse compliance posture than before the platform existed.

### Operational Safety

The simulation identified 10 AI-specific risks, including a P0
platform defect (Ruvector persistence failure, risk score 20) that
affects lineage traceability. If the platform executed writes while
this defect is active, there would be no audit trail connecting
production data back to the simulation that generated it.

### Data Integrity

All financial figures in the platform have been through a formal
correction process (token-to-cost reconciliation with per-department
scale factors) and an independent audit (5/5 PASS, variance < 0.01%).
The gate ensures this corrected, audited data is what reaches the ERP
— not a preliminary or uncorrected version.

## How This Differs From Typical Platforms

### Typical AI Platform

1. Build connectors
2. Enable writes
3. Monitor for errors
4. Fix problems after they occur

The assumption is that production is the test environment. Errors are
expected and handled reactively.

### This Platform

1. Simulate operations for 30 days across 8 departments
2. Audit the simulation data for internal consistency
3. Correct any discrepancies with formal documentation
4. Map every entity to its target ERP system
5. Generate integration scaffolding with explicit TODO blocks
6. Lock execution until all prerequisites are verified
7. Provide executive-grade explanation of why execution is locked
8. Only unlock when connectors, infrastructure, and governance are ready

The assumption is that the first write to production must be correct.
Errors in financial systems, regulatory filings, and risk registers are
not routine — they are incidents with real consequences.

### Typical DevOps Pipeline

DevOps pipelines gate deployment on automated tests: unit tests pass,
integration tests pass, staging environment looks good, deploy to
production. The gate is technical: does the code work?

This platform's gate is operational: are the *systems and processes*
ready? A connector might compile and pass unit tests but still be
wrong if the ONESOURCE report template doesn't match what the
regulator expects. A credential vault might be provisioned but useless
if the network path to the ERP endpoint is blocked.

Gate 7 does not check if the code works. It checks if the enterprise
is ready.

## The Three States

| State | Meaning | Allowed |
|---|---|---|
| `INSPECTION_ONLY` | Simulation artifacts exist but no integration mapping | Read-only commands |
| `INTEGRATION_READY_EXECUTION_GATED` | Integration artifacts generated, execution blocked | Read + integration commands, no writes |
| `EXECUTION_READY` | All prerequisites met | All commands including production writes |

Each state transition is deterministic and documented. There is no
manual override.

## The Agentics Auth Gate and Model Backends (ADR-PIPELINE-112)

There are two distinct gates, and they operate at different layers:

1. **The Agentics platform auth gate** (`agentics login` / `AGENTICS_API_KEY`)
   is the *prerequisite to running the pipeline at all*. A fresh install of the
   CLI cannot reach any generation engine until it has authenticated to the
   Agentics platform. This is the gate you pass first.
2. **The Readiness Gate (Gate 7)** described above is the *prerequisite to
   writing to enterprise systems*. It is enforced after generation, on the
   artifacts the pipeline produced.

### Which model backends the pipeline uses

The pipeline's synthesis phases (SPARC, ADRs, DDD, TDD, implementation
prompts, Phase 7 deliverables) run **only** through the user's Claude Code /
Codex subscription. The backend is resolved once per run, in this order, and
the first available wins:

1. **ruflo** — the local swarm, bound to Claude Code / Codex and run with
   `--local-only` so it never opens an independent provider connection.
2. **`claude --print`** — the same Claude Code subscription session.
3. **Codex CLI** (`codex`) — for OpenAI Codex subscription users.
4. **Loud failure** — if none of the above is available the phase emits a
   visible failure artifact and a non-zero verdict. It does **not** fall back
   to embedded templates.

### Raw Anthropic API keys are NOT supported

A raw `ANTHROPIC_API_KEY` is **not** a supported configuration and is **not**
an alternative to `agentics login`. The pipeline does not read
`ANTHROPIC_API_KEY` from the environment for any synthesis path. This is
intentional:

- **Cost stays inside your subscription.** Direct API calls bill against a raw
  API account rather than your Claude Code / Claude Max or Codex subscription.
- **The model version follows your session.** There is no hardcoded model
  string that can drift out of date and fail silently.
- **There is no long-lived key to leak.** No raw provider key sits in the
  process environment, logs, or crash dumps.

If you previously relied on `ANTHROPIC_API_KEY` to drive generation, the
supported path now is: authenticate with `agentics login`, and ensure a
Claude Code (or Codex) CLI is installed and reachable on `PATH`. A CI
environment without a coding-agent session should not attempt LLM synthesis —
it will hit the loud-failure path by design.

## Verifying the Gate

```bash
# See the current readiness state
agentics readiness show

# Get an executive-level explanation
agentics readiness explain

# Attempt a blocked command (will fail with exit code 111)
agentics deploy run <any-id>
```

The gate is enforced at the CLI entry point, before any command
handler executes. It cannot be bypassed by flags, environment
variables, or configuration changes.
