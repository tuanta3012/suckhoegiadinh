import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { buildApiUrl, getApiBaseUrl } from './apiConfig';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('backend API URL configuration', () => {
  it('uses the configured backend for native requests', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');

    expect(buildApiUrl('/api/gemini/status')).toBe('https://api.example.com/api/gemini/status');
  });

  it('requires a configured backend for native requests', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');

    expect(() => getApiBaseUrl()).toThrow('BACKEND_API_URL');
  });

  it('keeps web requests same-origin when no backend URL is configured', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'web');

    expect(buildApiUrl('/api/gemini/status')).toBe('/api/gemini/status');
  });
});
