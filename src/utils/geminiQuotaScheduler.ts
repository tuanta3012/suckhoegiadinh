export type GeminiTask = 'digitization' | 'analysis' | 'assistant' | 'refinement';

export interface GeminiProject {
  id: string;
  apiKey: string;
}

export interface GeminiQuota {
  rpm: number;
}

interface UsageWindow {
  minuteRequests: number[];
  cooldownUntil: number;
}

export function parseGeminiProjects(
  apiKeys: string[],
  defaultKey: string | undefined,
): GeminiProject[] {
  const keys = [...new Set([...apiKeys, ...(defaultKey ? [defaultKey] : [])])];
  return keys.map((apiKey, index) => ({ id: `account-${index + 1}`, apiKey }));
}

function waitForCapacity(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Gemini request was cancelled.'));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : new Error('Gemini request was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface GeminiSchedulerSnapshot {
  totalProjects: number;
  excludedCount: number;
  disabledCount: number;
  disabledModelCount: number;
  rpmLimit: number;
  activeRequests: Record<string, number>;
  rpmUsed: Record<string, number>;
  projectCooldownRemainingMs: Record<string, number>;
  modelCooldownRemainingMs: Record<string, number>;
}

const DEFAULT_UNAVAILABLE_TTL_MS = 5 * 60_000;
const RPD_BLOCK_STORAGE_KEY = 'gemini_rpd_blocked_models_v1';

export function getMsUntilNextPacificMidnight(now: Date = new Date()): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  const second = Number(parts.find((p) => p.type === 'second')?.value ?? 0);

  const secondsPassedToday = (hour % 24) * 3600 + minute * 60 + second;
  const secondsInDay = 86400;
  const secondsRemaining = secondsInDay - secondsPassedToday + 5;
  return Math.max(60_000, secondsRemaining * 1000);
}

function getPersistedRpdBlocks(): Record<string, number> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(RPD_BLOCK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePersistedRpdBlock(apiKey: string, model: string, unblockTimestamp: number): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const blocks = getPersistedRpdBlocks();
    const keySig = apiKey.length > 16 ? apiKey.slice(-16) : apiKey;
    blocks[`${keySig}:${model}`] = unblockTimestamp;
    const now = Date.now();
    for (const k of Object.keys(blocks)) {
      if (blocks[k] <= now) delete blocks[k];
    }
    window.localStorage.setItem(RPD_BLOCK_STORAGE_KEY, JSON.stringify(blocks));
  } catch {
    // Ignore storage quota/permission errors
  }
}

export class GeminiQuotaScheduler {
  private readonly usage = new Map<string, UsageWindow>();
  private readonly cursors = new Map<string, number>();
  private readonly disabledProjectsUntil = new Map<string, number>();
  private readonly disabledProjectModelsUntil = new Map<string, number>();
  private readonly projectCooldownUntil = new Map<string, number>();
  private readonly activeRequests = new Map<string, number>();

  constructor(
    private readonly projects: GeminiProject[],
    private readonly maxConcurrentPerProject = 1,
  ) {
    this.hydratePersistedBlocks();
  }

  private hydratePersistedBlocks(): void {
    const persisted = getPersistedRpdBlocks();
    const now = Date.now();
    for (const project of this.projects) {
      const keySig = project.apiKey.length > 16 ? project.apiKey.slice(-16) : project.apiKey;
      for (const [keyModel, unblockUntil] of Object.entries(persisted)) {
        if (typeof unblockUntil === 'number' && unblockUntil > now) {
          const colonIdx = keyModel.lastIndexOf(':');
          if (colonIdx > 0) {
            const sig = keyModel.slice(0, colonIdx);
            const model = keyModel.slice(colonIdx + 1);
            if (keySig === sig) {
              this.disabledProjectModelsUntil.set(`${project.id}:${model}`, unblockUntil);
            }
          }
        }
      }
    }
  }

  getProjects(): readonly GeminiProject[] {
    return this.projects;
  }

  async acquire(
    task: GeminiTask,
    model: string,
    quota: GeminiQuota,
    excludedProjectIds: ReadonlySet<string>,
    timeoutMs: number,
    preferredProjectId?: string,
    signal?: AbortSignal,
  ): Promise<{ project: GeminiProject; release: (options?: { refundRpm?: boolean }) => void }> {
    const startedAt = Date.now();
    const queueKey = `${task}:${model}`;
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Gemini request was cancelled.');
      }
      const now = Date.now();
      const candidates = this.getOrderedCandidates(queueKey).filter((project) =>
        (!preferredProjectId || project.id === preferredProjectId) &&
        !excludedProjectIds.has(project.id) &&
        !this.isProjectDisabled(project.id, now) &&
        !this.isModelDisabled(project.id, model, now),
      );
      if (candidates.length === 0) {
        throw new Error(`No available projects remain for ${model}.`);
      }
      let nextWaitMs = timeoutMs - (Date.now() - startedAt);
      let blockedByCapacity = false;

