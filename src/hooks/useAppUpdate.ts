import { useState, useCallback, useEffect } from 'react';
import type { AppUpdateInfo } from '../components/AppUpdateModal';

const VERSION_PATTERN = /^v?(\d+(?:\.\d+){0,3})$/i;
const UPDATE_CHECK_TIMEOUT_MS = 10_000;

export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (version: string): number[] | null => {
    const match = VERSION_PATTERN.exec(version.trim());
    if (!match) return null;
    return match[1].split('.').map(Number);
  };
  const currParts = parse(current);
  const lateParts = parse(latest);
  if (!currParts || !lateParts) return false;
  for (let i = 0; i < Math.max(currParts.length, lateParts.length); i++) {
    const c = currParts[i] ?? 0;
    const l = lateParts[i] ?? 0;
    if (l > c) return true;
    if (c > l) return false;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface UseAppUpdateOptions {
  currentVersion: string;
  updateServerUrl: string; // Đường dẫn URL raw tới file version.json trên GitHub
  autoCheckDelayMs?: number; // Tự động kiểm tra sau N milliseconds (mặc định 2000ms)
  onNotification?: (msg: string, type: 'info' | 'success' | 'error') => void;
}

export function useAppUpdate({
  currentVersion,
  updateServerUrl,
  autoCheckDelayMs = 2000,
  onNotification,
}: UseAppUpdateOptions) {
  const isPlayStore = (import.meta as any).env?.VITE_APP_MODE === 'play';
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [isUpdateModalOpen, setIsUpdateModalOpen] = useState<boolean>(false);
  const [isChecking, setIsChecking] = useState<boolean>(false);

  const checkAppUpdate = useCallback(async (manual: boolean = false) => {
    // Không thực hiện kiểm tra hoặc mở modal trên bản phát hành Google Play AAB
    if (isPlayStore) {
      if (manual && onNotification) {
        onNotification(`Phiên bản ứng dụng: v${currentVersion}`, 'info');
      }
      return;
    }

    setIsChecking(true);
    if (manual && onNotification) {
      onNotification('Đang kiểm tra phiên bản mới từ máy chủ...', 'info');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
    try {
      const separator = updateServerUrl.includes('?') ? '&' : '?';
      const response = await fetch(`${updateServerUrl}${separator}_t=${Date.now()}`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Máy chủ cập nhật trả về lỗi HTTP ${response.status}.`);
      }

      const manifest: unknown = await response.json();
      if (!isRecord(manifest)) throw new Error('Dữ liệu version.json không hợp lệ.');
      const latestVersion = manifest.version ?? manifest.versionName;
      if (typeof latestVersion !== 'string' || !VERSION_PATTERN.test(latestVersion.trim())) {
        throw new Error('version.json thiếu phiên bản hợp lệ.');
      }

      if (isNewerVersion(currentVersion, latestVersion)) {
        const downloadUrl = getHttpsUrl(manifest.downloadUrl) || getHttpsUrl(manifest.apkUrl);
        if (!downloadUrl) throw new Error('version.json thiếu đường dẫn HTTPS hợp lệ tới APK.');
        const notes = typeof manifest.notes === 'string' ? manifest.notes : undefined;
        const changelog = Array.isArray(manifest.changelog)
          ? manifest.changelog.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [];
        setUpdateInfo({
          version: latestVersion,
          downloadUrl,
          apkUrl: downloadUrl,
          changelog: changelog.length ? changelog : [notes || 'Nâng cấp tính năng và cải thiện hiệu năng.'],
          releaseDate: typeof manifest.releaseDate === 'string'
            ? manifest.releaseDate
            : typeof manifest.date === 'string'
              ? manifest.date
              : undefined,
        });
        setIsUpdateModalOpen(true);
        if (manual && onNotification) {
          onNotification(`Đã tìm thấy bản cập nhật mới v${latestVersion}!`, 'success');
        }
      } else if (manual && onNotification) {
        onNotification(`Bạn đang dùng phiên bản mới nhất (v${currentVersion}).`, 'success');
      }
    } catch (error) {
      console.warn('Lỗi kiểm tra cập nhật:', error);
      if (manual && onNotification) {
        const message = error instanceof DOMException && error.name === 'AbortError'
          ? 'Máy chủ cập nhật phản hồi quá lâu. Vui lòng thử lại.'
          : error instanceof Error
            ? error.message
            : 'Không thể kết nối máy chủ. Vui lòng kiểm tra lại mạng.';
        onNotification(message, 'error');
      }
    } finally {
      clearTimeout(timeout);
      setIsChecking(false);
    }
  }, [currentVersion, updateServerUrl, onNotification]);

  useEffect(() => {
    if (isPlayStore) return;
    if (autoCheckDelayMs > 0) {
      const timer = setTimeout(() => {
        checkAppUpdate(false);
      }, autoCheckDelayMs);
      return () => clearTimeout(timer);
    }
  }, [checkAppUpdate, autoCheckDelayMs, isPlayStore]);

  return {
    updateInfo,
    isUpdateModalOpen,
    setIsUpdateModalOpen,
    isChecking,
    checkAppUpdate,
  };
}
