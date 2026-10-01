import { describe, expect, it } from 'vitest';
import { renderBulkErrorCsv, renderBulkExportCsv, renderImportErrorCsv } from './job-artifacts.js';

describe('renderImportErrorCsv', () => {
  it('creates an RFC-4180-compatible error artifact with row, reason, and source data', () => {
    expect(renderImportErrorCsv([
      { rowNumber: 3, error: 'INVALID_EMAIL', rawData: { Email: 'not-an-email', Name: 'Nguyen, An' } },
    ])).toBe('row_number,error,raw_data\r\n3,INVALID_EMAIL,"{\"\"Email\"\":\"\"not-an-email\"\",\"\"Name\"\":\"\"Nguyen, An\"\"}"\r\n');
  });

  it('creates a downloadable bulk error artifact from durable recipient checkpoints', () => {
    expect(renderBulkErrorCsv([{ recipientId: 'recipient-1', error: 'ROW_PROCESSING_FAILED' }]))
      .toBe('recipient_id,error\r\nrecipient-1,ROW_PROCESSING_FAILED\r\n');
  });

  it('creates a compact deterministic export artifact from successful recipient checkpoints', () => {
    expect(renderBulkExportCsv(['recipient-1', 'recipient-2']))
      .toBe('recipient_id\r\nrecipient-1\r\nrecipient-2\r\n');
  });
});
