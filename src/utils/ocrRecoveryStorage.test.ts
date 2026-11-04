import { describe, expect, it } from 'vitest';
import {
  readOcrRecoveryJobs,
  removeOcrRecoveryJob,
  upsertOcrRecoveryJob,
} from './ocrRecoveryStorage';

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] || null,
    get length() {
      return values.size;
    },
  };
}

describe('OCR recovery local storage', () => {
  it('stores only resumable metadata and marks in-flight jobs interrupted after reload', () => {
    const storage = createStorage();
    const updatedAt = Date.now();
    upsertOcrRecoveryJob('workspace-1', {
      driveFileId: 'drive-file-1',
      status: 'processing',
      progressPercent: 64,
      updatedAt,
    }, storage);

    const restored = readOcrRecoveryJobs('workspace-1', storage, updatedAt + 1);
    expect(restored).toEqual([{
      driveFileId: 'drive-file-1',
      status: 'interrupted',
      progressPercent: 64,
      updatedAt,
    }]);
    expect(storage.getItem('health_ocr_recovery_v1_workspace-1')).not.toContain('diagnoses');
  });

  it('updates and removes a recovery item by Drive file id', () => {
    const storage = createStorage();
    upsertOcrRecoveryJob('workspace-1', {
      driveFileId: 'drive-file-1',
      status: 'interrupted',
      progressPercent: 24,
      updatedAt: Date.now(),
    }, storage);
    const remaining = upsertOcrRecoveryJob('workspace-1', {
      driveFileId: 'drive-file-1',
      status: 'needs_review',
      progressPercent: 100,
      updatedAt: Date.now(),
    }, storage);
    expect(remaining).toHaveLength(1);
    expect(removeOcrRecoveryJob('workspace-1', 'drive-file-1', storage)).toEqual([]);
    expect(storage.length).toBe(0);
  });

  it('rejects malformed saved state instead of hiding corruption', () => {
    const storage = createStorage();
    storage.setItem('health_ocr_recovery_v1_workspace-1', '{');
    expect(() => readOcrRecoveryJobs('workspace-1', storage)).toThrow('Không đọc được trạng thái OCR');
  });

  it('strips any fields beyond the explicitly allowed metadata', () => {
    const storage = createStorage();
    storage.setItem('health_ocr_recovery_v1_workspace-1', JSON.stringify([{
      driveFileId: 'drive-file-1',
      status: 'interrupted',
      progressPercent: 50,
      updatedAt: Date.now(),
      diagnoses: ['sensitive medical data'],
    }]));
    readOcrRecoveryJobs('workspace-1', storage);
    expect(storage.getItem('health_ocr_recovery_v1_workspace-1')).not.toContain('diagnoses');
  });
});
