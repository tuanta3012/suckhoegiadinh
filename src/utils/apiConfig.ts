import { Capacitor } from '@capacitor/core';

/**
 * Returns the base backend API URL.
 * - On Web (browser): returns empty string '' to use same-origin relative requests (/api/gemini/...)
 * - On Native Android (APK) or APK build mode: returns the configured VITE_BACKEND_URL
 *   or falls back to the production Cloud Run host of the applet.
 */
export function getApiBaseUrl(): string {
  const envUrl = (import.meta.env.VITE_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (envUrl) {
    return envUrl;
  }

  // When running on Capacitor native Android, relative '/api/...' calls hit 'https://localhost/api/...'
  // which will fail. We route to the deployed backend server.
  if (Capacitor.isNativePlatform() || import.meta.env.VITE_APP_MODE === 'apk') {
    return 'https://ais-pre-imtbttibm2v2b4iq2k6rff-546075383474.asia-southeast1.run.app';
  }

  return '';
}

export function buildApiUrl(endpointPath: string): string {
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const base = getApiBaseUrl();
  return `${base}${cleanPath}`;
}
