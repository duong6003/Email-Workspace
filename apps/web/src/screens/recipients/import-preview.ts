import type { ImportJobRequest } from '../../api/import-jobs.js';
import type { CustomField } from '../../api/customFields.js';

export type ImportDraft = {
  fileName: string;
  fileSizeBytes: number;
  fileFingerprint?: string;
  mode: ImportJobRequest['mode'];
  columns: string[];
  rows: ImportJobRequest['rows'];
};

export type ImportPreview = {
  rows: ImportJobRequest['rows'];
  errors: Array<{ rowNumber: number; column: string; reason: string }>;
};

export function buildImportRequest(draft: ImportDraft, mapping: Record<string, string>): ImportJobRequest {
  if (!mapping.email) throw new Error('Chọn cột email trước khi tiếp tục.');
  const sourceColumns = Object.values(mapping);
  if (new Set(sourceColumns).size !== sourceColumns.length) throw new Error('Một cột chỉ có thể map vào một trường.');
  return { fileName: draft.fileName, fileSizeBytes: draft.fileSizeBytes, fileFingerprint: draft.fileFingerprint, mode: draft.mode, mapping, rows: draft.rows };
}

/** BR-IMP-003 preflight: local feedback complements, never replaces, server validation. */
export function buildImportPreview(request: ImportJobRequest, customFields: CustomField[] = []): ImportPreview {
  const emailColumn = request.mapping.email;
  return {
    rows: request.rows.slice(0, 20),
    errors: request.rows.slice(0, 20).flatMap((row) => [
      ...emailPreviewError(row.rowNumber, emailColumn, row.rawData[emailColumn]),
      ...customFields.flatMap((field) => customFieldPreviewError(row.rowNumber, request.mapping[`custom_${field.key}`], field, row.rawData)),
    ]),
  };
}

function emailPreviewError(rowNumber: number, column: string, value: unknown): ImportPreview['errors'] {
  return typeof value === 'string' && /^\S+@\S+\.\S+$/.test(value.trim())
    ? []
    : [{ rowNumber, column, reason: 'Email không hợp lệ.' }];
}

function customFieldPreviewError(rowNumber: number, column: string | undefined, field: CustomField, rawData: Record<string, unknown>): ImportPreview['errors'] {
  if (!column) return [];
  const value = rawData[column];
  if (value === undefined || value === '') return [];
  const reason = customFieldReason(field, value);
  return reason ? [{ rowNumber, column, reason }] : [];
}

function customFieldReason(field: CustomField, value: unknown): string | null {
  if (field.type === 'text') return typeof value === 'string' ? null : `Trường "${field.label}" cần văn bản.`;
  if (field.type === 'number') return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) ? null : `Trường "${field.label}" cần một giá trị số.`;
  if (field.type === 'boolean') return value === true || value === false || value === 'true' || value === 'false' ? null : `Trường "${field.label}" cần giá trị true hoặc false.`;
  if (field.type === 'date') return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? null : `Trường "${field.label}" cần ngày ISO-8601.`;
  return typeof value === 'string' && (field.enumOptions ?? []).includes(value) ? null : `Trường "${field.label}" phải là một trong: ${(field.enumOptions ?? []).join(', ')}.`;
}
