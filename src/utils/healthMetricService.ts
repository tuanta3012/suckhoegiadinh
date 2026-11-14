import type { HealthEvent, HealthMetric } from '../types';
import { standardizeMetricKey } from './healthRecordService';

export const VITAL_HEIGHT_KEY = 'VITAL_HEIGHT';
export const VITAL_WEIGHT_KEY = 'VITAL_WEIGHT';
export const VITAL_BP_KEY = 'VITAL_BP';

export function isVitalOverviewMetricKey(standardKey: string): boolean {
  return (
    standardKey === VITAL_BP_KEY ||
    standardKey === VITAL_HEIGHT_KEY ||
    standardKey === VITAL_WEIGHT_KEY
  );
}

export interface HealthMetricChartPoint {
  date: string;
  value: number;
  secondaryValue?: number;
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
  CALCIUM: 'Canxi',
  CA_ION: 'Canxi ion',
  MPV: 'MPV',
  VITAMIN_D: 'Vitamin D',
  MCV: 'MCV',
  MCH: 'MCH',
  MCHC: 'MCHC',
  NEU_PCT: 'NEU%',
  LYM_PCT: 'LYM%',
  MONO_PCT: 'MONO%',
  ESR_1H: 'Máu lắng 1h',
  NA: 'Natri (Na⁺)',
  K: 'Kali (K⁺)',
  CL: 'Clo (Cl⁻)',
  [VITAL_HEIGHT_KEY]: 'Chiều cao',
  [VITAL_WEIGHT_KEY]: 'Cân nặng',
  [VITAL_BP_KEY]: 'Huyết áp',
};

export function getHealthMetricStandardKey(metric: HealthMetric): string {
  return standardizeMetricKey(metric.standardKey || metric.name, metric.unit, metric.name);
}

