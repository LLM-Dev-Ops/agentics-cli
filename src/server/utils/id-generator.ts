/**
 * ID Generator Utilities
 *
 * Generates consistent, prefixed IDs for various resource types.
 */

/**
 * Generate a random hex string of specified length
 */
function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
}

/**
 * Generate a timestamped ID with prefix
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = randomHex(8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Generate IDs for specific resource types
 */
export const ids = {
  simulation: () => generateId('sim'),
  manifest: () => generateId('manifest'),
  plan: () => generateId('plan'),
  run: () => generateId('run'),
  roi: () => generateId('roi'),
  intent: () => generateId('intent'),
  export: () => generateId('export'),
  diligence: () => generateId('diligence'),
  erp: () => generateId('erp'),
  scenario: () => generateId('scenario'),
} as const;

/**
 * Generate a checksum-like string for responses
 */
export function generateChecksum(): string {
  return `sha256:${randomHex(64)}`;
}

/**
 * Generate an artifact location URL
 */
export function generateArtifactLocation(type: string, id: string): string {
  return `https://artifacts.agentics.dev/${type}/${id}`;
}
