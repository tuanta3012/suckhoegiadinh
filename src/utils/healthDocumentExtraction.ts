import { normalizeModalityKey } from './deduplicationService';
import { standardizeMetricKey } from './healthRecordService';
import { classifyHealthEventType } from './healthEventType';
import {
  extractPatientNameFallbackFromText,
  isRecognizablePatientName,
  sanitizeOcrPatientName,
} from './ocrSubjectRouting';
import { normalizeVietnamese } from './formatters';

type JsonRecord = Record<string, unknown>;

export interface ExtractedPageBatch {
  firstPage: number;
  lastPage: number;
  extracted: JsonRecord;
  modelUsed?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}



export function cleanExtractedJson(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error('Phản hồi Gemini không phải một JSON object.');
  const result = { ...value };

  if (Array.isArray(result.diagnoses)) {
    const seen = new Set<string>();
    result.diagnoses = result.diagnoses.filter((diagnosis): diagnosis is string => {
      if (typeof diagnosis !== 'string') return false;
      const normalized = diagnosis.trim().toLowerCase().replace(/[.,;]$/, '');
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  if (Array.isArray(result.medications)) {
    const medications = new Map<string, JsonRecord>();
    for (const medication of result.medications) {
      if (!isRecord(medication) || typeof medication.name !== 'string' || !medication.name.trim()) continue;
      const key = medication.name
        .trim()
        .toLowerCase()
        .replace(/\b\d+(\.\d+)?\s*(mg|g|mcg|ml|l|iu|ui|viên|ống|gói|chai)\b/gi, '')
        .trim();
      const existing = medications.get(key);
      medications.set(key, existing
        ? {
            ...existing,
            name: existing.name && (existing.name as string).length >= medication.name.length
              ? existing.name
              : medication.name,
            dosage: existing.dosage || medication.dosage,
            frequency: existing.frequency || medication.frequency,
            duration: existing.duration || medication.duration,
          }
        : medication);
    }
    result.medications = Array.from(medications.values()).map((m) => ({
      name: m.name,
      dosage: typeof m.dosage === 'string' ? m.dosage.trim() : undefined,
      quantity: typeof m.quantity === 'string' ? m.quantity.trim() : undefined,
      frequency: typeof m.frequency === 'string' ? m.frequency.trim() : undefined,
      timing: typeof m.timing === 'string' ? m.timing.trim() : undefined,
      duration: typeof m.duration === 'string' ? m.duration.trim() : undefined,
      instructions: typeof m.instructions === 'string' ? m.instructions.trim() : undefined,
    }));
  }


  if (Array.isArray(result.metrics)) {
    const metrics = new Map<string, JsonRecord>();
    for (const metric of result.metrics) {
      if (!isRecord(metric) || typeof metric.name !== 'string' || !metric.name.trim()) continue;
      const name = metric.name.trim();
      const rawKey = typeof metric.standardKey === 'string' && metric.standardKey.trim()
          ? metric.standardKey
          : name;
      
      const standardKey = standardizeMetricKey(rawKey, String(metric.unit || ''), name);

      const cleanedMetric: JsonRecord = {
        ...metric,
        name,
        standardKey,
      };
      if (typeof metric.status === 'string') {
        cleanedMetric.status = metric.status.trim();
      }
      if (typeof metric.refRange === 'string') {
        cleanedMetric.refRange = metric.refRange.trim();
      }
      const identity = standardKey.toUpperCase();
      const existing = metrics.get(identity);
      if (!existing || (!existing.refRange && cleanedMetric.refRange)) {
        metrics.set(identity, cleanedMetric);
      }
    }
    result.metrics = Array.from(metrics.values());
  }

  if (isRecord(result.physicalExam)) {
    result.physicalExam = {
      height_cm: typeof result.physicalExam.height_cm === 'number' ? result.physicalExam.height_cm : undefined,
      weight_kg: typeof result.physicalExam.weight_kg === 'number' ? result.physicalExam.weight_kg : undefined,
      bmi: typeof result.physicalExam.bmi === 'number' ? result.physicalExam.bmi : undefined,
      bp_mmHg: typeof result.physicalExam.bp_mmHg === 'string' ? result.physicalExam.bp_mmHg.trim() : undefined,
      pulse_bpm: typeof result.physicalExam.pulse_bpm === 'number' ? result.physicalExam.pulse_bpm : undefined,
      classification: typeof result.physicalExam.classification === 'string' ? result.physicalExam.classification.trim() : undefined,
    };
  }

  if (Array.isArray(result.imagingResults)) {
    const imagingMap = new Map<string, JsonRecord>();
    for (const item of result.imagingResults) {
      if (!isRecord(item)) continue;
      const modality = typeof item.modality === 'string' ? item.modality.trim() : '';
      const findings = typeof item.findings === 'string' ? item.findings.trim() : '';
      const conclusion = typeof item.conclusion === 'string' ? item.conclusion.trim() : '';
      if (!modality && !findings && !conclusion) continue;

      const normModality = normalizeModalityKey(modality);
      const existing = imagingMap.get(normModality);
      if (!existing) {
        imagingMap.set(normModality, { modality: modality || 'Chẩn đoán hình ảnh', findings, conclusion });
      } else {
        const prevFindings = typeof existing.findings === 'string' ? existing.findings : '';
        let mergedFindings = prevFindings;
        if (findings && findings !== prevFindings) {
          if (!prevFindings) mergedFindings = findings;
          else if (!prevFindings.includes(findings) && !findings.includes(prevFindings)) {
            mergedFindings = `${prevFindings}; ${findings}`;
          } else if (findings.length > prevFindings.length) {
            mergedFindings = findings;
          }
        }
        const prevConclusion = typeof existing.conclusion === 'string' ? existing.conclusion : '';
        const mergedConclusion = conclusion.length > prevConclusion.length ? conclusion : prevConclusion;

        imagingMap.set(normModality, {
          modality: (existing.modality as string) || modality,
          findings: mergedFindings,
          conclusion: mergedConclusion,
        });
      }
    }
    result.imagingResults = Array.from(imagingMap.values());
  }

  if (Array.isArray(result.vaccinations)) {
    const vaxList: JsonRecord[] = [];
    const seen = new Set<string>();
    for (const item of result.vaccinations) {
      if (!isRecord(item) || typeof item.vaccineName !== 'string' || !item.vaccineName.trim()) continue;
      const vaccineName = item.vaccineName.trim();
      const administeredDate = typeof item.administeredDate === 'string' ? item.administeredDate.trim() : '';
      const key = `${vaccineName.toLowerCase()}_${administeredDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      vaxList.push({
        vaccineName,
        targetDisease: typeof item.targetDisease === 'string' ? item.targetDisease.trim() : undefined,
        doseNumber: item.doseNumber !== undefined ? String(item.doseNumber) : undefined,
        lotNumber: typeof item.lotNumber === 'string' ? item.lotNumber.trim() : undefined,
        manufacturer: typeof item.manufacturer === 'string' ? item.manufacturer.trim() : undefined,
        injectionSite: typeof item.injectionSite === 'string' ? item.injectionSite.trim() : undefined,
        administeredDate: administeredDate || new Date().toISOString().slice(0, 10),
        nextDoseDate: typeof item.nextDoseDate === 'string' && item.nextDoseDate.trim() ? item.nextDoseDate.trim() : null,
        reactionNotes: typeof item.reactionNotes === 'string' ? item.reactionNotes.trim() : undefined,
      });
    }
    result.vaccinations = vaxList;
  }

  if (isRecord(result.hospitalization)) {
    result.hospitalization = {
      admissionDate: typeof result.hospitalization.admissionDate === 'string' ? result.hospitalization.admissionDate.trim() : undefined,
      dischargeDate: typeof result.hospitalization.dischargeDate === 'string' ? result.hospitalization.dischargeDate.trim() : undefined,
      department: typeof result.hospitalization.department === 'string' ? result.hospitalization.department.trim() : undefined,
      treatmentSummary: typeof result.hospitalization.treatmentSummary === 'string' ? result.hospitalization.treatmentSummary.trim() : undefined,
      surgicalNotes: typeof result.hospitalization.surgicalNotes === 'string' ? result.hospitalization.surgicalNotes.trim() : undefined,
    };
  }

  if (isRecord(result.extractedData)) {
    result.extractedData = { ...result.extractedData };
  }

  if (typeof result.doctorName === 'string') {
    result.doctorName = result.doctorName.trim();
  }
  if (typeof result.customCategory === 'string') {
    result.customCategory = result.customCategory.trim();
  }

  return result;
}

/**
 * Thuật toán chọn ngày sự kiện dựa trên phân tích tần suất (Frequency-based Date Voting / Consensus)
 * Giúp chọn chính xác ngày khám thực tế ngay cả khi trang bìa in sai niên độ hoặc có ngày in trôi nổi.
 */
export function resolveConsensusDate(
  values: JsonRecord[],
  patientBirthDate?: string,
  preferredYear?: string
): string | undefined {
  const dateCounts = new Map<string, number>();
  const yearCounts = new Map<string, number>();

  const normalizeDateStr = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    const dmy = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) {
      const d = dmy[1].padStart(2, '0');
      const m = dmy[2].padStart(2, '0');
      const y = dmy[3];
      return `${y}-${m}-${d}`;
    }
    const ymd = trimmed.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (ymd) {
      const y = ymd[1];
      const m = ymd[2].padStart(2, '0');
      const d = ymd[3].padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
    return null;
  };

  const addCandidate = (dateStr: unknown, weight = 1) => {
    if (typeof dateStr !== 'string') return;
    const normalized = normalizeDateStr(dateStr);
    if (!normalized) return;

    if (patientBirthDate && normalized === patientBirthDate) {
      return;
    }

    const y = parseInt(normalized.substring(0, 4), 10);
    const currentYear = new Date().getFullYear();
    if (y < 1990 || y > currentYear + 1) return;

    dateCounts.set(normalized, (dateCounts.get(normalized) || 0) + weight);
    const yearStr = normalized.substring(0, 4);
    yearCounts.set(yearStr, (yearCounts.get(yearStr) || 0) + weight);
  };

  for (const v of values) {
    if (v.date) addCandidate(v.date, 4);
    if (isRecord(v.hospitalization)) {
      if (v.hospitalization.admissionDate) addCandidate(v.hospitalization.admissionDate, 3);
      if (v.hospitalization.dischargeDate) addCandidate(v.hospitalization.dischargeDate, 3);
    }
    if (Array.isArray(v.vaccinations)) {
      for (const item of v.vaccinations) {
        if (isRecord(item) && item.administeredDate) addCandidate(item.administeredDate, 3);
      }
    }
    
    const textToScan = JSON.stringify(v);
    
    // Scans standard numeric dates (DD/MM/YYYY or YYYY-MM-DD)
    const dateMatches = textToScan.matchAll(/\b(\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2})\b/g);
    for (const match of dateMatches) {
      addCandidate(match[1], 1);
    }
    const isoMatches = textToScan.matchAll(/\b((?:19|20)\d{2}[/-]\d{1,2}[/-]\d{1,2})\b/g);
    for (const match of isoMatches) {
      addCandidate(match[1], 1);
    }
    
    // Scans Vietnamese textual dates (e.g. "ngày 22 tháng 05 năm 2024")
    const vnTextMatches = textToScan.matchAll(/ng[àa]y\s+(\d{1,2})\s+th[áa]ng\s+(\d{1,2})\s+n[ăa]m\s+((?:19|20)\d{2})/gi);
    for (const match of vnTextMatches) {
      const d = match[1].padStart(2, '0');
      const m = match[2].padStart(2, '0');
      const y = match[3];
      addCandidate(`${y}-${m}-${d}`, 2);
    }
  }

  if (dateCounts.size === 0) return undefined;

  let bestYear = preferredYear;
  if (!bestYear) {
    let maxYearWeight = -1;
    for (const [year, weight] of yearCounts.entries()) {
      if (weight > maxYearWeight) {
        maxYearWeight = weight;
        bestYear = year;
      }
    }
  }

  let bestDate: string | undefined;
  let maxWeight = -1;

  for (const [date, weight] of dateCounts.entries()) {
    let effectiveWeight = weight;
    if (bestYear && date.startsWith(bestYear)) {
      effectiveWeight += 10;
    }
    if (effectiveWeight > maxWeight) {
      maxWeight = effectiveWeight;
      bestDate = date;
    }
  }

  return bestDate;
}

function isPlaceholderFieldValue(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const normalized = normalizeVietnamese(trimmed);
  return (
    !normalized ||
    ['na', 'n a', 'unknown', 'khong ro', 'chua ro', 'khong co', 'null', 'undefined'].includes(normalized)
  );
}

function resolveConsensusPatientName(values: JsonRecord[]): string | undefined {
  const counts = new Map<string, { count: number; bestDisplay: string }>();
  for (const value of values) {
    if (typeof value.patientName !== 'string') continue;
    if (!isRecognizablePatientName(value.patientName)) continue;
    const sanitized = sanitizeOcrPatientName(value.patientName);
    const key = normalizeVietnamese(sanitized);
    if (!key) continue;
    const existing = counts.get(key);
    if (!existing) {
      counts.set(key, { count: 1, bestDisplay: sanitized });
    } else {
      existing.count += 1;
      // Prefer properly accented / longer Vietnamese display form
      if (sanitized.length > existing.bestDisplay.length || (/[À-ỹ]/.test(sanitized) && !/[À-ỹ]/.test(existing.bestDisplay))) {
        existing.bestDisplay = sanitized;
      }
    }
  }
  let best: { count: number; bestDisplay: string } | undefined;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }
  return best?.bestDisplay;
}

export function mergeExtractedBatches(
  batches: ExtractedPageBatch[],
  preferredYear?: string,
  fileName?: string,
): JsonRecord {
  const values = batches.map(({ extracted }) => cleanExtractedJson(extracted));
  const merged: JsonRecord = {};
  const contentPages: string[] = [];
  const rawCollectedPageTexts: string[] = [];
  let contentIndexComplete = batches.length > 0;
  for (const [index, batch] of batches.entries()) {
    const extractedPages = values[index].pageTexts;
    if (Array.isArray(extractedPages)) {
      for (const page of extractedPages) {
        if (typeof page === 'string' && page.trim()) rawCollectedPageTexts.push(page.trim());
      }
    }
    const expectedPages = batch.lastPage - batch.firstPage + 1;
    if (
      !Array.isArray(extractedPages) ||
      extractedPages.length !== expectedPages ||
      extractedPages.some((page) => typeof page !== 'string' || !page.trim())
    ) {
      contentIndexComplete = false;
      continue;
    }
    contentPages.push(...extractedPages.map((page) => (page as string).trim()));
  }
  merged.contentIndexPages = contentIndexComplete ? contentPages : [];
  merged.contentIndexComplete = contentIndexComplete;
  for (const key of [
    'title',
    'type',
    'patientBirthDate',
    'patientGender',
    'facility',
    'doctorName',
    'customCategory',
    'nextFollowUp',
  ]) {
    const entry = values.find((value) => !isPlaceholderFieldValue(value[key]));
    if (entry) merged[key] = entry[key];
  }

  const consensusPatientName = resolveConsensusPatientName(values);
  if (consensusPatientName) {
    merged.patientName = consensusPatientName;
  }

  const patientBirthDate = merged.patientBirthDate as string | undefined;
  const consensusDate = resolveConsensusDate(values, patientBirthDate, preferredYear);
  if (consensusDate) {
    merged.date = consensusDate;
  } else {
    const fallbackDateEntry = values.find((value) => typeof value.date === 'string' && Boolean((value.date as string).trim()));
    if (fallbackDateEntry) merged.date = fallbackDateEntry.date;
  }

  const physEntry = values.find((value) => isRecord(value.physicalExam) && Object.keys(value.physicalExam).length > 0);
  if (physEntry) merged.physicalExam = physEntry.physicalExam;

  const hospEntry = values.find((value) => isRecord(value.hospitalization) && Object.keys(value.hospitalization).length > 0);
  if (hospEntry) merged.hospitalization = hospEntry.hospitalization;

  merged.diagnoses = values.flatMap((value) => Array.isArray(value.diagnoses) ? value.diagnoses : []);
  merged.medications = values.flatMap((value) => Array.isArray(value.medications) ? value.medications : []);
  merged.metrics = values.flatMap((value) => Array.isArray(value.metrics) ? value.metrics : []);
  merged.imagingResults = values.flatMap((value) => Array.isArray(value.imagingResults) ? value.imagingResults : []);
  merged.vaccinations = values.flatMap((value) => Array.isArray(value.vaccinations) ? value.vaccinations : []);

  const mergedExtractedData: JsonRecord = {};
  for (const val of values) {
    if (isRecord(val.extractedData)) {
      Object.assign(mergedExtractedData, val.extractedData);
    }
  }
  if (Object.keys(mergedExtractedData).length > 0) {
    merged.extractedData = mergedExtractedData;
  }

  const notes = batches.map((_batch, index) => {
    const note = typeof values[index].notes === 'string' ? values[index].notes.trim() : '';
    return note && !note.includes('Có dữ liệu được trích xuất') ? note : '';
  }).filter(Boolean);
  if (notes.length) merged.notes = Array.from(new Set(notes)).join('\n');

  const advice = Array.from(new Set(values
    .map((value) => value.advice)
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())));
  if (advice.length) merged.advice = advice.join('\n');

  if (!merged.patientName) {
    const fallbackPatientName = extractPatientNameFallbackFromText(merged, rawCollectedPageTexts);
    if (fallbackPatientName) {
      merged.patientName = fallbackPatientName;
    }
  }

  const cleaned = cleanExtractedJson(merged);
  const classifiedType = classifyHealthEventType(cleaned, fileName);
  if (classifiedType) cleaned.type = classifiedType;
  return cleaned;
}
