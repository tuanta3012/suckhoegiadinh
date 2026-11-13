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

export class GeminiQuotaScheduler {
  private readonly usage = new Map<string, UsageWindow>();
  private readonly cursors = new Map<string, number>();
  private readonly disabledProjects = new Set<string>();
  private readonly disabledProjectModels = new Set<string>();
  private readonly projectCooldownUntil = new Map<string, number>();
  private readonly activeRequests = new Map<string, number>();

  constructor(
    private readonly projects: GeminiProject[],
    private readonly maxConcurrentPerProject = 1,
  ) {}

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
  ): Promise<{ project: GeminiProject; release: () => void }> {
    const startedAt = Date.now();
    const queueKey = `${task}:${model}`;
    while (Date.now() - startedAt < timeoutMs) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Gemini request was cancelled.');
      }
      const candidates = this.getOrderedCandidates(queueKey).filter((project) =>
        (!preferredProjectId || project.id === preferredProjectId) &&
        !excludedProjectIds.has(project.id) &&
        !this.disabledProjects.has(project.id) &&
        !this.disabledProjectModels.has(`${project.id}:${model}`),
      );
      if (candidates.length === 0) {
        throw new Error(`No available projects remain for ${model}.`);
      }
      let nextWaitMs = timeoutMs - (Date.now() - startedAt);
      let blockedByCapacity = false;

      for (const project of candidates) {
        const usage = this.getUsage(project.id, model);
        const now = Date.now();
        usage.minuteRequests = usage.minuteRequests.filter((timestamp) => now - timestamp < 60_000);

        const projectCooldownWait = Math.max(0, (this.projectCooldownUntil.get(project.id) || 0) - now);
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
          ? Math.max(1, 60_000 - (now - usage.minuteRequests[0]))
          : 0;
        const cooldownWait = Math.max(0, usage.cooldownUntil - now);
        if (requestWait > 0 || cooldownWait > 0) {
          blockedByCapacity = true;
          nextWaitMs = Math.min(nextWaitMs, Math.max(requestWait, cooldownWait));
          continue;
        }

        usage.minuteRequests.push(now);
        this.activeRequests.set(project.id, (this.activeRequests.get(project.id) || 0) + 1);
        let released = false;
        return {
          project,
          release: () => {
            if (released) return;
            released = true;
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

  markProjectUnavailable(projectId: string): void {
    this.disabledProjects.add(projectId);
  }

  markModelUnavailable(projectId: string, model: string): void {
    this.disabledProjectModels.add(`${projectId}:${model}`);
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
