# ADR-PIPELINE-119: Ed25519 Witness-Signed Decision Pack

**Status:** Proposed
**Date:** 2026-07-06
**Authors:** Nick Ruest
**Priority:** MEDIUM — The pipeline hands a decision-maker a bundle (~85 consulting deliverables, ADRs/DDD, a generated prototype, an ERP-surface mapping, and — under ADR-118 — a fit/cost/safety scorecard and SBOM) on which a go/no-go decision and a live ERP push are based. That bundle is currently **unsigned**: there is no tamper-evident, verifiable attestation of *what content this trace actually produced*. MetaHarness ships an Ed25519 "witness" sign/verify capability (`harness sign` / `harness verify`, "Ed25519 witness-signed releases") in the same kernel the pipeline already depends on. This ADR signs the deliverable pack at the end of a run and emits a verifiable witness, so a consumer can prove the pack was produced by this trace and has not been altered.
**Builds on:** ADR-PIPELINE-117 (MetaHarness resolution + placement — this ADR realises the Phase 6/7 signing slot), ADR-PIPELINE-118 (quality/security gate — the scorecard and SBOM are included in the signed manifest), ADR-PIPELINE-105 (deliverable guarantee — the witness attests to the guaranteed pack), ADR-PIPELINE-116 (loud failure — signing failure is recorded, never silently dropped as "signed").

---

## Context

### Why a decision pack needs provenance

The pipeline's output is consumed as *evidence for an enterprise decision*: the README describes pushing to the ERP surface "so a decision can be reached." A decision-grade artifact bundle carries the same integrity requirements as any audit artifact the README already targets (SOC2, HIPAA, GDPR, PCI-DSS reviews):

1. **Authenticity** — this pack was produced by the agentics pipeline for this specific trace/query, not hand-edited or substituted.
2. **Integrity** — no document, ADR, scorecard, or SBOM in the pack was altered after generation.
3. **Reproducible verification** — any recipient can verify (1) and (2) offline with a public key, without trusting the sender's word.

Today the pack has none of these. A `manifest.json` records what *should* be present, but nothing binds the manifest to the actual bytes on disk with a signature.

### What MetaHarness provides

MetaHarness's release model is **Ed25519 witness-signed releases** with `harness sign` / `harness verify`. A witness is a signed statement over a content manifest (path → content hash) plus run metadata. This is the same primitive needed here, from the same kernel already resolved by ADR-117.

---

## Decision

### D1. At end-of-run, compute a content manifest over the deliverable pack and sign it

After Phase 7 completes (deliverables emitted) and after the ADR-118 gate (if run), a signing step:

1. Enumerates the deliverable pack: every file under `<runDir>/deliverables/`, the ADRs/DDD, the Phase 5 prototype tree, `erp-surface-mapping.json`, and the ADR-118 `metaharness/` artifacts (scorecard, mcp-scan, threat-model, sbom).
2. Computes a **content manifest**: `{ path → sha256 }` for each file, plus run metadata (`trace_id`, `query`, `run_verdict`, `metaharness.gate.score`, timestamps).
3. Signs the canonicalised content manifest with Ed25519 via the ADR-117 resolver (`metaharness sign` / `metaharness_*` witness tool), producing `<runDir>/metaharness/witness.json`:

```json
{
  "algorithm": "ed25519",
  "trace_id": "…",
  "content_manifest_sha256": "…",
  "signature": "base64…",
  "public_key": "base64…",
  "signed_at": "…",
  "files": 173
}
```

The witness is copied into the deliverable pack so it travels with the bundle.

### D2. `agentics verify <pack>` verifies a witness offline

A `verify` surface (CLI subcommand + reuse of MetaHarness `verify`) recomputes the content manifest from the pack on disk, checks each file hash against the witness, and verifies the Ed25519 signature against the embedded (or a pinned) public key. Output: `VERIFIED` (all hashes match, signature valid) or a list of `MISMATCH`/`MISSING`/`EXTRA` files and/or `SIGNATURE INVALID`. Verification requires **no** network and **no** LLM — it is pure hashing + signature check.

### D3. Signing is non-blocking and recorded honestly (ADR-116)

Signing never blocks a run or gates any phase — an unsigned pack is still a valid pack; the signature is additive assurance. But its outcome is recorded truthfully:

- Success → `manifest.metaharness.witness = { signed: true, algorithm: "ed25519", artifact: "metaharness/witness.json" }`.
- MetaHarness unavailable (`tier: 'none'`) or signing error → `{ signed: false, reason: "…" }` and a one-line stderr notice. **The pack is never reported as `signed: true` when it is not** (ADR-116 honesty principle). No placeholder/empty witness is emitted.

### D4. Key management is explicit and out-of-band; no key is generated silently into the repo

The signing key is resolved from `AGENTICS_WITNESS_KEY` (a PEM path or inline PEM value); when unset or invalid, signing is skipped and recorded per D3 — i.e. a two-tier `env → none` resolution. The pipeline **never** generates a private key into the working repo or commits one. The public key is embedded (SPKI/DER, base64) in the witness for verification; the private key never leaves the operator's key store. This keeps signing opt-in-by-key-presence and avoids the footgun of committing secrets.

