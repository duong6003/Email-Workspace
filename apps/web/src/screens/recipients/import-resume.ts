export const IMPORT_RESUME_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'eow-recipient-import-draft-v1';

export type ImportResumeCheckpoint = {
  fileName: string;
  fileSizeBytes: number;
  fileFingerprint: string;
  mapping: Record<string, string>;
  step: 'mapping' | 'preview';
  idempotencyKey: string;
  expiresAt: number;
};

export async function fingerprintImportFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function loadImportCheckpoint(storage: Storage, now = Date.now()): ImportResumeCheckpoint | null {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const checkpoint = JSON.parse(raw) as ImportResumeCheckpoint;
    if (checkpoint.expiresAt <= now || !/^[a-f0-9]{64}$/.test(checkpoint.fileFingerprint)) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    return checkpoint;
  } catch {
    storage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveImportCheckpoint(storage: Storage, checkpoint: Omit<ImportResumeCheckpoint, 'expiresAt'>, now = Date.now()): void {
  storage.setItem(STORAGE_KEY, JSON.stringify({ ...checkpoint, expiresAt: now + IMPORT_RESUME_TTL_MS }));
}

export function clearImportCheckpoint(storage: Storage): void {
  storage.removeItem(STORAGE_KEY);
}

export function checkpointMatchesFile(checkpoint: ImportResumeCheckpoint, file: File, fingerprint: string): boolean {
  return checkpoint.fileName === file.name && checkpoint.fileSizeBytes === file.size && checkpoint.fileFingerprint === fingerprint;
}
