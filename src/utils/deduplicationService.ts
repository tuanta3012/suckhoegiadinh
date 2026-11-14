import type {
  FamilyMember,
  HealthEvent,
  HealthMetric,
  HealthProfile,
  HealthSource,
  ImagingResult,
  Medication,
} from '../types';
import { cleanHospitalizationRecord } from './healthEventType';
import { standardizeMetricKey } from './healthRecordService';

/**
 * Tính mã băm SHA-256 của tệp để định danh nội dung chính xác
 */
export async function computeFileFingerprint(file: Blob | File): Promise<{ hash: string; size: number }> {
  const size = file.size;
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const buffer = await file.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
      return { hash, size };
    }
  } catch (err) {
    console.warn('[Deduplication] Không thể tính SHA-256 bằng crypto.subtle:', err);
  }

  // Fallback: Tạo fingerprint kết hợp kích thước và tên tệp
  const name = 'name' in file ? (file as File).name : 'blob';
  return { hash: `fallback_${name}_${size}`, size };
}


/**
 * Bỏ dấu tiếng Việt để so sánh chuỗi regex mạnh mẽ hơn
 */
export function removeVietnameseAccents(str: string): string {
  if (!str) return '';
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

/**
 * Chuẩn hóa chuỗi văn bản y tế tiếng Việt để so sánh chính xác
 */
export function normalizeMedicalText(text: string): string {
  if (!text) return '';
  return text
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/[.,:;!?"'()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Chuẩn hóa tên thuốc (loại bỏ liều lượng nếu gắn liền, chuẩn hóa viết thường)
 */
export function normalizeMedicationName(name: string): string {
  if (!name) return '';
  let normalized = normalizeMedicalText(name);
  // Loại bỏ các tiền tố số thứ tự: 1., 1/, Thuốc 1:, Thuốc: (không bỏ chữ Thuốc đứng độc lập như Thuốc A)
  normalized = normalized.replace(/^\s*(?:(?:\d+|[ivx]+)[\.\/\)\-:]|\bthuốc\s*\d+[:\.\-]?|\bthuốc\s*[:\-])\s*/i, '');
  // Loại bỏ liều lượng kết hợp (VD: 50mg + 1000mg, 50/1000, 10mg + 20mg, 50/850mg)
  normalized = normalized.replace(/\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|µg|ml|l|iu|ui|%|viên|v|ống|gói|chai)?\s*[\/+\-x]\s*\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|µg|ml|l|iu|ui|%|viên|v|ống|gói|chai)?\b/gi, ' ');
  normalized = normalized.replace(/\b\d+\s*\/\s*\d+\b/g, ' ');
  // Loại bỏ các hậu tố liều thông dụng như 5mg, 500mg, 10ml, 1g, 0.1%...
  normalized = normalized.replace(/\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|µg|ml|l|iu|ui|%|viên|v|ống|gói|chai)\b/gi, ' ');
  // Loại bỏ các ký tự dấu toán học hoặc nối còn sót lại ở cuối chuỗi (+, /, -)
  normalized = normalized.replace(/[\/+\-·,.;]+(?:\s+|$)/g, ' ');
  return normalized.replace(/\s+/g, ' ').trim();
}

/**
 * Trích xuất các token định danh cốt lõi của thuốc (hoạt chất và biệt dược)
 * Loại bỏ tiền tố số thứ tự, hậu tố liều lượng phức hợp, đơn vị, dung tích, phần trăm
 * Sắp xếp các token hoạt chất để "A + B" trùng "B + A"
 */
export function canonicalizeMedicationKey(name: string): string {
  if (!name || typeof name !== 'string') return '';

  // 1. Loại bỏ số thứ tự đầu dòng: "1. ", "1/ ", "1) ", "Thuốc 1: ", v.v.
  let cleaned = name.replace(/^\s*(?:(?:\d+|[ivx]+)[\.\/\)\-:]|\bthuốc\s*\d+[:\.\-]?|\bthuốc\s*[:\-])\s*/i, '');

  // 2. Tách phần trong ngoặc (biệt dược thường nằm trong ngoặc như "(VASITIMB 10/20MG)" hoặc "(METFORMIN HCL 850/SITAGLIPTIN 50)")
  const brandMatches = cleaned.match(/\(([^)]+)\)/g) || [];
  const brandTexts = brandMatches.map((m) => m.replace(/[()]/g, ' '));
  let mainText = cleaned.replace(/\(([^)]+)\)/g, ' ');

  // 3. Hàm loại bỏ liều lượng và con số/đơn vị toàn diện:
  const stripDosagePatterns = (text: string): string => {
    return text
      .replace(/\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|µg|ml|l|iu|ui|%|viên|v|ống|gói|chai)?\s*[\/+\-x]\s*\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|µg|ml|l|iu|ui|%|viên|v|ống|gói|chai)?\b/gi, ' ')
      .replace(/\b\d+\s*\/\s*\d+(?:mg|g)?\b/gi, ' ')
      .replace(/\b\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|µg|ml|l|iu|ui|%|viên|v|ống|gói|chai|lo|hop)\b/gi, ' ')
      .replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ')
      .replace(/\b\d+(?:[.,]\d+)?\s*(?:ml|l)\b/gi, ' ')
      .replace(/\b\d+(?:[.,]\d+)?\b/g, ' ');
  };

  mainText = stripDosagePatterns(mainText);
  const brandCombined = stripDosagePatterns(brandTexts.join(' '));

  // 4. Chuẩn hóa tiếng Việt, bỏ dấu và ký tự đặc biệt, chuẩn hóa gốc dược học
  const normalizeTokens = (text: string): string[] => {
    const unaccented = removeVietnameseAccents(text.toLowerCase());
    return unaccented
      .replace(/[^a-z0-9]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((token) => {
        if (token.length < 2) return false;
        const stopWords = new Set([
          'thuoc', 'vien', 'ong', 'goi', 'chai', 'lo', 'hop', 'dung', 'dich',
          'eye', 'drop', 'drops', 'sl', 'mg', 'ml', 'uong', 'ngay', 'lan',
          'hcl', 'salt', 'sodium', 'potassium'
        ]);
        return !stopWords.has(token);
      })
      .map((token) => {
        if (token.endsWith('ine')) return token.slice(0, -1);
        if (token.endsWith('ole')) return token.slice(0, -1);
        return token;
      });
  };

  const mainTokens = normalizeTokens(mainText);
  const brandTokens = normalizeTokens(brandCombined);

  // Nếu có brandTokens đặc trưng (như vasitimb, sitamet, stradiras), ưu tiên đưa lên đầu khóa
  const primaryBrand = brandTokens.find((t) => t.length >= 4 && !['metformin', 'sitagliptin', 'ezetimibe', 'simvastatin', 'atorvastatin'].includes(t));
  if (primaryBrand) {
    return `brand_${primaryBrand}`;
  }

  const allTokens = Array.from(new Set([...mainTokens, ...brandTokens])).sort();
  if (allTokens.length === 0) {
    return normalizeMedicationName(name) || normalizeMedicalText(name);
  }
  return allTokens.join('_');
}

