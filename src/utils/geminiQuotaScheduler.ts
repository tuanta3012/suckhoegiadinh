export type GeminiTask = 'digitization' | 'analysis' | 'assistant' | 'refinement';

export interface GeminiProject {
  id: string;
  apiKey: string;
}

export interface GeminiQuota {
  rpm: number;
  rpd: number;
  maxConcurrent: number;
}

interface UsageWindow {
  minuteRequests: number[];
  day: string;
  dayRequests: number;
  active: number;
  cooldownUntil: number;
}

export function parseGeminiProjects(
  apiKeys: string[],
  defaultKey: string | undefined,
): GeminiProject[] {
  const keys = [...new Set([...apiKeys, ...(defaultKey ? [defaultKey] : [])])];
  return keys.map((apiKey, index) => ({ id: `account-${index + 1}`, apiKey }));
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export class GeminiQuotaScheduler {
  private readonly usage = new Map<string, UsageWindow>();
  private readonly cursors = new Map<string, number>();
  private readonly disabledProjects = new Set<string>();
  private readonly disabledProjectModels = new Set<string>();
  private readonly projectCooldownUntil = new Map<string, number>();

  constructor(private readonly projects: GeminiProject[]) {}

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
  ): Promise<{ project: GeminiProject; release: () => void }> {
    const startedAt = Date.now();
    const queueKey = `${task}:${model}`;
    while (Date.now() - startedAt < timeoutMs) {
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
      let hasDailyQuota = false;
      let blockedByConcurrency = false;
      let blockedByCapacity = false;

      for (const project of candidates) {
        const usage = this.getUsage(project.id, model);
        const now = Date.now();
        usage.minuteRequests = usage.minuteRequests.filter((timestamp) => now - timestamp < 60_000);
        if (usage.day !== utcDay(now)) {
          usage.day = utcDay(now);
          usage.dayRequests = 0;
        }
        if (usage.dayRequests >= quota.rpd) continue;
        hasDailyQuota = true;

        const projectCooldownWait = Math.max(0, (this.projectCooldownUntil.get(project.id) || 0) - now);
        if (projectCooldownWait > 0) {
          blockedByCapacity = true;
          nextWaitMs = Math.min(nextWaitMs, projectCooldownWait);
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
        if (usage.active >= quota.maxConcurrent) {
          blockedByConcurrency = true;
          nextWaitMs = Math.min(nextWaitMs, 250);
          continue;
        }

        usage.minuteRequests.push(now);
        usage.dayRequests++;
        usage.active++;
        return {
          project,
          release: () => {
            usage.active = Math.max(0, usage.active - 1);
          },
        };
      }

      if (!hasDailyQuota) {
        throw new Error(`No daily ${task} quota remains for ${model} in any configured Gemini project.`);
      }
      if (!blockedByConcurrency && !blockedByCapacity) {
        throw new Error(`No RPM capacity remains for ${model} in the configured projects.`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(nextWaitMs, 1_000)));
    }

    // Fallback: If timeout elapsed but there are viable candidates with remaining daily quota,
    // available RPM capacity, and available concurrency that were only held back by a software cooldown,
    // bypass the cooldown on the best candidate (lowest remaining cooldown wait) and proceed.
    const finalCandidates = this.getOrderedCandidates(queueKey).filter((project) =>
      (!preferredProjectId || project.id === preferredProjectId) &&
      !excludedProjectIds.has(project.id) &&
      !this.disabledProjects.has(project.id) &&
      !this.disabledProjectModels.has(`${project.id}:${model}`),
    );
    const viableCandidates = finalCandidates.filter((project) => {
      const usage = this.getUsage(project.id, model);
      const now = Date.now();
      usage.minuteRequests = usage.minuteRequests.filter((timestamp) => now - timestamp < 60_000);
      return (
        usage.dayRequests < quota.rpd &&
        usage.active < quota.maxConcurrent &&
        usage.minuteRequests.length < quota.rpm
      );
    });

    if (viableCandidates.length > 0) {
      viableCandidates.sort((a, b) => {
        const usageA = this.getUsage(a.id, model);
        const usageB = this.getUsage(b.id, model);
        const cdA = Math.max(usageA.cooldownUntil, this.projectCooldownUntil.get(a.id) || 0);
        const cdB = Math.max(usageB.cooldownUntil, this.projectCooldownUntil.get(b.id) || 0);
        return cdA - cdB;
      });

      const selected = viableCandidates[0];
      const usage = this.getUsage(selected.id, model);
      usage.cooldownUntil = 0;
      this.projectCooldownUntil.delete(selected.id);

      const now = Date.now();
      usage.minuteRequests.push(now);
      usage.dayRequests++;
      usage.active++;
      return {
        project: selected,
        release: () => {
          usage.active = Math.max(0, usage.active - 1);
        },
      };
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

  markDailyQuotaExhausted(projectId: string, model: string): void {
    const usage = this.getUsage(projectId, model);
    usage.day = utcDay(Date.now());
    usage.dayRequests = Number.MAX_SAFE_INTEGER;
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
        day: utcDay(Date.now()),
        dayRequests: 0,
        active: 0,
        cooldownUntil: 0,
      };
      this.usage.set(key, usage);
    }
    return usage;
  }
}