export function formatFallbackMetricDisplayName(rawName: string): string {
  const cleaned = rawName
    .replace(/[*#]/g, '')
    .replace(/^(?:định\s+lượng|xét\s+nghiệm|chỉ\s+số)\s+/i, '')
    .replace(/\s*\[[^\]]+\]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || rawName.trim();
}

export function getHealthMetricDisplayName(standardKey: string, fallbackName?: string): string {
  if (METRIC_DISPLAY_NAMES[standardKey]) {
    return METRIC_DISPLAY_NAMES[standardKey];
  }
  if (fallbackName && fallbackName.trim()) {
    return formatFallbackMetricDisplayName(fallbackName);
  }
  return standardKey.replace(/_/g, ' ');
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

  if (standardKey === 'CALCIUM') {
    if (normalized === 'mg/dl') return { value: Number((value * 0.2495).toFixed(2)), unit: 'mmol/L' };
    if (normalized === 'mmol/l') return { value, unit: 'mmol/L' };
  }

  return { value, unit };
}

function parseBloodPressure(raw?: string): { systolic: number; diastolic: number } | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const match = raw.trim().match(/(\d{2,3})\s*[/\\-]\s*(\d{2,3})/);
  if (!match) return undefined;
  const systolic = Number(match[1]);
  const diastolic = Number(match[2]);
  if (
    !Number.isFinite(systolic) ||
    !Number.isFinite(diastolic) ||
    systolic <= diastolic ||
    systolic < 50 ||
    systolic > 300 ||
    diastolic < 20 ||
    diastolic > 200
  ) {
    return undefined;
  }
  return { systolic, diastolic };
}

function normalizeLabelForVitalMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

function extractVitalPointFromEvent(
  event: HealthEvent,
  standardKey: string,
): Omit<HealthMetricChartPoint, 'date' | 'facility'> | undefined {
  if (standardKey === VITAL_HEIGHT_KEY) {
    const height = event.physicalExam?.height_cm;
    if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
      return { value: height, unit: 'cm' };
    }
    const metric = (event.metrics || []).find((m) => {
      const label = normalizeLabelForVitalMatch(`${m.standardKey || ''} ${m.name}`);
      return label.includes('chieu cao') || /\bheight\b/.test(label);
    });
    if (metric) {
      const parsed = parseMetricValue(metric.value);
      if (parsed !== undefined && parsed > 0) {
        const unitNorm = normalizedUnit(metric.unit || '');
        if (unitNorm === 'm' || (parsed < 3 && !unitNorm)) {
          return { value: Number((parsed * 100).toFixed(1)), unit: 'cm' };
        }
        return { value: parsed, unit: 'cm' };
      }
    }
    return undefined;
  }

  if (standardKey === VITAL_WEIGHT_KEY) {
    const weight = event.physicalExam?.weight_kg;
    if (typeof weight === 'number' && Number.isFinite(weight) && weight > 0) {
      return { value: weight, unit: 'kg' };
    }
    const metric = (event.metrics || []).find((m) => {
      const label = normalizeLabelForVitalMatch(`${m.standardKey || ''} ${m.name}`);
      return label.includes('can nang') || /\bweight\b/.test(label);
    });
    if (metric) {
      const parsed = parseMetricValue(metric.value);
      if (parsed !== undefined && parsed > 0) {
        return { value: parsed, unit: 'kg' };
      }
    }
    return undefined;
  }

  if (standardKey === VITAL_BP_KEY) {
    const fromExam = parseBloodPressure(event.physicalExam?.bp_mmHg);
    if (fromExam) {
      return {
        value: fromExam.systolic,
        secondaryValue: fromExam.diastolic,
        unit: 'mmHg',
      };
    }
    const metric = (event.metrics || []).find((m) => {
      const label = normalizeLabelForVitalMatch(`${m.standardKey || ''} ${m.name}`);
      return label.includes('huyet ap') || label.includes('blood pressure') || /\bbp\b/.test(label);
    });
    if (metric && typeof metric.value === 'string') {
      const fromMetric = parseBloodPressure(metric.value);
      if (fromMetric) {
        return {
          value: fromMetric.systolic,
          secondaryValue: fromMetric.diastolic,
          unit: 'mmHg',
        };
      }
    }
    return undefined;
  }

  return undefined;
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

  const isVitalSeries =
    standardKey === VITAL_HEIGHT_KEY ||
    standardKey === VITAL_WEIGHT_KEY ||
    standardKey === VITAL_BP_KEY;

  for (const event of orderedEvents) {
    const eventDate = new Date(event.date);
    const timestamp = Number.isFinite(eventDate.getTime())
      ? eventDate
      : new Date(event.recordedAt);
    if (!Number.isFinite(timestamp.getTime())) continue;
    const date = Number.isFinite(eventDate.getTime())
      ? event.date.slice(0, 10)
      : timestamp.toISOString().slice(0, 10);

    if (isVitalSeries) {
      const vitalPoint = extractVitalPointFromEvent(event, standardKey);
      if (!vitalPoint) continue;
      pointsByDate.set(date, {
        date,
        value: vitalPoint.value,
        ...(vitalPoint.secondaryValue !== undefined ? { secondaryValue: vitalPoint.secondaryValue } : {}),
        unit: vitalPoint.unit,
        facility: event.facility || '',
      });
      continue;
    }

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
  minNormal?: number;
  maxNormal?: number;
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
  if (standardKey === 'CALCIUM' && source === 'mg/dl' && target === 'mmol/l') {
    return value * 0.2495;
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

  let minimum = info.minNormal ?? 0;
  let maximum = info.maxNormal ?? Number.POSITIVE_INFINITY;
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
  const hasLowerBound = !rangeText.startsWith('dưới') && info.minNormal !== undefined;
  const hasUpperBound = !rangeText.startsWith('trên') && info.maxNormal !== undefined;
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
  CALCIUM: {
    name: 'Canxi toàn phần (Ca)',
    description: 'Khoáng chất thiết yếu cho xương, dẫn truyền thần kinh và co cơ.',
    normalRangeText: '2.15 - 2.55 mmol/L',
    minNormal: 2.15,
    maxNormal: 2.55,
    unit: 'mmol/L',
  },
  CA_ION: {
    name: 'Canxi Ion hóa (Ca²⁺)',
    description: 'Dạng canxi tự do có hoạt tính sinh học trực tiếp trong máu.',
    normalRangeText: '1.12 - 1.32 mmol/L',
    minNormal: 1.12,
    maxNormal: 1.32,
    unit: 'mmol/L',
  },
  MPV: {
    name: 'MPV (Thể tích trung bình tiểu cầu)',
    description: 'Đánh giá kích thước trung bình của tiểu cầu, phản ánh hoạt động tủy xương.',
    normalRangeText: '7.5 - 11.5 fL',
    minNormal: 7.5,
    maxNormal: 11.5,
    unit: 'fL',
  },
  VITAMIN_D: {
    name: 'Vitamin D (25-OH)',
    description: 'Đánh giá dự trữ vitamin D giúp hấp thu canxi, chắc khỏe xương và miễn dịch.',
    normalRangeText: '30 - 100 ng/mL',
    minNormal: 30,
    maxNormal: 100,
    unit: 'ng/mL',
  },
  MCV: {
    name: 'MCV (Thể tích trung bình hồng cầu)',
    description: 'Phân loại kích thước hồng cầu, hỗ trợ tầm soát thiếu máu.',
    normalRangeText: '80 - 100 fL',
    minNormal: 80,
    maxNormal: 100,
    unit: 'fL',
  },
  MCH: {
    name: 'MCH (Lượng huyết sắc tố TB hồng cầu)',
    description: 'Lượng hemoglobin trung bình có trong mỗi tế bào hồng cầu.',
    normalRangeText: '27 - 32 pg',
    minNormal: 27,
    maxNormal: 32,
    unit: 'pg',
  },
  MCHC: {
    name: 'MCHC (Nồng độ huyết sắc tố TB hồng cầu)',
    description: 'Nồng độ hemoglobin trung bình trên một đơn vị thể tích hồng cầu.',
    normalRangeText: '320 - 360 g/L',
    minNormal: 320,
    maxNormal: 360,
    unit: 'g/L',
  },
  ESR_1H: {
    name: 'Tốc độ máu lắng 1h (ESR)',
    description: 'Chỉ số gián tiếp phản ánh tình trạng viêm trong cơ thể.',
    normalRangeText: 'Dưới 20 mm/h',
    minNormal: 0,
    maxNormal: 20,
    unit: 'mm/h',
  },
  NA: {
    name: 'Natri (Na⁺)',
    description: 'Chất điện giải chính điều hòa cân bằng nước và áp lực thẩm thấu.',
    normalRangeText: '135 - 145 mmol/L',
    minNormal: 135,
    maxNormal: 145,
    unit: 'mmol/L',
  },
  K: {
    name: 'Kali (K⁺)',
    description: 'Chất điện giải thiết yếu cho nhịp tim và hoạt động thần kinh cơ.',
    normalRangeText: '3.5 - 5.0 mmol/L',
    minNormal: 3.5,
    maxNormal: 5.0,
    unit: 'mmol/L',
  },
  CL: {
    name: 'Clo (Cl⁻)',
    description: 'Chất điện giải giúp duy trì cân bằng kiềm toan và dịch cơ thể.',
    normalRangeText: '98 - 107 mmol/L',
    minNormal: 98,
    maxNormal: 107,
    unit: 'mmol/L',
  },
};

export function getHealthMetricInfo(standardKey: string): HealthMetricInfo {
  return HEALTH_METRIC_INFOS[standardKey] || {
    name: getHealthMetricDisplayName(standardKey),
    description: 'Chỉ số xét nghiệm sinh hóa hoặc huyết học theo dõi sức khỏe.',
    normalRangeText: '',
    minNormal: undefined,
    maxNormal: undefined,
    unit: '',
  };
}

interface ParsedRefRange {
  min?: number;
  max?: number;
  text: string;
  unit: string;
}

function parseRefRangeForChart(
  standardKey: string,
  refRange?: string,
  unit: string = '',
): ParsedRefRange | undefined {
  if (!refRange || typeof refRange !== 'string') return undefined;
  const trimmed = refRange.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/,/g, '.');
  const cleanUnit = unit.trim();

  const betweenMatch = normalized.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|~|to|đến)\s*(-?\d+(?:\.\d+)?)/i);
  if (betweenMatch) {
    const rawMin = Number(betweenMatch[1]);
    const rawMax = Number(betweenMatch[2]);
    if (Number.isFinite(rawMin) && Number.isFinite(rawMax) && rawMin <= rawMax) {
      const convMin = normalizeMetricForChart(standardKey, rawMin, cleanUnit);
      const convMax = normalizeMetricForChart(standardKey, rawMax, cleanUnit);
      const chartUnit = convMin.unit || cleanUnit;
      const sameRawUnit = normalizedUnit(chartUnit) === normalizedUnit(cleanUnit);
      const displayText = sameRawUnit
        ? `${betweenMatch[1]} - ${betweenMatch[2]}${chartUnit ? ` ${chartUnit}` : ''}`
        : `${Number(convMin.value.toFixed(2))} - ${Number(convMax.value.toFixed(2))}${chartUnit ? ` ${chartUnit}` : ''}`;
      return {
        min: convMin.value,
        max: convMax.value,
        text: displayText,
        unit: chartUnit,
      };
    }
  }

  const upperMatch = normalized.match(/^(<=|<|≤|dưới|nhỏ hơn)\s*(-?\d+(?:\.\d+)?)/i);
  if (upperMatch) {
    const rawMax = Number(upperMatch[2]);
    if (Number.isFinite(rawMax)) {
      const convMax = normalizeMetricForChart(standardKey, rawMax, cleanUnit);
      const chartUnit = convMax.unit || cleanUnit;
      return {
        min: undefined,
        max: convMax.value,
        text: `${trimmed}${chartUnit && !trimmed.toLowerCase().includes(chartUnit.toLowerCase()) ? ` ${chartUnit}` : ''}`,
        unit: chartUnit,
      };
    }
  }

  const lowerMatch = normalized.match(/^(>=|>|≥|trên|lớn hơn)\s*(-?\d+(?:\.\d+)?)/i);
  if (lowerMatch) {
    const rawMin = Number(lowerMatch[2]);
    if (Number.isFinite(rawMin)) {
      const convMin = normalizeMetricForChart(standardKey, rawMin, cleanUnit);
      const chartUnit = convMin.unit || cleanUnit;
      return {
        min: convMin.value,
        max: undefined,
        text: `${trimmed}${chartUnit && !trimmed.toLowerCase().includes(chartUnit.toLowerCase()) ? ` ${chartUnit}` : ''}`,
        unit: chartUnit,
      };
    }
  }

  return undefined;
}

