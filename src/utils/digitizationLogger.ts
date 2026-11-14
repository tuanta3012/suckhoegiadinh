
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export interface DigitizationLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  durationMs?: number;
  source?: 'client' | 'server';
  data?: any;
}

export const DIGITIZATION_LOGS_STORAGE_KEY = 'family_health_ai_digitization_logs';
const LOG_TIME_ZONE = 'Asia/Ho_Chi_Minh';

function getLogDateKey(value: string | Date): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: LOG_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function sanitizeSensitiveText(value: string): string {
  return value
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, '$1***')
    .replace(/([?&]key=)[^&\s]+/gi, '$1***');
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const masked = sanitizeSensitiveText(value);
    return masked.length > 1500 ? `${masked.slice(0, 1500)}…` : masked;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeSensitiveText(value.message).slice(0, 1000),
    };
  }
  if (depth >= 4) return '[Nested]';
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeLogValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:apiKey|apikey|clientGeminiKeys|authorization|token|password|secret)$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeLogValue(v, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

class DigitizationLogger {
  private logs: DigitizationLogEntry[] = [];
  private readonly MAX_LOGS = 5000;
  private currentLogDate = getLogDateKey(new Date()) || '';

  constructor() {
    try {
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(DIGITIZATION_LOGS_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            this.logs = parsed.filter((entry): entry is DigitizationLogEntry =>
              Boolean(
                entry &&
                  typeof entry.timestamp === 'string' &&
                  getLogDateKey(entry.timestamp) === this.currentLogDate,
              ),
            );
            if (this.logs.length !== parsed.length) this.persistLogs();
          }
        }
      }
    } catch (e) {
      console.warn('[DigitizationLogger] Failed to load logs from localStorage:', e);
    }
  }

  startTimer(): () => number {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return () => {
      const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return Math.round(end - start);
    };
  }

  log(
    level: 'info' | 'warn' | 'error',
    stage: string,
    message: string,
    data?: any,
    durationMs?: number,
    source?: 'client' | 'server',
  ) {
    this.retainCurrentDay();
    const safeMessage = sanitizeSensitiveText(String(message || ''));
    const safeData = data !== undefined ? sanitizeLogValue(data) : undefined;
    const entry: DigitizationLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message: safeMessage,
      durationMs,
      source: source || (typeof window === 'undefined' ? 'server' : 'client'),
      data: safeData,
    };
    this.logs.push(entry);
    if (this.logs.length > this.MAX_LOGS) this.logs.shift();
    this.persistLogs();

    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const durStr = durationMs !== undefined ? ` [${durationMs}ms]` : '';
    logFn(`[Digitization][${stage}] ${safeMessage}${durStr}`, safeData || '');
  }

  getLogs(): DigitizationLogEntry[] {
    this.retainCurrentDay();
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
    this.currentLogDate = getLogDateKey(new Date()) || '';
    this.persistLogs();
  }

  async exportLogsAsFile(
    customLogs?: DigitizationLogEntry[],
    extraMetadata?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      // Kết hợp cả Client logs và Server logs theo trình tự thời gian
      const currentDay = getLogDateKey(new Date());
      const clientLogs: DigitizationLogEntry[] = this.getLogs().map((l) => ({
        ...l,
        source: l.source || 'client',
      }));
      const serverLogs: DigitizationLogEntry[] = (customLogs || [])
        .filter((entry) => getLogDateKey(entry.timestamp) === currentDay)
        .map((l) => ({
          ...l,
          message: sanitizeSensitiveText(String(l.message || '')),
          data: l.data !== undefined ? sanitizeLogValue(l.data) : undefined,
          source: l.source || 'server',
        }));

      // Hợp nhất và sắp xếp theo mốc thời gian ISO
      const mergedLogs = [...clientLogs, ...serverLogs].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      const finalLogs =
        mergedLogs.length > 0
          ? mergedLogs
          : [
              {
                timestamp: new Date().toISOString(),
                level: 'info' as const,
                stage: 'SYSTEM',
                message: 'Không có dữ liệu log nào được ghi nhận tại thời điểm xuất.',
                source: 'client' as const,
              },
            ];

      const exportPayload = {
        title: 'Báo cáo Hoạt động Số hóa & Phân tích AI - Sức Khỏe Gia Đình',
        exportedAt: new Date().toISOString(),
        logDate: currentDay,
        environment: {
          platform: Capacitor.getPlatform(),
          isNative: Capacitor.isNativePlatform(),
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
          ...(extraMetadata ? (sanitizeLogValue(extraMetadata) as Record<string, unknown>) : {}),
        },
        statistics: {
          totalEntries: finalLogs.length,
          clientEntries: finalLogs.filter((l) => l.source === 'client').length,
          serverEntries: finalLogs.filter((l) => l.source === 'server').length,
          errorCount: finalLogs.filter((l) => l.level === 'error').length,
          warnCount: finalLogs.filter((l) => l.level === 'warn').length,
          infoCount: finalLogs.filter((l) => l.level === 'info').length,
        },
        logs: finalLogs,
      };

      const jsonString = JSON.stringify(exportPayload, null, 2);
      const dateStr = new Date().toISOString().slice(0, 10);
      const timeStr = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
      const fileName = `family_health_ai_logs_${dateStr}_${timeStr}.json`;

      if (Capacitor.isNativePlatform()) {
        const file = await Filesystem.writeFile({
          path: fileName,
          data: jsonString,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: 'Nhật ký hoạt động Sức Khỏe Gia Đình',
          text: `Tệp log chẩn đoán AI & số hóa y tế (${finalLogs.length} sự kiện).`,
          url: file.uri,
          dialogTitle: 'Chia sẻ hoặc lưu tệp log',
        });
        return true;
      }

      const url = URL.createObjectURL(new Blob([jsonString], { type: 'application/json;charset=utf-8;' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      console.error('[DigitizationLogger] Failed to export logs:', e);
      return false;
    }
  }

  private retainCurrentDay(): void {
    const currentDay = getLogDateKey(new Date()) || '';
    if (currentDay !== this.currentLogDate) {
      this.logs = [];
      this.currentLogDate = currentDay;
      this.persistLogs();
      return;
    }

    const currentLogs = this.logs.filter(
      (entry) => getLogDateKey(entry.timestamp) === currentDay,
    );
    if (currentLogs.length !== this.logs.length) {
      this.logs = currentLogs;
      this.persistLogs();
    }
  }

  private persistLogs(): void {
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem(DIGITIZATION_LOGS_STORAGE_KEY, JSON.stringify(this.logs));
      }
    } catch (e) {
      console.warn('[DigitizationLogger] Failed to save logs from the current day:', e);
    }
  }
}

export const digitizationLogger = new DigitizationLogger();
