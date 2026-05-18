# Protein-Engine SPARC Specification
### London School TDD / Outside-In Development Plan
**Version 1.0**

---

## S — Specification

### Problem Statement

Build an AI-native, quantum-aware, distributed protein engineering platform packaged as a single `.rvf` cognitive container. The platform must support cellular reprogramming factor design (Yamanaka factors: OCT4, SOX2, KLF4, cMYC), with evolutionary optimization, neural fitness scoring, quantum energy simulation, and cryptographic auditability — deployable identically across Docker, WASM browser, bare-metal, Raspberry Pi, and AI agent (MCP) targets.

### Functional Requirements

| ID | Requirement | Acceptance Criteria |
|----|-------------|---------------------|
| FR-01 | **Protein variant modeling** — represent sequences, mutations, fitness scores, and lineage as domain types | `ProteinVariant`, `Mutation`, `FitnessScore`, `ExperimentResult` types compile under `no_std` + WASM |
| FR-02 | **Sequence embedding** — generate 320-dim ESM-2 embeddings per variant | Embedding output matches reference ESM-2 t6 8M within tolerance; stored in VEC_SEG |
| FR-03 | **Similarity search** — sub-ms HNSW nearest-neighbor lookup across variant embeddings | 99th-percentile latency < 1ms for 100K vectors; INDEX_SEG persists across restarts |
| FR-04 | **Neural fitness scoring** — predict reprogramming efficiency, expression dynamics, and experimental outcomes | Ensemble (Transformer + LSTM + N-BEATS) returns `FitnessScore` within 100ms on CPU |
| FR-05 | **Evolutionary optimization** — mutation, crossover, selection loops over variant populations | Population converges over generations; top candidates promoted to HOT_SEG |
| FR-06 | **Quantum energy simulation** — VQE molecular Hamiltonians, QAOA sequence QUBO | pe-quantum routes to Origin Quantum / IBM / local WASM simulator; VQE snapshots in SKETCH_SEG |
| FR-07 | **Cryptographic audit trail** — every design, result, and model state is immutable and signed | QuDAG WITNESS_SEG chain verifiable; ML-DSA signatures validate; append-only JOURNAL_SEG |
| FR-08 | **Multi-agent swarm orchestration** — ephemeral agents per task (sequence-explorer, fitness-scorer, structural-validator, toxicity-screener, experiment-designer, quantum-dispatcher) | Agents coordinate via Synaptic-Mesh; SAFLA closed loop completes design-synthesize-measure-learn-redesign cycle |
| FR-09 | **RVF packaging** — all segments assembled into a single `.rvf` file | `.rvf` file opens in all 7 deployment targets; MANIFEST_SEG declares capabilities; parent hash lineage intact |
| FR-10 | **Lab instrument integration** — Opentrons/Hamilton protocol generation and live data ingestion | pe-stream ingests flow cytometry data; instrument-bridge generates valid Opentrons protocols |
| FR-11 | **WASM browser runtime** — full offline operation from a single file in a browser tab | pe-wasm exposes `score_sequence`, `run_evolution_step`, `run_local_quantum_sim`, `commit_to_ledger` |
| FR-12 | **MCP agent interface** — Claude Code can operate the entire platform via MCP server | `@ruvector/rvf-mcp-server` exposes all RVF operations; Claude can invoke scoring, evolution, and queries |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-01 | WASM bundle size | < 10 MB (microkernel < 6 KB) |
| NFR-02 | Neural inference latency | < 100ms CPU, no GPU required |
| NFR-03 | Similarity search latency | < 1ms p99 at 100K vectors |
| NFR-04 | Post-quantum crypto | ML-KEM + ML-DSA for all signing/encapsulation |
| NFR-05 | Cross-platform compilation | `no_std` core types; `native` and `wasm` feature flags |
| NFR-06 | Tamper-evidence | SHA3-hashed journal; ML-DSA signed witness chain |

### Constraints

- Language: Rust (2021 edition)
- All core domain types must be `no_std` compatible
- Feature flags: `native` (server/Docker) vs `wasm` (browser/edge)
- External quantum chemistry via Python sidecar (pyChemiQ), not inline
- Single `.rvf` artifact is the sole deployment unit

---

## P — Pseudocode

### London School TDD: Outside-In Layered Test Strategy

Development proceeds **outside-in**, starting from the outermost user-facing boundary (API/CLI/WASM) and driving inward to core domain logic. Each layer defines collaborators as **traits** (interfaces), and inner layers are **test doubles (mocks/stubs)** until implemented.