export function resolveHealthMetricDisplayInfo(
  standardKey: string,
  timeline: HealthEvent[],
  gender?: 'male' | 'female' | 'other',
): HealthMetricInfo {
  if (standardKey === VITAL_HEIGHT_KEY) {
    return {
      name: 'Chiều cao (cm)',
      description: 'Theo dõi diễn biến chiều cao qua các lần khám sức khỏe.',
      normalRangeText: '',
      minNormal: undefined,
      maxNormal: undefined,
      unit: 'cm',
    };
  }
  if (standardKey === VITAL_WEIGHT_KEY) {
    return {
      name: 'Cân nặng (kg)',
      description: 'Theo dõi biến động cân nặng qua các lần khám định kỳ.',
      normalRangeText: '',
      minNormal: undefined,
      maxNormal: undefined,
      unit: 'kg',
    };
  }
  if (standardKey === VITAL_BP_KEY) {
    return {
      name: 'Huyết áp (mmHg)',
      description: 'Gồm huyết áp tâm thu (đường trên) và huyết áp tâm trương (đường dưới).',
      normalRangeText: '90/60 - 120/80 mmHg',
      minNormal: undefined,
      maxNormal: undefined,
      unit: 'mmHg',
    };
  }

  const orderedEvents = [...timeline].sort((a, b) => {
    const dateA = new Date(a.date || a.recordedAt).getTime();
    const dateB = new Date(b.date || b.recordedAt).getTime();
    return (Number.isFinite(dateA) ? dateA : 0) - (Number.isFinite(dateB) ? dateB : 0);
  });

  const matchingMetrics: HealthMetric[] = [];
  for (const evt of orderedEvents) {
    for (const metric of evt.metrics || []) {
      if (getHealthMetricStandardKey(metric) === standardKey) {
        matchingMetrics.push(metric);
      }
    }
  }

  const latestMetric = matchingMetrics[matchingMetrics.length - 1];
  const parsedLabRange = [...matchingMetrics]
    .reverse()
    .map((m) => parseRefRangeForChart(standardKey, m.refRange, m.unit || latestMetric?.unit || ''))
    .find((parsed): parsed is ParsedRefRange => parsed !== undefined);

  const catalog = HEALTH_METRIC_INFOS[standardKey];
  if (catalog) {
    // Always follow the lab reference range recorded in the Hồ sơ timeline when available
    const conciseCatalogDescription = clampWords(catalog.description, 20);
    if (parsedLabRange) {
      return {
        name: catalog.name,
        description: conciseCatalogDescription,
        normalRangeText: parsedLabRange.text,
        minNormal: parsedLabRange.min,
        maxNormal: parsedLabRange.max,
        unit: parsedLabRange.unit || catalog.unit,
      };
    }

    let minNormal = catalog.minNormal;
    let maxNormal = catalog.maxNormal;
    if (standardKey === 'CREATININ') {
      minNormal = gender === 'female' ? 44 : gender === 'male' ? 53 : 44;
      maxNormal = gender === 'female' ? 97 : gender === 'male' ? 106 : 106;
    } else if (standardKey === 'ACID_URIC') {
      minNormal = gender === 'female' ? 143 : gender === 'male' ? 202 : 143;
      maxNormal = gender === 'female' ? 339 : gender === 'male' ? 416 : 416;
    } else if (standardKey === 'HGB') {
      minNormal = gender === 'female' ? 110 : gender === 'male' ? 120 : 110;
      maxNormal = gender === 'female' ? 145 : gender === 'male' ? 160 : 160;
    }

    return {
      ...catalog,
      description: conciseCatalogDescription,
      minNormal,
      maxNormal,
    };
  }

  const displayName = getHealthMetricDisplayName(standardKey, latestMetric?.name);
  const resolvedDescription = getHealthMetricOverviewDescription(
    standardKey,
    latestMetric?.name || displayName,
  );

  return {
    name: displayName,
    description: resolvedDescription,
    normalRangeText: parsedLabRange?.text || '',
    minNormal: parsedLabRange?.min,
    maxNormal: parsedLabRange?.max,
    unit: parsedLabRange?.unit || latestMetric?.unit || '',
  };
}

export interface HealthMetricOption {
  key: string;
  label: string;
}

export function extractAbnormalHealthMetricOptions(
  timeline: HealthEvent[],
  gender?: 'male' | 'female' | 'other',
): HealthMetricOption[] {
  const labelByKey = new Map<string, string>();
  for (const event of timeline) {
    for (const metric of event.metrics || []) {
      const key = getHealthMetricStandardKey(metric);
      if (!key) continue;
      const { isAbnormal } = classifyHealthMetricForDisplay(metric, gender);
      if (isAbnormal && !labelByKey.has(key)) {
        labelByKey.set(key, getHealthMetricDisplayName(key, metric.name));
      }
    }
  }
  return Array.from(labelByKey.entries()).map(([key, label]) => ({
    key,
    label,
  }));
}

export function extractOverviewHealthMetricOptions(
  timeline: HealthEvent[],
  gender?: 'male' | 'female' | 'other',
): HealthMetricOption[] {
  const optionsByKey = new Map<string, HealthMetricOption>();

  if (buildHealthMetricChartData(timeline, VITAL_BP_KEY).length > 0) {
    optionsByKey.set(VITAL_BP_KEY, { key: VITAL_BP_KEY, label: 'Huyết áp' });
  }

  for (const abnormalOption of extractAbnormalHealthMetricOptions(timeline, gender)) {
    if (!optionsByKey.has(abnormalOption.key)) {
      optionsByKey.set(abnormalOption.key, abnormalOption);
    }
  }

  const trailingVitals: Array<{ key: string; label: string }> = [
    { key: VITAL_HEIGHT_KEY, label: 'Chiều cao' },
    { key: VITAL_WEIGHT_KEY, label: 'Cân nặng' },
  ];

  for (const vital of trailingVitals) {
    if (buildHealthMetricChartData(timeline, vital.key).length > 0 && !optionsByKey.has(vital.key)) {
      optionsByKey.set(vital.key, vital);
    }
  }

  return Array.from(optionsByKey.values());
}

export interface CategorizedHealthMetric {
  metric: HealthMetric;
  rangeStatus: HealthMetricRangeStatus;
  isAbnormal: boolean;
  index: number;
}

const EXPLICIT_ABNORMAL_STATUS_RE = /^(?:critical(?:_high|_low)?|warning(?:_high|_low)?|high|low|abnormal|elevated|borderline|out_of_range|positive|cao|thấp|thap|bất\s*thường|bat\s*thuong|vượt\s*ngưỡng|vuot\s*nguong|dương\s*tính|duong\s*tinh|h|l|\+)$/i;
const EXPLICIT_NORMAL_STATUS_RE = /^(?:normal|ok|within_range|negative|neg|bình\s*thường|binh\s*thuong|âm\s*tính|am\s*tinh|ổn\s*định|on\s*dinh|n)$/i;

function evaluateRefRangeStatus(value: number, refRange?: string): HealthMetricRangeStatus | undefined {
  if (!refRange || typeof refRange !== 'string') return undefined;
  const normalized = refRange.trim().replace(/,/g, '.');
  if (!normalized) return undefined;

  const betweenMatch = normalized.match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|~|to|đến)\s*(-?\d+(?:\.\d+)?)/i);
  if (betweenMatch) {
    const min = Number(betweenMatch[1]);
    const max = Number(betweenMatch[2]);
    if (Number.isFinite(min) && Number.isFinite(max) && min <= max) {
      if (value < min) return 'warning_low';
      if (value > max) return 'warning_high';
      return 'normal';
    }
  }

  const upperMatch = normalized.match(/^(?:<=|<|≤|dưới|nhỏ hơn)\s*(-?\d+(?:\.\d+)?)/i);
  if (upperMatch) {
    const max = Number(upperMatch[1]);
    if (Number.isFinite(max)) {
      return value > max ? 'warning_high' : 'normal';
    }
  }

  const lowerMatch = normalized.match(/^(?:>=|>|≥|trên|lớn hơn)\s*(-?\d+(?:\.\d+)?)/i);
  if (lowerMatch) {
    const min = Number(lowerMatch[1]);
    if (Number.isFinite(min)) {
      return value < min ? 'warning_low' : 'normal';
    }
  }

  return undefined;
}

