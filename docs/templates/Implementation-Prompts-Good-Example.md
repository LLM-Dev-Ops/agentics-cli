# Protein-Engine Implementation Prompts

Sequential, copy-paste-ready prompts for building the platform. Each prompt references the specific ADRs and DDDs it depends on. Execute in order — each prompt's outputs are inputs to subsequent prompts.

---

## Prompt 01: Workspace Scaffold and Cargo Configuration

```
Set up the Rust workspace for Protein-Engine. Create the directory structure exactly as defined in the SPARC specification (plans/sparc-specification.md, "Repository Structure" section).

Create:
1. Root Cargo.toml with all 14 workspace members and all workspace dependencies exactly as specified in plans/research.md ("Workspace Cargo.toml" section). Include every dependency with its exact version, git URL, and feature flags.
2. .cargo/config.toml with target-specific rustflags for wasm32-unknown-unknown, x86_64-unknown-linux-musl, and aarch64-unknown-linux-gnu as specified in the research doc.
3. A minimal Cargo.toml for each of the 14 crates under crates/ — each should have:
   - workspace package inheritance (version, edition, license, authors, repository, description)
   - the correct subset of workspace dependencies for that crate
   - feature flags following ADR-003 (plans/adr-003-feature-flag-native-vs-wasm.md): native vs wasm mutual exclusivity
   - dev-dependencies: mockall (workspace) per ADR-002
   - pe-core must have NO feature flags and NO std dependency (ADR-009)
4. A placeholder lib.rs for each crate that compiles (just `//! Crate description` comment)
5. Stub directories for services/chemiq-sidecar/, services/instrument-bridge/, web/, docker/ as shown in the repo structure

Verify: `cargo check --workspace` succeeds. `cargo check --target wasm32-unknown-unknown -p pe-core` succeeds (no_std validation).

Reference: plans/research.md (full Cargo.toml), ADR-003, ADR-009
```

---

## Prompt 02: pe-core Domain Types

```
Implement the pe-core crate with all domain types defined in DDD-001 (plans/ddd-001-protein-engineering-domain-model.md, "Variant Design Context" and "Fitness Evaluation Context") and DDD-003 (plans/ddd-003-aggregate-specifications.md, Aggregates 1, 2, and 6).

The crate MUST be #![no_std] with extern crate alloc per ADR-009 (plans/adr-009-nostd-core-domain-types.md). Use BTreeMap not HashMap. Import from alloc, not std.

Implement these types with all invariants from DDD-003:

1. AminoAcid — enum of 20 standard residues (A,C,D,E,F,G,H,I,K,L,M,N,P,Q,R,S,T,V,W,Y) with from_char/to_char conversions
2. AminoAcidSequence — validated, immutable sequence wrapper. Constructor rejects empty sequences and invalid residue chars. Implements Deref<Target=[AminoAcid]> for easy access.
3. YamanakaFactor — enum: OCT4, SOX2, KLF4, CMYC
4. Mutation — value object with position, from_residue, to_residue. Constructor enforces from != to (invariant PV-7).
5. ProteinVariant — aggregate root with id (Uuid), name, sequence, target_factor, mutations, generation, parent_id. Factory methods:
   - wild_type(name, sequence, target_factor) — generation 0, no parent (PV-3)
   - from_mutation(parent, mutation) — validates PV-5, PV-6, increments generation (PV-4)
   - from_crossover(parent_a, parent_b, crossover_point) — validates same length, combines sequences
6. FitnessScore — value object with reprogramming_efficiency, expression_stability, structural_plausibility, safety_score, composite. Constructor clamps to [0.0, 1.0] and computes weighted composite (invariants FS-1 through FS-4). Include FitnessWeights.
7. AssayType — enum: FlowCytometry, WesternBlot, QPCR, PlateReader, CellViability, Custom(String)
8. ExperimentResult — entity with variant_id, assay_type, measured_values (BTreeMap<String, f64>), timestamp, instrument_id, notes. Constructor enforces ER-1 through ER-4.
9. ScoredVariant — tuple struct (ProteinVariant, FitnessScore)
10. Embedding320 — newtype wrapper around [f32; 320] with basic operations (cosine_similarity, etc.)

Write London School TDD unit tests for every invariant listed in DDD-003. No mocks needed — pe-core is the leaf node. Test every factory method, every validation rule, every rejection case.

All types must derive Serialize, Deserialize, Clone, Debug. PartialEq where specified in DDD-003.

Verify: `cargo test -p pe-core` passes. `cargo check --target wasm32-unknown-unknown -p pe-core` compiles.

Reference: ADR-009, DDD-001, DDD-003 (Aggregates 1, 2, 6)
```

---

## Prompt 03: pe-rvf Segment Types and RVF Builder

```
Implement the pe-rvf crate with the RVF builder and segment definitions defined in ADR-001 (plans/adr-001-rvf-universal-deployment-artifact.md) and DDD-003 (plans/ddd-003-aggregate-specifications.md, Aggregate 4: RvfFile).

Implement:

1. SegmentType — enum with discriminants for all 15 segments (MANIFEST_SEG 0x00 through KERNEL_SEG 0x0E) as listed in ADR-001's segment allocation table.
2. Capability — enum: VecSearch, ProteinScoring, Evolution, WasmRuntime, QuantumVqe, P2pSync, McpAgent, TeeAttestation
3. Manifest — struct with name, version, capabilities, parent_hash, signing_key_fingerprint, created_at. Validation per RF-7.
4. SegmentProducer trait (from ADR-004, plans/adr-004-trait-boundary-dependency-injection.md):
   ```rust
   pub trait SegmentProducer: Send + Sync {
       fn segment_type(&self) -> SegmentType;
       fn produce(&self) -> Result<Vec<u8>>;
   }
   ```
5. RvfBuilder trait and concrete implementation:
   ```rust
   pub trait RvfAssembler: Send + Sync {
       fn set_manifest(&mut self, manifest: Manifest);
       fn add_segment(&mut self, seg_type: SegmentType, data: Vec<u8>) -> Result<()>;
       fn build(self) -> Result<RvfFile>;
   }
   ```
6. RvfFile — struct holding manifest + BTreeMap<SegmentType, Vec<u8>> + file_hash. Enforce invariants RF-1 through RF-6 from DDD-003.
7. Serialization: RvfFile can serialize to bytes and deserialize back. Use a simple binary format: manifest length (u32) + manifest bytes + for each segment: type (u8) + length (u32) + data bytes. Compute file_hash as SHA3-256 of the complete output.
8. Auto-capability inference: build() must scan present segments and populate capabilities (RF-2 through RF-4). If VEC_SEG present → VecSearch capability. If WASM_SEG → WasmRuntime. Etc.

