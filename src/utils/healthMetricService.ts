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

export interface HealthMetricInfo {
  name: string;
  description: string;
  normalRangeText: string;
  minNormal: number;
  maxNormal: number;
  unit: string;
}

export type HealthMetricRangeStatus =
  | 'normal'
  | 'warning_high'
  | 'warning_low'
  | 'critical_high'
  | 'critical_low'
  | 'unknown';

function normalizeClinicalMetricValue(
  standardKey: string,
  value: number,
  unit: string,
  targetUnit: string,
): number | undefined {
  const source = normalizedUnit(unit);
  const target = normalizedUnit(targetUnit);

  if (source === target) return value;
  if (standardKey === 'ACID_URIC') {
    if (source === 'mmol/l' && target === 'umol/l') return value * 1000;
    if (source === 'mg/dl' && target === 'umol/l') return value * 59.48;
  }
  if (standardKey === 'CREATININ' && source === 'mg/dl' && target === 'umol/l') {
    return value * 88.4;
  }
  if (standardKey === 'GLUCOSE' && source === 'mg/dl' && target === 'mmol/l') {
    return value / 18.0182;
  }
  if (
    (standardKey === 'CHOLESTEROL' || standardKey === 'HDL_C' || standardKey === 'LDL_C') &&
    source === 'mg/dl' &&
    target === 'mmol/l'
  ) {
    return value * 0.02586;
  }
  if (standardKey === 'TRIGLYCERID' && source === 'mg/dl' && target === 'mmol/l') {
    return value * 0.01129;
  }
  if (
    standardKey === 'TSH' &&
    (source === 'uiu/ml' || source === 'miu/l') &&
    target === 'miu/l'
  ) {
    return value;
  }
  if (
    standardKey === 'WBC' &&
    (source === '10^9/l' || source === 'g/l') &&
    target === '10⁹/l'
  ) {
    return value;
  }
  return undefined;
}

export function getHealthMetricRangeStatus(
  metric: HealthMetric,
  gender?: 'male' | 'female' | 'other',
): HealthMetricRangeStatus {
  const declaredStatus = metric.status?.toLowerCase();
  if (
    declaredStatus === 'critical_high' ||
    declaredStatus === 'critical_low' ||
    declaredStatus === 'warning_high' ||
    declaredStatus === 'warning_low'
  ) {
    return declaredStatus;
  }

  const standardKey = getHealthMetricStandardKey(metric);
  const info = HEALTH_METRIC_INFOS[standardKey];
  if (!info) return 'unknown';

  const rawValue = parseMetricValue(metric.value);
  if (rawValue === undefined) return 'unknown';
  const value = normalizeClinicalMetricValue(standardKey, rawValue, metric.unit, info.unit);
  if (value === undefined) return 'unknown';

  let minimum = info.minNormal;
  let maximum = info.maxNormal;
  if (standardKey === 'CREATININ') {
    minimum = gender === 'female' ? 44 : gender === 'male' ? 53 : 44;
    maximum = gender === 'female' ? 97 : gender === 'male' ? 106 : 106;
  } else if (standardKey === 'ACID_URIC') {
    minimum = gender === 'female' ? 143 : gender === 'male' ? 202 : 143;
    maximum = gender === 'female' ? 339 : gender === 'male' ? 416 : 416;
  } else if (standardKey === 'HGB') {
    minimum = gender === 'female' ? 110 : gender === 'male' ? 120 : 110;
    maximum = gender === 'female' ? 145 : gender === 'male' ? 160 : 160;
  }

  const rangeText = info.normalRangeText.trim().toLowerCase();
  const hasLowerBound = !rangeText.startsWith('dưới');
  const hasUpperBound = !rangeText.startsWith('trên');
  if (standardKey === 'EGFR') {
    minimum = 90;
    maximum = Number.POSITIVE_INFINITY;
  }

  if (hasLowerBound && value < minimum) return 'warning_low';
  if (hasUpperBound && value > maximum) return 'warning_high';
  return 'normal';
}

