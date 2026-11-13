import type { HealthEvent, HospitalizationRecord } from '../types';

export const HEALTH_EVENT_TYPES: HealthEvent['type'][] = [
  'comprehensive_exam',
  'medical_report',
  'prescription',
  'test_result',
  'vaccination',
  'discharge',
  'imaging',
  'other',
];

export function isHealthEventType(value: unknown): value is HealthEvent['type'] {
  return typeof value === 'string' && HEALTH_EVENT_TYPES.includes(value as HealthEvent['type']);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return Boolean(text) && patterns.some((pattern) => pattern.test(text));
}

function isMeaningfulFieldText(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const normalized = normalizeText(trimmed);
  return (
    Boolean(normalized) &&
    ![
      'na',
      'n a',
      'unknown',
      'khong ro',
      'chua ro',
      'khong co',
      'khong',
      'null',
      'undefined',
      'none',
    ].includes(normalized)
  );
}

export function cleanHospitalizationRecord(value: unknown): HospitalizationRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const cleaned: HospitalizationRecord = {
    admissionDate: isMeaningfulFieldText(record.admissionDate) ? record.admissionDate.trim() : undefined,
    dischargeDate: isMeaningfulFieldText(record.dischargeDate) ? record.dischargeDate.trim() : undefined,
    department: isMeaningfulFieldText(record.department) ? record.department.trim() : undefined,
    treatmentSummary: isMeaningfulFieldText(record.treatmentSummary) ? record.treatmentSummary.trim() : undefined,
    surgicalNotes: isMeaningfulFieldText(record.surgicalNotes) ? record.surgicalNotes.trim() : undefined,
  };
  return Object.values(cleaned).some(Boolean) ? cleaned : undefined;
}

export function hasMeaningfulHospitalization(value: unknown): boolean {
  return cleanHospitalizationRecord(value) !== undefined;
}

export function hasMeaningfulPhysicalExam(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Boolean(
    (typeof record.height_cm === 'number' && Number.isFinite(record.height_cm)) ||
    (typeof record.weight_kg === 'number' && Number.isFinite(record.weight_kg)) ||
    (typeof record.bmi === 'number' && Number.isFinite(record.bmi)) ||
    (typeof record.pulse_bpm === 'number' && Number.isFinite(record.pulse_bpm)) ||
    isMeaningfulFieldText(record.bp_mmHg) ||
    isMeaningfulFieldText(record.classification),
  );
}

function isPlaceholderPageText(page: string): boolean {
  const normalized = normalizeText(page);
  return (
    !normalized ||
    normalized === 'trang bia anh' ||
    normalized === 'trang khong co van ban' ||
    normalized === 'trang trong'
  );
}

function extractLeadingDocumentHeader(value: Record<string, unknown>): string {
  const pageSources = Array.isArray(value.pageTexts)
    ? value.pageTexts
    : Array.isArray(value.contentIndexPages)
      ? value.contentIndexPages
      : [];
  const meaningfulPages = pageSources
    .filter((page): page is string => typeof page === 'string' && !isPlaceholderPageText(page))
    .slice(0, 2);
  return meaningfulPages.join('\n').slice(0, 1200);
}

function extractFullDocumentBody(value: Record<string, unknown>): string {
  const parts: string[] = [];
  const pageSources = Array.isArray(value.pageTexts)
    ? value.pageTexts
    : Array.isArray(value.contentIndexPages)
      ? value.contentIndexPages
      : [];
  for (const page of pageSources) {
    if (typeof page === 'string' && page.trim()) parts.push(page);
  }
  if (typeof value.facility === 'string' && value.facility.trim()) parts.push(value.facility);
  if (typeof value.notes === 'string' && value.notes.trim()) parts.push(value.notes);
  if (typeof value.advice === 'string' && value.advice.trim()) parts.push(value.advice);
  if (Array.isArray(value.diagnoses)) {
    for (const item of value.diagnoses) {
      if (typeof item === 'string' && item.trim()) parts.push(item);
    }
  }
  return parts.join(' ');
}

const COMPREHENSIVE_PATTERNS = [
  /\bkham suc khoe\b/,
  /\bsuc khoe dinh ky\b/,
  /\bsuc khoe tong quat\b/,
  /\bho so kham suc khoe\b/,
  /\bho so kham dinh ky\b/,
  /\bphieu kham suc khoe\b/,
  /\bket qua kham suc khoe\b/,
  /\btong ket suc khoe\b/,
  /\bso kham suc khoe\b/,
  /\bkham tong quat\b/,
  /\bkham dinh ky\b/,
  /\bkham skdk\b/,
  /\bkham doan\b/,
  /\bkiem tra suc khoe\b/,
  /\bhealth check(?:up)?\b/,
  /\bannual physical\b/,
];

