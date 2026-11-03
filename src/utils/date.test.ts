import { describe, expect, it } from 'vitest';
import { getVietnamDateISO } from './date';

describe('getVietnamDateISO', () => {
  it('returns the calendar date in Vietnam rather than UTC', () => {
    expect(getVietnamDateISO(new Date('2026-10-30T17:00:00.000Z'))).toBe('2026-10-31');
  });

  it('changes date at midnight in Vietnam', () => {
    expect(getVietnamDateISO(new Date('2026-10-30T16:59:59.999Z'))).toBe('2026-10-30');
    expect(getVietnamDateISO(new Date('2026-10-30T17:00:00.000Z'))).toBe('2026-10-31');
  });
});
