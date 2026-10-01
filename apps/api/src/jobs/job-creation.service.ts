import { BadRequestException } from '@nestjs/common';

const MAX_IMPORT_ROWS = 100_000;
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MULTI_VALUED_MAPPING_TARGETS = new Set(['list', 'tag']);

export const IMPORT_MAPPING_ERROR = 'Invalid import column mapping.';

export function validateImportMapping(mapping: Record<string, string>): void {
  if (!mapping.email?.trim()) {
    throw new BadRequestException(IMPORT_MAPPING_ERROR);
  }

  const targetCounts = new Map<string, number>();
  for (const target of Object.keys(mapping)) {
    const canonicalTarget = target.trim().toLowerCase();
    targetCounts.set(canonicalTarget, (targetCounts.get(canonicalTarget) ?? 0) + 1);
  }
  if ([...targetCounts.entries()].some(([target, count]) => !MULTI_VALUED_MAPPING_TARGETS.has(target) && count > 1)) {
    throw new BadRequestException(IMPORT_MAPPING_ERROR);
  }

  const sourceColumns = Object.values(mapping).map((value) => value.trim().toLowerCase());
  if (new Set(sourceColumns).size !== sourceColumns.length) {
    throw new BadRequestException(IMPORT_MAPPING_ERROR);
  }
}

export function validateImportRows(rows: unknown[]): void {
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new BadRequestException(`The import exceeds the ${MAX_IMPORT_ROWS} row limit.`);
  }
}

export function validateImportFileSize(fileSizeBytes: number): void {
  if (!Number.isInteger(fileSizeBytes) || fileSizeBytes < 0 || fileSizeBytes > MAX_IMPORT_FILE_BYTES) {
    throw new BadRequestException('The import file exceeds the 50 MB limit.');
  }
}

export function validateImportRowNumbers(rows: Array<{ rowNumber: number }>): void {
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.rowNumber)) {
      throw new BadRequestException(`Duplicate import row number ${row.rowNumber}.`);
    }
    seen.add(row.rowNumber);
  }
}
