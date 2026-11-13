import { parseGeminiApiKeys } from './geminiApiKeys';
import {
  GeminiQuotaScheduler,
  parseGeminiProjects,
  type GeminiProject,
} from './geminiQuotaScheduler';

export interface GeminiRequestContext {
  projects: GeminiProject[];
  scheduler: GeminiQuotaScheduler;
}

const sharedSchedulerRegistry = new Map<string, GeminiRequestContext>();

export function normalizeGeminiKeysInput(rawKeys: unknown): string[] {
  return Array.isArray(rawKeys)
    ? parseGeminiApiKeys(rawKeys.filter((key): key is string => typeof key === 'string').join(','))
    : [];
}

export function createGeminiRequestContext(rawKeys: unknown): GeminiRequestContext {
  const keys = normalizeGeminiKeysInput(rawKeys);
  const projects = parseGeminiProjects(keys, undefined);
  if (projects.length === 0) {
    throw new Error('Chưa có Gemini API key trong Tài nguyên AI. Hãy tải hoặc nhập key trong mục Tài nguyên AI.');
  }
  return { projects, scheduler: new GeminiQuotaScheduler(projects) };
}

/**
 * Returns a persistent shared GeminiRequestContext (scheduler + project pool)
 * keyed by the normalized key pool signature, so RPM/RPD/concurrency/cooldown/invalid-key
 * state is coordinated across all sequential and concurrent tasks on both server and APK.
 */
export function getOrCreateSharedGeminiRequestContext(rawKeys: unknown): GeminiRequestContext {
  const keys = normalizeGeminiKeysInput(rawKeys);
  const projects = parseGeminiProjects(keys, undefined);
  if (projects.length === 0) {
    throw new Error('Chưa có Gemini API key trong Tài nguyên AI. Hãy tải hoặc nhập key trong mục Tài nguyên AI.');
  }
  const cacheKey = projects.map((p) => p.apiKey).slice().sort().join('|');
  const existing = sharedSchedulerRegistry.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created: GeminiRequestContext = {
    projects,
    scheduler: new GeminiQuotaScheduler(projects),
  };
  if (sharedSchedulerRegistry.size > 16) {
    const oldestKey = sharedSchedulerRegistry.keys().next().value;
    if (oldestKey) sharedSchedulerRegistry.delete(oldestKey);
  }
  sharedSchedulerRegistry.set(cacheKey, created);
  return created;
}

export function resetSharedGeminiRequestContextsForTests(): void {
  sharedSchedulerRegistry.clear();
}
