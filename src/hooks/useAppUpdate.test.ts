import { describe, expect, it } from 'vitest';
import { isNewerVersion } from './useAppUpdate';

describe('app update version comparison', () => {
  it('recognizes newer versions with or without a v prefix', () => {
    expect(isNewerVersion('1.0.4', 'v1.0.5')).toBe(true);
    expect(isNewerVersion('v1.0.4', '1.1')).toBe(true);
  });

  it('treats equivalent and older versions as not newer', () => {
    expect(isNewerVersion('1.2.0', 'v1.2')).toBe(false);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(false);
  });

  it('rejects malformed or non-numeric versions', () => {
    expect(isNewerVersion('1.0.0', 'latest')).toBe(false);
    expect(isNewerVersion('1..0', '2.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0-beta', '1.0.1')).toBe(false);
  });
});
