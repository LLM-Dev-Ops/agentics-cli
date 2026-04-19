#!/usr/bin/env tsx
/**
 * promotion-sampler.ts (ADR-PIPELINE-084 §2.1 CLI).
 *
 * Draws a weekly sample of domain agent findings for human FP-rate review.
 * Pure logic (parse, filter, sample, CSV) lives in src/promotion/sampler-lib.ts.
 *
 * Usage:
 *   npx tsx tools/promotion-sampler.ts --domain <name> [--window-days 7] [--out sample.csv] [--input findings.jsonl] [--seed <n>]
 *
 * Data source priority:
 *   1. --input <path>              — JSONL or JSON-array file (testing / dev)
 *   2. OBSERVATORY_TELEMETRY_URL   — env var, HTTP GET returning JSONL/JSON
 *   3. (error)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { argv, env, exit, stderr, stdout } from 'node:process';
import {
  parseFindings,
  filterInWindow,
  filterBlocking,
  drawSample,
  toCsv,
  type Finding,
} from '../src/promotion/sampler-lib.js';

interface Args {
  domain: string;
  windowDays: number;
  out: string;
  input?: string;
  seed?: number;
}

function parseArgs(): Args {
  const args: Partial<Args> = { windowDays: 7, out: 'promotion-sample.csv' };
  const raw = argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    const flag = raw[i];
    const value = raw[i + 1];
    switch (flag) {
      case '--domain': args.domain = value; i++; break;
      case '--window-days': args.windowDays = parseInt(value ?? '7', 10); i++; break;
      case '--out': args.out = value ?? args.out; i++; break;
      case '--input': args.input = value; i++; break;
      case '--seed': args.seed = parseInt(value ?? '', 10); i++; break;
      case '-h': case '--help': printUsage(); exit(0);
    }
  }

  if (!args.domain) {
    stderr.write('ERROR: --domain is required\n\n');
    printUsage();
    exit(2);
  }

  return args as Args;
}

function printUsage(): void {
  stderr.write(`Usage:
  npx tsx tools/promotion-sampler.ts --domain <name> [--window-days 7] [--out sample.csv] [--input findings.jsonl] [--seed <n>]

Draws a 10%% random sample (floor 30, ceiling 200) of domain agent findings
from observatory telemetry for human FP-rate review per ADR-PIPELINE-084 §2.1.

Data source priority:
  1. --input <path>              (file, JSONL or JSON array)
  2. OBSERVATORY_TELEMETRY_URL   (env, HTTP JSONL or JSON array)
  3. (error)
`);
}

async function loadFindings(args: Args): Promise<Finding[]> {
  if (args.input) {
    if (!existsSync(args.input)) {
      throw new Error(`Input file not found: ${args.input}`);
    }
    return parseFindings(readFileSync(args.input, 'utf-8'));
  }

  const url = env['OBSERVATORY_TELEMETRY_URL'];
  if (url) {
    const response = await fetch(`${url}?domain=${encodeURIComponent(args.domain)}&window_days=${args.windowDays}`);
    if (!response.ok) {
      throw new Error(`Observatory fetch failed: ${response.status} ${response.statusText}`);
    }
    return parseFindings(await response.text());
  }

  throw new Error('No data source — provide --input <path> or set OBSERVATORY_TELEMETRY_URL env var');
}

async function main(): Promise<void> {
  const args = parseArgs();
  const allFindings = await loadFindings(args);
  const windowed = filterInWindow(allFindings, args.domain, args.windowDays);
  const blocking = filterBlocking(windowed);
  const sampleOpts = args.seed !== undefined ? { seed: args.seed } : {};
  const sample = drawSample(blocking, sampleOpts);

  writeFileSync(args.out, toCsv(sample), 'utf-8');

  stdout.write(`Domain: ${args.domain}\n`);
  stdout.write(`Window: last ${args.windowDays} days\n`);
  stdout.write(`Total findings (all): ${allFindings.length}\n`);
  stdout.write(`  after window+domain filter: ${windowed.length}\n`);
  stdout.write(`  after blocking filter:      ${blocking.length}\n`);
  stdout.write(`Sample size:                  ${sample.length}\n`);
  stdout.write(`CSV written to:               ${args.out}\n`);

  if (blocking.length < 30) {
    stdout.write(`\n⚠ WARNING: < 30 blocking findings in window. Per ADR-084 §2.2, if this persists for 3 consecutive weeks, domain cannot promote from advisory.\n`);
  }
}

main().catch(err => {
  stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  exit(1);
});
