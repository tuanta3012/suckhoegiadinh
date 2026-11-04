import { getSecureItem, setSecureItem } from './secureStorage';

export type GeminiTaskType = 'digitization' | 'analysis';

export interface ModelQuotaConfig {
  rpm: number;
  rpd: number;
}

export const TASK_MODEL_CONFIG: Record<
  GeminiTaskType,
  {
    primaryModels: string[];
    quota: ModelQuotaConfig;
    description: string;
  }
> = {
  digitization: {
    primaryModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
    quota: { rpm: 15, rpd: 500 },
    description: 'Số hóa, OCR, nhận dạng tài liệu, hiệu chỉnh & sắp xếp dữ liệu',
  },
  analysis: {
    primaryModels: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash', 'gemini-flash-latest'],
    quota: { rpm: 5, rpd: 20 },
    description: 'Phân tích toàn diện hồ sơ y tế, đánh giá sức khỏe & lời khuyên chi tiết',
  },
};

export interface KeyRuntimeState {
  keyIndex: number;
  label: string;
  apiKey: string;
  maskedKey: string;
  status: 'active' | 'cooldown' | 'disabled' | 'quota_exhausted';
  cooldownUntil: number;
  lastUsedAt: number;
  totalSuccess: number;
  totalFailures: number;
  lastError?: string;
  // Per-model request timestamps for sliding 60s window (RPM)
  modelRpmTimestamps: Record<string, number[]>;
  // Per-model daily counts (RPD)
  modelRpdUsage: Record<string, { date: string; count: number }>;
}

export interface PoolSummaryState {
  totalKeys: number;
  activeKeys: number;
  cooldownKeys: number;
  activeConcurrent: number;
  queueLength: number;
  keys: {
    index: number;
    label: string;
    maskedKey: string;
    status: 'active' | 'cooldown' | 'disabled' | 'quota_exhausted';
    cooldownRemainingSec: number;
    totalSuccess: number;
    totalFailures: number;
    lastError?: string;
    todayCalls: number;
  }[];
}

const STORAGE_KEY_GEMINI_KEYS = 'stk_gemini_api_keys_pool';
const MAX_CONCURRENT_CALLS = 10;

class GeminiPoolManager {
  private keys: string[] = [];
  private keyStates: Map<string, KeyRuntimeState> = new Map();
  private isInitialized = false;
  private activeCalls = 0;
  private queue: Array<() => void> = [];

  constructor() {
    // Initial sync load from env if present
    this.initFromEnvironment();
  }

  private initFromEnvironment() {
    try {
      const envKeys = (import.meta as unknown as { env: Record<string, string | undefined> }).env
        ?.GEMINI_API_KEYS ||
        (import.meta as unknown as { env: Record<string, string | undefined> }).env
          ?.VITE_GEMINI_API_KEYS ||
        '';

      if (envKeys) {
        this.addRawKeyString(envKeys);
      }
    } catch {
      // Ignore if not in browser or env is inaccessible
    }
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Load from secure storage
    try {
      const stored = await getSecureItem(STORAGE_KEY_GEMINI_KEYS);
      if (stored) {
        this.addRawKeyString(stored);
      }
    } catch (err) {
      console.warn('[GeminiPoolManager] Không tải được khóa từ SecureStorage:', err);
    }
  }

