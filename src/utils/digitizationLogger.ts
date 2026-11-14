
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

class DigitizationLogger {
  private logs: DigitizationLogEntry[] = [];
  private readonly MAX_LOGS = 3000;
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
    const entry: DigitizationLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      durationMs,
      source: source || (typeof window === 'undefined' ? 'server' : 'client'),
      data,
    };
    this.logs.push(entry);
    if (this.logs.length > this.MAX_LOGS) this.logs.shift();
    this.persistLogs();

    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const durStr = durationMs !== undefined ? ` [${durationMs}ms]` : '';
    logFn(`[Digitization][${stage}] ${message}${durStr}`, data || '');
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
        environment: {
          platform: Capacitor.getPlatform(),
          isNative: Capacitor.isNativePlatform(),
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
          ...(extraMetadata || {}),
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
