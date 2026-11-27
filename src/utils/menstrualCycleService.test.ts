import { describe, expect, it } from 'vitest';
import type { MenstrualCycleEntry } from '../types';
import {
  addDaysToIso,
  buildCycleSummaryForAi,
  calculateCycleMetrics,
  diffDaysIso,
  formatToIsoDate,
  getCalendarDayInfo,
  mergeCycleEntries,
  parseIsoDate,
} from './menstrualCycleService';

describe('menstrualCycleService', () => {
  it('handles empty cycles list gracefully with defaults', () => {
    const metrics = calculateCycleMetrics([], { defaultCycleLength: 30, defaultPeriodLength: 6 });
    expect(metrics.averageCycleLength).toBe(30);
    expect(metrics.averagePeriodLength).toBe(6);
    expect(metrics.isInPeriodToday).toBe(false);
    expect(metrics.regularityStatus).toBe('insufficient_data');
    expect(metrics.predictedCycles).toHaveLength(0);
  });

  it('calculates cycle day, next period, and fertile window for a single recorded cycle', () => {
    const cycles: MenstrualCycleEntry[] = [
      {
        id: 'c-1',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        flowLevel: 'medium',
        symptoms: ['cramps'],
        updatedAt: '2026-11-01T08:00:00Z',
      },
    ];

    const refDate = '2026-11-10'; // 9 days after start -> cycle day 10
    const metrics = calculateCycleMetrics(cycles, { defaultCycleLength: 28, defaultPeriodLength: 5 }, refDate);

    expect(metrics.currentCycleDay).toBe(10);
    expect(metrics.averageCycleLength).toBe(28);
    expect(metrics.averagePeriodLength).toBe(5);
    expect(metrics.nextPredictedPeriod).toBe('2026-11-29'); // 2026-11-01 + 28 days
    expect(metrics.daysUntilNextPeriod).toBe(19); // 2026-11-29 - 2026-11-10
    expect(metrics.isOverdue).toBe(false);
    expect(metrics.isInPeriodToday).toBe(false);

    // Ovulation is around day 14 (Nov 15) and fertile window is Nov 10 - Nov 16
    expect(metrics.predictedOvulationDate).toBe('2026-11-15');
    expect(metrics.fertileWindowStart).toBe('2026-11-10');
    expect(metrics.fertileWindowEnd).toBe('2026-11-16');
    expect(metrics.isFertileToday).toBe(true);
  });

  it('detects active period and overdue period correctly', () => {
    const cycles: MenstrualCycleEntry[] = [
      {
        id: 'c-1',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        flowLevel: 'heavy',
        updatedAt: '2026-11-01T08:00:00Z',
      },
    ];

    // Reference date during the period
    const inPeriod = calculateCycleMetrics(cycles, undefined, '2026-11-03');
    expect(inPeriod.isInPeriodToday).toBe(true);

    // Reference date way after expected next period (28 days later = 2026-11-29)
    const overdue = calculateCycleMetrics(cycles, undefined, '2026-12-05');
    expect(overdue.isOverdue).toBe(true);
    expect(overdue.daysUntilNextPeriod).toBe(-6); // 6 days overdue
  });

  it('adaptively calculates weighted average cycle length from multiple consecutive cycles', () => {
    const cycles: MenstrualCycleEntry[] = [
      { id: '1', startDate: '2026-08-01', endDate: '2026-08-05', updatedAt: '2026-08-01T00:00:00Z' }, // 30 days to next
      { id: '2', startDate: '2026-08-31', endDate: '2026-09-04', updatedAt: '2026-08-31T00:00:00Z' }, // 29 days to next
      { id: '3', startDate: '2026-09-29', endDate: '2026-10-03', updatedAt: '2026-09-29T00:00:00Z' }, // 28 days to next
      { id: '4', startDate: '2026-10-27', endDate: '2026-10-31', updatedAt: '2026-10-27T00:00:00Z' },
    ];

    const metrics = calculateCycleMetrics(cycles, undefined, '2026-11-15');
    // Intervals: 30, 29, 28 -> weighted toward 28-29
    expect(metrics.recentIntervals).toEqual([30, 29, 28]);
    expect(metrics.averageCycleLength).toBe(29);
    expect(metrics.regularityStatus).toBe('regular');
    expect(metrics.healthAssessmentLabel).toBe('Chu kỳ đều, ổn định');
    expect(metrics.cycleRecords.map((r) => r.cycleLengthDays)).toEqual([30, 29, 28, undefined]);
    expect(metrics.nextPredictedPeriod).toBe('2026-11-25'); // 2026-10-27 + 29 days
  });

  it('flags irregular and short cycles accurately when variation is wide (26, 29, 16 days)', () => {
    const cycles: MenstrualCycleEntry[] = [
      { id: 'c1', startDate: '2026-11-01', updatedAt: '2026-11-01T00:00:00Z' }, // 26d
      { id: 'c2', startDate: '2026-11-27', updatedAt: '2026-11-27T00:00:00Z' }, // 29d
      { id: 'c3', startDate: '2026-12-26', updatedAt: '2026-12-26T00:00:00Z' }, // 16d
      { id: 'c4', startDate: '2027-01-11', updatedAt: '2027-01-11T00:00:00Z' },
    ];

    const metrics = calculateCycleMetrics(cycles, { defaultCycleLength: 28, defaultPeriodLength: 5 }, '2027-01-11');
    expect(metrics.recentIntervals).toEqual([26, 29, 16]);
    expect(metrics.regularityStatus).toBe('irregular');
    expect(metrics.healthAssessmentLabel).toContain('16–29đ');
    expect(metrics.healthAssessmentLabel).toContain('<21đ');
  });

  it('flags irregular cycles with only 2 intervals when spread exceeds 6 days', () => {
    const cycles: MenstrualCycleEntry[] = [
      { id: 'c1', startDate: '2026-10-01', updatedAt: '2026-10-01T00:00:00Z' }, // 22d
      { id: 'c2', startDate: '2026-10-23', updatedAt: '2026-10-23T00:00:00Z' }, // 31d
      { id: 'c3', startDate: '2026-11-23', updatedAt: '2026-11-23T00:00:00Z' },
    ];

    const metrics = calculateCycleMetrics(cycles, { defaultCycleLength: 28, defaultPeriodLength: 5 }, '2026-11-25');
    expect(metrics.regularityStatus).toBe('irregular');
    expect(metrics.healthAssessmentLabel).toContain('22–31đ');
  });

  it('detects menorrhagia (prolonged/heavy bleeding) flag', () => {
    const cycles: MenstrualCycleEntry[] = [
      {
        id: 'c-long',
        startDate: '2026-10-01',
        endDate: '2026-10-09', // 9 days bleeding
        flowLevel: 'heavy',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ];

    const metrics = calculateCycleMetrics(cycles);
    expect(metrics.hasMenorrhagia).toBe(true);

    const aiSummary = buildCycleSummaryForAi(cycles);
    expect(aiSummary.hasMenorrhagia).toBe(true);
    expect(aiSummary.notes).toContain('Sắt/Ferritin/Hemoglobin');
  });

  it('correctly maps calendar days to actual, predicted, and fertile states', () => {
    const cycles: MenstrualCycleEntry[] = [
      {
        id: 'c-1',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        flowLevel: 'medium',
        updatedAt: '2026-11-01T00:00:00Z',
      },
    ];

    const metrics = calculateCycleMetrics(cycles, { defaultCycleLength: 28, defaultPeriodLength: 5 }, '2026-11-10');

    // Actual period day
    const dayActual = getCalendarDayInfo('2026-11-02', cycles, metrics);
    expect(dayActual.isActualPeriod).toBe(true);
    expect(dayActual.flowLevel).toBe('medium');

    // Predicted next period (starts 2026-11-29)
    const dayPredicted = getCalendarDayInfo('2026-11-29', cycles, metrics);
    expect(dayPredicted.isPredictedPeriod).toBe(true);

    // Current fertile window (ovulation around Nov 15)
    const dayFertile = getCalendarDayInfo('2026-11-14', cycles, metrics);
    expect(dayFertile.isFertileWindow).toBe(true);
  });

  it('merges cycles from different devices preserving latest updates and avoiding duplicates', () => {
    const localCycles: MenstrualCycleEntry[] = [
      {
        id: 'c-1',
        startDate: '2026-10-01',
        endDate: '2026-10-05',
        flowLevel: 'light',
        updatedAt: '2026-10-01T10:00:00Z',
      },
      {
        id: 'c-local-new',
        startDate: '2026-10-29',
        flowLevel: 'medium',
        updatedAt: '2026-10-29T08:00:00Z',
      },
    ];

    const remoteCycles: MenstrualCycleEntry[] = [
      {
        id: 'c-1',
        startDate: '2026-10-01',
        endDate: '2026-10-06', // updated on remote device
        flowLevel: 'medium',
        updatedAt: '2026-10-06T15:00:00Z',
      },
      {
        id: 'c-remote-old',
        startDate: '2026-09-02',
        endDate: '2026-09-06',
        updatedAt: '2026-09-02T10:00:00Z',
      },
    ];

    const merged = mergeCycleEntries(localCycles, remoteCycles);
    expect(merged).toHaveLength(3);
    // Sort is descending by startDate
    expect(merged[0].id).toBe('c-local-new');
    expect(merged[1].id).toBe('c-1');
    expect(merged[1].endDate).toBe('2026-10-06'); // remote won due to newer updatedAt
    expect(merged[1].flowLevel).toBe('medium');
    expect(merged[2].id).toBe('c-remote-old');
  });

  it('date helpers work correctly', () => {
    expect(addDaysToIso('2026-11-28', 3)).toBe('2026-12-01');
    expect(diffDaysIso('2026-12-01', '2026-11-28')).toBe(3);
    const d = parseIsoDate('2026-05-15');
    expect(formatToIsoDate(d)).toBe('2026-05-15');
  });

  it('respects deletedCycles tombstones when merging across devices', () => {
    const remoteCycles: MenstrualCycleEntry[] = [
      {
        id: 'c-deleted',
        startDate: '2026-11-26',
        endDate: '2026-11-30',
        updatedAt: '2026-11-26T08:00:00Z',
      },
      {
        id: 'c-kept',
        startDate: '2026-10-28',
        endDate: '2026-11-01',
        updatedAt: '2026-10-28T08:00:00Z',
      },
    ];
    const localCycles: MenstrualCycleEntry[] = [
      {
        id: 'c-kept',
        startDate: '2026-10-28',
        endDate: '2026-11-01',
        updatedAt: '2026-10-28T08:00:00Z',
      },
    ];
    const merged = mergeCycleEntries(remoteCycles, localCycles, [
      { id: 'c-deleted', deletedAt: '2026-11-27T10:00:00Z' },
    ]);
    expect(merged.map((c) => c.id)).toEqual(['c-kept']);
  });
});
