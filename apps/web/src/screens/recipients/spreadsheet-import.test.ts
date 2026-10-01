import { describe, expect, it } from 'vitest';
import { parseSpreadsheetImport } from './spreadsheet-import.js';

describe('parseSpreadsheetImport', () => {
  it('reads the first XLSX worksheet with headers and preserves spreadsheet row numbers', async () => {
    const xlsx = await import('exceljs');
    const workbook = new xlsx.Workbook();
    const sheet = workbook.addWorksheet('Recipients');
    sheet.addRow(['Email', 'First name']);
    sheet.addRow(['an@example.test', 'An']);
    const bytes = await workbook.xlsx.writeBuffer();
    const file = new File([bytes], 'recipients.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

    await expect(parseSpreadsheetImport(file)).resolves.toEqual({
      fileName: 'recipients.xlsx', fileSizeBytes: file.size, mode: 'upsert', columns: ['Email', 'First name'],
      rows: [{ rowNumber: 2, rawData: { Email: 'an@example.test', 'First name': 'An' } }],
    });
  });
});
