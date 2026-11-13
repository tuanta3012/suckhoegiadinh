import { describe, expect, it } from 'vitest';
import type { HealthEvent, HealthMetric } from '../types';
import { standardizeMetricKey } from './healthRecordService';
import {
  buildHealthMetricChartData,
  getHealthMetricRangeStatus,
  getHealthMetricStandardKey,
  partitionHealthMetricsForDisplay,
} from './healthMetricService';

function makeEvent(
  date: string,
  metrics: HealthMetric[],
  recordedAt = `${date}T12:00:00.000Z`,
): HealthEvent {
  return {
    id: `${date}-${metrics[0]?.name || 'event'}`,
    sourceFileId: 'source',
    sourceFileName: 'report.pdf',
    type: 'test_result',
    title: 'Test result',
    date,
    diagnoses: [],
    medications: [],
    metrics,
    recordedAt,
  };
}

describe('health metric standardization', () => {
  it.each([
    ['Creatinin', 'CREATININ'],
    ['Định lượng Creatinin', 'CREATININ'],
    ['Creatinin [Huyết Thanh]', 'CREATININ'],
    ['Uric Acid', 'ACID_URIC'],
    ['Thyroid Stimulating Hormone', 'TSH'],
    ['White Blood Cell Count', 'WBC'],
  ])('maps %s to %s', (name, expectedKey) => {
    expect(standardizeMetricKey(name, '', name)).toBe(expectedKey);
  });

  it('keeps blood WBC distinct from urine-cell metrics when the unit is per microliter', () => {
    expect(standardizeMetricKey('WBC', '10^3/µL', 'WBC')).toBe('WBC');
    expect(standardizeMetricKey('WBC', '/HPF', 'WBC nước tiểu')).toBe('URINE_LEU');
  });

  it('uses the standardized key even when source names differ', () => {
    expect(
      getHealthMetricStandardKey({
        name: 'Creatinin [Huyết Thanh]',
        standardKey: 'CREATININ',
        value: 80,
        unit: 'µmol/L',
      }),
    ).toBe('CREATININ');
  });
});