Write London School TDD tests using mockall. Mock SegmentProducer to return fixture bytes. Test every invariant from DDD-003 Aggregate 4:
- build with all segments produces valid RvfFile
- build fails without MANIFEST_SEG (RF-1)
- capabilities auto-populated from present segments (RF-2, RF-3, RF-4)
- segments ordered by type ID in output (RF-5)
- parent_hash links child to parent
- file_hash is deterministic for same inputs (RF-6)
- round-trip serialize/deserialize preserves all segments

Verify: `cargo test -p pe-rvf` passes.

Reference: ADR-001, ADR-004, DDD-003 (Aggregate 4)
```

---

## Prompt 04: pe-vector Embedding Store and Traits

```
Implement the pe-vector crate with vector storage, embedding traits, and HNSW search as specified in DDD-001 (plans/ddd-001-protein-engineering-domain-model.md, "Fitness Evaluation Context") and DDD-002 (plans/ddd-002-bounded-context-integration-patterns.md, section 1).

This crate depends on pe-core (for domain types) and integrates with RuVector for the actual vector database.

Implement:

1. EmbeddingModel trait (from ADR-004):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait EmbeddingModel: Send + Sync {
       fn embed(&self, sequence: &AminoAcidSequence) -> Result<Embedding320>;
   }
   ```

2. VariantMeta — filterable metadata stored alongside each embedding:
   - variant_id, target_factor, generation, composite_score, design_method

3. VectorStore trait (from ADR-004):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait VectorStore: Send + Sync {
       fn insert(&mut self, id: Uuid, embedding: Embedding320, meta: VariantMeta) -> Result<()>;
       fn search_nearest(&self, query: &Embedding320, k: usize) -> Result<Vec<(Uuid, f32)>>;
       fn get_meta(&self, id: Uuid) -> Result<Option<VariantMeta>>;
       fn count(&self) -> usize;
   }
   ```

4. InMemoryVectorStore — a pure-Rust in-memory implementation of VectorStore using brute-force cosine similarity. This serves as:
   - The WASM-target implementation (no RuVector dependency)
   - The reference implementation for testing
   - Serializable to/from VEC_SEG + INDEX_SEG byte formats (implement SegmentProducer from pe-rvf)

5. RuVectorStore (behind `native` feature flag) — wraps ruvector::Database, implements VectorStore trait. HNSW config: M=16, ef_construction=200, metric=Cosine per the research doc.

6. GraphStore trait — for GNN protein interaction network (GRAPH_SEG):
   ```rust
   pub trait GraphStore: Send + Sync {
       fn add_edge(&mut self, from: Uuid, to: Uuid, weight: f32) -> Result<()>;
       fn neighbors(&self, id: Uuid) -> Result<Vec<(Uuid, f32)>>;
   }
   ```

Write London School TDD tests. Mock EmbeddingModel (returns fixed 320-dim vectors). Test VectorStore with real InMemoryVectorStore:
- insert variant embedding and retrieve by ID
- search_nearest returns k closest by cosine similarity (insert 100 known vectors, verify ordering)
- search returns empty vec for empty store
- get_meta returns None for unknown ID
- count reflects number of inserted embeddings
- VEC_SEG + INDEX_SEG round-trip: serialize → deserialize → same search results

Verify: `cargo test -p pe-vector` passes. `cargo check --target wasm32-unknown-unknown -p pe-vector --no-default-features --features wasm` compiles.

Reference: ADR-003, ADR-004, DDD-001 (Fitness Evaluation Context), DDD-002 (Integration 1)
```

---

## Prompt 05: pe-neural Fitness Scoring Ensemble

```
Implement the pe-neural crate with the fitness prediction ensemble as specified in DDD-001 (plans/ddd-001-protein-engineering-domain-model.md, "Fitness Evaluation Context") and the SPARC pseudocode (plans/sparc-specification.md, Phase 3).

This crate depends on pe-core (domain types) and pe-vector (EmbeddingModel trait).

Implement:

1. SubModelScorer trait (from ADR-004):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait SubModelScorer: Send + Sync {
       fn score(&self, variant: &ProteinVariant, embedding: &Embedding320) -> Result<f64>;
       fn model_name(&self) -> &str;
   }
   ```

2. FitnessPredictor trait (from ADR-004):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait FitnessPredictor: Send + Sync {
       fn predict(&self, variant: &ProteinVariant, embedding: &Embedding320) -> Result<FitnessScore>;
   }
   ```

3. EnsemblePredictor<T, L, N> — generic over three SubModelScorers (Transformer, LSTM, N-BEATS). Implements FitnessPredictor. Takes FitnessWeights to compute the composite score.

4. Stub scorer implementations (real model loading comes later):
   - TransformerScorer — placeholder that scores based on sequence composition heuristics (e.g., hydrophobicity distribution). Must implement SubModelScorer.
   - LstmScorer — placeholder scoring based on sequence length and mutation count.
   - NBeatsScorer — placeholder returning a configurable baseline score.

5. ModelLoader trait — for loading weights from QUANT_SEG bytes:
   ```rust
   pub trait ModelLoader: Send + Sync {
       fn load_from_bytes(data: &[u8]) -> Result<Self> where Self: Sized;
   }
   ```

6. Implement SegmentProducer (from pe-rvf) for QUANT_SEG — serializes model weights.

Write London School TDD tests. Mock all three SubModelScorers:
- EnsemblePredictor aggregates three sub-model scores with correct weights
- predict returns error when any sub-model fails (one mock returns Err)
- composite score is correctly weighted (mock transformer=0.8, lstm=0.7, nbeats=0.9, verify exact composite)
- safety_score inversion in composite calculation
- EnsemblePredictor with all mocks returning 0.5 produces composite = 0.5
- model_name() returns correct identifier for each scorer

Verify: `cargo test -p pe-neural` passes.

Reference: ADR-002, ADR-004, DDD-001 (Fitness Evaluation), SPARC Phase 3
```

---

## Prompt 06: pe-solver Sparse Energy Minimization

```
Implement the pe-solver crate with sparse energy minimization backed by the sublinear-time-solver.

This crate depends on pe-core (domain types).

Implement:

1. EnergySolver trait:
   ```rust
   #[cfg_attr(test, automock)]
   pub trait EnergySolver: Send + Sync {
       fn minimize(&self, energy_landscape: &EnergyLandscape) -> Result<MinimizationResult>;
   }
   ```

2. EnergyLandscape — represents a sparse energy surface over protein conformational space:
   - dimensions: usize
   - sparse_entries: Vec<(Vec<usize>, f64)> — (coordinate indices, energy value)

3. MinimizationResult — the solver output:
   - minimum_energy: f64
   - optimal_coordinates: Vec<f64>
   - iterations: usize
   - converged: bool

4. SublinearSolver — wraps pe-sublinear (sublinear-time-solver crate). Implements EnergySolver.

5. SimpleGradientSolver — a pure-Rust fallback for WASM targets. Implements EnergySolver.

6. Implement SegmentProducer for storing solver results in JOURNAL_SEG format.

