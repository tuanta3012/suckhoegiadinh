type JsonRecord = Record<string, unknown>;

export interface ExtractedPageBatch {
  firstPage: number;
  lastPage: number;
  extracted: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStandardKey(name: string): string {
  const clean = name.trim().toLowerCase();
  if (/acid\s*uric|uric\s*acid|axit\s*uric/.test(clean)) return 'ACID_URIC';
  if (/hba1c|hb\s*a1c/.test(clean)) return 'HbA1c';
  if (/glucose|đường\s*huyết|duong\s*huyet|\bglu\b/.test(clean)) return 'GLUCOSE';
  if (/creatinin|creatinine|\bcre\b/.test(clean)) return 'CREATININ';
  if (/egfr|\bgfr\b|lọc\s*cầu\s*thận/.test(clean)) return 'EGFR';
  if (/wbc|bạch\s*cầu|bach\s*cau/.test(clean)) return 'WBC';
  if (/rbc|hồng\s*cầu|hong\s*cau/.test(clean)) return 'RBC';
  if (/hgb|\bhb\b|hemoglobin/.test(clean)) return 'HGB';
  if (/hct|hematocrit/.test(clean)) return 'HCT';
  if (/mcv/.test(clean)) return 'MCV';
  if (/mchc/.test(clean)) return 'MCHC';
  if (/mch/.test(clean)) return 'MCH';
  if (/plt|tiểu\s*cầu|tieu\s*cau/.test(clean)) return 'PLT';
  if (/triglycerid|triglyceride|\btri\b/.test(clean)) return 'TRIGLYCERID';
  if (/cholesterol/.test(clean)) return 'CHOLESTEROL';
  if (/hdl/.test(clean)) return 'HDL';
  if (/ldl/.test(clean)) return 'LDL';
  if (/ast|sgot|\bgot\b/.test(clean)) return 'AST';
  if (/alt|sgpt|\bgpt\b/.test(clean)) return 'ALT';
  if (/ggt/.test(clean)) return 'GGT';
  if (/ure|urea/.test(clean)) return 'URE';
  if (/đạm\s*niệu|protein\s*niệu|proteinuria/.test(clean)) return 'PROTEIN_URINE';
  if (/sys|huyết\s*áp\s*tâm\s*thu/.test(clean)) return 'BLOOD_PRESSURE_SYS';
  if (/dia|huyết\s*áp\s*tâm\s*trương/.test(clean)) return 'BLOOD_PRESSURE_DIA';
  if (/spo2/.test(clean)) return 'SPO2';
  if (/weight|cân\s*nặng/.test(clean)) return 'WEIGHT';
  if (/height|chiều\s*cao/.test(clean)) return 'HEIGHT';
  return name.trim().toUpperCase().replace(/\s+/g, '_');
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
      const name = metric.name.trim();
      const standardKey = typeof metric.standardKey === 'string' && metric.standardKey.trim()
        ? metric.standardKey.trim()
        : normalizeStandardKey(name);
      const cleanedMetric: JsonRecord = {
        ...metric,
        name,
        standardKey,
      };
      if (typeof metric.status === 'string') {
        cleanedMetric.status = metric.status.trim();
      }
      metrics.set(standardKey.toLowerCase(), cleanedMetric);
    }
    result.metrics = Array.from(metrics.values());
  }

  if (Array.isArray(result.imagingResults)) {
    const imagingList: JsonRecord[] = [];
    const seen = new Set<string>();
    for (const item of result.imagingResults) {
      if (!isRecord(item)) continue;
      const modality = typeof item.modality === 'string' ? item.modality.trim() : '';
      const findings = typeof item.findings === 'string' ? item.findings.trim() : '';
      const conclusion = typeof item.conclusion === 'string' ? item.conclusion.trim() : '';
      if (!modality && !findings && !conclusion) continue;
      const key = `${modality.toLowerCase()}_${conclusion.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      imagingList.push({ modality, findings, conclusion });
    }
    result.imagingResults = imagingList;
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
  merged.imagingResults = values.flatMap((value) => Array.isArray(value.imagingResults) ? value.imagingResults : []);

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