describe('buildHealthMetricChartData', () => {
  it('converts uric acid units and sorts observations oldest to newest', () => {
    const timeline = [
      makeEvent('2024-01-01', [{ name: 'Uric Acid', value: 0.5, unit: 'mmol/L' }]),
      makeEvent('2022-01-01', [{ name: 'Acid Uric', value: 300, unit: 'µmol/L' }]),
      makeEvent('2023-01-01', [{ name: 'Uric Acid', value: 5, unit: 'mg/dL' }]),
    ];

    expect(buildHealthMetricChartData(timeline, 'ACID_URIC')).toEqual([
      { date: '2022-01-01', value: 300, unit: 'µmol/L', facility: '' },
      { date: '2023-01-01', value: 297.4, unit: 'µmol/L', facility: '' },
      { date: '2024-01-01', value: 500, unit: 'µmol/L', facility: '' },
    ]);
  });

  describe('getHealthMetricRangeStatus', () => {
    it('flags high and low values using the metric reference range', () => {
      expect(getHealthMetricRangeStatus({
        name: 'Glucose',
        value: 7.2,
        unit: 'mmol/L',
      })).toBe('warning_high');
      expect(getHealthMetricRangeStatus({
        name: 'TSH',
        value: 0.2,
        unit: 'mIU/L',
      })).toBe('warning_low');
    });

    it('normalizes supported equivalent units before comparing ranges', () => {
      expect(getHealthMetricRangeStatus({
        name: 'Glucose',
        value: 130,
        unit: 'mg/dL',
      })).toBe('warning_high');
      expect(getHealthMetricRangeStatus({
        name: 'Creatinin',
        value: 1.1,
        unit: 'mg/dL',
      }, 'male')).toBe('normal');
    });

    it('uses sex-specific ranges and keeps one-sided ranges one-sided', () => {
      expect(getHealthMetricRangeStatus({
        name: 'Creatinin',
        value: 100,
        unit: 'µmol/L',
      }, 'female')).toBe('warning_high');
      expect(getHealthMetricRangeStatus({
        name: 'Creatinin',
        value: 100,
        unit: 'µmol/L',
      }, 'male')).toBe('normal');
      expect(getHealthMetricRangeStatus({
        name: 'Cholesterol',
        value: 2,
        unit: 'mmol/L',
      })).toBe('normal');
    });

    it('prioritizes explicit warning and critical statuses and ignores unknown ranges', () => {
      expect(getHealthMetricRangeStatus({
        name: 'Glucose',
        value: 5,
        unit: 'mmol/L',
        status: 'critical_high',
      })).toBe('critical_high');
      expect(getHealthMetricRangeStatus({
        name: 'Unmapped metric',
        value: 500,
        unit: 'units',
      })).toBe('unknown');
    });
  });

  it('consolidates same-day aliases into one point and normalizes equivalent TSH units', () => {
    const timeline = [
      makeEvent('2023-04-10', [{ name: 'TSH', value: 2.1, unit: 'mIU/L' }]),
      makeEvent('2023-04-10', [{ name: 'Thyroid Stimulating Hormone', value: 2.3, unit: 'µIU/mL' }]),
      makeEvent('2024-04-10', [{ name: 'TSH', value: 1.8, unit: 'mIU/L' }]),
    ];

    expect(buildHealthMetricChartData(timeline, 'TSH')).toEqual([
      { date: '2023-04-10', value: 2.3, unit: 'mIU/L', facility: '' },
      { date: '2024-04-10', value: 1.8, unit: 'mIU/L', facility: '' },
    ]);
  });

  it.each([
    {
      standardKey: 'CREATININ',
      metricNames: ['Creatinin', 'Định lượng Creatinin'],
      units: ['mg/dL', 'µmol/L'],
      values: [0.9, 80],
    },
    {
      standardKey: 'WBC',
      metricNames: ['WBC', 'White Blood Cell Count'],
      units: ['10^9/L', '10^9/L'],
      values: [6.1, 7.2],
    },
  ])('builds a multi-date series for $standardKey aliases', ({ standardKey, metricNames, units, values }) => {
    const timeline = [
      makeEvent('2022-01-01', [{ name: metricNames[0], value: values[0], unit: units[0] }]),
      makeEvent('2024-01-01', [{ name: metricNames[1], value: values[1], unit: units[1] }]),
    ];

    expect(buildHealthMetricChartData(timeline, standardKey)).toHaveLength(2);
  });

  it('returns an empty set for invalid values and ignores unrelated metrics', () => {
    const timeline = [
      makeEvent('2023-01-01', [
        { name: 'Creatinin', value: 'not numeric', unit: 'µmol/L' },
        { name: 'TSH', value: 2, unit: 'mIU/L' },
      ]),
    ];

    expect(buildHealthMetricChartData(timeline, 'CREATININ')).toEqual([]);
  });
});

describe('partitionHealthMetricsForDisplay', () => {
  it('places out-of-range, critical, explicit abnormal, and refRange-violating metrics into abnormal and keeps normal metrics collapsible', () => {
    const { abnormal, normal } = partitionHealthMetricsForDisplay(
      [
        { name: 'Glucose', value: 7.4, unit: 'mmol/L' }, // warning_high
        { name: 'Creatinin', value: 84, unit: 'µmol/L' }, // normal for male
        { name: 'TSH', value: 1.9, unit: 'mIU/L' }, // normal
        { name: 'Vitamin D 25-OH', value: 18, unit: 'ng/mL', refRange: '30 - 100' }, // below refRange
        { name: 'AFP', value: 4.5, unit: 'ng/mL', refRange: '< 10' }, // within refRange -> normal
        { name: 'CRP hs', value: 12, unit: 'mg/L', status: 'Cao' }, // explicit abnormal status
      ],
      'male',
    );

    expect(abnormal.map((item) => item.metric.name)).toEqual([
      'Glucose',
      'Vitamin D 25-OH',
      'CRP hs',
    ]);
    expect(normal.map((item) => item.metric.name)).toEqual([
      'Creatinin',
      'TSH',
      'AFP',
    ]);
  });
});

