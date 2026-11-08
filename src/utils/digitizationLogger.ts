
import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export interface DigitizationLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  stage: string;
  message: string;
  data?: any;
}

export const DIGITIZATION_LOGS_STORAGE_KEY = 'family_health_ai_digitization_logs';

class DigitizationLogger {
  private logs: DigitizationLogEntry[] = [];
  private readonly MAX_LOGS = 1000;

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

  log(level: 'info' | 'warn' | 'error', stage: string, message: string, data?: any) {
    const entry: DigitizationLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
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
    logFn(`[Digitization][${stage}] ${message}`, data || '');
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

  async exportLogsAsFile(customLogs?: DigitizationLogEntry[]): Promise<boolean> {
    try {
      // Prioritize customLogs (usually from server), then local logs, then default message
      let logsToExport: DigitizationLogEntry[] = [];
      
      if (customLogs && Array.isArray(customLogs)) {
        logsToExport = customLogs;
      } else if (this.logs && this.logs.length > 0) {
        logsToExport = this.logs;
      }

      if (logsToExport.length === 0) {
        logsToExport = [{
          timestamp: new Date().toISOString(),
          level: 'info',
          stage: 'SYSTEM',
          message: 'Không có dữ liệu log nào được ghi nhận tại thời điểm xuất.'
        }];
      }

      const jsonString = JSON.stringify(logsToExport, null, 2);
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `family_health_ai_digitization_logs_${dateStr}.json`;
      if (Capacitor.isNativePlatform()) {
        const file = await Filesystem.writeFile({
          path: fileName,
          data: jsonString,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({
          title: 'Log ứng dụng Sức khỏe Gia đình',
          text: 'Tệp log chẩn đoán của ứng dụng.',
          url: file.uri,
          dialogTitle: 'Xuất log ứng dụng',
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