      for (const project of candidates) {
        const usage = this.getUsage(project.id, model);
        const loopNow = Date.now();
        usage.minuteRequests = usage.minuteRequests.filter((timestamp) => loopNow - timestamp < 60_000);

        const projectCooldownWait = Math.max(0, (this.projectCooldownUntil.get(project.id) || 0) - loopNow);
        if (projectCooldownWait > 0) {
          blockedByCapacity = true;
          nextWaitMs = Math.min(nextWaitMs, projectCooldownWait);
          continue;
        }

        if ((this.activeRequests.get(project.id) || 0) >= this.maxConcurrentPerProject) {
          blockedByCapacity = true;
          nextWaitMs = Math.min(nextWaitMs, 100);
          continue;
        }

        const requestWait = usage.minuteRequests.length >= quota.rpm
          ? Math.max(1, 60_000 - (loopNow - usage.minuteRequests[0]))
          : 0;
        const cooldownWait = Math.max(0, usage.cooldownUntil - loopNow);
        if (requestWait > 0 || cooldownWait > 0) {
          blockedByCapacity = true;
          nextWaitMs = Math.min(nextWaitMs, Math.max(requestWait, cooldownWait));
          continue;
        }

        const tokenTimestamp = loopNow;
        usage.minuteRequests.push(tokenTimestamp);
        this.activeRequests.set(project.id, (this.activeRequests.get(project.id) || 0) + 1);
        let released = false;
        return {
          project,
          release: (options?: { refundRpm?: boolean }) => {
            if (released) return;
            released = true;
            if (options?.refundRpm) {
              const tokenIndex = usage.minuteRequests.lastIndexOf(tokenTimestamp);
              if (tokenIndex !== -1) {
                usage.minuteRequests.splice(tokenIndex, 1);
              }
            }
            const activeCount = this.activeRequests.get(project.id) || 0;
            if (activeCount <= 1) this.activeRequests.delete(project.id);
            else this.activeRequests.set(project.id, activeCount - 1);
          },
        };
      }
      if (!blockedByCapacity) {
        throw new Error(`No RPM capacity remains for ${model} in the configured projects.`);
      }
      await waitForCapacity(Math.max(1, Math.min(nextWaitMs, 1_000)), signal);
    }

    throw new Error(`Timed out waiting for an available ${task} Gemini quota slot.`);
  }

  getDiagnosticsSnapshot(
    model: string,
    quota: GeminiQuota,
    excludedProjectIds: ReadonlySet<string> = new Set(),
  ): GeminiSchedulerSnapshot {
    const now = Date.now();
    const activeRequests: Record<string, number> = {};
    const rpmUsed: Record<string, number> = {};
    const projectCooldownRemainingMs: Record<string, number> = {};
    const modelCooldownRemainingMs: Record<string, number> = {};
    let disabledCount = 0;
    let disabledModelCount = 0;

    for (const project of this.projects) {
      if (this.isProjectDisabled(project.id, now)) disabledCount++;
      if (this.isModelDisabled(project.id, model, now)) disabledModelCount++;

      const active = this.activeRequests.get(project.id) || 0;
      if (active > 0) activeRequests[project.id] = active;

      const usage = this.getUsage(project.id, model);
      usage.minuteRequests = usage.minuteRequests.filter((ts) => now - ts < 60_000);
      rpmUsed[project.id] = usage.minuteRequests.length;

      const projCd = Math.max(0, (this.projectCooldownUntil.get(project.id) || 0) - now);
      if (projCd > 0) projectCooldownRemainingMs[project.id] = projCd;

      const modelCd = Math.max(0, usage.cooldownUntil - now);
      if (modelCd > 0) modelCooldownRemainingMs[project.id] = modelCd;
    }

    return {
      totalProjects: this.projects.length,
      excludedCount: excludedProjectIds.size,
      disabledCount,
      disabledModelCount,
      rpmLimit: quota.rpm,
      activeRequests,
      rpmUsed,
      projectCooldownRemainingMs,
      modelCooldownRemainingMs,
    };
  }

  markRateLimited(projectId: string, model: string, retryAfterMs = 60_000): void {
    const usage = this.getUsage(projectId, model);
    usage.cooldownUntil = Math.max(usage.cooldownUntil, Date.now() + retryAfterMs);
  }

  markProjectCooldown(projectId: string, cooldownMs: number): void {
    this.projectCooldownUntil.set(
      projectId,
      Math.max(this.projectCooldownUntil.get(projectId) || 0, Date.now() + cooldownMs),
    );
  }

  markProjectUnavailable(projectId: string, durationMs = DEFAULT_UNAVAILABLE_TTL_MS): void {
    this.disabledProjectsUntil.set(projectId, Date.now() + durationMs);
  }

  markModelUnavailable(projectId: string, model: string, durationMs = DEFAULT_UNAVAILABLE_TTL_MS): void {
    const unblockTimestamp = Date.now() + durationMs;
    this.disabledProjectModelsUntil.set(`${projectId}:${model}`, unblockTimestamp);
    if (durationMs > 10 * 60_000) {
      const project = this.projects.find((p) => p.id === projectId);
      if (project) {
        savePersistedRpdBlock(project.apiKey, model, unblockTimestamp);
      }
    }
  }

  private isProjectDisabled(projectId: string, now: number): boolean {
    const until = this.disabledProjectsUntil.get(projectId);
    if (!until) return false;
    if (now >= until) {
      this.disabledProjectsUntil.delete(projectId);
      return false;
    }
    return true;
  }

  private isModelDisabled(projectId: string, model: string, now: number): boolean {
    const key = `${projectId}:${model}`;
    const until = this.disabledProjectModelsUntil.get(key);
    if (!until) return false;
    if (now >= until) {
      this.disabledProjectModelsUntil.delete(key);
      return false;
    }
    return true;
  }

  private getOrderedCandidates(queueKey: string): GeminiProject[] {
    if (this.projects.length < 2) return this.projects;
    const cursor = this.cursors.get(queueKey) || 0;
    this.cursors.set(queueKey, (cursor + 1) % this.projects.length);
    return [...this.projects.slice(cursor), ...this.projects.slice(0, cursor)];
  }

  private getUsage(projectId: string, model: string): UsageWindow {
    const key = `${projectId}:${model}`;
    let usage = this.usage.get(key);
    if (!usage) {
      usage = {
        minuteRequests: [],
        cooldownUntil: 0,
      };
      this.usage.set(key, usage);
    }
    return usage;
  }
}
