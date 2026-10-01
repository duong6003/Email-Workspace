import { parse } from 'papaparse';
import type { ImportDraft } from './import-preview.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_ROWS = 100_000;

export async function parseCsvImport(file: File): Promise<ImportDraft> {
  if (file.size > MAX_FILE_BYTES) throw new Error('Tệp import vượt quá 50 MB.');
  if (!/\.csv$/i.test(file.name)) throw new Error('Hiện tại chỉ hỗ trợ tệp CSV.');
  const text = await file.text();
  const parsed = parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  if (parsed.data.length > MAX_ROWS) throw new Error('Tệp import vượt quá 100.000 dòng.');
  const columns = Object.keys(parsed.data[0] ?? {});
  const fatalError = parsed.errors.find((issue) => !issue.message.includes('Unable to auto-detect delimiting character'));
  if (fatalError) throw new Error(`Không thể đọc CSV: ${fatalError.message}.`);
  return {
    fileName: file.name, fileSizeBytes: file.size, mode: 'upsert', columns,
    rows: parsed.data.map((rawData, index) => ({ rowNumber: index + 2, rawData })),
  };
}