Write London School TDD tests:
- minimize returns convergence on a known convex energy surface
- minimize handles empty landscape gracefully
- result contains correct iteration count
- round-trip serialization of MinimizationResult

Verify: `cargo test -p pe-solver` passes.

Reference: SPARC Phase 3, DDD-001 (Fitness Evaluation Context)
```

---

## Prompt 07: pe-quantum-wasm Local Quantum Simulator

```
Implement the pe-quantum-wasm crate — the pure-Rust statevector quantum simulator that runs on ALL targets including WASM, as specified in ADR-006 (plans/adr-006-quantum-backend-routing.md).

This crate has NO feature flags. It must compile everywhere: native, wasm32, aarch64, no_std+alloc.

Implement:

1. Statevector simulator:
   - Qubit — representation of a quantum bit
   - StateVector — 2^n complex amplitude vector (use num-complex)
   - Gate operations: H (Hadamard), X, Y, Z, CNOT, RX, RY, RZ, CZ
   - Measurement: collapse statevector, return classical bit string with probabilities

2. Circuit representation:
   - QuantumCircuit — ordered list of gate applications
   - CircuitBuilder — fluent API for constructing circuits

3. VQE implementation:
   - MolecularHamiltonian — from pe-core or defined here, matrix of Pauli terms
   - VqeRunner — classical optimizer loop (gradient-free: COBYLA or Nelder-Mead) that minimizes <psi|H|psi> by varying circuit parameters
   - VqeResult — ground state energy, optimal parameters, convergence flag, iteration count

4. QAOA implementation:
   - QuboInstance — symmetric matrix encoding the optimization problem
   - QaoaRunner — p-layer QAOA with parameter optimization
   - QaoaResult — best solution bitstring, cost, iterations

5. BackendCapabilities for the local simulator: max_qubits = 20 (practical limit for statevector), is_simulator = true

Write unit tests (no mocks — this is a leaf crate):
- H gate on |0⟩ produces equal superposition
- X gate flips |0⟩ to |1⟩
- CNOT entangles two qubits correctly
- VQE on H2 molecule (2-qubit, known ground state ≈ -1.137 Ha) converges within tolerance
- QAOA on a trivial 2-variable QUBO finds the optimal solution
- Measurement probabilities match theoretical predictions (statistical test)
- Simulator rejects circuits requiring > 20 qubits

Verify: `cargo test -p pe-quantum-wasm` passes. `cargo check --target wasm32-unknown-unknown -p pe-quantum-wasm` compiles.

Reference: ADR-006, DDD-001 (Quantum Simulation Context), DDD-003 (Aggregate 5: QuantumJob)
```

---

## Prompt 08: pe-quantum Backend Router

```
Implement the pe-quantum crate — the hardware-agnostic quantum router as specified in ADR-006 (plans/adr-006-quantum-backend-routing.md) and DDD-001 (plans/ddd-001-protein-engineering-domain-model.md, "Quantum Simulation Context").

This crate is native-only (feature = "native"). It depends on pe-core, pe-quantum-wasm, and pe-rvf.

Implement:

1. QuantumBackend trait (from ADR-004/ADR-006):
   ```rust
   #[async_trait]
   #[cfg_attr(test, automock)]
   pub trait QuantumBackend: Send + Sync {
       async fn submit_vqe(&self, hamiltonian: MolecularHamiltonian) -> Result<VqeResult>;
       async fn submit_qaoa(&self, qubo: QuboInstance) -> Result<QaoaResult>;
       fn capabilities(&self) -> BackendCapabilities;
   }
   ```

2. BackendCapabilities — max_qubits, gate_set (HashSet<GateType>), is_simulator, provider (ProviderName enum)

3. QuantumRouter — holds Vec<Box<dyn QuantumBackend>>. Routing logic per ADR-006:
   - Filter by qubit count >= job requirement
   - Filter by gate set superset
   - Filter by reachability (health check)
   - Sort by closest qubit count match
   - Fallback to LocalSimulator (pe-quantum-wasm)
   - Return Err(NoSuitableBackend) if nothing qualifies

4. LocalSimulatorBackend — wraps pe-quantum-wasm's VqeRunner/QaoaRunner, implements QuantumBackend

5. QuantumJob entity (DDD-003, Aggregate 5):
   - State machine: Created → Submitted → Running → Completed | Failed
   - Enforce all invariants QJ-1 through QJ-5

6. VQE result caching: implement SegmentProducer for SKETCH_SEG (VQE snapshots)

Write London School TDD tests. Mock QuantumBackend for each provider:
- router selects best backend for VQE by qubit count (mock_origin=72, mock_ibm=127, mock_local=20; job=50 qubits → origin selected)
- router falls back to local WASM simulator when all remotes fail
- router returns NoSuitableBackend when job exceeds all backends
- job state machine: full lifecycle test
- job rejects invalid transitions (cannot complete without submit)
- VQE snapshots round-trip through SKETCH_SEG

Verify: `cargo test -p pe-quantum` passes.

Reference: ADR-006, ADR-004, DDD-001 (Quantum Simulation), DDD-003 (Aggregate 5)
```

---

## Prompt 09: pe-chemistry pyChemiQ HTTP Bridge

```
Implement the pe-chemistry crate — the HTTP bridge to the pyChemiQ Python sidecar as specified in ADR-008 (plans/adr-008-python-sidecar-quantum-chemistry.md).

This crate is native-only. It depends on pe-core, pe-quantum (for QuantumBackend trait), and reqwest.

Implement:

1. ChemiqBridge struct:
   - base_url: String (e.g., "http://chemiq-sidecar:8100")
   - client: reqwest::Client
   - timeout: Duration (configurable, default 30s)

2. Implement QuantumBackend for ChemiqBridge:
   - submit_vqe: POST /vqe with JSON body {molecule, basis_set, ansatz, max_iterations}. Translate domain MolecularHamiltonian → sidecar JSON. Translate response → VqeResult.
   - submit_qaoa: POST /qaoa with JSON body {qubo_matrix, p_layers}. Translate QuboInstance → JSON. Translate response → QaoaResult.
   - capabilities: GET /capabilities → BackendCapabilities

3. Health checking: GET /health → sidecar status. Cache result for 30s.

4. Anti-corruption layer (DDD-001): ChemiqBridge translates between domain types and the sidecar's Python-centric JSON format. Domain types never leak sidecar-specific fields. Sidecar errors are mapped to domain error types.

5. Request/response DTOs (internal, not public): ChemiqVqeRequest, ChemiqVqeResponse, ChemiqQaoaRequest, ChemiqQaoaResponse — serde(rename_all = "snake_case")

6. Also create the Python sidecar stub: services/chemiq-sidecar/main.py with FastAPI endpoints matching the API surface in ADR-008. Include services/chemiq-sidecar/requirements.txt (pychemiq, pyqpanda3, fastapi, uvicorn) and services/chemiq-sidecar/Dockerfile.

