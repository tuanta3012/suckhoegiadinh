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

export function stripAdministrativeFacilityContext(text: string): string {
  return text
    .replace(/\b(?:phong\s+kham|khoa|bac\s+si|bs|khoa\s+noi|chuyen\s+khoa)\s+(?:kham\s+)?(?:tong\s+quat|da\s+khoa|noi\s+tong\s+quat)\b/g, ' ')
    .replace(/\b(?:phong\s+kham|khoa|chuyen\s+khoa)\s+kham\s+benh\b/g, ' ')
    .replace(/\b(?:benh\s+vien|phong\s+kham|trung\s+tam\s+y\s+te)\s+(?:da\s+khoa|dai\s+hoc\s+y\s+duoc(?:\s*\d+)?)\b/g, ' ')
    .replace(/\b(?:tai\s+kham|hen\s+kham|lich\s+kham)\s+(?:dinh\s+ky|lai)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  /\bkham skdk\b/,
  /\bkham doan\b/,
  /\bkiem tra suc khoe\b/,
  /\bhealth check(?:up)?\b/,
  /\bannual physical\b/,
  /\bgiay kham suc khoe\b/,
];

const PURE_COMPREHENSIVE_EXAM_PATTERNS = [
  ...COMPREHENSIVE_PATTERNS,
  /\bkham tong quat\b/,
  /\bkham dinh ky\b/,
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
  /\bdon thuoc dieu tri\b/,
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
  const directTitleText = stripAdministrativeFacilityContext(`${fileLabel} ${titleLabel}`);

  const rawHeader = extractLeadingDocumentHeader(value);
  const headerLabel = stripAdministrativeFacilityContext(normalizeText(rawHeader));

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
  const fullContent = stripAdministrativeFacilityContext(`${bodyText} ${structuredText}`);

  const metricsCount = Array.isArray(value.metrics) ? value.metrics.length : 0;
  const diagnosesCount = Array.isArray(value.diagnoses) ? value.diagnoses.length : 0;
  const hasMetrics = metricsCount > 0;
  const hasImaging = Array.isArray(value.imagingResults) && value.imagingResults.length > 0;
  const hasMeds = Array.isArray(value.medications) && value.medications.length > 0;
  const hasVax = Array.isArray(value.vaccinations) && value.vaccinations.length > 0;
  const hasHosp = hasMeaningfulHospitalization(value.hospitalization);
  const hasPhysicalExam = hasMeaningfulPhysicalExam(value.physicalExam);

  // 1. TIÊU ĐỀ RÕ RÀNG (Direct explicit document title):
  // 1.1 Đơn thuốc: nếu tiêu đề/tên file nói rõ là đơn thuốc/toa thuốc
  if (matchesAny(directTitleText, PRESCRIPTION_PATTERNS)) {
    if (hasMeds || (!hasMetrics && !hasImaging)) {
      return 'prescription';
    }
  }

  // 1.2 Tiêm chủng
  if (matchesAny(directTitleText, VACCINATION_PATTERNS) || hasVax) {
    return 'vaccination';
  }

  // 1.3 Giấy ra viện / xuất viện
  if (matchesAny(directTitleText, DISCHARGE_PATTERNS) || (hasHosp && !matchesAny(directTitleText, PRESCRIPTION_PATTERNS))) {
    return 'discharge';
  }

  // 1.4 Khám sức khỏe định kỳ / tổng quát (khi tiêu đề nói rõ là hồ sơ/sổ/phiếu khám sức khỏe)
  if (matchesAny(directTitleText, PURE_COMPREHENSIVE_EXAM_PATTERNS) && !matchesAny(directTitleText, PRESCRIPTION_PATTERNS)) {
    return 'comprehensive_exam';
  }

  // 1.5 Xét nghiệm vs Chẩn đoán hình ảnh vs Khám bệnh từ tiêu đề
  const isDirectTitleLab = matchesAny(directTitleText, TEST_RESULT_PATTERNS);
  const isDirectTitleImaging = matchesAny(directTitleText, IMAGING_PATTERNS);
  const isDirectTitleMedicalReport = matchesAny(directTitleText, MEDICAL_REPORT_PATTERNS);

  if (isDirectTitleLab && !isDirectTitleImaging) return 'test_result';
  if (isDirectTitleImaging && !isDirectTitleLab && !hasPhysicalExam) return 'imaging';
  if (isDirectTitleMedicalReport && !isDirectTitleImaging && !isDirectTitleLab) {
    return hasMetrics && hasImaging && (hasPhysicalExam || diagnosesCount >= 2)
      ? 'comprehensive_exam'
      : 'medical_report';
  }

  // 2. HEADER TRANG ĐẦU TIÊN (Khi tiêu đề/file chưa đủ rõ, đọc banner tiêu đề trang đầu):
  if (matchesAny(headerLabel, PRESCRIPTION_PATTERNS) && (hasMeds || (!hasMetrics && !hasImaging))) {
    return 'prescription';
  }
  if (matchesAny(headerLabel, VACCINATION_PATTERNS)) {
    return 'vaccination';
  }
  if (matchesAny(headerLabel, DISCHARGE_PATTERNS) || hasHosp) {
    return 'discharge';
  }
  if (matchesAny(headerLabel, COMPREHENSIVE_PATTERNS) && !matchesAny(headerLabel, PRESCRIPTION_PATTERNS)) {
    return 'comprehensive_exam';
  }

  const isHeaderLab = matchesAny(headerLabel, TEST_RESULT_PATTERNS);
  const isHeaderImaging = matchesAny(headerLabel, IMAGING_PATTERNS);
  const isHeaderMedicalReport = matchesAny(headerLabel, MEDICAL_REPORT_PATTERNS);

  if (isHeaderLab && !isHeaderImaging && !hasImaging) return 'test_result';
  if (isHeaderImaging && !isHeaderLab && !hasMetrics && !hasPhysicalExam) return 'imaging';
  if (isHeaderMedicalReport && !isHeaderImaging && !isHeaderLab) {
    return hasMetrics && hasImaging && (hasPhysicalExam || diagnosesCount >= 2)
      ? 'comprehensive_exam'
      : 'medical_report';
  }

  // 3. HỒ SƠ ĐA CHUYÊN KHOA (Khám sức khỏe tổng hợp gồm cả xét nghiệm + chẩn đoán hình ảnh + thể lực)
  if (!isDirectTitleImaging && !isHeaderImaging && hasMetrics && hasImaging && (hasPhysicalExam || (metricsCount >= 2 && diagnosesCount >= 2))) {
    return 'comprehensive_exam';
  }
  if (matchesAny(fullContent, COMPREHENSIVE_PATTERNS) && hasMetrics && (hasImaging || hasPhysicalExam)) {
    return 'comprehensive_exam';
  }

  // 4. KIỂM TRA ĐẶC ĐIỂM DỮ LIỆU CẤU TRÚC KẾT HỢP
  if (isDirectTitleImaging || isHeaderImaging || hasImaging) {
    if (hasMetrics && !hasImaging) return 'test_result';
    if (hasImaging && !hasMetrics && !matchesAny(`${directTitleText} ${headerLabel}`, MEDICAL_REPORT_PATTERNS)) return 'imaging';
    if (matchesAny(`${directTitleText} ${headerLabel}`, TEST_RESULT_PATTERNS)) return 'test_result';
    if (matchesAny(`${directTitleText} ${headerLabel}`, MEDICAL_REPORT_PATTERNS)) return 'medical_report';
    return 'imaging';
  }

  if (isDirectTitleLab || isHeaderLab) {
    return 'test_result';
  }

  if (matchesAny(`${directTitleText} ${headerLabel}`, MEDICAL_REPORT_PATTERNS)) {
    return 'medical_report';
  }

  // 5. TOÀN BỘ NỘI DUNG VĂN BẢN (Full body text)
  if (matchesAny(fullContent, VACCINATION_PATTERNS)) return 'vaccination';
  if (matchesAny(fullContent, DISCHARGE_PATTERNS)) return 'discharge';
  if (matchesAny(fullContent, PRESCRIPTION_PATTERNS) || (hasMeds && !hasMetrics && !hasImaging)) {
    return 'prescription';
  }
  if (matchesAny(fullContent, TEST_RESULT_PATTERNS) || (hasMetrics && !hasImaging)) {
    return 'test_result';
  }
  if (matchesAny(fullContent, IMAGING_PATTERNS)) return 'imaging';

  // 6. GIỮ PHÂN LOẠI CỦA MODEL NẾU HỢP LỆ VÀ HỢP LÝ
  if (isHealthEventType(value.type)) {
    if (value.type === 'discharge' && !hasHosp && !matchesAny(`${directTitleText} ${headerLabel} ${fullContent}`, DISCHARGE_PATTERNS)) {
      if (hasMetrics) return 'test_result';
      if (hasImaging) return 'imaging';
      if (hasMeds) return 'prescription';
      return 'medical_report';
    }
    // Nếu model nhầm đơn thuốc (có thuốc, không xét nghiệm, không hình ảnh) thành comprehensive_exam hay medical_report:
    if ((value.type === 'comprehensive_exam' || value.type === 'medical_report') && hasMeds && !hasMetrics && !hasImaging) {
      return 'prescription';
    }
    return value.type;
  }

  // 7. FALLBACK THEO DỮ LIỆU THỰC TẾ
  if (hasMeds) return 'prescription';
  if (hasMetrics) return 'test_result';
  if (hasImaging) return 'imaging';

  return undefined;
}
