import { Capacitor } from '@capacitor/core';

/**
 * Returns the base backend API URL.
 * - On Web (browser): returns empty string '' to use same-origin relative requests (/api/gemini/...)
 * - On Native Android: requires VITE_BACKEND_URL to point to a deployed backend.
 */
export function getApiBaseUrl(): string {
  const envUrl = (import.meta.env.VITE_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (envUrl) {
    return envUrl;
  }

  if (Capacitor.isNativePlatform() || import.meta.env.VITE_APP_MODE === 'apk') {
    throw new Error(
      'Chưa cấu hình máy chủ AI cho ứng dụng Android. Hãy đặt BACKEND_API_URL thành URL HTTPS của máy chủ API đã triển khai.',
    );
  }

  return '';
}

export function buildApiUrl(endpointPath: string): string {
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const base = getApiBaseUrl();
  return `${base}${cleanPath}`;
}