  public addRawKeyString(raw: string): number {
    if (!raw || typeof raw !== 'string') return 0;
    let extracted: string[] = [];

    // Try parsing as JSON array
    const trimmed = raw.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          extracted = parsed.filter((item): item is string => typeof item === 'string');
        }
      } catch {
        // Fallback to delimiter splitting
      }
    }

    if (extracted.length === 0) {
      // Split by comma, semicolon, or newline
      extracted = trimmed
        .split(/[\n,;]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 10 && !k.startsWith('http')); // Filter out URLs or empty strings
    }

    let addedCount = 0;
    for (const key of extracted) {
      if (!this.keys.includes(key)) {
        this.keys.push(key);
        this.registerKey(key, this.keys.length);
        addedCount++;
      }
    }

    return addedCount;
  }

  public async setKeys(newKeys: string[]): Promise<void> {
    const cleaned = Array.from(
      new Set(
        newKeys
          .map((k) => k.trim())
          .filter((k) => k.length > 10 && !k.startsWith('http'))
      )
    );

    this.keys = cleaned;
    this.keyStates.clear();
    cleaned.forEach((key, idx) => this.registerKey(key, idx + 1));

    // Save to SecureStorage
    try {
      await setSecureItem(STORAGE_KEY_GEMINI_KEYS, JSON.stringify(cleaned));
    } catch (err) {
      console.error('[GeminiPoolManager] Không thể lưu danh sách khóa vào SecureStorage:', err);
    }
  }

  public getKeys(): string[] {
    return [...this.keys];
  }

  public getAllKeys(): string[] {
    return [...this.keys];
  }

  private registerKey(key: string, index: number) {
    const masked = key.length > 10
      ? `${key.slice(0, 6)}...${key.slice(-4)}`
      : '***';

    this.keyStates.set(key, {
      keyIndex: index,
      label: `Tài khoản Google ${index}`,
      apiKey: key,
      maskedKey: masked,
      status: 'active',
      cooldownUntil: 0,
      lastUsedAt: 0,
      totalSuccess: 0,
      totalFailures: 0,
      modelRpmTimestamps: {},
      modelRpdUsage: {},
    });
  }

  private getTodayUtcDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private cleanRpmTimestamps(timestamps: number[]): number[] {
    const now = Date.now();
    return timestamps.filter((ts) => now - ts < 60000);
  }

  private checkKeyQuota(
    state: KeyRuntimeState,
    model: string,
    quota: ModelQuotaConfig
  ): { available: boolean; reason?: string } {
    const now = Date.now();

    // Check cooldown
    if (state.status === 'disabled') {
      return { available: false, reason: 'Khóa bị vô hiệu hóa hoặc không hợp lệ' };
    }
    if (state.cooldownUntil > now) {
      const waitSec = Math.ceil((state.cooldownUntil - now) / 1000);
      return { available: false, reason: `Đang tạm dừng bảo vệ quota (còn ${waitSec}s)` };
    }

    // Check RPM (sliding 60 seconds)
    const currentTimestamps = this.cleanRpmTimestamps(state.modelRpmTimestamps[model] || []);
    state.modelRpmTimestamps[model] = currentTimestamps;
    if (currentTimestamps.length >= quota.rpm) {
      return { available: false, reason: `Vượt RPM giới hạn (${currentTimestamps.length}/${quota.rpm} req/phút)` };
    }

    // Check RPD (today)
    const today = this.getTodayUtcDate();
    const rpdRecord = state.modelRpdUsage[model];
    if (rpdRecord && rpdRecord.date === today && rpdRecord.count >= quota.rpd) {
      return { available: false, reason: `Đạt giới hạn ngày RPD (${rpdRecord.count}/${quota.rpd} req/ngày)` };
    }

    return { available: true };
  }

  /**
   * Acquire a concurrency slot in the multi-threading worker pool
   */
  private async acquireSlot(): Promise<void> {
    if (this.activeCalls < MAX_CONCURRENT_CALLS) {
      this.activeCalls++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.activeCalls++;
        resolve();
      });
    });
  }

  private releaseSlot() {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next?.();
    }
  }

  /**
   * Central execution engine with:
   * 1. Multi-threading concurrency control
   * 2. Task-based model routing
   * 3. Automatic failover across 6 keys & fallback models
   * 4. Sliding-window RPM & RPD quota enforcement
   */
  public async executeTask<T>(
    taskType: GeminiTaskType,
    runner: (apiKey: string, model: string) => Promise<T>
  ): Promise<T> {
    await this.init();

    if (this.keys.length === 0) {
      throw new Error(
        'Chưa có API key Gemini nào trong kho GEMINI_API_KEYS. Vui lòng cấu hình ít nhất 1 khóa API để tiếp tục.'
      );
    }

    const taskConfig = TASK_MODEL_CONFIG[taskType];
    const candidateModels = taskConfig.primaryModels;
    const quotaConfig = taskConfig.quota;

    await this.acquireSlot();

    try {
      const errorsCollected: string[] = [];

      // Try models in task-specific order
      for (const model of candidateModels) {
        // Get all keys eligible for this model, sorted by least-recently-used & lowest RPM usage
        const candidateKeys = this.keys
          .map((k) => this.keyStates.get(k)!)
          .filter(Boolean)
          .sort((a, b) => {
            const rpmA = (a.modelRpmTimestamps[model] || []).length;
            const rpmB = (b.modelRpmTimestamps[model] || []).length;
            if (rpmA !== rpmB) return rpmA - rpmB;
            return a.lastUsedAt - b.lastUsedAt;
          });

        for (const keyState of candidateKeys) {
          const quotaCheck = this.checkKeyQuota(keyState, model, quotaConfig);
          if (!quotaCheck.available) {
            continue; // Skip throttled / out-of-quota key
          }

          // Attempt call with this key & model
          try {
            const result = await this.invokeWithTelemetry(keyState, model, quotaConfig, runner);
            return result;
          } catch (callError: unknown) {
            const err = callError instanceof Error ? callError : new Error(String(callError));
            const msg = err.message || '';
            const statusMatch = msg.match(/\b(429|403|401|503|500|504)\b/);
            const httpStatus = statusMatch ? Number(statusMatch[1]) : 0;

            console.warn(
              `[GeminiPoolManager] Lỗi tại ${keyState.label} (${keyState.maskedKey}) với model ${model}:`,
              msg
            );

            // Handle Failover Cases
            if (httpStatus === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(msg)) {
              // Rate limit on this key/model - Cooldown this key for 60 seconds
              keyState.status = 'cooldown';
              keyState.cooldownUntil = Date.now() + 60000;
              keyState.lastError = `429 Quota Exceeded (Cooldown 60s): ${msg.slice(0, 100)}`;
              keyState.totalFailures++;
              errorsCollected.push(`${keyState.label} [${model}] hết quota: tự động chuyển khóa kế tiếp`);
              // Immediately loop to the next key!
              continue;
            } else if (httpStatus === 401 || httpStatus === 403 || /API_KEY_INVALID/i.test(msg)) {
              // Invalid Key - Disable for this session
              keyState.status = 'disabled';
              keyState.lastError = `Khóa không hợp lệ (401/403): ${msg.slice(0, 100)}`;
              keyState.totalFailures++;
              errorsCollected.push(`${keyState.label} không hợp lệ: bỏ qua`);
              continue;
            } else {
              // Transient or model error - Record and try next key/model
              keyState.totalFailures++;
              keyState.lastError = msg.slice(0, 100);
              errorsCollected.push(`${keyState.label} [${model}]: ${msg.slice(0, 80)}`);
              continue;
            }
          }
        }
      }

      // If loop completed without returning, all candidate keys/models were exhausted or failed
      const summaryReason = errorsCollected.length > 0
        ? errorsCollected.slice(-3).join('; ')
        : 'Tất cả các API key trong kho đang chạm giới hạn RPM/RPD hoặc gặp lỗi tạm thời.';

      throw new Error(
        `Không thể hoàn tất tác vụ (${taskConfig.description}). Chi tiết: ${summaryReason}. Vui lòng thử lại sau giây lát.`
      );
    } finally {
      this.releaseSlot();
    }
  }

  private async invokeWithTelemetry<T>(
    keyState: KeyRuntimeState,
    model: string,
    quota: ModelQuotaConfig,
    runner: (apiKey: string, model: string) => Promise<T>
  ): Promise<T> {
    const now = Date.now();
    const today = this.getTodayUtcDate();

    const result = await runner(keyState.apiKey, model);

    // Record success & quota consumption
    keyState.lastUsedAt = now;
    keyState.totalSuccess++;
    keyState.status = 'active';

    // Record RPM
    const timestamps = this.cleanRpmTimestamps(keyState.modelRpmTimestamps[model] || []);
    timestamps.push(now);
    keyState.modelRpmTimestamps[model] = timestamps;

    // Record RPD
    const rpdRecord = keyState.modelRpdUsage[model];
    if (rpdRecord && rpdRecord.date === today) {
      rpdRecord.count += 1;
    } else {
      keyState.modelRpdUsage[model] = { date: today, count: 1 };
    }

    return result;
  }

  public getPoolState(): PoolSummaryState {
    const now = Date.now();
    const today = this.getTodayUtcDate();

    const keysSummary = this.keys.map((key, idx) => {
      const state = this.keyStates.get(key);
      if (!state) {
        return {
          index: idx + 1,
          label: `Tài khoản Google ${idx + 1}`,
          maskedKey: '***',
          status: 'disabled' as const,
          cooldownRemainingSec: 0,
          totalSuccess: 0,
          totalFailures: 0,
          todayCalls: 0,
        };
      }

      let status = state.status;
      let cooldownRemainingSec = 0;
      if (state.cooldownUntil > now) {
        status = 'cooldown';
        cooldownRemainingSec = Math.ceil((state.cooldownUntil - now) / 1000);
      } else if (state.status === 'cooldown') {
        status = 'active';
      }

      let todayCalls = 0;
      Object.values(state.modelRpdUsage).forEach((rpd) => {
        if (rpd.date === today) todayCalls += rpd.count;
      });

      return {
        index: state.keyIndex,
        label: state.label,
        maskedKey: state.maskedKey,
        status,
        cooldownRemainingSec,
        totalSuccess: state.totalSuccess,
        totalFailures: state.totalFailures,
        lastError: state.lastError,
        todayCalls,
      };
    });

    const activeKeys = keysSummary.filter((k) => k.status === 'active').length;
    const cooldownKeys = keysSummary.filter((k) => k.status === 'cooldown').length;

    return {
      totalKeys: this.keys.length,
      activeKeys,
      cooldownKeys,
      activeConcurrent: this.activeCalls,
      queueLength: this.queue.length,
      keys: keysSummary,
    };
  }
}

export const geminiPool = new GeminiPoolManager();
