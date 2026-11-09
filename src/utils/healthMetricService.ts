import type { HealthEvent, HealthMetric } from '../types';
import { standardizeMetricKey } from './healthRecordService';

export interface HealthMetricChartPoint {
  date: string;
  value: number;
  unit: string;
  facility: string;
}

const METRIC_DISPLAY_NAMES: Record<string, string> = {
  CREATININ: 'Creatinin',
  ACID_URIC: 'Acid Uric',
  TSH: 'TSH',
  WBC: 'WBC',
  RBC: 'RBC',
  HGB: 'Hemoglobin',
  HCT: 'Hematocrit',
  PLT: 'Tiểu cầu',
  GLUCOSE: 'Glucose',
  HBA1C: 'HbA1c',
  UREA: 'Urea',
  EGFR: 'eGFR',
  CHOLESTEROL: 'Cholesterol',
  HDL_C: 'HDL-C',
  LDL_C: 'LDL-C',
  TRIGLYCERID: 'Triglycerid',
  AST: 'AST',
  ALT: 'ALT',
  GGT: 'GGT',
  FT4: 'FT4',
  FT3: 'FT3',
};

export function getHealthMetricStandardKey(metric: HealthMetric): string {
  return standardizeMetricKey(metric.standardKey || metric.name, metric.unit, metric.name);
}

export function getHealthMetricDisplayName(standardKey: string): string {
  return METRIC_DISPLAY_NAMES[standardKey] || standardKey.replace(/_/g, ' ');
}

function parseMetricValue(value: HealthMetric['value']): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedUnit(unit: string): string {
  return unit
    .trim()
    .toLowerCase()
    .replace(/[μµ]/g, 'u')
    .replace(/\s+/g, '')
    .replace(/litre|liter/g, 'l');
}

function normalizeMetricForChart(
  standardKey: string,
  value: number,
  unit: string,
): { value: number; unit: string } {
  const normalized = normalizedUnit(unit);

  if (standardKey === 'ACID_URIC') {
    if (normalized === 'mmol/l') return { value: value * 1000, unit: 'µmol/L' };
    if (normalized === 'umol/l') return { value, unit: 'µmol/L' };
    if (normalized === 'mg/dl') return { value: value * 59.48, unit: 'µmol/L' };
  }

  if (standardKey === 'CREATININ') {
    if (normalized === 'mg/dl') return { value: value * 88.4, unit: 'µmol/L' };
    if (normalized === 'umol/l') return { value, unit: 'µmol/L' };
  }

  if (standardKey === 'GLUCOSE') {
    if (normalized === 'mmol/l') return { value: value * 18.0182, unit: 'mg/dL' };
    if (normalized === 'mg/dl') return { value, unit: 'mg/dL' };
  }

  if (standardKey === 'CHOLESTEROL' || standardKey === 'HDL_C' || standardKey === 'LDL_C') {
    if (normalized === 'mg/dl') return { value: value * 0.02586, unit: 'mmol/L' };
    if (normalized === 'mmol/l') return { value, unit: 'mmol/L' };
  }

  if (standardKey === 'TRIGLYCERID') {
    if (normalized === 'mg/dl') return { value: value * 0.01129, unit: 'mmol/L' };
    if (normalized === 'mmol/l') return { value, unit: 'mmol/L' };
  }

  if (standardKey === 'TSH' && (normalized === 'uiu/ml' || normalized === 'miu/l')) {
    return { value, unit: 'mIU/L' };
  }

  if (standardKey === 'WBC' && (normalized === '10^9/l' || normalized === 'g/l')) {
    return { value, unit: '10⁹/L' };
  }

  return { value, unit };
}

export function buildHealthMetricChartData(
  timeline: HealthEvent[],
  standardKey: string,
): HealthMetricChartPoint[] {
  const pointsByDate = new Map<string, HealthMetricChartPoint>();
  const orderedEvents = [...timeline].sort((a, b) => {
    const dateA = new Date(a.date).getTime();
    const dateB = new Date(b.date).getTime();
    const validDateA = Number.isFinite(dateA);
    const validDateB = Number.isFinite(dateB);
    if (validDateA && validDateB && dateA !== dateB) return dateA - dateB;
    return new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime();
  });

  for (const event of orderedEvents) {
    const eventDate = new Date(event.date);
    const timestamp = Number.isFinite(eventDate.getTime())
      ? eventDate
      : new Date(event.recordedAt);
    if (!Number.isFinite(timestamp.getTime())) continue;
    const date = Number.isFinite(eventDate.getTime())
      ? event.date.slice(0, 10)
      : timestamp.toISOString().slice(0, 10);

    const metric = event.metrics.find(
      (item) => getHealthMetricStandardKey(item) === standardKey,
    );
    if (!metric) continue;

    const rawValue = parseMetricValue(metric.value);
    if (rawValue === undefined) continue;

    const normalized = normalizeMetricForChart(standardKey, rawValue, metric.unit);
    pointsByDate.set(date, {
      date,
      value: normalized.value,
      unit: normalized.unit,
      facility: event.facility || '',
    });
  }

  return Array.from(pointsByDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}