### Layer 7 → Layer 1 Implementation Order

```
Outside-In Flow:
  [API/CLI/WASM boundary tests]
       ↓ mock
  [Swarm orchestration tests]
       ↓ mock
  [Neural inference tests]
       ↓ mock
  [Vector/Graph DB tests]
       ↓ mock
  [Quantum simulation tests]
       ↓ mock
  [Ledger/Crypto tests]
       ↓ mock
  [Core domain types — real implementations bottom out here]
```

### Phase 1: pe-core (Domain Types — The Innermost Real Layer)

```
// No mocks needed — these are pure value types

struct ProteinVariant:
    id: Uuid
    name: String
    sequence: AminoAcidSequence    // validated, immutable
    target_factor: YamanakaFactor  // OCT4 | SOX2 | KLF4 | CMYC
    mutations: Vec<Mutation>
    generation: u32
    parent_id: Option<Uuid>

struct Mutation:
    position: usize
    from_residue: AminoAcid
    to_residue: AminoAcid

struct FitnessScore:
    reprogramming_efficiency: f64   // 0.0..1.0
    expression_stability: f64
    structural_plausibility: f64
    safety_score: f64               // oncogenic risk, lower = safer
    composite: f64                  // weighted aggregate

struct ExperimentResult:
    variant_id: Uuid
    assay_type: AssayType
    measured_values: HashMap<String, f64>
    timestamp: DateTime
    instrument_id: String

// TESTS (unit, no mocks):
test "ProteinVariant validates amino acid sequences"
test "Mutation applies to sequence producing new variant"
test "FitnessScore composite is weighted average of components"
test "AminoAcidSequence rejects invalid residue codes"
test "ProteinVariant tracks lineage via parent_id chain"
```

### Phase 2: pe-vector (Vector DB — Mock the Embedding Source)

```
// Trait defining what we need from an embedding model
trait EmbeddingModel:
    fn embed(sequence: &AminoAcidSequence) -> Result<Embedding320>

// Trait defining the vector store
trait VectorStore:
    fn insert(id: Uuid, embedding: Embedding320, meta: VariantMeta)
    fn search_nearest(query: Embedding320, k: usize) -> Vec<(Uuid, f32)>
    fn get_meta(id: Uuid) -> Option<VariantMeta>

// RuVectorStore implements VectorStore backed by RuVector
struct RuVectorStore:
    inner: ruvector::Database

// TESTS (London School — mock EmbeddingModel):
test "insert variant embedding and retrieve by ID":
    mock_embedder returns fixed 320-dim vector
    store.insert(variant.id, mock_embedder.embed(seq), meta)
    assert store.get_meta(variant.id) == meta

test "search_nearest returns k closest by cosine similarity":
    insert 100 variants with known embeddings
    results = store.search_nearest(query_embedding, 5)
    assert results.len() == 5
    assert results are sorted by descending similarity

test "HNSW index persists to INDEX_SEG and reloads":
    store.insert(variants...)
    bytes = store.serialize_to_index_seg()
    store2 = RuVectorStore::from_index_seg(bytes)
    assert store2.search_nearest(...) == store.search_nearest(...)
```

### Phase 3: pe-neural (Fitness Scoring — Mock Vector Store + Models)

```
trait FitnessPredictor:
    fn predict(variant: &ProteinVariant, embedding: &Embedding320) -> Result<FitnessScore>

struct EnsemblePredictor:
    transformer: TransformerScorer   // reprogramming efficiency
    lstm: LstmScorer                 // expression dynamics
    nbeats: NBeatsScorer             // outcome forecasting

// TESTS (London School — mock individual scorers):
test "EnsemblePredictor aggregates three sub-model scores":
    mock_transformer returns reprogramming = 0.8
    mock_lstm returns stability = 0.7
    mock_nbeats returns outcome = 0.9
    score = ensemble.predict(variant, embedding)
    assert score.composite == weighted_average(0.8, 0.7, 0.9)

test "predict returns error when any sub-model fails":
    mock_transformer returns Err(ModelNotLoaded)
    assert ensemble.predict(...).is_err()

test "model weights load from QUANT_SEG bytes":
    bytes = read_fixture("quant_seg_sample.bin")
    scorer = TransformerScorer::from_quant_seg(bytes)
    assert scorer.predict(sample_variant).is_ok()
```

### Phase 4: pe-swarm (Agent Orchestration — Mock All Collaborators)

