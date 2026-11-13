interface AdmissionWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface AdmissionState {
  active: number;
  queue: AdmissionWaiter[];
}

export class GeminiRequestAdmission {
  private readonly states = new Map<string, AdmissionState>();

  constructor(
    private readonly maxActivePerIdentity = 6,
    private readonly maxQueuedPerIdentity = 12,
  ) {}

  acquire(identity: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('Request was cancelled.'));
    }

    const state = this.states.get(identity) || { active: 0, queue: [] };
    this.states.set(identity, state);

    if (state.active < this.maxActivePerIdentity) {
      state.active++;
      return Promise.resolve(this.createRelease(identity, state));
    }

    if (state.queue.length >= this.maxQueuedPerIdentity) {
      return Promise.reject(new Error('Gemini request queue is full. Please retry shortly.'));
    }

    return new Promise((resolve, reject) => {
      const waiter: AdmissionWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        signal?.removeEventListener('abort', waiter.onAbort!);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Request was cancelled.'));
        this.removeIdleState(identity, state);
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      state.queue.push(waiter);
    });
  }

  private createRelease(identity: string, state: AdmissionState): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      while (state.queue.length > 0) {
        const next = state.queue.shift()!;
        next.signal?.removeEventListener('abort', next.onAbort!);
        if (next.signal?.aborted) {
          next.reject(next.signal.reason instanceof Error ? next.signal.reason : new Error('Request was cancelled.'));
          continue;
        }
        next.resolve(this.createRelease(identity, state));
        return;
      }

      state.active--;
      this.removeIdleState(identity, state);
    };
  }

  private removeIdleState(identity: string, state: AdmissionState): void {
    if (state.active === 0 && state.queue.length === 0) {
      this.states.delete(identity);
    }
  }
}