Write London School TDD tests. Mock HTTP responses (use mockall on a trait wrapping reqwest, or use a test HTTP server):
- submit_vqe translates domain Hamiltonian to correct JSON and parses response
- submit_qaoa translates domain QUBO to correct JSON and parses response
- capabilities returns correct BackendCapabilities from sidecar response
- timeout error is mapped to domain error
- malformed JSON response returns parse error, not panic
- health check caches result for 30s

Verify: `cargo test -p pe-chemistry` passes.

Reference: ADR-008, ADR-006, DDD-001 (Quantum Simulation, Anti-Corruption Layer)
```

---

## Prompt 10: pe-ledger Cryptographic Journal and Witness Chain

```
Implement the pe-ledger crate with the append-only journal, hash chaining, and ML-DSA signing as specified in ADR-005 (plans/adr-005-post-quantum-cryptography.md), ADR-010 (plans/adr-010-append-only-journal-cryptographic-chaining.md), and DDD-003 (plans/ddd-003-aggregate-specifications.md, Aggregate 3: JournalChain).

This crate depends on pe-core, pe-rvf, pqcrypto-mldsa, pqcrypto-mlkem, and sha3.

Implement:

1. CryptoSigner trait (from ADR-004/ADR-005):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait CryptoSigner: Send + Sync {
       fn sign(&self, data: &[u8]) -> Result<MlDsaSignature>;
       fn verify(&self, data: &[u8], sig: &MlDsaSignature) -> Result<bool>;
   }
   ```

2. MlDsaSigner — real implementation using pqcrypto-mldsa (native only). Holds signing key.

3. MlDsaSignature — newtype wrapper around the signature bytes.

4. EntryHash — newtype around [u8; 32] (SHA3-256).

5. EntryType — enum of all 9 auditable event types from ADR-010: VariantDesigned, FitnessScored, StructureValidated, SafetyScreened, ExperimentRecorded, ModelUpdated, VqeCompleted, CycleCompleted, AgentRetired.

6. JournalEntry — struct with sequence_number, timestamp, prev_hash, entry_type, payload, signature. Enforce all invariants from DDD-003.

7. JournalChain — aggregate root (DDD-003, Aggregate 3):
   - new() → empty chain, tip_hash = [0u8; 32]
   - append_entry(entry_type, payload, signer) → Result<EntryHash>
     Enforces JC-1 through JC-5. Computes SHA3, signs, chains.
   - verify_chain() → Result<bool>
     Traverses all entries checking hash chain (JC-2) + signatures (JC-4). Returns Err(TamperDetected{index}) on failure.
   - len() → number of entries
   - tip_hash() → current chain tip

8. LedgerWriter trait (from ADR-004):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait LedgerWriter: Send + Sync {
       fn append_entry(&mut self, entry_type: EntryType, payload: Vec<u8>) -> Result<EntryHash>;
       fn verify_chain(&self) -> Result<bool>;
       fn len(&self) -> usize;
   }
   ```

9. SegmentProducer implementations:
   - JOURNAL_SEG: serialize JournalChain entries
   - WITNESS_SEG: serialize in QuDAG-compatible witness format

Write London School TDD tests. Mock CryptoSigner (returns deterministic 64-byte signature, verify always returns true):
- append to empty chain sets prev_hash to zeros (JC-3)
- append chains hashes correctly across 3 entries (JC-2)
- verify_chain succeeds on valid chain (JC-6)
- verify_chain detects tampered payload
- verify_chain detects tampered prev_hash
- verify_chain detects invalid signature (mock verify returns false)
- sequence_numbers are strictly sequential (JC-1)
- round-trip through JOURNAL_SEG preserves all entries
- WITNESS_SEG serialization produces parseable output

Also write one integration test with real MlDsaSigner (pqcrypto-mldsa): append 3 entries, verify chain with real crypto.

Verify: `cargo test -p pe-ledger` passes.

Reference: ADR-005, ADR-010, ADR-004, DDD-003 (Aggregate 3), DDD-001 (Trust & Audit Context)
```

---

## Prompt 11: pe-governance Lifecycle Management

```
Implement the pe-governance crate with autonomous agent lifecycle management backed by the daa framework, as specified in ADR-007 (plans/adr-007-safla-closed-loop-orchestration.md) and DDD-001 (plans/ddd-001-protein-engineering-domain-model.md, "Trust & Audit Context").

This crate depends on pe-core and daa.

Implement:

1. AgentMetrics — performance stats for a swarm agent:
   - agent_id: Uuid
   - role: AgentRole (enum matching the 6 roles from ADR-007)
   - cycles_completed: u64
   - avg_quality_score: f64 (average fitness of variants this agent contributed to)
   - avg_latency_ms: f64
   - error_count: u64

2. BudgetAllocation — compute budget assigned per agent per cycle:
   - allocations: BTreeMap<Uuid, BudgetEntry>
   - BudgetEntry: max_compute_ms, max_variants, priority_weight

3. LifecycleManager trait (from ADR-004):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait LifecycleManager: Send + Sync {
       fn should_retire(&self, agent: &AgentMetrics) -> bool;
       fn allocate_budget(&self, agents: &[AgentMetrics], cycle_config: &CycleConfig) -> BudgetAllocation;
       fn adjust_priorities(&mut self, cycle_result: &CycleResult);
   }
   ```

4. DaaLifecycleManager — concrete implementation using daa framework:
   - Retirement rule: retire if avg_quality_score < threshold AND cycles_completed > min_cycles
   - Budget allocation: proportional to avg_quality_score * priority_weight
   - Priority adjustment: increase exploration budget for under-represented Yamanaka factors

Write London School TDD tests (no mocks needed — leaf-like crate):
- should_retire returns true for low-quality agent past minimum cycles
- should_retire returns false for new agent (below min_cycles)
- should_retire returns false for high-quality agent
- allocate_budget distributes proportionally to quality
- allocate_budget gives minimum budget to all agents (floor)
- adjust_priorities increases budget for under-explored factor

Verify: `cargo test -p pe-governance` passes.

Reference: ADR-007, DDD-001 (Trust & Audit Context)
```

---

## Prompt 12: pe-stream Lab Instrument Ingestion

