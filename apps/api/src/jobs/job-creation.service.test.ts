import { describe, expect, it } from 'vitest';
import { IMPORT_MAPPING_ERROR, validateImportFileSize, validateImportMapping, validateImportRows, validateImportRowNumbers } from './job-creation.service.js';
import { importJobCreateRequestSchema } from './dto/job.dto.js';

describe('import job request validation', () => {
  it('requires one mapped email column before a job is created', () => {
    expect(() => validateImportMapping({ firstName: 'First name' })).toThrow(IMPORT_MAPPING_ERROR);
  });

  it('rejects duplicate single-valued mapping targets with the canonical error', () => {
    expect(() => validateImportMapping({ email: 'Email', Email: 'Work email' })).toThrow(IMPORT_MAPPING_ERROR);
  });

  it('rejects a source column reused by distinct targets with the canonical error', () => {
    expect(() => validateImportMapping({ email: 'Email', firstName: 'Email' })).toThrow(IMPORT_MAPPING_ERROR);
  });

  it('accepts list and tag source mappings alongside the required email mapping', () => {
    expect(() => validateImportMapping({ email: 'Email', list: 'Customer list', tag: 'Interest tag' })).not.toThrow();
  });

  it('rejects more rows than the configured default import limit before a job is created', () => {
    expect(() => validateImportRows(new Array(100_001).fill({}))).toThrow('The import exceeds the 100000 row limit.');
  });

  it('rejects a file larger than 50 MB before a job is created', () => {
    expect(() => validateImportFileSize(50 * 1024 * 1024 + 1)).toThrow('The import file exceeds the 50 MB limit.');
  });

  it('rejects duplicate source row numbers before a job is created', () => {
    expect(() => validateImportRowNumbers([{ rowNumber: 2 }, { rowNumber: 2 }])).toThrow('Duplicate import row number 2.');
  });

  it('accepts only a lowercase SHA-256 file fingerprint', () => {
    const input = { fileName: 'recipients.csv', fileSizeBytes: 10, fileFingerprint: 'a'.repeat(64), mapping: { email: 'email' }, rows: [] };
    expect(importJobCreateRequestSchema.parse(input).fileFingerprint).toBe('a'.repeat(64));
    expect(() => importJobCreateRequestSchema.parse({ ...input, fileFingerprint: 'changed-file' })).toThrow();
  });
});
