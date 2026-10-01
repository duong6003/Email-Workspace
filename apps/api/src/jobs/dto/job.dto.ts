import { z } from 'zod';

const importModeSchema = z.enum(['create_only', 'update_existing', 'upsert']);
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const rowSchema = z
  .object({
    rowNumber: z.number().int().min(2),
    rawData: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * The browser/parser owns converting CSV/XLSX bytes to a preview and a
 * bounded row payload. This endpoint persists the approved preview into a
 * durable async job; file object-storage integration remains part of the
 * later upload adapter rather than accepting unbounded raw bytes here.
 */
export const importJobCreateRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255).refine((name) => /\.(csv|xlsx)$/i.test(name), 'Only CSV and XLSX files are supported.'),
    fileSizeBytes: z.number().int().min(0).max(MAX_IMPORT_FILE_BYTES),
    fileFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    mode: importModeSchema.default('upsert'),
    mapping: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(120)).refine((mapping) => Object.keys(mapping).length > 0, 'At least one column mapping is required.'),
    rows: z.array(rowSchema).max(100_000),
  })
  .strict();

export type ImportJobCreateRequestDto = z.infer<typeof importJobCreateRequestSchema>;
