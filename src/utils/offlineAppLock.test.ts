import { beforeEach, describe, expect, it, vi } from 'vitest';

const { isAvailableMock, verifyIdentityMock } = vi.hoisted(() => ({
  isAvailableMock: vi.fn(),
  verifyIdentityMock: vi.fn(),
}));

vi.mock('@capgo/capacitor-native-biometric', () => ({
  NativeBiometric: {
    isAvailable: isAvailableMock,
    verifyIdentity: verifyIdentityMock,
  },
}));

import { verifyDeviceUnlock } from './offlineAppLock';

describe('device unlock for offline cache', () => {
  beforeEach(() => {
    isAvailableMock.mockReset();
    verifyIdentityMock.mockReset();
  });

  it('uses the device biometric with screen-lock fallback', async () => {
    isAvailableMock.mockResolvedValue({ isAvailable: true });

    await verifyDeviceUnlock();

    expect(isAvailableMock).toHaveBeenCalledWith({ useFallback: true });
    expect(verifyIdentityMock).toHaveBeenCalledWith(expect.objectContaining({
      useFallback: true,
      maxAttempts: 3,
    }));
  });

  it('does not open cached data if the device has no configured lock', async () => {
    isAvailableMock.mockResolvedValue({ isAvailable: false });

    await expect(verifyDeviceUnlock()).rejects.toThrow('chưa bật vân tay hoặc mã khóa màn hình');
    expect(verifyIdentityMock).not.toHaveBeenCalled();
  });
});
