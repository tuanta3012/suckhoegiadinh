import { useState, useCallback, useEffect } from 'react';
import { AppUpdateInfo } from '../components/AppUpdateModal';

export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split('.').map(Number);
  const currParts = parse(current);
  const lateParts = parse(latest);
  for (let i = 0; i < Math.max(currParts.length, lateParts.length); i++) {
    const c = currParts[i] || 0;
    const l = lateParts[i] || 0;
    if (l > c) return true;
    if (c > l) return false;
  }
  return false;
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
    try {
      const res = await fetch(`${updateServerUrl}?_t=${Date.now()}`);
      if (res.ok) {
        const data = await res.json();
        const latestVersion = data.version || data.versionName;
        if (data && latestVersion) {
          const isNewer = isNewerVersion(currentVersion, latestVersion);
          if (isNewer) {
            setUpdateInfo({
              version: latestVersion,
              downloadUrl: data.downloadUrl || data.apkUrl,
              apkUrl: data.apkUrl || data.downloadUrl,
              changelog: Array.isArray(data.changelog)
                ? data.changelog
                : (data.notes ? [data.notes] : ['Nâng cấp tính năng và cải thiện hiệu năng.']),
              releaseDate: data.releaseDate || data.date,
            });
            setIsUpdateModalOpen(true);
            if (manual && onNotification) {
              onNotification(`Đã tìm thấy bản cập nhật mới v${latestVersion}!`, 'success');
            }
          } else {
            if (manual && onNotification) {
              onNotification(`Bạn đang dùng phiên bản mới nhất (v${currentVersion}).`, 'success');
            }
          }
        }
      } else {
        if (manual && onNotification) {
          onNotification(`Không thể kết nối máy chủ cập nhật (Mã lỗi ${res.status}).`, 'error');
        }
      }
    } catch (err: any) {
      console.warn('Lỗi kiểm tra cập nhật:', err);
      if (manual && onNotification) {
        onNotification('Không thể kết nối máy chủ. Vui lòng kiểm tra lại mạng.', 'error');
      }
    } finally {
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
