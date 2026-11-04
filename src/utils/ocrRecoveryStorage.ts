export type OcrRecoveryStatus = 'processing' | 'interrupted' | 'needs_review';

export interface OcrRecoveryJob {
  driveFileId: string;
  status: OcrRecoveryStatus;
  progressPercent: number;
  updatedAt: number;
}

const STORAGE_KEY_PREFIX = 'health_ocr_recovery_v1_';
const MAX_RECOVERY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function getStorageKey(workspaceRootId: string): string {
  return `${STORAGE_KEY_PREFIX}${workspaceRootId}`;
}

function isOcrRecoveryJob(value: unknown): value is OcrRecoveryJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Partial<OcrRecoveryJob>;
  return typeof job.driveFileId === 'string' &&
    job.driveFileId.length > 0 &&
    (job.status === 'processing' || job.status === 'interrupted' || job.status === 'needs_review') &&
    typeof job.progressPercent === 'number' &&
    Number.isFinite(job.progressPercent) &&
    typeof job.updatedAt === 'number' &&
    Number.isFinite(job.updatedAt);
}

export function readOcrRecoveryJobs(
  workspaceRootId: string,
  storage: Storage = localStorage,
  now = Date.now(),
): OcrRecoveryJob[] {
  const key = getStorageKey(workspaceRootId);
  const raw = storage.getItem(key);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('Không đọc được trạng thái OCR đã lưu trên thiết bị.', { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every(isOcrRecoveryJob)) {
    throw new Error('Trạng thái OCR đã lưu trên thiết bị không hợp lệ.');
  }

  const jobs = parsed
    .filter((job) => now - job.updatedAt <= MAX_RECOVERY_AGE_MS)
    .map((job) => ({
      driveFileId: job.driveFileId,
      status: job.status === 'processing' ? 'interrupted' as const : job.status,
      progressPercent: Math.max(0, Math.min(100, job.progressPercent)),
      updatedAt: job.updatedAt,
    }));
  const normalized = JSON.stringify(jobs);
  if (normalized !== raw) storage.setItem(key, normalized);
  return jobs;
}

export function upsertOcrRecoveryJob(
  workspaceRootId: string,
  job: OcrRecoveryJob,
  storage: Storage = localStorage,
): OcrRecoveryJob[] {
  const jobs = readOcrRecoveryJobs(workspaceRootId, storage);
  const updatedJobs = [
    ...jobs.filter((item) => item.driveFileId !== job.driveFileId),
    job,
  ].sort((left, right) => left.updatedAt - right.updatedAt);
  storage.setItem(getStorageKey(workspaceRootId), JSON.stringify(updatedJobs));
  return updatedJobs;
}

export function removeOcrRecoveryJob(
  workspaceRootId: string,
  driveFileId: string,
  storage: Storage = localStorage,
): OcrRecoveryJob[] {
  const jobs = readOcrRecoveryJobs(workspaceRootId, storage)
    .filter((job) => job.driveFileId !== driveFileId);
  const key = getStorageKey(workspaceRootId);
  if (jobs.length) storage.setItem(key, JSON.stringify(jobs));
  else storage.removeItem(key);
  return jobs;
}

export function clearOcrRecoveryJobs(
  workspaceRootId: string,
  storage: Storage = localStorage,
): void {
  storage.removeItem(getStorageKey(workspaceRootId));
}