```
trait EvolutionEngine:
    fn mutate(variant: &ProteinVariant) -> ProteinVariant
    fn crossover(a: &ProteinVariant, b: &ProteinVariant) -> ProteinVariant
    fn select(population: &[ScoredVariant], top_k: usize) -> Vec<ScoredVariant>

trait SwarmCoordinator:
    fn run_design_cycle(config: CycleConfig) -> Result<CycleResult>

// Agent roles (each a trait implementor):
struct SequenceExplorer       // evolutionary mutation + crossover
struct FitnessScorerAgent     // delegates to FitnessPredictor
struct StructuralValidator    // ESMFold / HNSW plausibility check
struct ToxicityScreener       // oncogenic risk classifier
struct ExperimentDesigner     // Opentrons protocol generation
struct QuantumDispatcher      // VQE / QAOA job routing

// TESTS (London School — mock all agent collaborators):
test "SAFLA closed loop: design → score → validate → screen → log":
    mock_explorer returns 10 mutated variants
    mock_scorer returns fitness scores for each
    mock_validator returns structural_ok for 8/10
    mock_screener returns safe for 7/8
    result = coordinator.run_design_cycle(config)
    assert result.promoted.len() == 7
    verify mock_explorer.mutate called 10 times
    verify mock_scorer.predict called 10 times

test "agent retirement: low-performing agents replaced":
    mock governance returns retirement signal for slow_agent
    coordinator.tick()
    assert slow_agent is removed from active pool
```

### Phase 5: pe-quantum (Quantum Routing — Mock Backends)

```
trait QuantumBackend:
    fn submit_vqe(hamiltonian: MolecularHamiltonian) -> Result<VqeResult>
    fn submit_qaoa(qubo: QuboInstance) -> Result<QaoaResult>
    fn capabilities() -> BackendCapabilities

struct QuantumRouter:
    backends: Vec<Box<dyn QuantumBackend>>

// TESTS (London School — mock quantum backends):
test "router selects best backend for VQE by qubit count":
    mock_origin supports 72 qubits
    mock_ibm supports 127 qubits
    mock_local supports 20 qubits
    job requires 50 qubits
    router.submit_vqe(hamiltonian)
    verify mock_origin.submit_vqe called (closest fit)

test "router falls back to local WASM simulator when offline":
    mock_origin returns Err(Unreachable)
    mock_ibm returns Err(Unreachable)
    result = router.submit_vqe(small_hamiltonian)
    verify mock_local.submit_vqe called
    assert result.is_ok()

test "VQE snapshots serialized to SKETCH_SEG format":
    result = VqeResult { energy: -1.234, params: [...] }
    bytes = result.to_sketch_seg()
    roundtrip = VqeResult::from_sketch_seg(bytes)
    assert roundtrip == result
```

### Phase 6: pe-ledger (Cryptographic Audit — Mock Crypto Primitives)

```
trait LedgerWriter:
    fn append_entry(entry: JournalEntry) -> Result<EntryHash>
    fn verify_chain() -> Result<bool>

trait CryptoSigner:
    fn sign(data: &[u8]) -> Result<MlDsaSignature>
    fn verify(data: &[u8], sig: &MlDsaSignature) -> Result<bool>

// TESTS (London School — mock signer for fast tests):
test "append_entry chains SHA3 hashes correctly":
    mock_signer returns deterministic signature
    hash1 = ledger.append_entry(entry1)
    hash2 = ledger.append_entry(entry2)
    assert entry2.prev_hash == hash1

test "verify_chain detects tampered entry":
    ledger.append_entry(entry1)
    ledger.append_entry(entry2)
    tamper entry1 payload
    assert ledger.verify_chain() == Err(TamperDetected)

test "WITNESS_SEG round-trips through QuDAG":
    entry = JournalEntry::new(ScoringRun { ... })
    ledger.append_entry(entry)
    seg_bytes = ledger.to_witness_seg()
    restored = Ledger::from_witness_seg(seg_bytes)
    assert restored.verify_chain().is_ok()
```

### Phase 7: pe-rvf (RVF Assembly — Mock All Segment Producers)