const VACCINATION_PATTERNS = [
  /\bphieu tiem(?: chung| ngua)?\b/,
  /\bso tiem(?: chung| ngua)?\b/,
  /\btiem chung\b/,
  /\btiem ngua\b/,
  /\bvaccin(?:ation|e|es)\b/,
  /\blich tiem\b/,
];

const PRESCRIPTION_PATTERNS = [
  /\bdon thuoc\b/,
  /\btoa thuoc\b/,
  /\bke don\b/,
  /\bphieu linh thuoc\b/,
  /\bchi dinh dung thuoc\b/,
  /\bprescription\b/,
];

const DISCHARGE_PATTERNS = [
  /\bgiay ra vien\b/,
  /\bphieu ra vien\b/,
  /\bphieu xuat vien\b/,
  /\btom tat benh an\b/,
  /\bgiay chuyen vien\b/,
  /\bho so benh an noi tru\b/,
  /\bdieu tri noi tru\b/,
  /\bdischarge summary\b/,
];

const IMAGING_PATTERNS = [
  /\bsieu am\b/,
  /\bx quang\b/,
  /\bchup x quang\b/,
  /\bdien tam do\b/,
  /\becg\b/,
  /\bct scan\b/,
  /\bchup ct\b/,
  /\bmri\b/,
  /\bchup mri\b/,
  /\bnoi soi\b/,
  /\bdoppler\b/,
  /\bchan doan hinh anh\b/,
];

const TEST_RESULT_PATTERNS = [
  /\bxet nghiem\b/,
  /\bket qua xn\b/,
  /\bphieu xn\b/,
  /\bhoa sinh\b/,
  /\bhuyet hoc\b/,
  /\bmien dich\b/,
  /\bvi sinh\b/,
  /\bnuoc tieu\b/,
  /\blab(?:oratory)? result\b/,
  /\bblood test\b/,
  /\burine test\b/,
];

const MEDICAL_REPORT_PATTERNS = [
  /\bkham benh\b/,
  /\bphieu kham\b/,
  /\bso kham benh\b/,
  /\bphieu kham chuyen khoa\b/,
  /\bmedical report\b/,
  /\bclinical note\b/,
];