> **Implementation note (0.2):** an optional middle tier — a MetaHarness-managed default key store — was considered but intentionally **not** shipped. It would broaden the key-source surface without a clear, audited store to point at; the conservative `env → none` path never signs with an unexpected key. If a managed store is added later it slots in ahead of `none`, unchanged for callers.

### D5. The witness covers the ADR-118 assurance artifacts

Because the ADR-118 scorecard, mcp-scan, threat-model, and SBOM are included in the content manifest, the signature binds the *safety assessment* to the *pack it assessed*. A recipient can verify not only that the deliverables are intact but that the scorecard they are reading is the one produced for this exact prototype — closing the "was this score really for this build?" gap.

---

## Alternatives Considered

### Alternative 1: Rely on git commit hashes for provenance

Use the git commit the pipeline creates (the materialization commit) as the provenance record.

**Rejected because:** (a) ADR-PIPELINE (this session's repo-safety fix) makes repo materialization opt-in and off by default — most runs will have no commit; (b) a git hash proves *a* commit exists, not that a specific recipient's copy of the pack is unaltered, and requires trusting the git host; (c) it cannot be verified offline against a loose bundle of files handed to a decision-maker. An Ed25519 witness over a content manifest verifies any copy of the pack anywhere, with a public key, offline.

### Alternative 2: Sign with the raw Anthropic/API key or a cloud KMS

Use an existing platform credential or a managed KMS to sign.

**Rejected because:** it re-introduces a credential/transport the pipeline deliberately avoids (ADR-112 §D1 removed raw-API transports), couples signing to a cloud dependency, and would not be verifiable offline without that cloud. MetaHarness's self-contained Ed25519 witness needs only a keypair and a hash function.

### Alternative 3: Make signing blocking (fail the run if it cannot sign)

Treat an unsigned pack as a failed run.

**Rejected because:** the pack has value with or without a signature; a decision-maker in an ungoverned context should still receive the deliverables. Signing is additive assurance, so its absence is recorded (D3) but does not fail the run. Governed contexts that *require* a signature can check `manifest.metaharness.witness.signed` in CI.

---

## Consequences

### Benefits

1. **The decision pack is tamper-evident.** Any recipient can verify, offline with a public key, that the pack is exactly what this trace produced.
2. **The safety assessment is bound to the build.** The signature covers the ADR-118 scorecard/SBOM, so the score cannot be silently swapped or reattributed.
3. **Fits the compliance framing.** The README already targets SOC2/HIPAA/GDPR/PCI-DSS review contexts; a signed, verifiable artifact bundle is standard practice there.
4. **No new credential or cloud dependency.** Self-contained Ed25519 from the already-resolved MetaHarness kernel; verification needs no network and no LLM.

### Risks and Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| No signing key available in most environments | High (initially) | Low | Signing is opt-in-by-key-presence; unsigned is recorded honestly (D3); no run fails for lack of a key |
| Operator commits a private key by mistake | Low | High | D4: the pipeline never generates or writes a private key into the repo; keys are resolved from env/out-of-band store only |
| Witness schema drift across MetaHarness versions | Low | Low | The witness is stored verbatim; `verify` reads documented fields; version recorded in the manifest |
| Recipients lack tooling to verify | Medium | Low | `agentics verify <pack>` ships in-CLI (D2); verification is pure hash+signature, no dependencies |

### Performance Targets

| Metric | Target |
|--------|--------|
| Signing wall-clock (hash pack + Ed25519 sign) | < 5s typical |
| Private keys generated into or committed to the repo | 0 |
| Packs reported `signed: true` without a valid signature | 0 (ADR-116 honesty) |
| `agentics verify` network/LLM dependencies | 0 |
| Files in the signed content manifest not present in the pack | 0 (manifest derived from the pack) |

---

## Related Decisions

- **ADR-PIPELINE-117** — MetaHarness resolution + placement. This ADR realises the Phase 6/7 signing slot and uses its resolver + manifest block.
- **ADR-PIPELINE-118** — Quality/security gate. The scorecard, mcp-scan, threat-model, and SBOM are included in the signed content manifest (D5).
- **ADR-PIPELINE-105** — Deliverable guarantee. The witness attests to the guaranteed Phase 7 pack.
- **ADR-PIPELINE-116** — Loud failure / honesty. A pack is never reported as signed when it is not.
- **ADR-PIPELINE-112** — Model backend policy. The no-extra-credential principle this ADR follows (self-contained Ed25519, no cloud KMS).

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-07-06 | Nick Ruest | Initial proposal — end-of-run Ed25519 witness over the deliverable content manifest, offline `agentics verify`, non-blocking + honest recording, explicit out-of-band key management (never generate/commit keys), signature binds the ADR-118 assurance artifacts to the pack |