export function classifyHealthMetricForDisplay(
  metric: HealthMetric,
  gender?: 'male' | 'female' | 'other',
): { rangeStatus: HealthMetricRangeStatus; isAbnormal: boolean } {
  const rawStatus = metric.status?.trim();
  if (rawStatus && EXPLICIT_ABNORMAL_STATUS_RE.test(rawStatus)) {
    const inferred: HealthMetricRangeStatus = /low|thấp|thap|^l$/i.test(rawStatus)
      ? 'warning_low'
      : /critical/i.test(rawStatus)
        ? 'critical_high'
        : 'warning_high';
    return { rangeStatus: inferred, isAbnormal: true };
  }

  // Respect the lab's own reference range first when it flags a measurement out-of-range
  const numericValue = parseMetricValue(metric.value);
  const refStatus =
    numericValue !== undefined ? evaluateRefRangeStatus(numericValue, metric.refRange) : undefined;
  if (refStatus === 'warning_low' || refStatus === 'warning_high') {
    return { rangeStatus: refStatus, isAbnormal: true };
  }

  const baseStatus = getHealthMetricRangeStatus(metric, gender);
  if (
    baseStatus === 'critical_high' ||
    baseStatus === 'critical_low' ||
    baseStatus === 'warning_high' ||
    baseStatus === 'warning_low'
  ) {
    return { rangeStatus: baseStatus, isAbnormal: true };
  }

  if (rawStatus && EXPLICIT_NORMAL_STATUS_RE.test(rawStatus)) {
    return { rangeStatus: 'normal', isAbnormal: false };
  }
  if (refStatus === 'normal' || baseStatus === 'normal') {
    return { rangeStatus: 'normal', isAbnormal: false };
  }

  return { rangeStatus: baseStatus, isAbnormal: false };
}

export function partitionHealthMetricsForDisplay(
  metrics: HealthMetric[],
  gender?: 'male' | 'female' | 'other',
): {
  abnormal: CategorizedHealthMetric[];
  normal: CategorizedHealthMetric[];
} {
  const abnormal: CategorizedHealthMetric[] = [];
  const normal: CategorizedHealthMetric[] = [];

  metrics.forEach((metric, index) => {
    const { rangeStatus, isAbnormal } = classifyHealthMetricForDisplay(metric, gender);
    const entry: CategorizedHealthMetric = { metric, rangeStatus, isAbnormal, index };
    if (isAbnormal) {
      abnormal.push(entry);
    } else {
      normal.push(entry);
    }
  });

  return { abnormal, normal };
}

