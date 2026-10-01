import { describe, expect, it } from 'vitest';
import { read } from './repo.js';

/**
 * ARCH-ASYNCAPI-CONFORMANCE (M6-GATE, condition 4). Before this rule nothing in
 * the workspace opened contracts/asyncapi.yaml or catalog/realtime-events.json --
 * the two files were documentation that only humans read, the same D-38 drift
 * class screen-catalog.yaml already demonstrated. The gate's own wording is
 * "every EMITTED envelope", so the containment is one-directional: an emitted
 * event type must be declared, a declared channel need not yet be emitted.
 */

/** Event types that are outbox domain rows, never socket envelopes. */
const NON_REALTIME_OUTBOX_EVENTS = new Set([
  // Internal work-item relays: outbox-relay.ts turns each into a BullMQ job.
  // They never reach a client, so they are deliberately not AsyncAPI channels.
  'import.job.created',
  'bulk-update.job.created',
  // M4-S4's durable snapshot record. Deliberately visible before a consumer
  // exists, the same boundary campaign.execution_state_changed's own contract
  // comment describes -- but unlike that one it has no client-facing shape
  // agreed yet, so it is not declared as a channel.
  'campaign.snapshot_frozen',
  'campaign.snapshot_superseded',
]);

/** Files that construct a realtime envelope destined for a socket. */
const ENVELOPE_SOURCES = [
  'apps/api/src/campaigns/progress-event.ts',
  'apps/api/src/realtime/realtime.gateway.ts',
  'apps/worker/src/campaign-send/progress-event.ts',
  'apps/worker/src/job-events.ts',
  'apps/worker/src/progress-reconcile.ts',
  'apps/api/src/quota/quota-event.ts',
];

const REQUIRED_ENVELOPE_FIELDS = ['event_id', 'event_type', 'occurred_at', 'tenant_id', 'version', 'data'];

function declaredAddresses(): string[] {
  return [...read('contracts/asyncapi.yaml').matchAll(/^\s{4}address: (\S+)$/gm)].map((m) => m[1]!).sort();
}

function catalogEvents(): { event: string; dedupe: string }[] {
  return JSON.parse(read('catalog/realtime-events.json')) as { event: string; dedupe: string }[];
}

/** Every quoted dotted event-type literal in a source file. */
function emittedTypes(repoRelativePath: string): string[] {
  const source = read(repoRelativePath);
  return [...source.matchAll(/event_type ?: ?'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!)
    .concat([...source.matchAll(/eventType ?: ?'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!))
    .concat([...source.matchAll(/emit\('([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!));
}

describe('ARCH-ASYNCAPI-CONFORMANCE: emitted realtime envelopes match the published contract', () => {
  it('declares an AsyncAPI channel for every emitted event type', () => {
    const declared = new Set(declaredAddresses());
    const undeclared: string[] = [];
    for (const file of ENVELOPE_SOURCES) {
      for (const type of emittedTypes(file)) {
        if (!declared.has(type) && !NON_REALTIME_OUTBOX_EVENTS.has(type)) undeclared.push(`${file}: ${type}`);
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('finds a non-trivial number of emitted event types (guards against a dead scanner)', () => {
    const found = ENVELOPE_SOURCES.flatMap(emittedTypes);
    expect(found.length, 'no event types found — the scanner regex or the file list is wrong').toBeGreaterThanOrEqual(8);
  });

  it('keeps catalog/realtime-events.json and contracts/asyncapi.yaml in agreement', () => {
    const declared = new Set(declaredAddresses());
    const catalogued = catalogEvents().map((e) => e.event);
    expect(catalogued.filter((e) => !declared.has(e))).toEqual([]);
  });

  it('gives every emitted envelope all six required EventEnvelope fields', () => {
    const contract = read('contracts/asyncapi.yaml');
    const required = /required: \[(.+?)\]/.exec(contract)![1]!.split(',').map((f) => f.trim());
    expect(required.sort()).toEqual([...REQUIRED_ENVELOPE_FIELDS].sort());
    const violations: string[] = [];
    for (const file of ENVELOPE_SOURCES) {
      const source = read(file);
      // Scan per emission site, not per file, so one conforming builder cannot
      // cover for a non-conforming sibling in the same module.
      for (const match of source.matchAll(/event_id ?: ?[^;]{0,600}?data ?: ?\{/gs)) {
        const literal = match[0];
        const missing = REQUIRED_ENVELOPE_FIELDS.filter((f) => !new RegExp(`\\b${f} ?:`).test(literal));
        if (missing.length) violations.push(`${file}: envelope missing ${missing.join(', ')}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never feeds a hard-coded version to an event whose dedupe key includes version', () => {
    const versioned = new Set(catalogEvents().filter((e) => e.dedupe.includes('version')).map((e) => e.event));
    const sources = [...ENVELOPE_SOURCES, 'apps/worker/src/import-processor.ts', 'apps/worker/src/bulk-processor.ts', 'apps/worker/src/export-processor.ts'];
    const violations: string[] = [];
    for (const file of sources) {
      const source = read(file);
      for (const match of source.matchAll(/eventType ?: ?'([a-z_]+\.[a-z_]+)'[^;]{0,200}?version ?: ?(\d+)\b/g)) {
        if (versioned.has(match[1]!)) violations.push(`${file}: ${match[1]} given literal version ${match[2]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