```
Implement the pe-stream crate for live laboratory instrument data ingestion as specified in DDD-001 (plans/ddd-001-protein-engineering-domain-model.md, "Experiment & Lab Context") and DDD-002 (plans/ddd-002-bounded-context-integration-patterns.md, Integration 3).

This crate is native-only. It depends on pe-core, midstream, and tokio.

Implement:

1. InstrumentType — enum: Opentrons, Hamilton, FlowCytometer, PlateReader

2. InstrumentReading — raw data point:
   - instrument_type: InstrumentType
   - instrument_id: String
   - timestamp: DateTime<Utc>
   - raw_data: BTreeMap<String, f64>
   - channel: Option<String>

3. InstrumentSource trait (from ADR-004):
   ```rust
   #[async_trait]
   #[cfg_attr(test, automock)]
   pub trait InstrumentSource: Send + Sync {
       async fn read_next(&mut self) -> Result<Option<InstrumentReading>>;
       fn instrument_type(&self) -> InstrumentType;
   }
   ```

4. ReadingNormalizer — anti-corruption layer (DDD-001) that converts raw InstrumentReadings into ExperimentResult domain types:
   - Maps instrument-specific field names to canonical metric names
   - Validates readings (reject NaN, Inf, out-of-range values)
   - Associates readings with variant IDs via plate map or barcode lookup

5. StreamProcessor — consumes an InstrumentSource stream and produces normalized ExperimentResults:
   ```rust
   pub struct StreamProcessor<S: InstrumentSource> {
       source: S,
       normalizer: ReadingNormalizer,
   }
   impl<S: InstrumentSource> StreamProcessor<S> {
       pub async fn process_next(&mut self) -> Result<Option<ExperimentResult>>;
       pub async fn process_batch(&mut self, max: usize) -> Result<Vec<ExperimentResult>>;
   }
   ```

6. MidstreamSource — wraps midstream crate for real-time AI stream analysis (native only).

Write London School TDD tests. Mock InstrumentSource:
- process_next returns ExperimentResult from mocked instrument reading
- process_next returns None when source is exhausted
- normalizer rejects NaN values in raw data
- normalizer maps instrument-specific field names to canonical names
- process_batch collects up to max results
- instrument_type is correctly propagated

Verify: `cargo test -p pe-stream` passes.

Reference: DDD-001 (Experiment & Lab Context), DDD-002 (Integration 3), ADR-004
```

---

## Prompt 13: pe-swarm Agent Orchestration and SAFLA Loop

```
Implement the pe-swarm crate — the multi-agent orchestration layer with the SAFLA closed loop as specified in ADR-007 (plans/adr-007-safla-closed-loop-orchestration.md), DDD-001 (plans/ddd-001-protein-engineering-domain-model.md, "Variant Design Context"), and DDD-002 (plans/ddd-002-bounded-context-integration-patterns.md, all integration patterns).

This crate depends on pe-core, pe-neural (FitnessPredictor), pe-vector (VectorStore, EmbeddingModel), pe-quantum (QuantumBackend), pe-ledger (LedgerWriter), pe-stream (InstrumentSource), pe-governance (LifecycleManager), and pe-rvf (SegmentProducer for HOT_SEG).

Implement:

1. AgentRole — enum: SequenceExplorer, FitnessScorer, StructuralValidator, ToxicityScreener, ExperimentDesigner, QuantumDispatcher

2. AgentTask / AgentResult — enums wrapping the input/output for each role

3. SwarmAgent trait (from ADR-004):
   ```rust
   #[async_trait]
   #[cfg_attr(test, automock)]
   pub trait SwarmAgent: Send + Sync {
       async fn execute(&self, task: AgentTask) -> Result<AgentResult>;
       fn role(&self) -> AgentRole;
   }
   ```

4. EvolutionEngine trait (from SPARC pseudocode):
   ```rust
   #[cfg_attr(test, automock)]
   pub trait EvolutionEngine: Send + Sync {
       fn mutate(&self, variant: &ProteinVariant) -> Result<ProteinVariant>;
       fn crossover(&self, a: &ProteinVariant, b: &ProteinVariant) -> Result<ProteinVariant>;
       fn select(&self, population: &[ScoredVariant], top_k: usize) -> Vec<ScoredVariant>;
   }
   ```

5. Concrete agent implementations (each implements SwarmAgent):
   - SequenceExplorerAgent — uses EvolutionEngine to mutate/crossover
   - FitnessScorerAgent — delegates to FitnessPredictor + EmbeddingModel
   - StructuralValidatorAgent — uses VectorStore HNSW search for plausibility
   - ToxicityScreenerAgent — classifies oncogenic risk based on known oncogene similarity
   - ExperimentDesignerAgent — generates lab protocol stubs for Opentrons
   - QuantumDispatcherAgent — submits VQE/QAOA via QuantumBackend

6. CycleConfig — generation number, population_size, mutation_rate, crossover_rate, quantum_enabled, top_k for promotion

7. CycleResult — promoted variants, generation number, stats (variants_created, scored, validated, screened)

8. SwarmCoordinator trait and DefaultCoordinator implementation:
   ```rust
   #[async_trait]
   pub trait SwarmCoordinator: Send + Sync {
       async fn run_design_cycle(&mut self, config: CycleConfig) -> Result<CycleResult>;
   }
   ```
   DefaultCoordinator orchestrates the SAFLA loop exactly as specified in ADR-007:
   DESIGN → SCORE → VALIDATE → SCREEN → (QUANTUM) → LOG → (LEARN) → PROMOTE

9. SimpleEvolutionEngine — concrete EvolutionEngine:
   - mutate: random single-point amino acid substitution
   - crossover: single-point crossover at random position
   - select: sort by composite score, take top_k

10. HOT_SEG SegmentProducer — serializes top-100 promoted candidates.

Write London School TDD tests. Mock ALL collaborators (this is the critical London School layer):
- SAFLA closed loop test: mock_explorer returns 10 variants, mock_scorer scores them, mock_validator passes 8/10, mock_screener passes 7/8. Assert result.promoted.len() == 7. Verify call counts on each mock.
- Agent retirement: mock LifecycleManager returns retire=true for slow agent. Verify agent is removed.
- Quantum dispatch: when config.quantum_enabled, verify mock QuantumBackend.submit_vqe is called for top-N candidates.
- Ledger integration: verify LedgerWriter.append_entry called with CycleCompleted event.
- Evolution engine: mutate produces valid child variant. Crossover combines parents. Select returns top_k.
- Empty population: run_design_cycle with 0 population returns empty result, no errors.

Verify: `cargo test -p pe-swarm` passes.

Reference: ADR-007, ADR-002, ADR-004, DDD-001 (Variant Design), DDD-002 (all integrations)
```

---

## Prompt 14: pe-api Axum HTTP/WebSocket Server