/**
 * Làm sạch tên thuốc hiển thị:
 * Cắt bỏ phần liều lượng thừa lặp lại sau ngoặc tên biệt dược (VD: "(SITA-MET 50/1000) 50mg + 1000mg" -> "(SITA-MET 50/1000)")
 * Chuẩn hóa viết hoa chữ cái đầu cho tên hoạt chất
 */
export function cleanMedicationDisplayName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  let cleaned = name.trim().replace(/^\s*(?:(?:\d+|[ivx]+)[\.\/\)\-:]|\bthuốc\s*\d+[:\.\-]?|\bthuốc\s*[:\-])\s*/i, '');

  const lastCloseParenIndex = cleaned.lastIndexOf(')');
  if (lastCloseParenIndex !== -1 && lastCloseParenIndex < cleaned.length - 1) {
    const tail = cleaned.slice(lastCloseParenIndex + 1).trim();
    // Nếu phần tail là liều lượng hoặc số lượng lặp lại
    if (/^(\d+(?:[.,]\d+)?\s*(?:mg|g|mcg|µg|ml|l|iu|ui|%|viên|v|ống|gói|chai)?\s*[\/+\-x]?\s*)+$/i.test(tail)) {
      cleaned = cleaned.slice(0, lastCloseParenIndex + 1).trim();
    }
  }

  // Viết hoa chữ cái đầu của các hoạt chất chính
  cleaned = cleaned.replace(/(?:^|\+\s*)([a-zà-ỹ])/g, (match) => match.toUpperCase());
  return cleaned.trim();
}

function pickBestMedicationDisplayName(a: string, b: string): string {
  const aClean = cleanMedicationDisplayName(a);
  const bClean = cleanMedicationDisplayName(b);
  const aHasParen = /\([^)]+\)/.test(aClean);
  const bHasParen = /\([^)]+\)/.test(bClean);
  if (aHasParen && !bHasParen) return aClean;
  if (bHasParen && !aHasParen) return bClean;
  return aClean.length >= bClean.length ? aClean : bClean;
}

function pickBetterClinicalValue(a?: string, b?: string): string | undefined {
  if (!a) return b ? b.trim() : undefined;
  if (!b) return a.trim();
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (aTrim === bTrim) return aTrim;
  if (aTrim.toLowerCase().includes(bTrim.toLowerCase())) return aTrim;
  if (bTrim.toLowerCase().includes(aTrim.toLowerCase())) return bTrim;
  if (/ngày|lần|viên|uống|sau/i.test(aTrim) && !/ngày|lần|viên|uống|sau/i.test(bTrim)) return aTrim;
  if (/ngày|lần|viên|uống|sau/i.test(bTrim) && !/ngày|lần|viên|uống|sau/i.test(aTrim)) return bTrim;
  return aTrim.length >= bTrim.length ? aTrim : bTrim;
}

function pickBetterDuration(a?: string, b?: string): string | undefined {
  if (!a) return b ? b.trim() : undefined;
  if (!b) return a.trim();
  const aTrim = a.trim();
  const bTrim = b.trim();
  if (aTrim === bTrim) return aTrim;
  if (aTrim.includes('ngày') && bTrim.toLowerCase().includes('days')) return aTrim;
  if (bTrim.includes('ngày') && aTrim.toLowerCase().includes('days')) return bTrim;
  return aTrim.length >= bTrim.length ? aTrim : bTrim;
}

/**
 * Hợp nhất thông minh một cặp thuốc trùng lặp (giữ tên chuẩn, ghép liều, tần suất, thời gian, số lượng)
 */
export function mergeMedicationPair(existing: Medication, incoming: Medication): Medication {
  const merged: Medication = {
    name: pickBestMedicationDisplayName(existing.name, incoming.name),
    dosage: pickBetterClinicalValue(existing.dosage, incoming.dosage),
    frequency: pickBetterClinicalValue(existing.frequency, incoming.frequency),
    duration: pickBetterDuration(existing.duration, incoming.duration),
  };
  const quantity = pickBetterClinicalValue(existing.quantity, incoming.quantity);
  if (quantity) merged.quantity = quantity;
  const timing = pickBetterClinicalValue(existing.timing, incoming.timing);
  if (timing) merged.timing = timing;
  const instructions = pickBetterClinicalValue(existing.instructions, incoming.instructions);
  if (instructions) merged.instructions = instructions;

  return merged;
}

/**
 * Khử trùng lặp danh sách thuốc: gom các biến thể có cùng hoạt chất/biệt dược thành 1 bản ghi tối ưu nhất
 */
export function cleanAndDeduplicateMedications(medications: Medication[]): Medication[] {
  if (!Array.isArray(medications) || medications.length === 0) return [];
  const medMap = new Map<string, Medication>();

  for (const rawMed of medications) {
    if (!rawMed || typeof rawMed.name !== 'string' || !rawMed.name.trim()) continue;
    const cleanedName = cleanMedicationDisplayName(rawMed.name);
    const key = canonicalizeMedicationKey(cleanedName) || normalizeMedicationName(cleanedName) || normalizeMedicalText(cleanedName);
    if (!key) continue;

    const med: Medication = {
      name: cleanedName,
      dosage: rawMed.dosage ? rawMed.dosage.trim() : undefined,
      frequency: rawMed.frequency ? rawMed.frequency.trim() : undefined,
      duration: rawMed.duration ? rawMed.duration.trim() : undefined,
    };
    if (rawMed.quantity && rawMed.quantity.trim()) med.quantity = rawMed.quantity.trim();
    if (rawMed.timing && rawMed.timing.trim()) med.timing = rawMed.timing.trim();
    if (rawMed.instructions && rawMed.instructions.trim()) med.instructions = rawMed.instructions.trim();

    const existing = medMap.get(key);
    if (!existing) {
      medMap.set(key, med);
    } else {
      medMap.set(key, mergeMedicationPair(existing, med));
    }
  }

  return Array.from(medMap.values());
}

