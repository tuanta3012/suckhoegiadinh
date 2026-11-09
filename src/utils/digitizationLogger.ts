
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

class DigitizationLogger {
  private logs: DigitizationLogEntry[] = [];
  private readonly MAX_LOGS = 3000;

  constructor() {
    try {
      if (typeof window !== 'undefined') {
        const stored = localStorage.getItem(DIGITIZATION_LOGS_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            this.logs = parsed;
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
    source: 'client' | 'server' = 'client',
  ) {
    const entry: DigitizationLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      durationMs,
      source,
      data,
    };
    this.logs.push(entry);
    if (this.logs.length > this.MAX_LOGS) this.logs.shift();

    // Save to localStorage
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem(DIGITIZATION_LOGS_STORAGE_KEY, JSON.stringify(this.logs));
      }
    } catch (e) {
      console.warn('[DigitizationLogger] Failed to save logs to localStorage:', e);
    }

    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    const durStr = durationMs !== undefined ? ` [${durationMs}ms]` : '';
    logFn(`[Digitization][${stage}] ${message}${durStr}`, data || '');
  }

  getLogs(): DigitizationLogEntry[] {
    return [...this.logs];
  }

  clearLogs() {
    this.logs = [];
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(DIGITIZATION_LOGS_STORAGE_KEY);
      }
    } catch (e) {
      console.warn('[DigitizationLogger] Failed to clear logs from localStorage:', e);
    }
  }

  async exportLogsAsFile(
    customLogs?: DigitizationLogEntry[],
    extraMetadata?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      // Kết hợp cả Client logs và Server logs theo trình tự thời gian
      const clientLogs: DigitizationLogEntry[] = this.logs.map((l) => ({
        ...l,
        source: l.source || 'client',
      }));
      const serverLogs: DigitizationLogEntry[] = (customLogs || []).map((l) => ({
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
}

export const digitizationLogger = new DigitizationLogger();