```
Implement the pe-api crate — the axum HTTP/WebSocket API layer as specified in the SPARC specification (plans/sparc-specification.md, Phase 8) and DDD-002 (plans/ddd-002-bounded-context-integration-patterns.md).

This crate is native-only. It depends on pe-core, pe-swarm (SwarmCoordinator), pe-neural (FitnessPredictor), pe-vector (VectorStore, EmbeddingModel), pe-ledger (LedgerWriter), pe-quantum (QuantumBackend), and pe-rvf.

Implement:

1. AppState — holds all domain trait objects via dependency injection (ADR-004):
   ```rust
   pub struct AppState {
       pub scorer: Arc<dyn FitnessPredictor>,
       pub store: Arc<RwLock<dyn VectorStore>>,
       pub embedder: Arc<dyn EmbeddingModel>,
       pub ledger: Arc<RwLock<dyn LedgerWriter>>,
       pub coordinator: Arc<RwLock<dyn SwarmCoordinator>>,
   }
   ```

2. REST endpoints (axum handlers):
   - POST /api/variants — create a new ProteinVariant (wild_type or from_mutation)
   - POST /api/variants/score — score a variant, returns FitnessScore JSON
   - GET /api/variants/:id — get variant by ID
   - GET /api/variants/search?sequence=...&k=5 — nearest-neighbor search by sequence embedding
   - POST /api/evolution/cycle — trigger a design cycle, returns CycleResult
   - GET /api/evolution/top?k=10 — get top-k promoted candidates from HOT_SEG
   - GET /api/ledger/verify — verify journal chain integrity
   - GET /api/ledger/entries?limit=50&offset=0 — paginated journal entries
   - GET /api/health — health check

3. WebSocket endpoint:
   - WS /api/ws/evolution — streams CycleResult events as design cycles complete

4. Error handling: map domain errors to appropriate HTTP status codes (400 for validation, 404 for not found, 500 for internal). Use a consistent JSON error response format.

5. CORS configuration for browser WASM clients.

6. Router construction: pub fn build_router(state: AppState) -> axum::Router

Write London School TDD tests. Mock ALL domain traits in AppState:
- POST /api/variants/score returns 200 with FitnessScore JSON (mock scorer returns predetermined score)
- POST /api/variants/score with invalid sequence returns 400
- GET /api/variants/:id returns 404 for unknown ID
- GET /api/variants/search returns k results (mock store returns fixture)
- POST /api/evolution/cycle returns CycleResult (mock coordinator)
- GET /api/ledger/verify returns {valid: true} (mock ledger)
- GET /api/health returns 200

Use axum::test for HTTP testing.

Verify: `cargo test -p pe-api` passes.

Reference: SPARC Phase 8, ADR-004, DDD-002
```

---

## Prompt 15: pe-wasm Browser WASM Entry Point

```
Implement the pe-wasm crate — the WASM browser entry point as specified in the SPARC specification (plans/sparc-specification.md, Phase 8) and ADR-003 (plans/adr-003-feature-flag-native-vs-wasm.md).

This crate is wasm-only (feature = "wasm"). It depends on pe-core, pe-vector (InMemoryVectorStore), pe-neural (EnsemblePredictor with stub scorers), pe-quantum-wasm (LocalSimulator), and pe-rvf.

Implement:

1. WASM-exported functions via #[wasm_bindgen]:
   - score_sequence(sequence: &str) -> JsValue — validates sequence, embeds, scores, returns FitnessScore as JSON
   - run_evolution_step(population_json: &str, config_json: &str) -> JsValue — runs one evolution generation, returns CycleResult as JSON
   - run_local_quantum_sim(hamiltonian_json: &str) -> JsValue — runs VQE on local simulator, returns VqeResult as JSON
   - search_similar(sequence: &str, k: u32) -> JsValue — embeds sequence, searches nearest neighbors, returns results as JSON
   - verify_ledger() -> JsValue — verifies local journal chain, returns {valid: bool}

2. WasmEngine — internal struct holding:
   - InMemoryVectorStore
   - EnsemblePredictor (with stub scorers)
   - LocalSimulatorBackend (pe-quantum-wasm)
   - JournalChain (local, verification-only — no signing in WASM per ADR-005)

3. Initialization:
   - init() — #[wasm_bindgen(start)], sets up panic hook (console_error_panic_hook), initializes tracing-wasm
   - load_rvf(data: &[u8]) -> JsValue — loads an .rvf file, populates WasmEngine from segments (VEC_SEG → store, QUANT_SEG → models, JOURNAL_SEG → ledger)

4. Error handling: all exported functions return Result<JsValue, JsValue> where errors are JSON {error: string}.

5. Memory management: use serde-wasm-bindgen for type conversion. Avoid large allocations; stream RVF segments.

Write tests that can run under wasm-pack test --node:
- score_sequence with valid sequence returns parseable JSON with composite in [0, 1]
- score_sequence with invalid sequence returns error JSON
- run_evolution_step with small population returns next generation
- search_similar returns k results
- verify_ledger returns {valid: true} on empty/valid chain

Verify: `wasm-pack build crates/pe-wasm --target bundler -- --no-default-features --features wasm` succeeds. Bundle < 10 MB.

Reference: ADR-003, ADR-005 (WASM crypto constraint), ADR-009, SPARC Phase 8
```

---

## Prompt 16: pe-cli Command-Line Interface

```
Implement the pe-cli crate — the native CLI entry point as specified in the SPARC specification (plans/sparc-specification.md, Phase 8).

This crate is native-only. It depends on pe-core, pe-swarm, pe-neural, pe-vector, pe-quantum, pe-ledger, pe-rvf, pe-stream, pe-governance, and pe-api.

Implement using clap for argument parsing:

1. Commands:
   - `protein-engine init` — create a new empty .rvf file with MANIFEST_SEG
   - `protein-engine score <sequence>` — score a protein sequence, print FitnessScore
   - `protein-engine evolve --generations N --population-size M` — run N evolution cycles, print summary per generation
   - `protein-engine search <sequence> --k K` — find K nearest neighbors by embedding similarity
   - `protein-engine quantum vqe <molecule>` — run VQE simulation, print energy
   - `protein-engine quantum qaoa <qubo-file>` — run QAOA optimization, print solution
   - `protein-engine ledger verify` — verify journal chain integrity
   - `protein-engine ledger show --limit N` — show last N journal entries
   - `protein-engine rvf build --output <path>` — assemble .rvf from current state
   - `protein-engine rvf inspect <path>` — show .rvf manifest and segment summary
   - `protein-engine serve --port 8080` — start the axum HTTP server (delegates to pe-api)

2. Dependency wiring: construct all real implementations and wire them into trait objects per ADR-004. This is the composition root.

3. Output formatting: structured JSON (--json flag) or human-readable table (default).

4. Configuration: read from environment variables (CHEMIQ_URL, QUANTUM_BACKEND, etc.) or --config file.

Write integration tests:
- `init` creates a valid .rvf file
- `score` with valid sequence prints a composite score
- `evolve --generations 1` completes and prints generation summary
- `ledger verify` on fresh .rvf returns "valid"
- `rvf inspect` on a built .rvf shows correct segment count

Verify: `cargo test -p pe-cli` passes. `cargo build -p pe-cli --features native` produces a working binary.

Reference: SPARC Phase 8, ADR-004 (composition root)
```

---

## Prompt 17: Python Sidecar Implementation

