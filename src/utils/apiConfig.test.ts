import { afterEach, describe, expect, it, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { buildApiUrl, getApiBaseUrl, hasConfiguredBackendUrl } from './apiConfig';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('backend API URL configuration', () => {
  it('uses the configured backend for native requests', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://api.example.com/');

    expect(hasConfiguredBackendUrl()).toBe(true);
    expect(buildApiUrl('/api/gemini/status')).toBe('https://api.example.com/api/gemini/status');
  });

  it('requires a configured backend for native requests', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', '');

    expect(() => getApiBaseUrl()).toThrow('VITE_BACKEND_URL');
  });

  it('requires a configured backend for Play builds', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'play');

    expect(() => getApiBaseUrl()).toThrow('VITE_BACKEND_URL');
  });

  it('keeps web requests same-origin when no backend URL is configured', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', '');
    vi.stubEnv('VITE_APP_MODE', 'web');

    expect(hasConfiguredBackendUrl()).toBe(false);
    expect(buildApiUrl('/api/gemini/status')).toBe('/api/gemini/status');
  });

  it('ignores non-URL VITE_BACKEND_URL values on web so requests stay same-origin', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false);
    vi.stubEnv('VITE_BACKEND_URL', 'AQ.token-one, AQ.token-two');
    vi.stubEnv('VITE_APP_MODE', 'web');

    expect(hasConfiguredBackendUrl()).toBe(false);
    expect(buildApiUrl('/api/gemini/ask-assistant')).toBe('/api/gemini/ask-assistant');
  });

  it('treats placeholder or malformed VITE_BACKEND_URL as missing on native APK', () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    vi.stubEnv('VITE_BACKEND_URL', 'https://YOUR_DEPLOYED_API_ORIGIN');

    expect(hasConfiguredBackendUrl()).toBe(false);
    expect(() => getApiBaseUrl()).toThrow('VITE_BACKEND_URL');
  });
});
