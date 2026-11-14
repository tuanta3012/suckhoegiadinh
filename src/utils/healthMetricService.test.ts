import { describe, expect, it } from 'vitest';
import type { HealthEvent, HealthMetric } from '../types';
import { standardizeMetricKey } from './healthRecordService';
import {
  buildHealthMetricChartData,
  extractAbnormalHealthMetricOptions,
  extractOverviewHealthMetricOptions,
  getHealthMetricBasicDescription,
  getHealthMetricInfo,
  getHealthMetricRangeStatus,
  getHealthMetricStandardKey,
  isVitalOverviewMetricKey,
  partitionHealthMetricsForDisplay,
  resolveHealthMetricDisplayInfo,
  VITAL_BP_KEY,
  VITAL_HEIGHT_KEY,
  VITAL_WEIGHT_KEY,
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
    ['Định lượng Canxi (Ca) [Huyết Thanh]', 'CALCIUM'],
    ['Canxi Ion Hóa (Ca2+)', 'CA_ION'],
    ['CA 72-4', 'CA 72-4'],
    ['Thể Tích Trung Bình Tiểu Cầu (MPV)', 'MPV'],
    ['25-OH Vitamin D', 'VITAMIN_D'],
    ['T4 Tự Do', 'FT4'],
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

describe('extractAbnormalHealthMetricOptions & resolveHealthMetricDisplayInfo', () => {
  it('surfaces every metric flagged abnormal in Timeline (including Canxi, MPV, Vitamin D, and unmapped metrics)', () => {
    const timeline: HealthEvent[] = [
      makeEvent('2026-01-06', [
        {
          name: 'Định lượng Canxi (Ca) [Huyết Thanh]',
          value: 2.23,
          unit: 'mmol/L',
          refRange: '2.30 - 2.60',
        },
        {
          name: 'T4 Tự Do',
          value: 13.05,
          unit: 'pmol/L',
          refRange: '9.01-19.05',
        },
        {
          name: 'Creatinin',
          value: 84,
          unit: 'µmol/L',
        },
      ]),
      makeEvent('2025-01-07', [
        {
          name: 'Thể Tích Trung Bình Tiểu Cầu (MPV)',
          value: 9.32,
          unit: 'fL',
          refRange: '12.3-13.1',
        },
        {
          name: 'T4 Tự Do',
          value: 11.41,
          unit: 'pmol/L',
          refRange: '9.01-19.05',
        },
        {
          name: '25-OH Vitamin D',
          value: 22,
          unit: 'ng/mL',
          refRange: '30-100',
        },
        {
          name: 'Định lượng iPTH [Huyết Thanh]',
          value: 85,
          unit: 'pg/mL',
          refRange: '15 - 65',
        },
      ]),
    ];

    const options = extractAbnormalHealthMetricOptions(timeline, 'male');
    expect(options).toEqual([
      { key: 'CALCIUM', label: 'Canxi' },
      { key: 'MPV', label: 'MPV' },
      { key: 'FT4', label: 'FT4' },
      { key: 'VITAMIN_D', label: 'Vitamin D' },
      { key: 'ĐỊNH LƯỢNG IPTH [HUYẾT THANH]', label: 'iPTH' },
    ]);

    const caInfo = resolveHealthMetricDisplayInfo('CALCIUM', timeline, 'male');
    expect(caInfo.normalRangeText).toBe('2.30 - 2.60 mmol/L');
    expect(caInfo.minNormal).toBe(2.3);
    expect(caInfo.maxNormal).toBe(2.6);

    const mpvInfo = resolveHealthMetricDisplayInfo('MPV', timeline, 'male');
    expect(mpvInfo.normalRangeText).toBe('12.3 - 13.1 fL');
    expect(mpvInfo.minNormal).toBe(12.3);
    expect(mpvInfo.maxNormal).toBe(13.1);

    const ft4Info = resolveHealthMetricDisplayInfo('FT4', timeline, 'male');
    expect(ft4Info.normalRangeText).toBe('9.01 - 19.05 pmol/L');
    expect(ft4Info.minNormal).toBe(9.01);
    expect(ft4Info.maxNormal).toBe(19.05);

    const ipthInfo = resolveHealthMetricDisplayInfo('ĐỊNH LƯỢNG IPTH [HUYẾT THANH]', timeline, 'male');
    expect(ipthInfo.name).toBe('iPTH');
    expect(ipthInfo.normalRangeText).toBe('15 - 65 pg/mL');
    expect(ipthInfo.minNormal).toBe(15);
    expect(ipthInfo.maxNormal).toBe(65);
    expect(ipthInfo.description).not.toBe('Chỉ số xét nghiệm ghi nhận trong hồ sơ sức khỏe.');
    expect(ipthInfo.description.toLowerCase()).toContain('cận giáp');
    expect(ipthInfo.description.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(20);
    expect(ft4Info.description.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(20);
    expect(caInfo.description.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(20);
    expect(mpvInfo.description.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(20);

    const unknownWithoutRange = getHealthMetricInfo('UNMAPPED_TEST');
    expect(unknownWithoutRange.minNormal).toBeUndefined();
    expect(unknownWithoutRange.maxNormal).toBeUndefined();
  });
});

describe('getHealthMetricBasicDescription', () => {
  it('returns concise Vietnamese descriptions within 100 words for catalog, keyword, and custom abnormal metrics', () => {
    const samples: HealthMetric[] = [
      { name: 'Định lượng Canxi (Ca) [Huyết Thanh]', value: 2.23, unit: 'mmol/L', refRange: '2.30 - 2.60' },
      { name: 'Thể Tích Trung Bình Tiểu Cầu (MPV)', value: 9.32, unit: 'fL', refRange: '12.3-13.1' },
      { name: 'T4 Tự Do', value: 11.41, unit: 'pmol/L', refRange: '9.01-19.05' },
      { name: '25-OH Vitamin D', value: 22, unit: 'ng/mL', refRange: '30-100' },
      { name: 'CRP hs', value: 15, unit: 'mg/L', status: 'Cao' },
      { name: 'Định lượng iPTH [Huyết Thanh]', value: 85, unit: 'pg/mL', refRange: '15 - 65' },
    ];

    for (const metric of samples) {
      const description = getHealthMetricBasicDescription(metric);
      const wordCount = description.trim().split(/\s+/).filter(Boolean).length;
      expect(wordCount).toBeGreaterThan(10);
      expect(wordCount).toBeLessThanOrEqual(100);
    }

    expect(getHealthMetricBasicDescription(samples[0]).toLowerCase()).toContain('canxi');
    expect(getHealthMetricBasicDescription(samples[1]).toLowerCase()).toContain('mpv');
    expect(getHealthMetricBasicDescription(samples[2]).toLowerCase()).toContain('ft4');
    expect(getHealthMetricBasicDescription(samples[3]).toLowerCase()).toContain('vitamin d');
    expect(getHealthMetricBasicDescription(samples[5]).toLowerCase()).toContain('cận giáp');
    expect(
      getHealthMetricBasicDescription(
        { name: 'Chỉ số đặc hiệu XYZ', value: 120, unit: 'U/L', refRange: '10 - 50' },
        'warning_high',
      ),
    ).toContain('cao hơn');
  });
});

describe('Overview vital signs (height, weight, blood pressure)', () => {
  it('places Blood Pressure first, abnormal lab metrics next, then Height and Weight at the end, and builds dual-series BP data', () => {
    const timeline: HealthEvent[] = [
      {
        ...makeEvent('2024-05-10', [
          { name: '25-OH Vitamin D', value: 22, unit: 'ng/mL', refRange: '30-100' },
        ]),
        physicalExam: {
          height_cm: 168,
          weight_kg: 58.5,
          bp_mmHg: '115/75 mmHg',
        },
      },
      {
        ...makeEvent('2025-05-12', []),
        physicalExam: {
          height_cm: 171,
          weight_kg: 62,
          bp_mmHg: '125/82',
        },
      },
    ];

    expect(extractOverviewHealthMetricOptions(timeline, 'male')).toEqual([
      { key: VITAL_BP_KEY, label: 'Huyết áp' },
      { key: 'VITAMIN_D', label: 'Vitamin D' },
      { key: VITAL_HEIGHT_KEY, label: 'Chiều cao' },
      { key: VITAL_WEIGHT_KEY, label: 'Cân nặng' },
    ]);

    expect(isVitalOverviewMetricKey(VITAL_BP_KEY)).toBe(true);
    expect(isVitalOverviewMetricKey(VITAL_HEIGHT_KEY)).toBe(true);
    expect(isVitalOverviewMetricKey(VITAL_WEIGHT_KEY)).toBe(true);
    expect(isVitalOverviewMetricKey('VITAMIN_D')).toBe(false);

    expect(buildHealthMetricChartData(timeline, VITAL_HEIGHT_KEY)).toEqual([
      { date: '2024-05-10', value: 168, unit: 'cm', facility: '' },
      { date: '2025-05-12', value: 171, unit: 'cm', facility: '' },
    ]);

    expect(buildHealthMetricChartData(timeline, VITAL_WEIGHT_KEY)).toEqual([
      { date: '2024-05-10', value: 58.5, unit: 'kg', facility: '' },
      { date: '2025-05-12', value: 62, unit: 'kg', facility: '' },
    ]);

    expect(buildHealthMetricChartData(timeline, VITAL_BP_KEY)).toEqual([
      { date: '2024-05-10', value: 115, secondaryValue: 75, unit: 'mmHg', facility: '' },
      { date: '2025-05-12', value: 125, secondaryValue: 82, unit: 'mmHg', facility: '' },
    ]);

    expect(resolveHealthMetricDisplayInfo(VITAL_BP_KEY, timeline, 'male')).toMatchObject({
      name: 'Huyết áp (mmHg)',
      normalRangeText: '90/60 - 120/80 mmHg',
    });
  });

  it('omits height, weight, and blood pressure options when no measurements exist in the timeline', () => {
    const timeline = [
      makeEvent('2025-05-12', [
        { name: 'Creatinin', value: 84, unit: 'µmol/L' },
      ]),
    ];

    expect(extractOverviewHealthMetricOptions(timeline, 'male')).toEqual([]);
  });
});