export function classifyHealthEventType(
  value: Partial<HealthEvent> & Record<string, unknown>,
  fileName?: string,
): HealthEvent['type'] | undefined {
  const fileLabel = normalizeText(fileName || '');
  const titleLabel = normalizeText(
    [value.title, value.customCategory].filter((item): item is string => typeof item === 'string').join(' '),
  );
  const headerLabel = normalizeText(extractLeadingDocumentHeader(value));
  const titleAndHeader = `${fileLabel} ${titleLabel} ${headerLabel}`.trim();
  const bodyText = normalizeText(extractFullDocumentBody(value));
  const structuredText = normalizeText(JSON.stringify({
    facility: value.facility,
    diagnoses: value.diagnoses,
    imagingResults: value.imagingResults,
    medications: value.medications,
    metrics: value.metrics,
    vaccinations: value.vaccinations,
    hospitalization: cleanHospitalizationRecord(value.hospitalization),
  }));
  const fullContent = `${bodyText} ${structuredText}`.trim();

  const metricsCount = Array.isArray(value.metrics) ? value.metrics.length : 0;
  const diagnosesCount = Array.isArray(value.diagnoses) ? value.diagnoses.length : 0;
  const hasMetrics = metricsCount > 0;
  const hasImaging = Array.isArray(value.imagingResults) && value.imagingResults.length > 0;
  const hasMeds = Array.isArray(value.medications) && value.medications.length > 0;
  const hasVax = Array.isArray(value.vaccinations) && value.vaccinations.length > 0;
  const hasHosp = hasMeaningfulHospitalization(value.hospitalization);
  const hasPhysicalExam = hasMeaningfulPhysicalExam(value.physicalExam);

  // 1. Khám sức khỏe định kỳ / tổng quát (ưu tiên cao nhất khi tiêu đề/header hoặc nội dung kết hợp)
  if (matchesAny(titleAndHeader, COMPREHENSIVE_PATTERNS)) {
    return 'comprehensive_exam';
  }
  if (matchesAny(fullContent, COMPREHENSIVE_PATTERNS) && hasMetrics && (hasImaging || hasPhysicalExam)) {
    return 'comprehensive_exam';
  }

  // 2. Tiêm chủng
  if (matchesAny(titleAndHeader, VACCINATION_PATTERNS) || hasVax) {
    return 'vaccination';
  }

  // 3. Đơn thuốc
  if (matchesAny(titleAndHeader, PRESCRIPTION_PATTERNS)) {
    return 'prescription';
  }

  // 4. Giấy ra viện / Tóm tắt bệnh án nội trú (chỉ khi thực sự có từ khóa hoặc hospitalization có dữ liệu thật)
  if (matchesAny(titleAndHeader, DISCHARGE_PATTERNS) || hasHosp) {
    return 'discharge';
  }

  // 5. Tiêu đề / header trang đầu nói rõ Xét nghiệm vs Chẩn đoán hình ảnh vs Khám bệnh
  const titleImaging = matchesAny(`${fileLabel} ${titleLabel}`, IMAGING_PATTERNS);
  const titleLab = matchesAny(`${fileLabel} ${titleLabel}`, TEST_RESULT_PATTERNS);
  const titleMedicalReport = matchesAny(`${fileLabel} ${titleLabel}`, MEDICAL_REPORT_PATTERNS);
  const headerImaging = matchesAny(headerLabel, IMAGING_PATTERNS);
  const headerLab = matchesAny(headerLabel, TEST_RESULT_PATTERNS);

  if (titleLab && !titleImaging) return 'test_result';
  if (titleImaging && !titleLab && !hasPhysicalExam) return 'imaging';
  if (titleMedicalReport && !titleImaging && !titleLab) {
    return hasMetrics && hasImaging && (hasPhysicalExam || diagnosesCount >= 2)
      ? 'comprehensive_exam'
      : 'medical_report';
  }

  if (headerLab && !headerImaging && !hasImaging) return 'test_result';
  if (headerImaging && !headerLab && !hasMetrics && !hasPhysicalExam) return 'imaging';

  // Hồ sơ đa chuyên khoa (có cả nhiều chỉ số xét nghiệm lẫn chẩn đoán hình ảnh và khám lâm sàng/nhiều chẩn đoán)
  if (!titleImaging && hasMetrics && hasImaging && (hasPhysicalExam || (metricsCount >= 2 && diagnosesCount >= 2))) {
    return 'comprehensive_exam';
  }

  if (titleImaging || headerImaging || hasImaging) {
    if (hasMetrics && !hasImaging) return 'test_result';
    if (hasImaging && !hasMetrics && !matchesAny(titleAndHeader, MEDICAL_REPORT_PATTERNS)) return 'imaging';
    if (matchesAny(titleAndHeader, TEST_RESULT_PATTERNS)) return 'test_result';
    if (matchesAny(titleAndHeader, MEDICAL_REPORT_PATTERNS)) return 'medical_report';
    return 'imaging';
  }

  if (titleLab || headerLab) {
    return 'test_result';
  }

  if (matchesAny(titleAndHeader, MEDICAL_REPORT_PATTERNS)) {
    return 'medical_report';
  }

  // 6. Đánh giá theo toàn bộ nội dung văn bản + dữ liệu cấu trúc
  if (matchesAny(fullContent, VACCINATION_PATTERNS)) return 'vaccination';
  if (matchesAny(fullContent, DISCHARGE_PATTERNS)) return 'discharge';
  if (matchesAny(fullContent, PRESCRIPTION_PATTERNS) || (hasMeds && !hasMetrics && !hasImaging)) {
    return 'prescription';
  }
  if (matchesAny(fullContent, TEST_RESULT_PATTERNS) || (hasMetrics && !hasImaging)) {
    return 'test_result';
  }
  if (matchesAny(fullContent, IMAGING_PATTERNS)) return 'imaging';

  // 7. Giữ phân loại của model nếu hợp lệ và không mâu thuẫn rõ rệt
  if (isHealthEventType(value.type)) {
    if (value.type === 'discharge' && !hasHosp && !matchesAny(`${titleAndHeader} ${fullContent}`, DISCHARGE_PATTERNS)) {
      if (hasMetrics) return 'test_result';
      if (hasImaging) return 'imaging';
      if (hasMeds) return 'prescription';
      return 'medical_report';
    }
    return value.type;
  }

  if (hasMetrics) return 'test_result';
  if (hasImaging) return 'imaging';
  if (hasMeds) return 'prescription';

  return undefined;
}