const METRIC_BASIC_DESCRIPTIONS: Record<string, string> = {
  CREATININ:
    'Creatinin là chất thải từ hoạt động cơ bắp được thận lọc bỏ qua nước tiểu. Chỉ số này phản ánh trực tiếp khả năng lọc của thận. Creatinin tăng có thể gặp khi chức năng thận suy giảm, mất nước hoặc vận động mạnh; mức thấp hơn thường gặp ở người ít khối lượng cơ.',
  ACID_URIC:
    'Acid Uric là sản phẩm chuyển hóa tự nhiên của chất purin trong cơ thể và thức ăn. Nồng độ tăng cao kéo dài dễ lắng đọng tinh thể muối urat tại khớp gây bệnh gút hoặc tạo sỏi thận; chế độ ăn nhiều đạm, hải sản và rượu bia thường làm chỉ số này tăng.',
  TSH:
    'TSH là hóc môn tuyến yên giữ vai trò điều phối hoạt động của tuyến giáp. TSH tăng cao thường gợi ý tuyến giáp hoạt động kém (suy giáp), còn TSH giảm thấp thường gợi ý tuyến giáp hoạt động quá mức (cường giáp). Bác sĩ thường xem kết hợp với FT4 và FT3.',
  FT4:
    'FT4 (Thyroxine tự do) là hóc môn chính do tuyến giáp tiết ra ở dạng hoạt động, giúp điều hòa chuyển hóa năng lượng, nhịp tim và thân nhiệt. FT4 tăng gợi ý cường giáp; FT4 giảm gợi ý suy giáp và thường được bác sĩ đánh giá cùng chỉ số TSH.',
  FT3:
    'FT3 (Triiodothyronine tự do) là dạng hóc môn tuyến giáp có hoạt tính sinh học mạnh, tham gia trực tiếp vào tốc độ trao đổi chất của tế bào. FT3 thay đổi bất thường giúp bác sĩ phát hiện sớm cường giáp hoặc đánh giá rối loạn chức năng tuyến giáp cùng TSH và FT4.',
  CALCIUM:
    'Canxi toàn phần là khoáng chất thiết yếu giúp xương răng chắc khỏe, hỗ trợ co cơ, dẫn truyền thần kinh và đông máu. Canxi thấp có thể liên quan đến thiếu vitamin D, kém hấp thu hoặc tuyến cận giáp; canxi cao thường cần kiểm tra thêm chuyển hóa xương hoặc tuyến cận giáp.',
  CA_ION:
    'Canxi Ion hóa (Ca²⁺) là phần canxi tự do thực sự có hoạt tính sinh học trong máu, không bị ảnh hưởng bởi nồng độ đạm Albumin. Chỉ số này phản ánh chính xác hơn tình trạng thiếu hoặc thừa canxi của cơ thể để bác sĩ đánh giá chức năng thần kinh cơ và cận giáp.',
  VITAMIN_D:
    '25-OH Vitamin D phản ánh lượng vitamin D dự trữ trong cơ thể, đóng vai trò then chốt giúp hấp thu canxi, phát triển xương và tăng cường miễn dịch. Chỉ số thấp thường do ít tiếp xúc ánh nắng hoặc thiếu từ chế độ ăn, dễ ảnh hưởng đến canxi máu và mật độ xương.',
  MPV:
    'MPV (Thể tích trung bình tiểu cầu) đo kích thước trung bình của tiểu cầu — tế bào máu giúp cầm máu và làm lành vết thương. Chỉ số này phản ánh mức độ tạo tiểu cầu của tủy xương; MPV lệch nhẹ đơn độc thường ít đáng ngại nếu số lượng tiểu cầu (PLT) vẫn bình thường.',
  PLT:
    'Tiểu cầu (PLT) là tế bào máu giúp tạo cục máu đông và ngăn chảy máu khi cơ thể bị thương. Số lượng tiểu cầu giảm làm tăng nguy cơ bầm tím hoặc chảy máu kéo dài; tiểu cầu tăng cao có thể liên quan phản ứng viêm hoặc rối loạn tăng sinh tủy.',
  WBC:
    'Bạch cầu (WBC) là tế bào miễn dịch giúp cơ thể chống lại vi khuẩn, vi rút và tác nhân gây bệnh. Bạch cầu tăng thường gặp khi đang nhiễm trùng hoặc viêm cấp; bạch cầu giảm có thể do nhiễm siêu vi, tác dụng phụ của thuốc hoặc suy giảm miễn dịch.',
  RBC:
    'Hồng cầu (RBC) đảm nhận nhiệm vụ vận chuyển oxy từ phổi đến các mô và cơ quan trong cơ thể. Giảm hồng cầu thường gợi ý tình trạng thiếu máu hoặc mất máu; tăng hồng cầu có thể gặp khi cô đặc máu do thiếu nước hoặc sống ở vùng cao.',
  HGB:
    'Hemoglobin (HGB) là huyết sắc tố nằm trong hồng cầu giúp gắn kết và mang oxy đi nuôi cơ thể. HGB giảm là dấu hiệu trực tiếp của thiếu máu (thường gặp do thiếu sắt, thiếu dinh dưỡng hoặc mất máu); HGB tăng có thể liên quan cô đặc máu.',
  HCT:
    'Hematocrit (HCT) biểu thị tỷ lệ phần trăm thể tích hồng cầu chiếm trong tổng thể tích máu. HCT giảm thường đi kèm thiếu máu hoặc thừa dịch; HCT tăng cao có thể do mất nước, cô đặc máu hoặc tăng sinh hồng cầu.',
  MCV:
    'MCV là thể tích trung bình của một tế bào hồng cầu, giúp bác sĩ phân loại nguyên nhân thiếu máu. MCV nhỏ thường liên quan thiếu sắt hoặc mang gen Thalassemia; MCV lớn có thể gặp khi thiếu vitamin B12, thiếu axit folic hoặc ảnh hưởng rượu bia.',
  MCH:
    'MCH đo lượng huyết sắc tố trung bình có trong mỗi tế bào hồng cầu. Chỉ số MCH giảm thường gặp trong thiếu máu thiếu sắt (hồng cầu nhược sắc); MCH tăng có thể đi kèm hồng cầu to do thiếu vitamin B12 hoặc axit folic.',
  MCHC:
    'MCHC phản ánh nồng độ huyết sắc tố trung bình bên trong hồng cầu. MCHC giảm cho thấy hồng cầu chứa ít huyết sắc tố hơn bình thường (nhược sắc), hay gặp ở người thiếu sắt kéo dài.',
  GLUCOSE:
    'Glucose (đường huyết) là nguồn năng lượng chính cho não và tế bào cơ thể. Đường huyết lúc đói tăng cao cảnh báo nguy cơ tiền đái tháo đường hoặc đái tháo đường; đường huyết quá thấp có thể gây hoa mắt, run tay chân và vã mồ hôi.',
  HBA1C:
    'HbA1c phản ánh mức đường huyết trung bình trong khoảng 2 đến 3 tháng gần nhất, không bị ảnh hưởng nhiều bởi bữa ăn ngay trước lúc lấy máu. Đây là chỉ số quan trọng để tầm soát đái tháo đường và đánh giá hiệu quả kiểm soát đường huyết.',
  UREA:
    'Urea là sản phẩm thoái hóa của chất đạm được gan tạo ra và đào thải qua thận. Urea tăng có thể do chức năng thận suy giảm, thiếu nước hoặc ăn quá nhiều đạm; thường được bác sĩ đánh giá cùng chỉ số Creatinin.',
  EGFR:
    'eGFR là độ lọc cầu thận ước tính — thước đo quan trọng đánh giá mức độ làm việc hiệu quả của hai quả thận. Chỉ số eGFR càng thấp cho thấy khả năng lọc máu của thận càng suy giảm, cần được theo dõi định kỳ cùng Creatinin.',
  CHOLESTEROL:
    'Cholesterol toàn phần đo tổng lượng mỡ cholesterol lưu hành trong máu. Mức quá cao làm tăng nguy cơ hình thành mảng xơ vữa thành mạch máu, dẫn đến bệnh tim mạch và đột quỵ; nên đánh giá cùng LDL-C, HDL-C và Triglycerid.',
  LDL_C:
    'LDL-C thường được gọi là "cholesterol xấu" vì dễ bám vào thành động mạch tạo mảng xơ vữa, gây hẹp lòng mạch và tăng nguy cơ nhồi máu cơ tim hoặc đột quỵ. Kiểm soát tốt chế độ ăn ít chất béo bão hòa giúp hạ LDL-C.',
  HDL_C:
    'HDL-C thường được gọi là "cholesterol tốt" vì giúp thu gom mỡ thừa từ thành mạch đưa về gan xử lý. Mức HDL-C thấp làm giảm khả năng bảo vệ mạch máu, tăng nguy cơ tim mạch; vận động đều đặn giúp cải thiện chỉ số này.',
  TRIGLYCERID:
    'Triglycerid là dạng chất béo dự trữ năng lượng chủ yếu trong máu, chịu ảnh hưởng mạnh từ tinh bột, đường ngọt, đồ chiên rán và rượu bia. Triglycerid quá cao làm tăng nguy cơ xơ vữa mạch máu, gan nhiễm mỡ và viêm tụy cấp.',
  AST:
    'AST (GOT) là men có nhiều trong tế bào gan, tim và cơ bắp. Khi tế bào gan hoặc cơ bị tổn thương, AST giải phóng vào máu làm chỉ số tăng lên; cần xem kết hợp cùng men gan ALT để xác định nguyên nhân tại gan.',
  ALT:
    'ALT (GPT) là men gan đặc hiệu phản ánh tình trạng viêm hoặc tổn thương tế bào gan. ALT tăng cao thường gặp trong viêm gan do vi rút, gan nhiễm mỡ, tác dụng phụ của thuốc hoặc lạm dụng rượu bia.',
  GGT:
    'GGT là enzyme nhạy cảm với tình trạng ứ mật và tổn thương gan do rượu bia hoặc thuốc. GGT tăng đơn độc hoặc tăng kèm AST, ALT giúp bác sĩ đánh giá sức khỏe gan mật và lối sống sinh hoạt.',
  ESR_1H:
    'Tốc độ máu lắng (ESR) đo tốc độ lắng của hồng cầu trong ống nghiệm sau 1 giờ. Chỉ số này tăng lên khi trong cơ thể đang có phản ứng viêm, nhiễm trùng, bệnh tự miễn hoặc thiếu máu, giúp bác sĩ theo dõi diễn biến viêm.',
  NA:
    'Natri (Na⁺) là chất điện giải quan trọng giúp cân bằng lượng nước trong cơ thể, duy trì huyết áp và dẫn truyền thần kinh. Natri tăng hoặc giảm bất thường dễ gây mệt mỏi, chóng mặt hoặc rối loạn điện giải cần bù dịch hợp lý.',
  K:
    'Kali (K⁺) là chất điện giải thiết yếu giúp điều hòa nhịp tim và sự co bóp của cơ bắp. Kali máu quá cao hoặc quá thấp đều có thể ảnh hưởng đến nhịp tim và gây yếu cơ, thường liên quan chức năng thận, thuốc hoặc tiêu hóa.',
  CL:
    'Clo (Cl⁻) là chất điện giải phối hợp cùng Natri và Kali để duy trì cân bằng dịch và độ pH (kiềm - toan) trong máu. Mức Clo thay đổi thường đi kèm tình trạng mất nước, nôn ói, rối loạn điện giải hoặc bệnh lý thận.',
  CEA:
    'CEA là chất chỉ điểm khối u thường dùng để theo dõi điều trị hoặc tầm soát hỗ trợ một số bệnh lý đường tiêu hóa và phổi. CEA tăng nhẹ cũng có thể gặp ở người hút thuốc lá hoặc đang có tình trạng viêm lành tính, nên cần bác sĩ đánh giá kèm thăm khám khác.',
  AFP:
    'AFP là protein huyết tương thường dùng trong tầm soát và theo dõi các bệnh lý gan mật, đặc biệt ở người viêm gan mạn tính hoặc xơ gan. Chỉ số tăng cần được bác sĩ kiểm tra kết hợp với siêu âm và các xét nghiệm chức năng gan.',
  CYFRA_21_1:
    'CYFRA 21-1 là chất chỉ điểm hỗ trợ theo dõi tổn thương biểu mô đường hô hấp, thường dùng kèm chẩn đoán hình ảnh phổi. Mức tăng nhẹ đôi khi xuất hiện trong các bệnh viêm phổi hoặc phế quản lành tính nên cần bác sĩ đối chiếu lâm sàng.',
  CA_72_4:
    'CA 72-4 là chất chỉ điểm hỗ trợ theo dõi các bệnh lý đường tiêu hóa như dạ dày. Chỉ số này có thể tăng tạm thời khi viêm dạ dày lành tính hoặc dùng một số thuốc, nên cần bác sĩ xem cùng nội soi và triệu chứng thực tế.',
  CA_125:
    'CA 125 là chỉ số hỗ trợ theo dõi các vấn đề vùng chậu và buồng trứng ở nữ giới. CA 125 có thể tăng trong nhiều tình trạng lành tính như lạc nội mạc tử cung, u xơ tử cung, chu kỳ kinh nguyệt hoặc viêm vùng chậu.',
  CA_19_9:
    'CA 19-9 là chỉ số hỗ trợ theo dõi bệnh lý đường mật và tuyến tụy. Nồng độ tăng cũng có thể gặp khi tắc mật lành tính hoặc viêm tụy, cần bác sĩ kết hợp với siêu âm và chụp chiếu.',
  HBSAG:
    'HBsAg là kháng nguyên bề mặt của vi rút viêm gan B, dùng để xác định cơ thể có đang nhiễm vi rút viêm gan B hay không. Kết quả dương tính cần làm thêm xét nghiệm men gan và tải lượng vi rút để theo dõi.',
  HBSAB:
    'HBsAb (Anti-HBs) là kháng thể bảo vệ cơ thể chống lại vi rút viêm gan B, hình thành sau khi tiêm vắc xin hoặc đã khỏi bệnh tự nhiên. Nồng độ càng cao cho thấy khả năng miễn dịch bảo vệ càng tốt.',
  HCV_AB:
    'Anti-HCV là kháng thể tầm soát phơi nhiễm với vi rút viêm gan C. Nếu kết quả dương tính, bác sĩ sẽ chỉ định xét nghiệm tìm ARN vi rút (HCV RNA) để xác định tình trạng nhiễm hiện tại.',
  URINE_PRO:
    'Protein niệu (đạm nước tiểu) kiểm tra xem thận có đang để lọt chất đạm ra nước tiểu hay không. Đạm niệu dương tính kéo dài cần kiểm tra chức năng thận, huyết áp hoặc đường huyết; đôi khi xuất hiện thoáng qua sau sốt hoặc vận động nặng.',
  URINE_LEU:
    'Bạch cầu niệu (LEU) phát hiện sự hiện diện của tế bào bạch cầu trong nước tiểu, thường gợi ý tình trạng viêm hoặc nhiễm trùng đường tiết niệu (viêm bàng quang, viêm thận).',
  URINE_GLU:
    'Đường niệu (GLU) kiểm tra lượng đường glucose thoát ra nước tiểu. Bình thường nước tiểu không có đường; đường niệu dương tính thường gặp khi đường huyết trong máu tăng cao vượt ngưỡng lọc của thận.',
  URINE_BLOOD:
    'Hồng cầu niệu (máu trong nước tiểu) phản ánh có hồng cầu rò rỉ vào đường tiết niệu, có thể gặp trong sỏi thận, nhiễm trùng đường tiểu, viêm cầu thận hoặc hành kinh ở nữ.',
  URINE_RBC_SED:
    'Hồng cầu lắng cặn nước tiểu đếm lượng hồng cầu dưới kính hiển vi, giúp phát hiện chảy máu vi thể đường tiết niệu do sỏi, viêm nhiễm hoặc bệnh lý cầu thận.',
  URINE_SG:
    'Tỷ trọng nước tiểu (SG) phản ánh khả năng cô đặc nước tiểu của thận và tình trạng đủ nước của cơ thể. Tỷ trọng tăng cao thường do uống ít nước; tỷ trọng thấp kéo dài có thể liên quan uống nhiều nước hoặc chức năng cô đặc thận.',
  URINE_PH:
    'Độ pH nước tiểu đo tính axit hay kiềm của nước tiểu. pH thay đổi theo chế độ ăn, tình trạng nhiễm trùng đường tiểu hoặc xu hướng hình thành một số loại sỏi thận.',
};

