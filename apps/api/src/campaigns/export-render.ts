/**
 * BR-HIS-003/BR-HIS-007's export artifact. Worker-native duplicate at
 * apps/worker/src/export-processor.ts (DEC-107/DEC-123 transliteration
 * precedent -- ARCH-EXPORT-PARITY keeps the two in step: any edit here
 * needs the matching edit there). Pure and DB-free so both copies are
 * exhaustively unit-testable without a database.
 *
 * Exactly the documented delivery columns, drawn only from campaign_recipient/
 * recipient/message_attempt -- never sender_config (secret_ref) or
 * app_user, so no secret can reach this file by construction (BR-HIS-007:
 * "Export ... khong bao gom secret").
 */
export type ExportRow = {
  recipientEmail: string;
  status: string;
  skippedReason: string | null;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorClass: string | null;
  lastErrorReason: string | null;
  submittedAt: string | null;
  deliveredAt: string | null;
};

function escapeCsv(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function renderExportCsv(rows: ExportRow[]): string {
  const header = 'recipient_email,status,skipped_reason,attempt_count,last_error_code,last_error_class,last_error_reason,submitted_at,delivered_at';
  const records = rows.map((row) => [
    row.recipientEmail,
    row.status,
    row.skippedReason ?? '',
    String(row.attemptCount),
    row.lastErrorCode ?? '',
    row.lastErrorClass ?? '',
    row.lastErrorReason ?? '',
    row.submittedAt ?? '',
    row.deliveredAt ?? '',
  ]);
  return [header, ...records.map((record) => record.map(escapeCsv).join(','))].join('\r\n') + '\r\n';
}