```
Implement the full chemiq-sidecar Python service as specified in ADR-008 (plans/adr-008-python-sidecar-quantum-chemistry.md).

Create services/chemiq-sidecar/ with:

1. main.py — FastAPI application with these endpoints:
   - POST /vqe — accepts {molecule: str, basis_set: str, ansatz: str, max_iterations: int}. Uses pyChemiQ to run VQE. Returns {energy: float, parameters: [float], iterations: int, converged: bool}.
   - POST /qaoa — accepts {qubo_matrix: [[float]], p_layers: int}. Uses pyqpanda-algorithm for QAOA. Returns {solution: [int], cost: float, iterations: int}.
   - GET /health — returns {status: "ok", backend: "origin_quantum"|"simulator"}
   - GET /capabilities — returns {max_qubits: int, available_ansatze: [str], backend: str}

2. requirements.txt:
   - pychemiq
   - pyqpanda3
   - pyqpanda_alg
   - fastapi
   - uvicorn
   - pydantic

3. Dockerfile:
   - FROM python:3.11-slim
   - Install requirements
   - EXPOSE 8100
   - CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]

4. Error handling: if pyChemiQ is not available (import fails), fall back to a simple numpy-based simulator and set backend to "simulator" in /health and /capabilities.

5. Input validation with Pydantic models for all request/response types.

Write pytest tests:
- /health returns 200 with status "ok"
- /vqe with H2 molecule returns energy within tolerance of -1.137 Ha
- /qaoa with trivial QUBO returns correct solution
- /vqe with invalid molecule returns 400
- /capabilities returns correct max_qubits

Reference: ADR-008
```

---

## Prompt 18: Docker and Docker Compose Configuration

```
Create the Docker infrastructure for Protein-Engine as specified in the research doc (plans/research.md, "Repository Structure" and "Deployment Philosophy").

Create:

1. docker/Dockerfile.node — full server node:
   - Multi-stage build: Rust builder stage (cargo build --release --features native) → minimal runtime image
   - COPY the built binary and any required assets
   - EXPOSE 8080
   - CMD starts pe-cli serve

2. docker/Dockerfile.chemiq — pyChemiQ sidecar:
   - FROM python:3.11-slim
   - COPY services/chemiq-sidecar/
   - Install dependencies
   - EXPOSE 8100

3. docker/Dockerfile.wasm-builder — wasm-pack build container:
   - FROM rust with wasm-pack installed
   - Runs wasm-pack build crates/pe-wasm

4. docker-compose.yml — production stack:
   - protein-engine service (Dockerfile.node)
   - chemiq-sidecar service (Dockerfile.chemiq)
   - Health checks on both services
   - Environment variables: CHEMIQ_URL=http://chemiq-sidecar:8100
   - Volumes for .rvf file persistence

5. docker-compose.dev.yml — dev stack:
   - Same services with hot reload (cargo-watch or similar)
   - Exposed ports for debugging
   - Volume mounts for source code

6. build-wasm.sh — one-command WASM build script:
   - Runs wasm-pack build with correct flags
   - Copies output to web/pkg/
   - Prints bundle size

7. build-rvf.sh — one-command .rvf assembly script:
   - Builds native binary
   - Runs pe-cli rvf build
   - Prints segment summary

All Dockerfiles should be minimal, use multi-stage builds, and not include unnecessary tools.

Reference: plans/research.md (Deployment Philosophy, Repository Structure), ADR-001
```

---

## Prompt 19: Web Frontend Scaffold

```
Create the web frontend scaffold for Protein-Engine as specified in the research doc (plans/research.md, "Repository Structure").

Create web/ with:

1. package.json — dependencies: vite, typescript, vite-plugin-wasm
   - scripts: dev, build, preview
   - devDependencies: vite, typescript, vite-plugin-wasm

2. vite.config.ts — configured with vite-plugin-wasm for loading pe-wasm WASM module

3. tsconfig.json — strict TypeScript config

4. index.html — minimal shell that loads main.ts

5. src/main.ts — TypeScript entry point:
   - Imports pe-wasm WASM module (from ../pkg/ after wasm-pack build)
   - Initializes the WASM engine
   - Demonstrates: score a hardcoded sequence, display result
   - Placeholder for loading .rvf file from user upload or URL

6. src/types.ts — TypeScript interfaces matching pe-core types:
   - ProteinVariant, FitnessScore, CycleResult, VqeResult

7. src/components/ — placeholder files:
   - sequence-editor.ts — text input for amino acid sequences
   - fitness-chart.ts — placeholder for fitness visualization
   - dag-viewer.ts — placeholder for lineage DAG visualization

This is a scaffold only — functional UI comes later. The goal is to verify the WASM module loads and executes in a browser context.

Reference: plans/research.md (Web Frontend), ADR-003 (wasm feature)
```

---

## Prompt 20: Integration Tests — Cross-Crate Wiring

```
Create a top-level integration test suite that verifies real crate-to-crate interactions, replacing London School mocks with real implementations one layer at a time per the SPARC refinement plan (plans/sparc-specification.md, "London School TDD Workflow Per Crate" step 7-8).

Create tests/ directory at workspace root with:

1. tests/integration_scoring_pipeline.rs:
   - Wire real pe-core types + real InMemoryVectorStore + real EnsemblePredictor (stub scorers)
   - Create 50 ProteinVariants, embed them (use a deterministic test embedder), store in VectorStore
   - Score all variants, verify FitnessScores are valid
   - Search nearest neighbors, verify results are sorted by similarity
   - No mocks — this validates the pe-core → pe-vector → pe-neural pipeline

2. tests/integration_evolution_cycle.rs:
   - Wire real SimpleEvolutionEngine + real EnsemblePredictor + real InMemoryVectorStore + mock LedgerWriter + mock QuantumBackend
   - Run 3 evolution cycles with population of 20
   - Verify population grows/evolves across generations
   - Verify top candidates are correctly selected
   - Verify LedgerWriter.append_entry was called per cycle

3. tests/integration_ledger_chain.rs:
   - Wire real JournalChain + real MlDsaSigner (actual post-quantum crypto)
   - Append 100 entries of various types
   - Verify chain integrity
   - Serialize to JOURNAL_SEG, deserialize, re-verify
   - Tamper with one entry, verify detection

4. tests/integration_quantum_local.rs:
   - Wire real QuantumRouter + real LocalSimulatorBackend (pe-quantum-wasm)
   - No remote backends registered — router must fall back to local
   - Run VQE on H2 molecule, verify energy ≈ -1.137 Ha
   - Run QAOA on trivial QUBO, verify correct solution

5. tests/integration_rvf_assembly.rs:
   - Wire real RvfBuilder + real segment producers from all crates
   - Build a complete .rvf file with all available segments
   - Verify MANIFEST_SEG capabilities
   - Verify parent_hash lineage
   - Deserialize and verify all segments are intact
   - Check file_hash is deterministic

6. tests/integration_full_safla.rs:
   - Wire the complete stack: all real implementations except QuantumBackend (use LocalSimulator) and InstrumentSource (mock — no lab hardware in CI)
   - Run a complete SAFLA cycle: design → score → validate → screen → quantum → log → promote
   - Verify promoted candidates are valid ProteinVariants with passing fitness, structure, and safety scores
   - Verify journal chain has entries for each step
   - This is the primary acceptance test for the platform

Reference: SPARC Completion (Test Pyramid), ADR-002 (step 7-8), DDD-002 (all integrations)
```

