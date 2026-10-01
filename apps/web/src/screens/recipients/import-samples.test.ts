import { describe, expect, it } from 'vitest';
import { buildRecipientSampleWorkbook, RECIPIENT_SAMPLE_FILENAME, RECIPIENT_SAMPLE_HEADERS } from './import-samples.js';

describe('recipient import sample', () => {
  it('contains a data-first sheet and complete embedded guidance', async () => {
    const workbook = await buildRecipientSampleWorkbook();
    const worksheet = workbook.getWorksheet('Nguoi_nhan');
    expect(RECIPIENT_SAMPLE_FILENAME).toContain('v1.xlsx');
    expect(workbook.worksheets[0]?.name).toBe('Nguoi_nhan');
    expect(worksheet?.getRow(1).values).toEqual([undefined, ...RECIPIENT_SAMPLE_HEADERS]);
    expect(worksheet?.autoFilter).toEqual({ from: 'A1', to: 'F3' });
    expect(worksheet?.actualRowCount).toBe(3);
    expect(workbook.getWorksheet('Huong_dan')?.getCell('B5').value).toContain('Bắt buộc');
  });
});
