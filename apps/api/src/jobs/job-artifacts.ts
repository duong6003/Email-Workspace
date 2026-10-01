export type ImportErrorRow = { rowNumber: number; error: string | null; rawData: Record<string, unknown> };
export type BulkErrorRow = { recipientId: string; error: string | null };

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A small durable download format: failed rows retain their source payload. */
export function renderImportErrorCsv(rows: ImportErrorRow[]): string {
  const records = rows.map((row) => [String(row.rowNumber), row.error ?? 'ROW_PROCESSING_FAILED', JSON.stringify(row.rawData)]);
  return ['row_number,error,raw_data', ...records.map((record) => record.map(escapeCsv).join(','))].join('\r\n') + '\r\n';
}

/** Bulk jobs retain only a recipient checkpoint, so their artifact is deliberately compact. */
export function renderBulkErrorCsv(rows: BulkErrorRow[]): string {
  const records = rows.map((row) => [row.recipientId, row.error ?? 'ROW_PROCESSING_FAILED']);
  return ['recipient_id,error', ...records.map((record) => record.map(escapeCsv).join(','))].join('\r\n') + '\r\n';
}

/** Bulk export result: durable checkpoint identifiers, ordered deterministically. */
export function renderBulkExportCsv(recipientIds: string[]): string {
  return ['recipient_id', ...recipientIds.map(escapeCsv)].join('\r\n') + '\r\n';
}
