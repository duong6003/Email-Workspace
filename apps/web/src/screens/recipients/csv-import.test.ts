import { describe, expect, it } from 'vitest';
import { parseCsvImport } from './csv-import.js';

describe('parseCsvImport', () => {
  it('maps a CSV email header and preserves source row numbers', async () => {
    const file = new File(['Email,First name\na@example.test,A'], 'recipients.csv', { type: 'text/csv' });
    await expect(parseCsvImport(file)).resolves.toEqual({
      fileName: 'recipients.csv', fileSizeBytes: file.size, mode: 'upsert', columns: ['Email', 'First name'],
      rows: [{ rowNumber: 2, rawData: { Email: 'a@example.test', 'First name': 'A' } }],
    });
  });

  it('keeps nonstandard columns for the user mapping step', async () => {
    const file = new File(['Name\nA'], 'recipients.csv', { type: 'text/csv' });
    await expect(parseCsvImport(file)).resolves.toMatchObject({ columns: ['Name'] });
  });
});
