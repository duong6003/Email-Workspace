import ExcelJS from 'exceljs';
import type { ImportDraft } from './import-preview.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  if ('text' in value) return value.text.trim();
  if ('result' in value) return String(value.result ?? '').trim();
  return String(value).trim();
}

/**
 * BR-IMP-001/002: parses the first non-empty XLSX worksheet entirely in the
 * browser, then sends only the bounded, mapped row preview to the durable job
 * endpoint. The server remains authoritative for validation and processing.
 */
export async function parseSpreadsheetImport(file: File): Promise<ImportDraft> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Tệp import vượt quá 50 MB.');
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Chỉ hỗ trợ tệp XLSX ở bước này.');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets.find((sheet) => sheet.actualRowCount > 0);
  if (!worksheet) throw new Error('Tệp XLSX không có dữ liệu.');

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  for (let column = 1; column <= headerRow.cellCount; column += 1) {
    const value = cellText(headerRow.getCell(column).value);
    if (value) headers.push(value);
  }
  const rows: ImportDraft['rows'] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.actualRowCount; rowNumber += 1) {
    if (rows.length >= MAX_ROWS) throw new Error('Tệp import vượt quá 100.000 dòng.');
    const row = worksheet.getRow(rowNumber);
    const rawData = Object.fromEntries(headers.map((header, index) => [header, cellText(row.getCell(index + 1).value)]));
    if (Object.values(rawData).some((value) => value !== '')) rows.push({ rowNumber, rawData });
  }

  return {
    fileName: file.name,
    fileSizeBytes: file.size,
    mode: 'upsert',
    columns: headers,
    rows,
  };
}