function clampWords(text: string, maxWords: number = 100): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text.trim();
  return `${words.slice(0, maxWords - 1).join(' ').replace(/[,;:\-]+$/, '')}.`;
}

const METRIC_OVERVIEW_DESCRIPTIONS: Record<string, string> = {
  NEU_PCT: 'Tỷ lệ bạch cầu trung tính hỗ trợ bảo vệ chống nhiễm khuẩn.',
  LYM_PCT: 'Tỷ lệ bạch cầu lympho chống vi rút và tạo miễn dịch.',
  MONO_PCT: 'Tỷ lệ bạch cầu đơn nhân tham gia dọn dẹp tác nhân viêm.',
  CEA: 'Chất chỉ điểm hỗ trợ theo dõi bệnh lý tiêu hóa và phổi.',
  AFP: 'Chỉ dấu huyết thanh tầm soát và theo dõi bệnh lý gan mật.',
  CYFRA_21_1: 'Chất chỉ điểm hỗ trợ theo dõi tổn thương biểu mô hô hấp.',
  CA_72_4: 'Chất chỉ điểm hỗ trợ theo dõi bệnh lý dạ dày, tiêu hóa.',
  CA_125: 'Chất chỉ điểm hỗ trợ theo dõi vùng chậu và buồng trứng.',
  CA_19_9: 'Chất chỉ điểm hỗ trợ theo dõi bệnh lý đường mật và tụy.',
  HBSAG: 'Kháng nguyên bề mặt xác định tình trạng nhiễm vi rút viêm gan B.',
  HBSAB: 'Kháng thể đánh giá miễn dịch bảo vệ trước vi rút viêm gan B.',
  HCV_AB: 'Kháng thể tầm soát phơi nhiễm với vi rút viêm gan C.',
  URINE_PRO: 'Kiểm tra đạm thoát ra nước tiểu, đánh giá khả năng lọc thận.',
  URINE_LEU: 'Phát hiện bạch cầu niệu, gợi ý viêm nhiễm đường tiết niệu.',
  URINE_GLU: 'Kiểm tra đường xuất hiện trong nước tiểu khi đường huyết cao.',
  URINE_BLOOD: 'Phát hiện máu vi thể giúp theo dõi bất thường tiết niệu.',
  URINE_RBC_SED: 'Đếm hồng cầu lắng cặn phát hiện chảy máu đường tiết niệu.',
  URINE_SG: 'Đánh giá khả năng cô đặc nước tiểu và mức độ đủ nước.',
  URINE_PH: 'Đo độ axit kiềm nước tiểu, hỗ trợ theo dõi sỏi thận.',
};

