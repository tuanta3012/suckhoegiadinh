type JsonRecord = Record<string, unknown>;

export interface ExtractedPageBatch {
  firstPage: number;
  lastPage: number;
  extracted: JsonRecord;
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
    result.medications = Array.from(medications.values());
  }

  if (Array.isArray(result.metrics)) {
    const metrics = new Map<string, JsonRecord>();
    for (const metric of result.metrics) {
      if (!isRecord(metric) || typeof metric.name !== 'string' || !metric.name.trim()) continue;
      metrics.set(metric.name.trim().toLowerCase(), metric);
    }
    result.metrics = Array.from(metrics.values());
  }

  return result;
}

export function mergeExtractedBatches(batches: ExtractedPageBatch[]): JsonRecord {
  const values = batches.map(({ extracted }) => cleanExtractedJson(extracted));
  const merged: JsonRecord = {};
  for (const key of [
    'title',
    'date',
    'type',
    'patientName',
    'patientBirthDate',
    'patientGender',
    'facility',
    'nextFollowUp',
  ]) {
    const entry = values.find((value) => typeof value[key] === 'string' && Boolean((value[key] as string).trim()));
    if (entry) merged[key] = entry[key];
  }

  merged.diagnoses = values.flatMap((value) => Array.isArray(value.diagnoses) ? value.diagnoses : []);
  merged.medications = values.flatMap((value) => Array.isArray(value.medications) ? value.medications : []);
  merged.metrics = values.flatMap((value) => Array.isArray(value.metrics) ? value.metrics : []);

  const notes = batches.map(({ firstPage, lastPage }, index) => {
    const note = typeof values[index].notes === 'string' ? values[index].notes.trim() : '';
    const hasExtractedData = Object.entries(values[index]).some(([key, item]) => {
      if (key === 'notes') return false;
      if (Array.isArray(item)) return item.length > 0;
      return typeof item === 'string' ? Boolean(item.trim()) : item !== undefined && item !== null;
    });
    return note || hasExtractedData
      ? `Trang ${firstPage}-${lastPage}: ${note || 'Có dữ liệu được trích xuất trong phần này.'}`
      : '';
  }).filter(Boolean);
  if (notes.length) merged.notes = notes.join('\n');

  const advice = Array.from(new Set(values
    .map((value) => value.advice)
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim())));
  if (advice.length) merged.advice = advice.join('\n');
  return cleanExtractedJson(merged);
}
