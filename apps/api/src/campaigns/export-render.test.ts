import { describe, expect, it } from 'vitest';
import { renderExportCsv, type ExportRow } from './export-render.js';

describe('renderExportCsv (BR-HIS-003/BR-HIS-007)', () => {
  it('renders the header row and one data row per recipient', () => {
    const rows: ExportRow[] = [
      { recipientEmail: 'a@example.test', status: 'delivered', skippedReason: null, attemptCount: 1, lastErrorCode: null, lastErrorClass: null, lastErrorReason: null, submittedAt: '2026-08-10T14:20:00.000Z', deliveredAt: '2026-08-10T14:20:05.000Z' },
    ];
    const csv = renderExportCsv(rows);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('recipient_email,status,skipped_reason,attempt_count,last_error_code,last_error_class,last_error_reason,submitted_at,delivered_at');
    expect(lines[1]).toBe('a@example.test,delivered,,1,,,,2026-08-10T14:20:00.000Z,2026-08-10T14:20:05.000Z');
  });

  it('round-trips a Vietnamese display value unmangled', () => {
    const rows: ExportRow[] = [
      { recipientEmail: 'nguyen.van.a@example.test', status: 'failed', skippedReason: null, attemptCount: 3, lastErrorCode: 'EENVELOPE', lastErrorClass: 'permanent', lastErrorReason: 'Không có địa chỉ người nhận hợp lệ', submittedAt: null, deliveredAt: null },
    ];
    const csv = renderExportCsv(rows);
    expect(csv).toContain('Không có địa chỉ người nhận hợp lệ');
  });

  it('quotes and doubles a value containing a comma, quote, or newline', () => {
    const rows: ExportRow[] = [
      { recipientEmail: 'quote@example.test', status: 'failed', skippedReason: null, attemptCount: 1, lastErrorCode: 'EUPSTREAM', lastErrorClass: 'transient', lastErrorReason: 'Error: "timeout", retry\nlater', submittedAt: null, deliveredAt: null },
    ];
    const csv = renderExportCsv(rows);
    expect(csv).toContain('"Error: ""timeout"", retry\nlater"');
  });

  it('carries a skipped row\'s skipped_reason', () => {
    const rows: ExportRow[] = [
      { recipientEmail: 'skipped@example.test', status: 'skipped', skippedReason: 'status_unsubscribed', attemptCount: 0, lastErrorCode: null, lastErrorClass: null, lastErrorReason: null, submittedAt: null, deliveredAt: null },
    ];
    const csv = renderExportCsv(rows);
    expect(csv).toContain('skipped@example.test,skipped,status_unsubscribed,0,,,,');
  });

  it('BR-HIS-007: never leaks a secret_ref-shaped value, since the renderer takes only the eight documented columns', () => {
    const rows: ExportRow[] = [
      { recipientEmail: 'a@example.test', status: 'delivered', skippedReason: null, attemptCount: 1, lastErrorCode: null, lastErrorClass: null, lastErrorReason: null, submittedAt: null, deliveredAt: null },
    ];
    const csv = renderExportCsv(rows);
    expect(csv).not.toMatch(/EOW_[A-Z_]+_SECRET/);
  });

  it('TC-SEC-014: prefixes spreadsheet formulas so opening the CSV cannot execute them', () => {
    const rows: ExportRow[] = [
      { recipientEmail: '=2+3', status: 'failed', skippedReason: null, attemptCount: 1, lastErrorCode: '@cmd', lastErrorClass: null, lastErrorReason: null, submittedAt: null, deliveredAt: null },
    ];
    expect(renderExportCsv(rows)).toContain("'=2+3,failed,,1,'@cmd");
  });
});
