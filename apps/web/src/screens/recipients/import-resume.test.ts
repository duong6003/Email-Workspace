import { describe, expect, it } from 'vitest';
import { checkpointMatchesFile, fingerprintImportFile, IMPORT_RESUME_TTL_MS, loadImportCheckpoint, saveImportCheckpoint } from './import-resume.js';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe('recipient import resume checkpoint', () => {
  it('uses file bytes for a stable SHA-256 fingerprint', async () => {
    const first = new File(['email\na@example.test'], 'recipients.csv');
    const second = new File(['email\nb@example.test'], 'recipients.csv');
    await expect(fingerprintImportFile(first)).resolves.toHaveLength(64);
    expect(await fingerprintImportFile(first)).not.toBe(await fingerprintImportFile(second));
  });

  it('restores only the same file before the checkpoint expires', async () => {
    const storage = memoryStorage();
    const file = new File(['email\na@example.test'], 'recipients.csv');
    const fileFingerprint = await fingerprintImportFile(file);
    saveImportCheckpoint(storage, {
      fileName: file.name,
      fileSizeBytes: file.size,
      fileFingerprint,
      mapping: { email: 'email' },
      step: 'preview',
      idempotencyKey: 'import-key',
    }, 1_000);
    const checkpoint = loadImportCheckpoint(storage, 1_001);
    expect(checkpoint && checkpointMatchesFile(checkpoint, file, fileFingerprint)).toBe(true);
    expect(loadImportCheckpoint(storage, 1_000 + IMPORT_RESUME_TTL_MS)).toBeNull();
  });
});
