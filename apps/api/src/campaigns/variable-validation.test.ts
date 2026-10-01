import { describe, expect, it } from 'vitest';
import { validateVariables, type VariableValidationCandidate } from './variable-validation.js';

/**
 * M4-S3 (BR-CMP-004/005/006). Pure aggregation over already-built recipient
 * contexts, so the matrix arithmetic is provable without a database. CP2's
 * integration test proves the SQL/context-building produces these candidates
 * for real. Calls the same apps/api/src/templates/template-variable-renderer.ts
 * function M3-S3's preview/test-send paths already use, so this can never
 * silently diverge from what a real send would render (BR-CMP-006).
 */
const template = { subject: 'Hello {{first_name}}', html: '<p>{{first_name}} {{city}}</p>', textBody: '' };
const schema = { required: ['city'], optional: ['first_name'], defaults: {} };

function candidate(overrides: Partial<VariableValidationCandidate> & Pick<VariableValidationCandidate, 'recipientId'>): VariableValidationCandidate {
  return { email: `${overrides.recipientId}@example.test`, context: {}, ...overrides };
}

describe('validateVariables', () => {
  it('reports everything complete when every candidate has the required variable', () => {
    const result = validateVariables(
      [candidate({ recipientId: 'r1', context: { city: 'Hanoi' } }), candidate({ recipientId: 'r2', context: { city: 'Saigon' } })],
      template, schema, {}, { sampleLimit: 10 },
    );
    expect(result).toMatchObject({ totalActionable: 2, completeCount: 2, missingCount: 0, missingByVariable: [], sample: [] });
  });

  it('BR-CMP-004: reports missingCount and a per-variable breakdown when a required variable is absent', () => {
    const result = validateVariables(
      [candidate({ recipientId: 'r1', context: { city: 'Hanoi' } }), candidate({ recipientId: 'r2', context: {} })],
      template, schema, {}, { sampleLimit: 10 },
    );
    expect(result.completeCount).toBe(1);
    expect(result.missingCount).toBe(1);
    expect(result.missingByVariable).toEqual([{ key: 'city', label: 'city', count: 1 }]);
  });

  it('uses a custom field label when one is supplied, matching the compose variable catalogue', () => {
    const result = validateVariables(
      [candidate({ recipientId: 'r1', context: {} })],
      template, schema, { city: 'Thành phố' }, { sampleLimit: 10 },
    );
    expect(result.missingByVariable).toEqual([{ key: 'city', label: 'Thành phố', count: 1 }]);
  });

  it('BR-CMP-006: an optional variable with no default renders empty and is never reported as missing', () => {
    const result = validateVariables(
      [candidate({ recipientId: 'r1', context: { city: 'Hanoi' } })], // first_name absent, optional, no default
      template, schema, {}, { sampleLimit: 10 },
    );
    expect(result.missingCount).toBe(0);
    expect(result.missingByVariable).toEqual([]);
  });

  it('names each affected recipient in a bounded sample with their own missing keys', () => {
    const result = validateVariables(
      [candidate({ recipientId: 'r1', context: {} })],
      template, schema, {}, { sampleLimit: 10 },
    );
    expect(result.sample).toEqual([{ recipientId: 'r1', email: 'r1@example.test', missingKeys: ['city'] }]);
  });

  it('bounds the sample to sampleLimit while still counting every affected recipient', () => {
    const many = Array.from({ length: 5 }, (_, i) => candidate({ recipientId: `r${i}`, context: {} }));
    const result = validateVariables(many, template, schema, {}, { sampleLimit: 2 });
    expect(result.missingCount).toBe(5);
    expect(result.sample).toHaveLength(2);
    expect(result.missingByVariable).toEqual([{ key: 'city', label: 'city', count: 5 }]);
  });

  it('BR-CMP-005: names every missing recipient id (not bounded by sampleLimit), for the accept-waiver decision to record exactly who it covers', () => {
    const many = Array.from({ length: 5 }, (_, i) => candidate({ recipientId: `r${i}`, context: {} }));
    const result = validateVariables(many, template, schema, {}, { sampleLimit: 2 });
    expect(result.missingRecipientIds).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
  });
});