export function getHealthMetricOverviewDescription(
  standardKey: string,
  rawName: string = '',
): string {
  const catalog = HEALTH_METRIC_INFOS[standardKey];
  if (catalog) {
    return clampWords(catalog.description, 20);
  }
  if (METRIC_OVERVIEW_DESCRIPTIONS[standardKey]) {
    return clampWords(METRIC_OVERVIEW_DESCRIPTIONS[standardKey], 20);
  }

  const normalizedName = `${standardKey} ${rawName}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();

  if (normalizedName.includes('pth') || normalizedName.includes('parathyroid')) {
    return clampWords('Hóc môn tuyến cận giáp điều hòa nồng độ canxi và phốt pho máu.', 20);
  }
  if (normalizedName.includes('ferritin')) {
    return clampWords('Protein phản ánh lượng sắt dự trữ chính của cơ thể.', 20);
  }
  if (normalizedName.includes('sat ') || normalizedName.includes('iron') || /\bfe\b/.test(normalizedName)) {
    return clampWords('Lượng sắt lưu hành trong máu cần thiết để tạo hồng cầu.', 20);
  }
  if (normalizedName.includes('crp')) {
    return clampWords('Chỉ dấu nhạy bén phản ánh tình trạng viêm hoặc nhiễm trùng cấp.', 20);
  }
  if (normalizedName.includes('bilirubin')) {
    return clampWords('Sắc tố mật phản ánh chức năng gan, đường mật và tan máu.', 20);
  }
  if (normalizedName.includes('albumin')) {
    return clampWords('Đạm quan trọng do gan tạo ra, duy trì dinh dưỡng và áp lực.', 20);
  }
  if (normalizedName.includes('protein') || normalizedName.includes('dam toan phan')) {
    return clampWords('Tổng lượng đạm máu, phản ánh dinh dưỡng, chức năng gan và thận.', 20);
  }
  if (normalizedName.includes('neu') || normalizedName.includes('trung tinh')) {
    return clampWords('Bạch cầu tuyến đầu bảo vệ cơ thể trước nhiễm khuẩn cấp.', 20);
  }
  if (normalizedName.includes('lym')) {
    return clampWords('Tế bào miễn dịch chủ lực chống vi rút và tạo kháng thể.', 20);
  }
  if (
    normalizedName.includes('mono') ||
    normalizedName.includes('eos') ||
    normalizedName.includes('baso') ||
    normalizedName.includes('ai toan') ||
    normalizedName.includes('ai kiem')
  ) {
    return clampWords('Thành phần bạch cầu liên quan dị ứng, ký sinh trùng hoặc viêm.', 20);
  }
  if (normalizedName.includes('rdw')) {
    return clampWords('Đánh giá độ đồng đều kích thước hồng cầu, tầm soát thiếu máu.', 20);
  }
  if (normalizedName.includes('pdw') || normalizedName.includes('pct') || normalizedName.includes('p lcr')) {
    return clampWords('Chỉ số kích thước và thể tích tiểu cầu hỗ trợ đánh giá đông máu.', 20);
  }
  if (normalizedName.includes('vitamin b12') || normalizedName.includes('b12')) {
    return clampWords('Vi chất thiết yếu cho quá trình tạo máu và hệ thần kinh.', 20);
  }
  if (normalizedName.includes('folate') || normalizedName.includes('folic')) {
    return clampWords('Vitamin B9 cần cho tổng hợp tế bào và tạo hồng cầu.', 20);
  }
  if (normalizedName.includes('magie') || normalizedName.includes('magnesium') || /\bmg\b/.test(normalizedName)) {
    return clampWords('Khoáng chất điều hòa cơ bắp, nhịp tim, thần kinh và canxi.', 20);
  }
  if (normalizedName.includes('phospho') || normalizedName.includes('phot pho')) {
    return clampWords('Khoáng chất phối hợp canxi cấu tạo xương răng và chuyển hóa.', 20);
  }
  if (normalizedName.includes('psa')) {
    return clampWords('Kháng nguyên đặc hiệu hỗ trợ tầm soát bệnh lý tuyến tiền liệt.', 20);
  }
  if (normalizedName.includes('amylase') || normalizedName.includes('lipase')) {
    return clampWords('Enzyme tiêu hóa phản ánh chức năng tụy và đường mật.', 20);
  }
  if (normalizedName.includes('alp') || normalizedName.includes('phosphatase kiem')) {
    return clampWords('Enzyme phản ánh tình trạng đường mật, gan và chuyển hóa xương.', 20);
  }
  if (normalizedName.includes('ldh')) {
    return clampWords('Enzyme giải phóng khi có tổn thương mô hoặc tế bào cơ thể.', 20);
  }
  if (normalizedName.includes('troponin') || normalizedName.includes('ck mb') || normalizedName.includes('bnp')) {
    return clampWords('Chỉ dấu sinh hóa chuyên biệt đánh giá tổn thương và chức năng tim.', 20);
  }
  if (
    normalizedName.includes('d dimer') ||
    normalizedName.includes('inr') ||
    normalizedName.includes('aptt') ||
    normalizedName.includes('fibrinogen') ||
    normalizedName.includes('prothrombin')
  ) {
    return clampWords('Chỉ số đánh giá chức năng đông máu và nguy cơ huyết khối.', 20);
  }
  if (normalizedName.includes('anti tpo') || normalizedName.includes('thyroglobulin')) {
    return clampWords('Chỉ dấu miễn dịch chuyên sâu đánh giá bệnh lý tuyến giáp.', 20);
  }
  if (normalizedName.includes('insulin')) {
    return clampWords('Hóc môn điều hòa đường huyết, đánh giá tình trạng kháng insulin.', 20);
  }
  if (normalizedName.includes('ige')) {
    return clampWords('Kháng thể miễn dịch liên quan cơ địa dị ứng hoặc ký sinh trùng.', 20);
  }

  return clampWords('Chỉ số xét nghiệm theo dõi sinh hóa, nội tiết hoặc chức năng cơ quan.', 20);
}

export function getHealthMetricBasicDescription(
  metric: HealthMetric,
  rangeStatus?: HealthMetricRangeStatus,
): string {
  const standardKey = getHealthMetricStandardKey(metric);
  if (METRIC_BASIC_DESCRIPTIONS[standardKey]) {
    return clampWords(METRIC_BASIC_DESCRIPTIONS[standardKey], 100);
  }

  const normalizedName = `${standardKey} ${metric.name}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();

  if (normalizedName.includes('pth') || normalizedName.includes('parathyroid')) {
    return clampWords(
      'PTH (Parathyroid Hormone) là hóc môn tuyến cận giáp giữ vai trò điều hòa nồng độ canxi và phốt pho trong máu. PTH tăng hoặc giảm bất thường giúp bác sĩ tìm nguyên nhân gây thiếu/thừa canxi máu hoặc thiếu vitamin D.',
      100,
    );
  }
  if (normalizedName.includes('ferritin')) {
    return clampWords(
      'Ferritin là protein dự trữ sắt chính của cơ thể. Ferritin giảm là dấu hiệu sớm của thiếu sắt; Ferritin tăng cao có thể gặp khi thừa sắt, gan nhiễm mỡ hoặc cơ thể đang có phản ứng viêm.',
      100,
    );
  }
  if (normalizedName.includes('sat ') || normalizedName.includes('iron') || /\bfe\b/.test(normalizedName)) {
    return clampWords(
      'Sắt huyết thanh (Fe) đo lượng sắt lưu hành trong máu cần thiết cho quá trình tạo hồng cầu và vận chuyển oxy. Sắt giảm thường gặp khi thiếu máu thiếu sắt; sắt tăng có thể gặp khi thừa sắt hoặc đang bổ sung sắt.',
      100,
    );
  }
  if (normalizedName.includes('crp')) {
    return clampWords(
      'CRP (Protein phản ứng C) là chỉ dấu nhạy bén phản ánh tình trạng viêm hoặc nhiễm trùng cấp tính trong cơ thể. CRP tăng cao gợi ý đang có ổ viêm nhiễm hoặc tổn thương mô cần được bác sĩ đánh giá nguyên nhân.',
      100,
    );
  }
  if (normalizedName.includes('bilirubin')) {
    return clampWords(
      'Bilirubin là sắc tố mật hình thành khi hồng cầu già bị phân hủy và được gan xử lý đào thải qua mật. Bilirubin tăng cao có thể gây vàng da, thường liên quan bệnh lý gan, tắc mật hoặc tan máu.',
      100,
    );
  }
  if (normalizedName.includes('albumin')) {
    return clampWords(
      'Albumin là loại đạm quan trọng nhất do gan sản xuất, giúp giữ nước trong lòng mạch và vận chuyển nhiều chất dinh dưỡng, thuốc. Albumin giảm có thể phản ánh suy dinh dưỡng, giảm chức năng gan hoặc mất đạm qua thận.',
      100,
    );
  }
  if (normalizedName.includes('protein') || normalizedName.includes('dam toan phan')) {
    return clampWords(
      'Protein toàn phần đo tổng lượng đạm Albumin và Globulin trong máu, phản ánh tình trạng dinh dưỡng, chức năng tổng hợp của gan và khả năng giữ đạm của thận.',
      100,
    );
  }
  if (normalizedName.includes('neu') || normalizedName.includes('trung tinh')) {
    return clampWords(
      'Bạch cầu trung tính (NEU) là nhóm bạch cầu chiếm tỷ lệ cao nhất, giữ vai trò tuyến đầu tiêu diệt vi khuẩn. Chỉ số này tăng thường gặp khi nhiễm khuẩn cấp; giảm có thể do nhiễm vi rút hoặc ảnh hưởng tủy xương.',
      100,
    );
  }
  if (normalizedName.includes('lym')) {
    return clampWords(
      'Bạch cầu lympho (LYM) là tế bào miễn dịch chủ lực chống lại vi rút và tạo kháng thể bảo vệ cơ thể. Tỷ lệ hoặc số lượng LYM thay đổi thường liên quan đến tình trạng nhiễm siêu vi hoặc phản ứng miễn dịch.',
      100,
    );
  }
  if (normalizedName.includes('mono') || normalizedName.includes('eos') || normalizedName.includes('baso') || normalizedName.includes('ai toan') || normalizedName.includes('ai kiem')) {
    return clampWords(
      'Đây là một thành phần của dòng bạch cầu giúp cơ thể phản ứng với dị ứng, ký sinh trùng hoặc tình trạng viêm mạn tính. Sự thay đổi nhẹ thường được bác sĩ đối chiếu cùng tổng số lượng bạch cầu (WBC) và triệu chứng lâm sàng.',
      100,
    );
  }
  if (normalizedName.includes('rdw')) {
    return clampWords(
      'RDW đo độ chênh lệch kích thước giữa các tế bào hồng cầu. RDW tăng cho thấy kích thước hồng cầu không đồng đều, thường hỗ trợ phát hiện sớm thiếu máu do thiếu sắt, thiếu vitamin B12 hoặc axit folic.',
      100,
    );
  }
  if (normalizedName.includes('pdw') || normalizedName.includes('pct') || normalizedName.includes('p lcr')) {
    return clampWords(
      'Đây là chỉ số phụ đánh giá kích thước, thể tích và mức độ đồng đều của tiểu cầu trong máu — giúp bác sĩ xem kết hợp với số lượng tiểu cầu (PLT) và MPV để đánh giá quá trình đông cầm máu.',
      100,
    );
  }
  if (normalizedName.includes('vitamin b12') || normalizedName.includes('b12')) {
    return clampWords(
      'Vitamin B12 là vi chất thiết yếu cho quá trình tạo hồng cầu và hoạt động của hệ thần kinh. Thiếu B12 dễ gây thiếu máu hồng cầu to, mệt mỏi và tê bì tay chân.',
      100,
    );
  }
  if (normalizedName.includes('folate') || normalizedName.includes('folic')) {
    return clampWords(
      'Folate (Axit folic / Vitamin B9) đóng vai trò quan trọng trong tổng hợp ADN và tạo hồng cầu. Thiếu hụt thường gây thiếu máu hồng cầu to và mệt mỏi.',
      100,
    );
  }
  if (normalizedName.includes('magie') || normalizedName.includes('magnesium') || /\bmg\b/.test(normalizedName)) {
    return clampWords(
      'Magie (Mg) là khoáng chất cần thiết cho hoạt động cơ bắp, dẫn truyền thần kinh, nhịp tim và chuyển hóa canxi. Thiếu magie có thể gây chuột rút, mệt mỏi hoặc rối loạn điện giải.',
      100,
    );
  }
  if (normalizedName.includes('phospho') || normalizedName.includes('phot pho')) {
    return clampWords(
      'Phốt pho là khoáng chất phối hợp cùng canxi và vitamin D để cấu tạo xương răng và chuyển hóa năng lượng tế bào. Nồng độ phốt pho thay đổi thường liên quan chức năng thận, cận giáp hoặc vitamin D.',
      100,
    );
  }
  if (normalizedName.includes('psa')) {
    return clampWords(
      'PSA là kháng nguyên đặc hiệu tuyến tiền liệt ở nam giới. PSA tăng có thể gặp trong phì đại lành tính tuyến tiền liệt, viêm tuyến tiền liệt hoặc cần tầm soát chuyên khoa tiết niệu.',
      100,
    );
  }
  if (normalizedName.includes('amylase') || normalizedName.includes('lipase')) {
    return clampWords(
      'Amylase / Lipase là men tiêu hóa do tuyến tụy sản xuất giúp tiêu hóa tinh bột và chất béo. Chỉ số tăng cao rõ rệt thường cần kiểm tra tình trạng viêm tụy hoặc bệnh lý đường mật.',
      100,
    );
  }
  if (normalizedName.includes('alp') || normalizedName.includes('phosphatase kiem')) {
    return clampWords(
      'ALP (Phosphatase kiềm) là enzyme có nhiều ở gan, đường mật và xương. ALP tăng có thể liên quan ứ mật, bệnh lý gan mật hoặc quá trình chuyển hóa, phát triển xương.',
      100,
    );
  }
  if (normalizedName.includes('ldh')) {
    return clampWords(
      'LDH là enzyme có mặt trong hầu hết các mô như tim, gan, cơ, hồng cầu. LDH tăng phản ánh tình trạng tổn thương tế bào hoặc mô trong cơ thể, cần đánh giá cùng các xét nghiệm đặc hiệu khác.',
      100,
    );
  }
  if (normalizedName.includes('troponin') || normalizedName.includes('ck mb') || normalizedName.includes('bnp')) {
    return clampWords(
      'Đây là chỉ dấu sinh hóa tim mạch giúp bác sĩ đánh giá tổn thương cơ tim hoặc áp lực gánh nặng lên tim, cần được theo dõi và tư vấn trực tiếp bởi bác sĩ chuyên khoa.',
      100,
    );
  }
  if (normalizedName.includes('d dimer') || normalizedName.includes('inr') || normalizedName.includes('aptt') || normalizedName.includes('fibrinogen') || normalizedName.includes('prothrombin')) {
    return clampWords(
      'Đây là chỉ số đánh giá chức năng đông máu và hình thành/tiêu hủy cục máu đông trong cơ thể, giúp bác sĩ kiểm tra nguy cơ chảy máu hoặc huyết khối và theo dõi thuốc chống đông.',
      100,
    );
  }
  if (normalizedName.includes('anti tpo') || normalizedName.includes('thyroglobulin')) {
    return clampWords(
      'Đây là chỉ số kháng thể hoặc protein đặc hiệu của tuyến giáp, giúp bác sĩ phát hiện bệnh lý tuyến giáp tự miễn (như viêm giáp Hashimoto) hoặc theo dõi tuyến giáp chuyên sâu.',
      100,
    );
  }
  if (normalizedName.includes('insulin')) {
    return clampWords(
      'Insulin là hóc môn do tuyến tụy tiết ra giúp đưa đường glucose từ máu vào tế bào tạo năng lượng. Chỉ số này hỗ trợ bác sĩ đánh giá tình trạng kháng insulin và nguy cơ rối loạn chuyển hóa đường.',
      100,
    );
  }
  if (normalizedName.includes('ige')) {
    return clampWords(
      'IgE là kháng thể miễn dịch thường tăng cao khi cơ thể có cơ địa dị ứng (viêm mũi dị ứng, hen, mề đay) hoặc nhiễm ký sinh trùng.',
      100,
    );
  }

  const displayName = getHealthMetricDisplayName(standardKey, metric.name);
  const resolvedStatus = rangeStatus || classifyHealthMetricForDisplay(metric).rangeStatus;
  if (resolvedStatus === 'warning_high' || resolvedStatus === 'critical_high') {
    return clampWords(
      `${displayName} là chỉ số xét nghiệm chuyên biệt dùng để đánh giá tình trạng chuyển hóa hoặc chức năng cơ quan tương ứng. Giá trị đo lần này cao hơn ngưỡng tham chiếu của phòng xét nghiệm, có thể chịu ảnh hưởng bởi sức khỏe hiện tại, chế độ sinh hoạt hoặc thuốc đang dùng.`,
      100,
    );
  }
  if (resolvedStatus === 'warning_low' || resolvedStatus === 'critical_low') {
    return clampWords(
      `${displayName} là chỉ số xét nghiệm chuyên biệt dùng để đánh giá tình trạng sinh hóa, nội tiết hoặc chức năng cơ quan tương ứng. Giá trị đo lần này thấp hơn ngưỡng tham chiếu của phòng xét nghiệm, có thể liên quan đến dinh dưỡng, hấp thu hoặc tình trạng sức khỏe nền.`,
      100,
    );
  }

  return clampWords(
    `${displayName} là chỉ số xét nghiệm chuyên biệt phản ánh trạng thái sinh hóa, huyết học hoặc chức năng cơ quan tương ứng. Khi vượt ngoài khoảng tham chiếu trên phiếu xét nghiệm, bạn nên đối chiếu cùng triệu chứng lâm sàng và trao đổi với bác sĩ.`,
    100,
  );
}