```
trait RvfBuilder:
    fn set_manifest(manifest: Manifest)
    fn add_segment(seg_type: SegmentType, data: Vec<u8>)
    fn build() -> Result<RvfFile>

// TESTS (London School — mock segment producers):
test "build assembles all 14 segment types into valid .rvf":
    mock producers return fixture bytes for each segment
    builder.set_manifest(manifest)
    builder.add_segment(VEC_SEG, mock_vec_bytes)
    builder.add_segment(INDEX_SEG, mock_index_bytes)
    // ... all segments
    rvf = builder.build()
    assert rvf.manifest().capabilities contains all expected
    assert rvf.segment_count() == 14

test "parent_hash lineage links child .rvf to parent":
    parent_rvf = build_parent()
    child_manifest = Manifest { parent_hash: parent_rvf.hash(), ... }
    child = builder.build_with_manifest(child_manifest)
    assert child.manifest().parent_hash == parent_rvf.hash()
```

### Phase 8: pe-api / pe-wasm / pe-cli (Outer Boundary — Integration Tests)

```
// pe-api (axum HTTP):
test "POST /variants/score returns FitnessScore JSON":
    mock FitnessPredictor behind trait
    response = client.post("/variants/score", variant_json)
    assert response.status == 200
    assert response.body parses as FitnessScore

// pe-wasm (browser entry):
test "score_sequence WASM export returns valid score":
    wasm_module = load_pe_wasm()
    result = wasm_module.score_sequence("MKWVTFISLLLLFSSAYS...")
    assert result.composite >= 0.0 && result.composite <= 1.0

// pe-cli:
test "cli run-evolution outputs generation summary":
    output = run_cli(["run-evolution", "--generations", "5"])
    assert output contains "Generation 5"
    assert output contains "top variant"
```

---

## A — Architecture

### Crate Dependency Graph (Outside-In)

```
pe-cli ─────┐
pe-api ─────┤
pe-wasm ────┤
            ▼
        pe-swarm ──────► pe-neural ──────► pe-vector ──────► pe-core
            │                │                  │
            ▼                ▼                  ▼
        pe-governance    pe-solver          ruvector (ext)
            │
            ▼
        pe-quantum ────► pe-quantum-wasm
            │
            ▼
        pe-chemistry (sidecar bridge)
            │
        pe-ledger ─────► qudag (ext)
            │
        pe-stream ─────► midstream (ext)
            │
        pe-rvf ────────► rvf / rvf-types / rvf-wire (ext)
```

### Trait Boundaries (London School Mock Points)

Each arrow in the dependency graph represents a **trait boundary**. The London School approach mandates that when testing a layer, all downstream dependencies are replaced with test doubles.

| Consuming Crate | Trait | Mock Used In Tests |
|-----------------|-------|--------------------|
| pe-vector | `EmbeddingModel` | `MockEmbedder` returns fixed 320-dim vectors |
| pe-neural | `FitnessPredictor` | `MockScorer` returns predetermined fitness scores |
| pe-swarm | `EvolutionEngine` | `MockEvolver` returns canned mutation/crossover results |
| pe-swarm | `SwarmCoordinator` agents | `MockAgent` for each role (explorer, scorer, validator...) |
| pe-quantum | `QuantumBackend` | `MockBackend` returns predetermined VQE/QAOA results |
| pe-ledger | `CryptoSigner` | `MockSigner` returns deterministic signatures |
| pe-rvf | segment producers | `MockSegmentProducer` returns fixture bytes |
| pe-api | all domain traits | Full mock stack for HTTP handler tests |
| pe-wasm | all domain traits | Stub implementations for WASM integration tests |

### RVF Segment Map (Architectural Invariant)

```
MANIFEST_SEG  0x00  ──► root metadata, capabilities, lineage hash
VEC_SEG       0x01  ──► 320-dim ESM-2 protein embeddings
INDEX_SEG     0x02  ──► HNSW nearest-neighbor index
OVERLAY_SEG   0x03  ──► LoRA adapter deltas
JOURNAL_SEG   0x04  ──► append-only experiment log
GRAPH_SEG     0x05  ──► GNN protein interaction network
QUANT_SEG     0x06  ──► INT8 quantized neural weights
META_SEG      0x07  ──► per-variant filterable metadata
HOT_SEG       0x08  ──► top-100 promoted candidates
SKETCH_SEG    0x09  ──► MinHash sketches + VQE snapshots
WASM_SEG      0x0A  ──► 5.5KB WASM microkernel
WITNESS_SEG   0x0B  ──► QuDAG cryptographic witness chain
CRYPTO_SEG    0x0C  ──► TEE attestation (SGX/SEV-SNP)
META_IDX_SEG  0x0D  ──► filterable metadata index
KERNEL_SEG    0x0E  ──► optional unikernel (Firecracker)
```

### Feature Flag Architecture