export const HEALTH_METRIC_INFOS: Record<string, HealthMetricInfo> = {
  CREATININ: {
    name: 'Creatinin',
    description: 'Đánh giá chức năng lọc và hoạt động của thận.',
    normalRangeText: '53 - 106 µmol/L (Nam) · 44 - 97 µmol/L (Nữ)',
    minNormal: 53,
    maxNormal: 106,
    unit: 'µmol/L',
  },
  ACID_URIC: {
    name: 'Acid Uric',
    description: 'Sản phẩm phân hủy purin; liên quan đến nguy cơ gút.',
    normalRangeText: '202 - 416 µmol/L (Nam) · 143 - 339 µmol/L (Nữ)',
    minNormal: 202,
    maxNormal: 416,
    unit: 'µmol/L',
  },
  TSH: {
    name: 'TSH',
    description: 'Hóc môn tuyến yên điều hòa hoạt động tuyến giáp.',
    normalRangeText: '0.4 - 4.0 mIU/L',
    minNormal: 0.4,
    maxNormal: 4.0,
    unit: 'mIU/L',
  },
  WBC: {
    name: 'Bạch cầu (WBC)',
    description: 'Tế bào máu bảo vệ cơ thể chống lại tác nhân nhiễm trùng.',
    normalRangeText: '4.0 - 10.0 10⁹/L',
    minNormal: 4.0,
    maxNormal: 10.0,
    unit: '10⁹/L',
  },
  RBC: {
    name: 'Hồng cầu (RBC)',
    description: 'Vận chuyển oxy từ phổi đến các cơ quan trong cơ thể.',
    normalRangeText: '4.0 - 5.8 T/L',
    minNormal: 4.0,
    maxNormal: 5.8,
    unit: 'T/L',
  },
  HGB: {
    name: 'Hemoglobin (HGB)',
    description: 'Huyết sắc tố trong hồng cầu giúp chuyên chở oxy.',
    normalRangeText: '120 - 160 g/L (Nam) · 110 - 145 g/L (Nữ)',
    minNormal: 120,
    maxNormal: 160,
    unit: 'g/L',
  },
  HCT: {
    name: 'Hematocrit (HCT)',
    description: 'Tỷ lệ thể tích hồng cầu trên tổng thể tích máu.',
    normalRangeText: '37% - 52%',
    minNormal: 37,
    maxNormal: 52,
    unit: '%',
  },
  PLT: {
    name: 'Tiểu cầu (PLT)',
    description: 'Tế bào máu đóng vai trò thiết yếu trong quá trình đông máu.',
    normalRangeText: '150 - 400 10⁹/L',
    minNormal: 150,
    maxNormal: 400,
    unit: '10⁹/L',
  },
  GLUCOSE: {
    name: 'Đường huyết (Glucose)',
    description: 'Nồng độ đường đơn trong máu cung cấp năng lượng tế bào.',
    normalRangeText: '3.9 - 6.1 mmol/L',
    minNormal: 3.9,
    maxNormal: 6.1,
    unit: 'mmol/L',
  },
  HBA1C: {
    name: 'HbA1c',
    description: 'Đường huyết trung bình trong 3 tháng gần nhất.',
    normalRangeText: 'Dưới 5.7%',
    minNormal: 4.0,
    maxNormal: 5.7,
    unit: '%',
  },
  UREA: {
    name: 'Urea',
    description: 'Sản phẩm thoái hóa protein được lọc bỏ qua thận.',
    normalRangeText: '2.5 - 7.5 mmol/L',
    minNormal: 2.5,
    maxNormal: 7.5,
    unit: 'mmol/L',
  },
  EGFR: {
    name: 'Độ lọc cầu thận (eGFR)',
    description: 'Đánh giá khả năng lọc máu của thận.',
    normalRangeText: 'Trên 90 mL/min/1.73m²',
    minNormal: 60,
    maxNormal: 140,
    unit: 'mL/min',
  },
  CHOLESTEROL: {
    name: 'Cholesterol toàn phần',
    description: 'Lượng chất béo toàn phần lưu hành trong máu.',
    normalRangeText: 'Dưới 5.2 mmol/L',
    minNormal: 3.0,
    maxNormal: 5.2,
    unit: 'mmol/L',
  },
  HDL_C: {
    name: 'HDL-C (Cholesterol tốt)',
    description: 'Giúp dọn dẹp mỡ xấu khỏi mạch máu, bảo vệ tim.',
    normalRangeText: 'Trên 1.0 mmol/L',
    minNormal: 1.0,
    maxNormal: 2.5,
    unit: 'mmol/L',
  },
  LDL_C: {
    name: 'LDL-C (Cholesterol xấu)',
    description: 'Mỡ xấu dễ bám thành mạch, tăng nguy cơ xơ vữa.',
    normalRangeText: 'Dưới 3.4 mmol/L',
    minNormal: 0,
    maxNormal: 3.4,
    unit: 'mmol/L',
  },
  TRIGLYCERID: {
    name: 'Triglycerid',
    description: 'Chất béo trung tính chính trong máu, nguồn năng lượng dự trữ.',
    normalRangeText: 'Dưới 2.3 mmol/L',
    minNormal: 0.5,
    maxNormal: 2.3,
    unit: 'mmol/L',
  },
  AST: {
    name: 'Men gan AST (GOT)',
    description: 'Enzyme trong gan và cơ tim, phản ánh tổn thương tế bào gan.',
    normalRangeText: 'Dưới 37 U/L',
    minNormal: 10,
    maxNormal: 37,
    unit: 'U/L',
  },
  ALT: {
    name: 'Men gan ALT (GPT)',
    description: 'Enzyme gan nhạy bén đánh giá tình trạng viêm gan.',
    normalRangeText: 'Dưới 40 U/L',
    minNormal: 10,
    maxNormal: 40,
    unit: 'U/L',
  },
  GGT: {
    name: 'Men gan GGT',
    description: 'Enzyme nhạy cảm với tổn thương đường mật và rượu bia.',
    normalRangeText: '8 - 61 U/L',
    minNormal: 8,
    maxNormal: 61,
    unit: 'U/L',
  },
  FT4: {
    name: 'FT4 (Thyroxine tự do)',
    description: 'Hóc môn tuyến giáp tham gia chuyển hóa năng lượng.',
    normalRangeText: '12 - 22 pmol/L',
    minNormal: 12,
    maxNormal: 22,
    unit: 'pmol/L',
  },
  FT3: {
    name: 'FT3 (Triiodothyronine tự do)',
    description: 'Hóc môn hoạt động sinh học mạnh của tuyến giáp.',
    normalRangeText: '3.1 - 6.8 pmol/L',
    minNormal: 3.1,
    maxNormal: 6.8,
    unit: 'pmol/L',
  },
};

export function getHealthMetricInfo(standardKey: string): HealthMetricInfo {
  return HEALTH_METRIC_INFOS[standardKey] || {
    name: standardKey.replace(/_/g, ' '),
    description: 'Chỉ số sinh hóa hoặc huyết học theo dõi sức khỏe tổng quát.',
    normalRangeText: '',
    minNormal: 0,
    maxNormal: 100,
    unit: '',
  };
}
