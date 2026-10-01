import { describe, expect, it } from 'vitest';
import { buildImportRequest, buildImportPreview } from './import-preview.js';

describe('import preview', () => {
  const draft = {
    fileName: 'recipients.csv', fileSizeBytes: 42, mode: 'upsert' as const, columns: ['Work email', 'First name'],
    rows: [{ rowNumber: 2, rawData: { 'Work email': 'an@example.test', 'First name': 'An' } }, { rowNumber: 3, rawData: { 'Work email': 'not-an-email', 'First name': 'Binh' } }],
  };

  it('accepts a user-selected email mapping when the source header is nonstandard', () => {
    expect(buildImportRequest(draft, { email: 'Work email', firstName: 'First name' }).mapping).toEqual({ email: 'Work email', firstName: 'First name' });
  });

  it('forwards the file fingerprint to the durable job request', () => {
    expect(buildImportRequest({ ...draft, fileFingerprint: 'a'.repeat(64) }, { email: 'Work email' }).fileFingerprint).toBe('a'.repeat(64));
  });

  it('shows the first rows and pinpoints a bad email cell before submission', () => {
    expect(buildImportPreview(buildImportRequest(draft, { email: 'Work email' }))).toEqual({
      rows: draft.rows,
      errors: [{ rowNumber: 3, column: 'Work email', reason: 'Email không hợp lệ.' }],
    });
  });

  it('reports a mapped custom-field cell with its source column and typed reason', () => {
    const typedDraft = {
      fileName: 'typed.csv', fileSizeBytes: 42, mode: 'upsert' as const, columns: ['Work email', 'Age'],
      rows: [{ rowNumber: 2, rawData: { 'Work email': 'an@example.test', Age: 'not-a-number' } }],
    };

    expect(buildImportPreview(buildImportRequest(typedDraft, { email: 'Work email', custom_age: 'Age' }), [{
      id: 'age', key: 'age', label: 'Age', type: 'number', required: false, defaultValue: null, enumOptions: null, sensitive: false, format: null, timezone: null,
      createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z',
    }])).toMatchObject({
      errors: [{ rowNumber: 2, column: 'Age', reason: 'Trường "Age" cần một giá trị số.' }],
    });
  });
});