```
                    ┌── native ──┐
                    │  tokio      │
                    │  axum       │
                    │  libp2p     │
                    │  ort        │
                    │  faer       │
                    │  polars     │
                    │  rayon      │
Cargo.toml ────────┤             │
                    │             │
                    └── wasm ────┐
                        │ wasm-bindgen   │
                        │ js-sys         │
                        │ web-sys        │
                        │ gloo-net       │
                        │ rvf-wasm       │
                        └────────────────┘

pe-core: no_std, no feature flags (always compiles everywhere)
pe-quantum-wasm: pure Rust, no feature flags (always available)
pe-quantum: native only (hardware backend routing)
pe-api: native only (axum server)
pe-wasm: wasm only (browser entry)
pe-cli: native only (binary entry)
```

### Deployment Target Matrix

| Target | Entry Crate | Feature | RVF Segment Used |
|--------|-------------|---------|------------------|
| Docker server | pe-cli / pe-api | `native` | KERNEL_SEG boots |
| WASM browser | pe-wasm | `wasm` | WASM_SEG runs |
| Bare-metal lab | pe-cli | `native` | KERNEL_SEG boots |
| Raspberry Pi | pe-cli | `native` (aarch64) | rvf-wire reads |
| Claude Code / MCP | rvf-mcp-server | `native` | All segments exposed |
| P2P transfer | rvf-wire | `native` | Zero conversion |

---

## R — Refinement

### London School TDD Workflow Per Crate

```
For each crate, working outside-in:

1. Write a failing acceptance test at the crate's public API boundary
2. Identify collaborator traits the crate needs
3. Create mock/stub implementations of those traits
4. Write unit tests for the crate's logic using mocks
5. Make tests pass with minimal implementation
6. Move inward: implement the next downstream crate
7. Replace mocks with real implementations one layer at a time
8. Run acceptance test again — now exercises real stack
```

### Implementation Phases

**Phase 1: Foundation (pe-core)**
- Pure domain types, zero dependencies beyond `serde`, `uuid`, `chrono`
- `no_std` compatible from day one
- Unit tests only (no mocks needed — leaf node)
- Deliverable: `ProteinVariant`, `Mutation`, `FitnessScore`, `ExperimentResult`, `AminoAcidSequence`

**Phase 2: Storage Layer (pe-vector + pe-rvf)**
- pe-vector: `VectorStore` + `EmbeddingModel` traits; `RuVectorStore` impl
- pe-rvf: `RvfBuilder` + segment serialization
- Mock: `MockEmbedder` for pe-vector tests
- Mock: `MockSegmentProducer` for pe-rvf tests
- Integration test: insert embeddings → serialize to VEC_SEG → reload

**Phase 3: Intelligence Layer (pe-neural + pe-solver)**
- pe-neural: `FitnessPredictor` trait; `EnsemblePredictor` (Transformer + LSTM + N-BEATS)
- pe-solver: sublinear-time sparse energy minimization
- Mock: individual scorer sub-models for ensemble tests
- Integration test: load QUANT_SEG fixture → score a known sequence

**Phase 4: Quantum Layer (pe-quantum + pe-quantum-wasm + pe-chemistry)**
- pe-quantum-wasm: pure-Rust statevector simulator (always available)
- pe-quantum: `QuantumBackend` trait; `QuantumRouter` dispatches to backends
- pe-chemistry: HTTP bridge to pyChemiQ sidecar
- Mock: `MockBackend` for router logic tests
- Integration test: VQE on H2 molecule via local simulator

**Phase 5: Trust Layer (pe-ledger + pe-governance)**
- pe-ledger: `LedgerWriter` + `CryptoSigner` traits; QuDAG integration
- pe-governance: daa lifecycle management
- Mock: `MockSigner` for fast chain tests
- Integration test: append 100 entries → verify chain → serialize to WITNESS_SEG

**Phase 6: Orchestration Layer (pe-swarm + pe-stream)**
- pe-swarm: `SwarmCoordinator` + agent role traits; Synaptic-Mesh integration
- pe-stream: live instrument data ingestion via midstream
- Mock: all downstream agent collaborators
- Integration test: SAFLA loop with mock agents → verify cycle output

**Phase 7: Interface Layer (pe-api + pe-wasm + pe-cli)**
- pe-api: axum HTTP/WebSocket handlers
- pe-wasm: WASM entry point compiled by wasm-pack
- pe-cli: CLI binary
- Mock: full domain trait stack behind dependency injection
- Integration test: HTTP round-trip with mock backend
- E2E test: WASM module exports callable from JS

