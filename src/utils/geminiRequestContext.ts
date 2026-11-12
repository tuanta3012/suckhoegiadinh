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

export function createGeminiRequestContext(rawKeys: unknown): GeminiRequestContext {
  const keys = Array.isArray(rawKeys)
    ? parseGeminiApiKeys(rawKeys.filter((key): key is string => typeof key === 'string').join(','))
    : [];
  const projects = parseGeminiProjects(keys, undefined);
  if (projects.length === 0) {
    throw new Error('Chưa có Gemini API key trong Tài nguyên AI. Hãy tải hoặc nhập key trong mục Tài nguyên AI.');
  }
  return { projects, scheduler: new GeminiQuotaScheduler(projects) };
}