---

## Prompt 21: CI Pipeline Configuration

```
Create the CI/CD pipeline configuration as specified in the SPARC completion section (plans/sparc-specification.md, "CI Pipeline Stages").

Create .github/workflows/ci.yml with these stages:

1. fmt — cargo fmt --check --all
2. clippy — cargo clippy --all-targets --features native -- -D warnings
3. test-native — cargo test --features native (unit + integration tests)
4. test-wasm — cargo test --target wasm32-unknown-unknown -p pe-core -p pe-quantum-wasm (no_std crates)
5. build-wasm — wasm-pack build crates/pe-wasm, check bundle size < 10 MB
6. cross-compile — cross build --target aarch64-unknown-linux-gnu --features native (verify Raspberry Pi target)
7. build-rvf — ./build-rvf.sh, validate the output artifact
8. docker — docker compose -f docker-compose.dev.yml up --build --abort-on-container-exit (full stack smoke test)

Matrix strategy: run on ubuntu-latest. Cache cargo registry and target dir. Install wasm-pack, cross, and wasm32-unknown-unknown target.

Also create:
- .github/workflows/release.yml — triggered on tags, builds release binaries for x86_64 + aarch64, builds WASM, assembles .rvf, creates GitHub release with all artifacts
- Makefile or justfile at root with convenience targets: make test, make build, make wasm, make rvf, make docker

Reference: SPARC Completion (CI Pipeline Stages, Definition of Done)
```

---

## Prompt 22: MCP Server Integration

```
Create the MCP (Model Context Protocol) server integration that allows Claude Code to operate the entire platform, as specified in FR-12 and the research doc (plans/research.md).

This wraps the existing @ruvector/rvf-mcp-server npm package with Protein-Engine-specific tool definitions.

Create mcp/ directory with:

1. mcp/protein-engine-mcp.json — MCP server configuration:
   - Tool definitions for all pe-cli commands exposed as MCP tools:
     - score_sequence(sequence: string) → FitnessScore
     - evolve(generations: int, population_size: int) → CycleResult
     - search_similar(sequence: string, k: int) → Vec<ScoredVariant>
     - quantum_vqe(molecule: string) → VqeResult
     - ledger_verify() → {valid: bool}
     - rvf_inspect(path: string) → ManifestSummary
     - create_variant(name: string, sequence: string, factor: string) → ProteinVariant

2. mcp/server.ts — thin TypeScript wrapper:
   - Imports @ruvector/rvf-mcp-server
   - Registers Protein-Engine-specific tools
   - Delegates to pe-cli binary via child process or to pe-api HTTP endpoints

3. mcp/package.json — dependencies: @ruvector/rvf-mcp-server, @ruvector/rvf-node

4. Instructions in mcp/README.md for adding to Claude Code config:
   ```json
   {
     "mcpServers": {
       "protein-engine": {
         "command": "npx",
         "args": ["@ruvector/rvf-mcp-server", "protein-engine.rvf"]
       }
     }
   }
   ```

Reference: FR-12, plans/research.md (MCP interface)
```

---

## Prompt 23: E2E Smoke Tests

```
Create end-to-end smoke tests that verify the platform works across deployment targets as specified in the SPARC completion section (plans/sparc-specification.md, "Test Pyramid" — E2E layer).

Create tests/e2e/ with:

1. tests/e2e/test_docker_stack.sh:
   - docker compose up -d
   - Wait for health checks to pass
   - curl POST /api/variants/score with a test sequence → verify 200
   - curl POST /api/evolution/cycle → verify CycleResult JSON
   - curl GET /api/ledger/verify → verify {valid: true}
   - curl GET /api/health → verify 200
   - docker compose down

2. tests/e2e/test_cli.sh:
   - Build pe-cli binary
   - Run `protein-engine init --output /tmp/test.rvf`
   - Run `protein-engine score MKWVTFISLLLLFSSAYS` → verify output contains "composite"
   - Run `protein-engine evolve --generations 2 --population-size 10` → verify output contains "Generation 2"
   - Run `protein-engine ledger verify` → verify "valid"
   - Run `protein-engine rvf inspect /tmp/test.rvf` → verify segment count

3. tests/e2e/test_wasm.js (Node.js):
   - Load pe-wasm package from web/pkg/
   - Call init()
   - Call score_sequence("MKWVTFISLLLLFSSAYS") → verify parseable result with composite in [0, 1]
   - Call verify_ledger() → verify {valid: true}

These tests are the top of the test pyramid — run in CI after all other stages pass.

Reference: SPARC Completion (Test Pyramid, Definition of Done for Platform)
```

---

## Dependency Graph Summary

```
Prompt 01: Workspace scaffold             (no dependencies)
Prompt 02: pe-core                        (depends on: 01)
Prompt 03: pe-rvf                         (depends on: 01, 02)
Prompt 04: pe-vector                      (depends on: 02, 03)
Prompt 05: pe-neural                      (depends on: 02, 04)
Prompt 06: pe-solver                      (depends on: 02)
Prompt 07: pe-quantum-wasm                (depends on: 02)
Prompt 08: pe-quantum                     (depends on: 02, 03, 07)
Prompt 09: pe-chemistry                   (depends on: 02, 08)
Prompt 10: pe-ledger                      (depends on: 02, 03)
Prompt 11: pe-governance                  (depends on: 02)
Prompt 12: pe-stream                      (depends on: 02)
Prompt 13: pe-swarm                       (depends on: 02, 04, 05, 08, 10, 11, 12)
Prompt 14: pe-api                         (depends on: 02, 04, 05, 08, 10, 13)
Prompt 15: pe-wasm                        (depends on: 02, 04, 05, 07)
Prompt 16: pe-cli                         (depends on: all crates)
Prompt 17: Python sidecar                 (depends on: 09 for API contract)
Prompt 18: Docker                         (depends on: 16, 17)
Prompt 19: Web frontend                   (depends on: 15)
Prompt 20: Integration tests              (depends on: all crates)
Prompt 21: CI pipeline                    (depends on: 18, 19, 20)
Prompt 22: MCP server                     (depends on: 14 or 16)
Prompt 23: E2E smoke tests               (depends on: 18, 19, 22)
```

### Parallelization Opportunities

These groups can be executed concurrently within each tier:

```
Tier 0: [01]
Tier 1: [02]
Tier 2: [03, 06, 07, 11, 12]        ← 5 prompts in parallel
Tier 3: [04, 08, 10]                 ← 3 prompts in parallel
Tier 4: [05, 09]                     ← 2 prompts in parallel
Tier 5: [13, 15, 17]                 ← 3 prompts in parallel
Tier 6: [14, 16]                     ← 2 prompts in parallel
Tier 7: [18, 19, 22]                 ← 3 prompts in parallel
Tier 8: [20]
Tier 9: [21, 23]                     ← 2 prompts in parallel
```
