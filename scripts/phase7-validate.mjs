#!/usr/bin/env node
// ADR-PIPELINE-098 — standalone Phase 7 validation harness.
// Runs Phase 7 against an existing run dir, reports what landed.
// Usage: node scripts/phase7-validate.mjs <runDir>

import * as fs from 'node:fs';
import * as path from 'node:path';

const runDir = process.argv[2];
if (!runDir || !fs.existsSync(runDir)) {
  console.error('Usage: node scripts/phase7-validate.mjs <runDir>');
  process.exit(2);
}

const { executePhase7 } = await import(path.resolve('dist/pipeline/phase7/coordinator.js'));

const start = Date.now();
const result = await executePhase7({
  runDir,
  traceId: 'phase7-validate-' + Date.now(),
  scenarioQuery: 'standalone validation run',
  options: {},
});
const elapsedMs = Date.now() - start;

const deliverablesDir = path.join(runDir, 'deliverables');
let onDiskCount = 0;
let bySection = {};
if (fs.existsSync(deliverablesDir)) {
  for (const sub of fs.readdirSync(deliverablesDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const files = fs.readdirSync(path.join(deliverablesDir, sub.name)).filter((f) => /\.(md|json|csv)$/.test(f));
    onDiskCount += files.length;
    bySection[sub.name] = files.length;
  }
}

console.log('='.repeat(72));
console.log(`Phase 7 validation against: ${runDir}`);
console.log('='.repeat(72));
console.log(`status:                 ${result.status}`);
console.log(`deliverables_total:     ${result.deliverables_total}`);
console.log(`deliverables_emitted:   ${result.deliverables_emitted ?? '(not exposed)'}`);
console.log(`deliverables_skeleton:  ${result.deliverables_skeleton ?? '(not exposed)'}`);
console.log(`deliverables_failed:    ${result.deliverables_failed ?? '(not exposed)'}`);
console.log(`coherence_violations:   ${(result.coherence_violations ?? []).length}`);
console.log(`timing_ms (returned):   ${result.timing_ms ?? '(not exposed)'}`);
console.log(`timing_ms (wall):       ${elapsedMs}`);
console.log('');
console.log(`on-disk count:          ${onDiskCount}`);
console.log('per section:');
for (const [s, n] of Object.entries(bySection).sort()) {
  console.log(`  ${s.padEnd(28)} ${n}`);
}
console.log('');
console.log('manifest:');
const manifestPath = path.join(deliverablesDir, 'phase7-manifest.json');
if (fs.existsSync(manifestPath)) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  console.log(`  emitted: ${m.deliverables_emitted ?? '?'} skeleton: ${m.deliverables_skeleton ?? '?'} failed: ${m.deliverables_failed ?? '?'} violations: ${(m.coherence_violations ?? []).length}`);
} else {
  console.log('  (no phase7-manifest.json on disk)');
}