### Risk Mitigations

| Risk | Mitigation |
|------|------------|
| RuVector/QuDAG API instability | Pin git revisions in Cargo.toml; trait boundaries insulate |
| WASM bundle size exceeds budget | `opt-level=z` + `lto=thin`; WASM_SEG measured in CI |
| Quantum backend unavailable | pe-quantum-wasm pure-Rust simulator always available offline |
| pyChemiQ sidecar latency | Async HTTP bridge with timeout; cache VQE results in SKETCH_SEG |
| Feature flag combinatorial explosion | CI matrix tests `native` and `wasm` profiles; `pe-core` has no flags |
| Cross-compilation failures (aarch64) | CI includes aarch64 cross-compile step; `no_std` core validated |

### Mock Library Choice

Use **`mockall`** crate for London School mocks:
- Auto-generates mock structs from trait definitions
- Supports expectation setting (call count, argument matching)
- Supports return value sequences
- Works with async traits via `#[async_trait]`

```toml
[workspace.dependencies]
mockall = { version = "0.12", optional = true }

# In each crate's Cargo.toml:
[dev-dependencies]
mockall = { workspace = true }
```

---

## C — Completion

### Definition of Done Per Crate

- [ ] All public types and traits documented with rustdoc
- [ ] London School unit tests pass with mocked collaborators
- [ ] Integration tests pass with real downstream crates
- [ ] `cargo clippy` clean (no warnings)
- [ ] `cargo fmt` applied
- [ ] Compiles for target profile (`native` or `wasm` or both)
- [ ] Feature flag gating verified (no native deps leak into wasm)

### Definition of Done for the Platform

- [ ] `cargo build --release --features native` succeeds
- [ ] `wasm-pack build crates/pe-wasm` produces < 10 MB bundle
- [ ] `./build-rvf.sh` assembles valid `.rvf` with all 15 segments
- [ ] `.rvf` opens in Docker, WASM browser, and CLI modes
- [ ] MCP server exposes all RVF operations to Claude Code
- [ ] Full SAFLA cycle completes: design → score → validate → screen → log
- [ ] QuDAG witness chain verifiable with ML-DSA signatures
- [ ] CI pipeline runs full test matrix (native + wasm + aarch64 cross-compile)

### Test Pyramid

```
                 ╱╲
                ╱  ╲         E2E Tests (3-5)
               ╱    ╲        .rvf opens in Docker + WASM + CLI
              ╱──────╲
             ╱        ╲      Integration Tests (15-25)
            ╱          ╲     Real crate-to-crate interactions
           ╱────────────╲
          ╱              ╲   London School Unit Tests (100+)
         ╱                ╲  Mocked collaborators, fast, isolated
        ╱──────────────────╲
       ╱                    ╲ Property / Fuzz Tests (10-15)
      ╱                      ╲ AminoAcidSequence, RVF parsing,
     ╱________________________╲ cryptographic round-trips
```

### CI Pipeline Stages

```
1. cargo fmt --check
2. cargo clippy --all-targets --all-features
3. cargo test --features native           (London School unit + integration)
4. cargo test --target wasm32-unknown-unknown --features wasm  (WASM unit)
5. wasm-pack build crates/pe-wasm         (bundle size check)
6. cross build --target aarch64-unknown-linux-gnu --features native
7. ./build-rvf.sh && validate-rvf protein-engine.rvf
8. docker compose -f docker-compose.dev.yml up --build --abort-on-container-exit
```

### Milestone Schedule

| Milestone | Crates | Key Deliverable |
|-----------|--------|-----------------|
| M1 — Foundation | pe-core, pe-rvf | Domain types + RVF builder with segment serialization |
| M2 — Storage | pe-vector | Embedding insert/search + HNSW persistence |
| M3 — Intelligence | pe-neural, pe-solver | Ensemble fitness scoring < 100ms |
| M4 — Quantum | pe-quantum, pe-quantum-wasm, pe-chemistry | VQE on local simulator + Origin Quantum bridge |
| M5 — Trust | pe-ledger, pe-governance | Verified witness chain + DAA lifecycle |
| M6 — Orchestration | pe-swarm, pe-stream | SAFLA closed loop + instrument ingestion |
| M7 — Interfaces | pe-api, pe-wasm, pe-cli | All 7 deployment targets operational |
| M8 — Integration | all | Single `.rvf` artifact passes full E2E suite |