/**
 * Chuẩn hóa các thuật ngữ / lỗi chính tả y tế thông dụng
 */
export function standardizeMedicalSpelling(text: string): string {
  if (!text) return '';
  return text
    .replace(/\binsuline\b/gi, 'insulin')
    .replace(/\b(glucozo|glucoza)\b/gi, 'glucose')
    .replace(/\bcholesteron\b/gi, 'cholesterol')
    .replace(/\btriglyceride\b/gi, 'triglycerid')
    .replace(/\bacid uric\b/gi, 'axit uric')
    .replace(/\bhb\s*a1c\b/gi, 'HbA1c')
    .replace(/\bcreatinine\b/gi, 'creatinin')
    .replace(/\bproteine\b/gi, 'protein')
    .replace(/\bđái tháo đường típ\b/gi, 'đái tháo đường typ')
    .replace(/\bđái tháo đường type\b/gi, 'đái tháo đường typ');
}

/**
 * Trích xuất mã ICD-10 từ chuỗi chẩn đoán nếu có (VD: "(E11)", "(I10)", "(E78.2)", "H10.5")
 */
export function extractIcdCode(text: string): string | null {
  if (!text) return null;
  const match = text.match(/\b\(([A-Z]\d{2}(?:\.\d{1,2})?)\)/i) || text.match(/\b([A-Z]\d{2}(?:\.\d{1,2})?)\b/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * Khử trùng lặp chẩn đoán y khoa thông minh:
 * 1. Gom nhóm theo mã ICD-10 (như E11, I10, E78.2...)
 * 2. Chuẩn hóa chính tả y tế (insuline -> insulin...)
 * 3. Loại bỏ chẩn đoán chung chung khi đã có chẩn đoán chi tiết bao trùm
 */
export function cleanAndDeduplicateDiagnoses(diagnoses: string[]): string[] {
  if (!Array.isArray(diagnoses) || diagnoses.length === 0) return [];

  interface DiagItem {
    raw: string;
    cleaned: string;
    icd: string | null;
    canonicalText: string;
  }

  const items: DiagItem[] = [];

  for (const d of diagnoses) {
    if (typeof d !== 'string') continue;
    let trimmed = d.trim()
      .replace(/^[-*•+]\s*/, '')
      .replace(/^\d+[\.\/\)]\s*/, '')
      .replace(/[.,;]$/, '')
      .trim();
    if (!trimmed) continue;

    trimmed = standardizeMedicalSpelling(trimmed);
    const icd = extractIcdCode(trimmed);
    const canonicalText = removeVietnameseAccents(normalizeMedicalText(trimmed))
      .replace(/\b(benh|hoi chung|tinh trang|mac|bi)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    items.push({
      raw: d,
      cleaned: trimmed,
      icd,
      canonicalText,
    });
  }

  const icdMap = new Map<string, DiagItem>();
  const nonIcdItems: DiagItem[] = [];

  for (const item of items) {
    if (item.icd) {
      const existing = icdMap.get(item.icd);
      if (!existing) {
        icdMap.set(item.icd, item);
      } else {
        if (item.cleaned.length > existing.cleaned.length) {
          icdMap.set(item.icd, item);
        }
      }
    } else {
      nonIcdItems.push(item);
    }
  }

  const resultItems: DiagItem[] = Array.from(icdMap.values());

  for (const nonIcd of nonIcdItems) {
    const isSubsumed = resultItems.some((accepted) => {
      if (accepted.canonicalText === nonIcd.canonicalText) return true;
      if (
        nonIcd.canonicalText.length >= 4 &&
        accepted.canonicalText.includes(nonIcd.canonicalText)
      ) {
        return true;
      }
      return false;
    });

    if (!isSubsumed) {
      const alreadyInResult = resultItems.some(
        (r) => r.canonicalText === nonIcd.canonicalText
      );
      if (!alreadyInResult) {
        resultItems.push(nonIcd);
      }
    }
  }

  return resultItems.map((item) => item.cleaned);
}

/**
 * Khử trùng lặp nội dung Lời dặn / Ghi chú của bác sĩ ở cấp độ câu và mệnh đề
 * Loại bỏ các đoạn văn bị dán nối tiếp nhiều lần (do OCR nhiều trang hoặc gộp đơn)
 */
export function deduplicateAdviceText(text?: string): string | undefined {
  if (!text || typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Tách văn bản thành các câu hoặc mục lời dặn
  const rawSegments = trimmed
    .split(/\n+|(?<=[.!?;])\s+/)
    .map((s) => s.trim().replace(/^[-*•+]\s*/, '').replace(/^\d+[\.\/\)]\s*/, ''))
    .filter((s) => s.length > 0);

  if (rawSegments.length <= 1) {
    return trimmed;
  }

  const acceptedSegments: string[] = [];
  const acceptedNormalized: string[] = [];

  for (const seg of rawSegments) {
    const cleanSeg = seg.trim().replace(/[.,;]$/, '');
    if (cleanSeg.length < 3) continue;

    const norm = removeVietnameseAccents(cleanSeg.toLowerCase())
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!norm) continue;

    if (acceptedNormalized.includes(norm)) {
      continue;
    }

    let isSubsumed = false;
    for (let i = 0; i < acceptedNormalized.length; i++) {
      const existing = acceptedNormalized[i];
      if (existing.includes(norm)) {
        isSubsumed = true;
        break;
      }
      if (norm.includes(existing) && norm.length > existing.length * 1.2) {
        acceptedSegments[i] = cleanSeg;
        acceptedNormalized[i] = norm;
        isSubsumed = true;
        break;
      }

      const normTokens = new Set(norm.split(' ').filter(t => t.length >= 2));
      const existingTokens = new Set(existing.split(' ').filter(t => t.length >= 2));
      let shared = 0;
      for (const t of normTokens) {
        if (existingTokens.has(t)) shared++;
      }
      const similarity = shared / Math.max(normTokens.size, existingTokens.size);
      if (similarity >= 0.85) {
        isSubsumed = true;
        if (cleanSeg.length > acceptedSegments[i].length) {
          acceptedSegments[i] = cleanSeg;
          acceptedNormalized[i] = norm;
        }
        break;
      }
    }

    if (!isSubsumed) {
      acceptedSegments.push(cleanSeg);
      acceptedNormalized.push(norm);
    }
  }

  if (acceptedSegments.length === 0) return undefined;

  const hasNewlines = trimmed.includes('\n');
  return acceptedSegments
    .map((s) => {
      const capitalized = s.charAt(0).toUpperCase() + s.slice(1);
      return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
    })
    .join(hasNewlines ? '\n' : ' ');
}

/**
 * Chuẩn hóa tên chỉ số đo (VD: "huyết áp tâm thu", "HA tâm thu" -> thống nhất)
 */
export function normalizeMetricName(name: string): string {
  if (!name) return '';
  const text = normalizeMedicalText(name);
  const unaccented = removeVietnameseAccents(text);
  if (/^(ha|huyet ap)\s*(tam thu|tt|max)/.test(unaccented)) return 'huyết áp tâm thu';
  if (/^(ha|huyet ap)\s*(tam truong|ttr|min)/.test(unaccented)) return 'huyết áp tâm trương';
  if (/^(duong huyet|glucose|glucoza)/.test(unaccented)) return 'đường huyết';
  if (/^(nhip tim|mach|pulse)/.test(unaccented)) return 'nhịp tim';
  if (/^(spo2|oxy mau|do bao hoa oxy)/.test(unaccented)) return 'spo2';
  if (/^(nhiet do|than nhiet|temp)/.test(unaccented)) return 'thân nhiệt';
  if (/^(can nang|trong luong|weight)/.test(unaccented)) return 'cân nặng';
  if (/^(chieu cao|height)/.test(unaccented)) return 'chiều cao';
  return text;
}

/**
 * Chuẩn hóa modality key cho chẩn đoán hình ảnh (VD: "Siêu âm tuyến giáp" -> "sieuamtuyengiap")
 */
export function normalizeModalityKey(modality: string): string {
  if (!modality) return 'chandan_hinhanh';
  return modality
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
    || 'chandan_hinhanh';
}

function resolveCanonicalMetricKey(metric: Partial<HealthMetric>): string {
  const name = metric.name?.trim() || '';
  const unit = metric.unit?.trim() || '';
  const normalizedName = normalizeMetricName(name);
  if (metric.standardKey && metric.standardKey.trim()) {
    return standardizeMetricKey(metric.standardKey.trim(), unit, name);
  }
  const stdFromName = standardizeMetricKey(normalizedName || name, unit, name);
  const rawUpper = (normalizedName || name).trim().toUpperCase();
  return stdFromName && stdFromName !== rawUpper ? stdFromName : (normalizedName || stdFromName);
}

/**
 * Khử trùng lặp nội dung BÊN TRONG của một sự kiện y tế (diagnoses, medications, metrics, imaging, advice, notes)
 */
export function cleanAndDeduplicateEventData<T extends Partial<HealthEvent>>(event: T): T {
  // 1. Khử trùng lặp Chẩn đoán (Diagnoses)
  let cleanedDiagnoses: string[] | undefined = undefined;
  if (Array.isArray(event.diagnoses)) {
    cleanedDiagnoses = cleanAndDeduplicateDiagnoses(event.diagnoses);
  }

  // 2. Khử trùng lặp Đơn thuốc (Medications)
  let cleanedMedications: Medication[] | undefined = undefined;
  if (Array.isArray(event.medications)) {
    cleanedMedications = cleanAndDeduplicateMedications(event.medications);
  }

  // 3. Khử trùng lặp Chỉ số đo (Metrics)
  let cleanedMetrics: HealthMetric[] | undefined = undefined;
  if (Array.isArray(event.metrics)) {
    const metricMap = new Map<string, HealthMetric>();
    for (const m of event.metrics) {
      const name = m.name?.trim() || '';
      if (!name || typeof m.value !== 'number' || !Number.isFinite(m.value)) continue;

      let stdKey = m.standardKey ? m.standardKey.trim().toUpperCase() : undefined;
      if (stdKey) {
        stdKey = standardizeMetricKey(stdKey, m.unit || '', name);
      }

      const key = resolveCanonicalMetricKey({ ...m, name, standardKey: stdKey });
      const existing = metricMap.get(key);
      if (!existing || (!existing.refRange && m.refRange)) {
        metricMap.set(key, { ...m, name, standardKey: stdKey });
      }
    }
    cleanedMetrics = Array.from(metricMap.values());
  }

  // 4. Khử trùng lặp Chẩn đoán hình ảnh (Imaging Results) - Đảm bảo DUY NHẤT 1 card mỗi Modality
  let cleanedImagingResults: ImagingResult[] | undefined = undefined;
  if (Array.isArray(event.imagingResults)) {
    const imgMap = new Map<string, ImagingResult>();
    for (const img of event.imagingResults) {
      const modality = img.modality?.trim() || '';
      const findings = img.findings?.trim() || '';
      const conclusion = img.conclusion?.trim() || '';
      if (!modality && !findings && !conclusion) continue;

      const key = normalizeModalityKey(modality);
      const existing = imgMap.get(key);
      if (!existing) {
        imgMap.set(key, {
          modality: modality || 'Chẩn đoán hình ảnh',
          findings: deduplicateAdviceText(findings) || findings,
          conclusion: deduplicateAdviceText(conclusion) || conclusion,
        });
      } else {
        let mergedFindings = existing.findings || '';
        if (findings && findings !== mergedFindings) {
          if (!mergedFindings) mergedFindings = findings;
          else if (!mergedFindings.includes(findings) && !findings.includes(mergedFindings)) {
            mergedFindings = `${mergedFindings}; ${findings}`;
          } else if (findings.length > mergedFindings.length) {
            mergedFindings = findings;
          }
        }
        const mergedConclusion = conclusion.length > (existing.conclusion || '').length ? conclusion : (existing.conclusion || '');
        imgMap.set(key, {
          modality: existing.modality || modality,
          findings: deduplicateAdviceText(mergedFindings) || mergedFindings,
          conclusion: deduplicateAdviceText(mergedConclusion) || mergedConclusion,
        });
      }
    }
    cleanedImagingResults = Array.from(imgMap.values());
  }

  // 5. Khử trùng lặp Lời dặn & Ghi chú (Advice & Notes)
  const cleanedAdvice = typeof event.advice === 'string' ? deduplicateAdviceText(event.advice) : event.advice;
  const cleanedNotes = typeof event.notes === 'string' ? deduplicateAdviceText(event.notes) : event.notes;

  return {
    ...event,
    diagnoses: cleanedDiagnoses ?? event.diagnoses,
    medications: cleanedMedications ?? event.medications,
    metrics: cleanedMetrics ?? event.metrics,
    imagingResults: cleanedImagingResults ?? event.imagingResults,
    advice: cleanedAdvice,
    notes: cleanedNotes,
  };
}

/**
 * Kiểm tra xem tệp tin vừa tải lên đã từng được tải lên hoặc số hóa chưa
 */
export interface FileDuplicateMatch {
  existingSource: HealthSource;
  linkedEvent?: HealthEvent;
  isExactContentMatch: boolean;
  memberId?: string;
  memberName?: string;
}

export function detectDuplicateFile(
  file: { name: string; size: number },
  fileHash: string,
  profile: HealthProfile,
  member?: FamilyMember
): FileDuplicateMatch | null {
  if (!profile.sources || profile.sources.length === 0) return null;

  for (const source of profile.sources) {
    const hashMatch = Boolean(
      source.fileHash &&
      fileHash &&
      /^[a-f0-9]{64}$/i.test(fileHash) &&
      /^[a-f0-9]{64}$/i.test(source.fileHash) &&
      source.fileHash === fileHash
    );
    if (hashMatch) {
      const linkedEvent = profile.timeline.find(
        (ev) => ev.sourceFileId === source.driveFileId || ev.sourceFileName === source.fileName
      );

      return {
        existingSource: source,
        linkedEvent,
        isExactContentMatch: true,
        memberId: member?.id || profile.member.id,
        memberName: member?.name || profile.member.name,
      };
    }
  }

  return null;
}

/**
 * Kiểm tra xem tệp tin có bị tải nhầm vào hồ sơ thành viên khác trong gia đình không
 */
export function detectCrossMemberDuplicateFile(
  file: { name: string; size: number },
  fileHash: string,
  profiles: Record<string, HealthProfile>,
  currentMemberId: string
): FileDuplicateMatch | null {
  for (const [memberId, profile] of Object.entries(profiles)) {
    if (memberId === currentMemberId) continue;
    const match = detectDuplicateFile(file, fileHash, profile);
    if (match && match.isExactContentMatch) {
      return {
        ...match,
        memberId,
        memberName: profile.member.name,
      };
    }
  }
  return null;
}

/**
 * Kết quả phân tích trùng lặp sự kiện trong Timeline
 */
export interface EventDuplicateMatch {
  matchedEvent: HealthEvent;
  score: number;
  confidence: 'high' | 'medium';
  reasons: string[];
}

const CLINICAL_EPISODE_WINDOW_DAYS = 14;

function parseIsoDateMs(dateStr?: string): number | null {
  if (typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const utc = Date.UTC(year, month, day);
  return Number.isFinite(utc) ? utc : null;
}

function getIsoDateDayDiff(leftDate?: string, rightDate?: string): number | null {
  const leftMs = parseIsoDateMs(leftDate);
  const rightMs = parseIsoDateMs(rightDate);
  if (leftMs === null || rightMs === null) return null;
  return Math.round(Math.abs(leftMs - rightMs) / 86_400_000);
}

export function areFacilitiesCompatible(leftFacility?: string, rightFacility?: string): boolean {
  const left = removeVietnameseAccents(normalizeMedicalText(leftFacility || ''));
  const right = removeVietnameseAccents(normalizeMedicalText(rightFacility || ''));
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;

  const stopWords = new Set(['benh', 'vien', 'phong', 'kham', 'trung', 'tam', 'y', 'te', 'co', 'so', 'tnhh', 'tp', 'hcm', 'ha', 'noi', 'viet', 'nam']);
  const leftTokens = left.split(' ').filter((token) => token.length >= 2 && !stopWords.has(token));
  const rightTokens = new Set(right.split(' ').filter((token) => token.length >= 2 && !stopWords.has(token)));
  if (leftTokens.length === 0 || rightTokens.size === 0) return false;

  const sharedTokens = leftTokens.filter((token) => rightTokens.has(token));
  const minTokenCount = Math.min(leftTokens.length, rightTokens.size);
  return sharedTokens.length >= 2 && sharedTokens.length / minTokenCount >= 0.6;
}

function getEventTypeMergePriority(type?: HealthEvent['type']): number {
  switch (type) {
    case 'comprehensive_exam':
      return 5;
    case 'discharge':
      return 4;
    case 'medical_report':
      return 3;
    case 'prescription':
    case 'vaccination':
      return 2;
    case 'test_result':
    case 'imaging':
      return 1;
    default:
      return 0;
  }
}

function isMasterClinicalEventType(type?: HealthEvent['type']): boolean {
  return type === 'comprehensive_exam' || type === 'discharge' || type === 'medical_report';
}

function isSubReportEventType(type?: HealthEvent['type']): boolean {
  return type === 'test_result' || type === 'imaging';
}

function isComplementaryEpisodePair(leftType?: HealthEvent['type'], rightType?: HealthEvent['type']): boolean {
  return Boolean(
    (isMasterClinicalEventType(leftType) && isSubReportEventType(rightType)) ||
    (isMasterClinicalEventType(rightType) && isSubReportEventType(leftType)),
  );
}

function collectMetricSignatureSet(event: Partial<HealthEvent>): Set<string> {
  const metricSet = new Set<string>();
  for (const metric of event.metrics || []) {
    if (!metric || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
    const key = resolveCanonicalMetricKey(metric);
    if (!key) continue;
    metricSet.add(`metric:${key}:${Number(metric.value).toFixed(2)}`);
  }
  return metricSet;
}

/**
 * Phát hiện sự kiện y tế trùng lặp trong dòng thời gian
 */
export function detectDuplicateEvent(
  timeline: HealthEvent[],
  incoming: Partial<HealthEvent>,
  ignoreEventId?: string
): EventDuplicateMatch | null {
  if (!timeline || timeline.length === 0) return null;

  const incomingDate = typeof incoming.date === 'string' ? incoming.date.trim() : '';
  if (!incomingDate && !incoming.sourceFileId) return null;

  const incomingTitle = normalizeMedicalText(incoming.title || '');
  const incomingDiagnoses = (incoming.diagnoses || []).map(normalizeMedicalText);
  const incomingMedications = (incoming.medications || []).map((m) =>
    normalizeMedicationName(m.name)
  );
  const incomingMetrics = collectMetricSignatureSet(incoming);

  let bestMatch: EventDuplicateMatch | null = null;

  for (const event of timeline) {
    if (ignoreEventId && event.id === ignoreEventId) continue;

    let score = 0;
    const reasons: string[] = [];

    // 1. Kiểm tra cùng tệp nguồn (Source File Match) - luôn nhận diện dù ngày có khác nhau
    const sameSourceFile = Boolean(
      incoming.sourceFileId && event.sourceFileId && incoming.sourceFileId === event.sourceFileId
    );
    if (sameSourceFile) {
      score += 65;
      reasons.push('Trùng khớp tệp tài liệu gốc trên Google Drive');
    }

    const dayDiff = incomingDate ? getIsoDateDayDiff(event.date, incomingDate) : null;
    const sameDate = Boolean(incomingDate && event.date === incomingDate);
    const withinEpisodeWindow =
      !sameDate &&
      dayDiff !== null &&
      dayDiff > 0 &&
      dayDiff <= CLINICAL_EPISODE_WINDOW_DAYS;

    if (!sameDate && !withinEpisodeWindow && !sameSourceFile) {
      continue;
    }

    const facilityMatch = areFacilitiesCompatible(event.facility, incoming.facility);
    const containment = compareStructuredEventContainment(event, incoming);

    const eventMetrics = collectMetricSignatureSet(event);
    let sharedMetricCount = 0;
    for (const item of incomingMetrics) {
      if (eventMetrics.has(item)) sharedMetricCount += 1;
    }

    if (sameDate) {
      score += 40;
      reasons.push(`Cùng ngày khám (${incomingDate})`);
    } else if (withinEpisodeWindow) {
      const hasStrongEpisodeLink =
        containment !== 'none' ||
        (sharedMetricCount >= 4 && (facilityMatch || isComplementaryEpisodePair(event.type, incoming.type)));
      if (!hasStrongEpisodeLink && !sameSourceFile) {
        continue;
      }
      score += 30;
      reasons.push(`Cùng đợt khám trong ${dayDiff} ngày (${event.date} & ${incomingDate})`);
    }

    if (facilityMatch) {
      score += 25;
      reasons.push(`Cùng cơ sở y tế: "${event.facility}"`);
    }

    if (incoming.type && event.type) {
      if (incoming.type === event.type) {
        score += 15;
        reasons.push(`Cùng loại tài liệu (${event.type})`);
      } else if (isComplementaryEpisodePair(event.type, incoming.type)) {
        score += 20;
        reasons.push(`Tài liệu cận lâm sàng bổ trợ cho hồ sơ khám (${incoming.type} & ${event.type})`);
      }
    }

    if (sharedMetricCount >= 4) {
      score += 35;
      reasons.push(`Trùng ${sharedMetricCount} chỉ số xét nghiệm giống hệt giá trị`);
    } else if (sharedMetricCount >= 2) {
      score += 20;
      reasons.push(`Trùng ${sharedMetricCount} chỉ số xét nghiệm`);
    }

    // 5. Kiểm tra chẩn đoán trùng lặp (Diagnosis Overlap)
    if (incomingDiagnoses.length > 0 && event.diagnoses && event.diagnoses.length > 0) {
      const existingDiagSet = new Set(event.diagnoses.map(normalizeMedicalText));
      const overlappingDiags = incomingDiagnoses.filter((d) => existingDiagSet.has(d));
      if (overlappingDiags.length > 0) {
        score += Math.min(30, overlappingDiags.length * 15);
        reasons.push(`Trùng ${overlappingDiags.length} chẩn đoán`);
      }
    }

    // 6. Kiểm tra đơn thuốc trùng lặp (Medication Overlap)
    if (incomingMedications.length > 0 && event.medications && event.medications.length > 0) {
      const existingMedSet = new Set(event.medications.map((m) => normalizeMedicationName(m.name)));
      const overlappingMeds = incomingMedications.filter((m) => existingMedSet.has(m));
      if (overlappingMeds.length > 0) {
        score += Math.min(30, overlappingMeds.length * 10);
        reasons.push(`Trùng ${overlappingMeds.length} loại thuốc`);
      }
    }

    // 7. Tiêu đề tương tự (Title Similarity)
    if (incomingTitle && event.title) {
      const existingTitle = normalizeMedicalText(event.title);
      if (existingTitle === incomingTitle) {
        score += 20;
        reasons.push('Tiêu đề hồ sơ trùng khớp hoàn toàn');
      }
    }

    if (containment !== 'none' && score < 75) {
      score = 75;
      reasons.push('Nội dung y khoa được bao trùm hoặc tương đương');
    }

    // Đánh giá ngưỡng trùng lặp
    const isDifferentSourceFile = Boolean(
      incoming.sourceFileId &&
      event.sourceFileId &&
      incoming.sourceFileId !== event.sourceFileId
    );
    const requiredScore = isDifferentSourceFile ? 75 : 60;

    if (score >= requiredScore) {
      const confidence: 'high' | 'medium' = score >= 75 ? 'high' : 'medium';
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          matchedEvent: event,
          score,
          confidence,
          reasons,
        };
      }
    }
  }

  return bestMatch;
}

/**
 * Hợp nhất thông minh 2 sự kiện y tế trùng lặp thành một sự kiện toàn diện nhất
 */
export function mergeHealthEvents(
  existing: HealthEvent,
  incoming: HealthEvent,
  now = new Date().toISOString()
): HealthEvent {
  // Làm sạch cả 2 trước khi gộp
  const cleanExisting = cleanAndDeduplicateEventData(existing);
  const cleanIncoming = cleanAndDeduplicateEventData(incoming);

  // Chọn bản chính (Master dossier: comprehensive_exam > discharge > medical_report > test_result/imaging)
  const existingPriority = getEventTypeMergePriority(cleanExisting.type);
  const incomingPriority = getEventTypeMergePriority(cleanIncoming.type);
  const existingItemCount = collectStructuredClinicalItems(cleanExisting).size;
  const incomingItemCount = collectStructuredClinicalItems(cleanIncoming).size;
  const preferIncomingAsPrimary =
    incomingPriority > existingPriority ||
    (incomingPriority === existingPriority && incomingItemCount > existingItemCount);
  const primary = preferIncomingAsPrimary ? cleanIncoming : cleanExisting;
  const secondary = preferIncomingAsPrimary ? cleanExisting : cleanIncoming;

  // 1. Gộp chẩn đoán (không trùng lặp, chuẩn hóa chính tả y tế và mã ICD-10)
  const mergedDiagnoses = cleanAndDeduplicateDiagnoses([
    ...(primary.diagnoses || []),
    ...(secondary.diagnoses || []),
  ]);

  // 2. Gộp đơn thuốc (cập nhật hoặc bổ sung thuốc mới, giữ đầy đủ liều lượng, số lượng, cách dùng)
  const mergedMedications = cleanAndDeduplicateMedications([
    ...(primary.medications || []),
    ...(secondary.medications || []),
  ]);

  // 3. Gộp chỉ số đo (Metrics) - Chuẩn hóa key để không trùng tên biến thể
  const metricMap = new Map<string, HealthMetric>();
  for (const m of [...primary.metrics, ...secondary.metrics]) {
    const key = resolveCanonicalMetricKey(m);
    const current = metricMap.get(key);
    if (!current || (!current.refRange && m.refRange) || (!current.standardKey && m.standardKey)) {
      metricMap.set(key, {
        ...current,
        ...m,
        name: current?.name && current.name.length >= m.name.length ? current.name : m.name,
        standardKey: m.standardKey || current?.standardKey,
        refRange: m.refRange || current?.refRange,
      });
    }
  }

  // 4. Gộp kết quả chẩn đoán hình ảnh (Imaging Results: Siêu âm, X-quang, CT, MRI, ECG...)
  const imgMap = new Map<string, ImagingResult>();
  for (const img of [...(primary.imagingResults || []), ...(secondary.imagingResults || [])]) {
    const modality = img.modality?.trim() || '';
    const findings = img.findings?.trim() || '';
    const conclusion = img.conclusion?.trim() || '';
    if (!modality && !findings && !conclusion) continue;

    const key = normalizeModalityKey(modality);
    const current = imgMap.get(key);
    if (!current) {
      imgMap.set(key, {
        modality: modality || 'Chẩn đoán hình ảnh',
        findings: deduplicateAdviceText(findings) || findings,
        conclusion: deduplicateAdviceText(conclusion) || conclusion,
      });
    } else {
      let mergedFindings = current.findings || '';
      if (findings && findings !== mergedFindings) {
        if (!mergedFindings) mergedFindings = findings;
        else if (!mergedFindings.includes(findings) && !findings.includes(mergedFindings)) {
          mergedFindings = `${mergedFindings}; ${findings}`;
        } else if (findings.length > mergedFindings.length) {
          mergedFindings = findings;
        }
      }
      const mergedConclusion = conclusion.length > (current.conclusion || '').length ? conclusion : (current.conclusion || '');
      imgMap.set(key, {
        modality: current.modality || modality,
        findings: deduplicateAdviceText(mergedFindings) || mergedFindings,
        conclusion: deduplicateAdviceText(mergedConclusion) || mergedConclusion,
      });
    }
  }

  // 5. Gộp Khám thể lực (Physical Exam)
  const mergedPhysicalExam = primary.physicalExam || secondary.physicalExam
    ? {
        height_cm: primary.physicalExam?.height_cm ?? secondary.physicalExam?.height_cm,
        weight_kg: primary.physicalExam?.weight_kg ?? secondary.physicalExam?.weight_kg,
        bmi: primary.physicalExam?.bmi ?? secondary.physicalExam?.bmi,
        bp_mmHg: primary.physicalExam?.bp_mmHg || secondary.physicalExam?.bp_mmHg,
        pulse_bpm: primary.physicalExam?.pulse_bpm ?? secondary.physicalExam?.pulse_bpm,
        classification: primary.physicalExam?.classification || secondary.physicalExam?.classification,
      }
    : undefined;

  // 6. Lời dặn & Ghi chú (khử trùng lặp câu & mệnh đề thông minh)
  const combinedAdvice = [primary.advice, secondary.advice].filter(Boolean).join('. ');
  const mergedAdvice = deduplicateAdviceText(combinedAdvice);

  const rawNotes = [...(primary.notes?.split('\n') || []), ...(secondary.notes?.split('\n') || [])]
    .map((n) => n.trim())
    .filter((n) => n && !n.includes('Có dữ liệu được trích xuất'));
  const mergedNotes = deduplicateAdviceText(rawNotes.join('. '));

  // 7. Gộp danh sách các tệp nguồn liên kết (additionalSources)
  const primarySources = primary.additionalSources || (primary.sourceFileId ? [{ driveFileId: primary.sourceFileId, fileName: primary.sourceFileName }] : []);
  const secondarySources = secondary.additionalSources || (secondary.sourceFileId ? [{ driveFileId: secondary.sourceFileId, fileName: secondary.sourceFileName }] : []);

  const sourcesMap = new Map<string, { driveFileId: string; fileName: string }>();
  for (const s of [...primarySources, ...secondarySources]) {
    if (s.driveFileId && !sourcesMap.has(s.driveFileId)) {
      sourcesMap.set(s.driveFileId, s);
    }
  }
  const mergedSources = Array.from(sourcesMap.values());

  return cleanAndDeduplicateEventData({
    ...primary,
    id: cleanExisting.id,
    sourceFileId: primary.sourceFileId || secondary.sourceFileId,
    sourceFileName: primary.sourceFileName || secondary.sourceFileName,
    title: primary.title || secondary.title,
    date: primary.date || secondary.date,
    type: primary.type || secondary.type,
    facility: primary.facility || secondary.facility,
    doctorName: primary.doctorName || secondary.doctorName,
    additionalSources: mergedSources.length > 1 ? mergedSources : primary.additionalSources,
    physicalExam: mergedPhysicalExam,
    diagnoses: mergedDiagnoses,
    medications: mergedMedications,
    metrics: Array.from(metricMap.values()),
    imagingResults: Array.from(imgMap.values()),
    vaccinations: primary.vaccinations?.length ? primary.vaccinations : secondary.vaccinations,
    hospitalization: cleanHospitalizationRecord(primary.hospitalization) ||
      cleanHospitalizationRecord(secondary.hospitalization),
    advice: mergedAdvice,
    notes: mergedNotes,
    nextFollowUp: primary.nextFollowUp || secondary.nextFollowUp,
    patientName: primary.patientName || secondary.patientName,
    patientBirthDate: primary.patientBirthDate || secondary.patientBirthDate,
    patientGender: primary.patientGender || secondary.patientGender,
    recordedAt: now,
  });
}

export type StructuredEventContainment =
  | 'left_contains_right'
  | 'right_contains_left'
  | 'equivalent'
  | 'none';

function collectStructuredClinicalItems(event: Partial<HealthEvent>): Set<string> {
  const items = new Set<string>();
  for (const diag of event.diagnoses || []) {
    const norm = normalizeMedicalText(diag);
    if (norm) items.add(`diag:${norm}`);
  }
  for (const metric of event.metrics || []) {
    if (!metric || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
    const key = resolveCanonicalMetricKey(metric);
    if (!key) continue;
    items.add(`metric:${key}:${Number(metric.value).toFixed(2)}`);
  }
  for (const med of event.medications || []) {
    const key = canonicalizeMedicationKey(med.name) || normalizeMedicationName(med.name) || normalizeMedicalText(med.name);
    if (key) items.add(`med:${key}`);
  }
  for (const img of event.imagingResults || []) {
    const key = normalizeModalityKey(img.modality);
    if (key) items.add(`img:${key}`);
  }
  for (const vax of event.vaccinations || []) {
    const key = normalizeMedicalText(vax.vaccineName);
    if (key) items.add(`vax:${key}`);
  }
  return items;
}

export function compareStructuredEventContainment(
  leftEvent: Partial<HealthEvent>,
  rightEvent: Partial<HealthEvent>,
): StructuredEventContainment {
  const leftDate = typeof leftEvent.date === 'string' ? leftEvent.date.trim() : '';
  const rightDate = typeof rightEvent.date === 'string' ? rightEvent.date.trim() : '';
  const dayDiff = getIsoDateDayDiff(leftDate, rightDate);
  if (dayDiff === null || dayDiff > CLINICAL_EPISODE_WINDOW_DAYS) return 'none';

  const leftItems = collectStructuredClinicalItems(leftEvent);
  const rightItems = collectStructuredClinicalItems(rightEvent);
  if (leftItems.size === 0 || rightItems.size === 0) return 'none';

  const minSize = Math.min(leftItems.size, rightItems.size);
  const sameFacility = areFacilitiesCompatible(leftEvent.facility, rightEvent.facility);
  if (minSize < 2) {
    const leftTitle = normalizeMedicalText(leftEvent.title || '');
    const rightTitle = normalizeMedicalText(rightEvent.title || '');
    const sameContext =
      sameFacility ||
      (Boolean(leftTitle) && Boolean(rightTitle) && leftTitle === rightTitle);
    if (!sameContext) return 'none';
  }

  let shared = 0;
  for (const item of leftItems) {
    if (rightItems.has(item)) shared += 1;
  }

  const leftInRight = shared / leftItems.size;
  const rightInLeft = shared / rightItems.size;

  if (dayDiff === 0) {
    if (leftInRight >= 0.9 && rightInLeft >= 0.9) return 'equivalent';
    if (leftInRight >= 0.9 && rightInLeft < 0.9) return 'right_contains_left';
    if (rightInLeft >= 0.9 && leftInRight < 0.9) return 'left_contains_right';
    return 'none';
  }

  // Khác ngày trong cùng đợt khám (<= 14 ngày): kiểm tra chặt theo chỉ số định lượng trùng & cơ sở y tế / vai trò hồ sơ
  const leftMetricItems = collectMetricSignatureSet(leftEvent);
  const rightMetricItems = collectMetricSignatureSet(rightEvent);
  let sharedMetrics = 0;
  for (const item of leftMetricItems) {
    if (rightMetricItems.has(item)) sharedMetrics += 1;
  }
  const leftMetricsInRight = leftMetricItems.size > 0 ? sharedMetrics / leftMetricItems.size : 0;
  const rightMetricsInLeft = rightMetricItems.size > 0 ? sharedMetrics / rightMetricItems.size : 0;

  const hasStrongEvidence =
    sharedMetrics >= 4 ||
    (sameFacility && shared >= 3);
  if (!hasStrongEvidence) return 'none';

  const leftMaster = isMasterClinicalEventType(leftEvent.type);
  const rightMaster = isMasterClinicalEventType(rightEvent.type);
  const leftContainedByRight =
    leftInRight >= 0.85 ||
    (sharedMetrics >= 4 && leftMetricsInRight >= 0.85 && rightItems.size >= leftItems.size);
  const rightContainedByLeft =
    rightInLeft >= 0.85 ||
    (sharedMetrics >= 4 && rightMetricsInLeft >= 0.85 && leftItems.size >= rightItems.size);

  if (
    leftContainedByRight &&
    rightContainedByLeft &&
    (sameFacility || sharedMetrics >= 6) &&
    leftInRight >= 0.9 &&
    rightInLeft >= 0.9
  ) {
    return 'equivalent';
  }
  if (
    leftContainedByRight &&
    (!rightContainedByLeft || (!leftMaster && rightMaster) || rightItems.size > leftItems.size)
  ) {
    return 'right_contains_left';
  }
  if (
    rightContainedByLeft &&
    (!leftContainedByRight || (leftMaster && !rightMaster) || leftItems.size > rightItems.size)
  ) {
    return 'left_contains_right';
  }

  return 'none';
}

export function consolidateTimelineEvents(timeline: HealthEvent[]): {
  timeline: HealthEvent[];
  mergedCount: number;
} {
  if (!timeline || timeline.length <= 1) {
    return { timeline: timeline ? timeline.map(cleanAndDeduplicateEventData) : [], mergedCount: 0 };
  }

  const prioritizedTimeline = [...timeline].sort(
    (left, right) =>
      getEventTypeMergePriority(right.type) - getEventTypeMergePriority(left.type) ||
      right.date.localeCompare(left.date) ||
      left.recordedAt.localeCompare(right.recordedAt),
  );

  const consolidated: HealthEvent[] = [];
  let mergedCount = 0;

  for (const event of prioritizedTimeline) {
    const duplicate = detectDuplicateEvent(consolidated, event);
    const matchIndex = duplicate
      ? consolidated.findIndex((item) => item.id === duplicate.matchedEvent.id)
      : consolidated.findIndex((item) => {
          if (compareStructuredEventContainment(item, event) !== 'none') return true;
          if (item.date !== event.date || !areFacilitiesCompatible(item.facility, event.facility)) {
            return false;
          }
          const leftDiags = [...(item.diagnoses || [])].map(normalizeMedicalText).filter(Boolean).sort();
          const rightDiags = [...(event.diagnoses || [])].map(normalizeMedicalText).filter(Boolean).sort();
          if (leftDiags.length > 0 && leftDiags.length === rightDiags.length) {
            return leftDiags.every((diag, idx) => diag === rightDiags[idx]);
          }
          return Boolean(
            item.title &&
              event.title &&
              normalizeMedicalText(item.title) === normalizeMedicalText(event.title),
          );
        });

    if (matchIndex === -1) {
      consolidated.push(cleanAndDeduplicateEventData(event));
    } else {
      consolidated[matchIndex] = cleanAndDeduplicateEventData(mergeHealthEvents(consolidated[matchIndex], event));
      mergedCount += 1;
    }
  }

  consolidated.sort(
    (left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt),
  );

  return { timeline: consolidated, mergedCount };
}
