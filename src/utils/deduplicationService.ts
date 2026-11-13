import type {
  FamilyMember,
  HealthEvent,
  HealthMetric,
  HealthProfile,
  HealthSource,
  ImagingResult,
  Medication,
} from '../types';

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
  const normalized = normalizeMedicalText(name);
  // Loại bỏ các hậu tố liều thông dụng như 5mg, 500mg, 10ml, 1g... để so sánh tên hoạt chất/biệt dược
  return normalized
    .replace(/\b\d+(\.\d+)?\s*(mg|g|mcg|ml|l|iu|ui|viên|ống|gói|chai)\b/gi, '')
    .trim();
}

/**
 * Bỏ dấu tiếng Việt để so sánh chuỗi regex mạnh mẽ hơn
 */
export function removeVietnameseAccents(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
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

/**
 * Khử trùng lặp nội dung BÊN TRONG của một sự kiện y tế (diagnoses, medications, metrics)
 */
export function cleanAndDeduplicateEventData<T extends Partial<HealthEvent>>(event: T): T {
  // 1. Khử trùng lặp Chẩn đoán (Diagnoses)
  let cleanedDiagnoses: string[] | undefined = undefined;
  if (Array.isArray(event.diagnoses)) {
    const seen = new Set<string>();
    cleanedDiagnoses = [];
    for (const d of event.diagnoses) {
      const trimmed = d.trim().replace(/^[-*•+]\s*/, '').replace(/[.,;]$/, '');
      if (!trimmed) continue;
      const normalized = normalizeMedicalText(trimmed);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        cleanedDiagnoses.push(trimmed);
      }
    }
  }

  // 2. Khử trùng lặp Đơn thuốc (Medications)
  let cleanedMedications: Medication[] | undefined = undefined;
  if (Array.isArray(event.medications)) {
    const medMap = new Map<string, Medication>();
    for (const med of event.medications) {
      const name = med.name?.trim();
      if (!name) continue;
      const key = normalizeMedicationName(name) || normalizeMedicalText(name);
      const existing = medMap.get(key);
      if (!existing) {
        medMap.set(key, { ...med, name });
      } else {
        medMap.set(key, {
          name: existing.name.length >= name.length ? existing.name : name,
          dosage: existing.dosage || med.dosage,
          frequency: existing.frequency || med.frequency,
          duration: existing.duration || med.duration,
        });
      }
    }
    cleanedMedications = Array.from(medMap.values());
  }

  // 3. Khử trùng lặp Chỉ số đo (Metrics)
  let cleanedMetrics: HealthMetric[] | undefined = undefined;
  if (Array.isArray(event.metrics)) {
    const metricMap = new Map<string, HealthMetric>();
    for (const m of event.metrics) {
      const name = m.name?.trim() || '';
      if (!name || typeof m.value !== 'number' || !Number.isFinite(m.value)) continue;

      let stdKey = m.standardKey ? m.standardKey.trim().toUpperCase() : undefined;
      
      // Sanitization: Fix common OCR mapping errors
      if (stdKey) {
        // 1. Fix accidental suffixes (e.g., NEU_1 -> NEU_#, LYM_# -> LYM_#)
        stdKey = stdKey.replace(/_(\d|#)$/, '_#').replace(/_$/, '');
        if (stdKey === 'NEU' || stdKey === 'LYM' || stdKey === 'MONO' || stdKey === 'EOS' || stdKey === 'BASO') {
          // If it was just 'NEU', usually it means NEU_PCT or NEU_# depending on unit
          // But for now just leave it or map to a base key
        }

        // 2. Fix Urine vs Blood collisions
        const isUrine = name.toLowerCase().includes('nước tiểu') || name.toLowerCase().includes('cặn lắng');
        if (isUrine) {
          if (stdKey === 'AST' && name.toLowerCase().includes('trụ')) stdKey = undefined; // 'Trụ' is not AST
          if (stdKey === 'WBC') stdKey = 'URINE_LEU';
          if (stdKey === 'RBC') stdKey = 'URINE_RBC_SED';
        }
      }

      const key = stdKey || normalizeMetricName(name);
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
        imgMap.set(key, { modality: modality || 'Chẩn đoán hình ảnh', findings, conclusion });
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
          findings: mergedFindings,
          conclusion: mergedConclusion,
        });
      }
    }
    cleanedImagingResults = Array.from(imgMap.values());
  }

  return {
    ...event,
    diagnoses: cleanedDiagnoses ?? event.diagnoses,
    medications: cleanedMedications ?? event.medications,
    metrics: cleanedMetrics ?? event.metrics,
    imagingResults: cleanedImagingResults ?? event.imagingResults,
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

/**
 * Phát hiện sự kiện y tế trùng lặp trong dòng thời gian
 */
export function detectDuplicateEvent(
  timeline: HealthEvent[],
  incoming: Partial<HealthEvent>,
  ignoreEventId?: string
): EventDuplicateMatch | null {
  if (!timeline || timeline.length === 0 || !incoming.date) return null;

  const incomingDate = incoming.date.trim();
  const incomingFacility = normalizeMedicalText(incoming.facility || '');
  const incomingTitle = normalizeMedicalText(incoming.title || '');
  const incomingDiagnoses = (incoming.diagnoses || []).map(normalizeMedicalText);
  const incomingMedications = (incoming.medications || []).map((m) =>
    normalizeMedicationName(m.name)
  );

  let bestMatch: EventDuplicateMatch | null = null;

  for (const event of timeline) {
    if (ignoreEventId && event.id === ignoreEventId) continue;

    let score = 0;
    const reasons: string[] = [];

    // 1. Kiểm tra cùng tệp nguồn (Source File Match)
    if (incoming.sourceFileId && event.sourceFileId && incoming.sourceFileId === event.sourceFileId) {
      score += 65;
      reasons.push('Trùng khớp tệp tài liệu gốc trên Google Drive');
    }

    // 2. Kiểm tra ngày khám (Date Match)
    if (event.date === incomingDate) {
      score += 40;
      reasons.push(`Cùng ngày khám (${incomingDate})`);

      // 3. Cùng cơ sở y tế (Facility Match)
      if (incomingFacility && event.facility) {
        const existingFacility = normalizeMedicalText(event.facility);
        if (
          existingFacility === incomingFacility ||
          existingFacility.includes(incomingFacility) ||
          incomingFacility.includes(existingFacility)
        ) {
          score += 25;
          reasons.push(`Cùng cơ sở y tế: "${event.facility}"`);
        }
      }

      // 4. Cùng loại hồ sơ (Type Match) hoặc loại bổ trợ (VD: khám tổng quát + xét nghiệm máu/chẩn đoán hình ảnh)
      if (incoming.type && event.type) {
        if (incoming.type === event.type) {
          score += 15;
          reasons.push(`Cùng loại tài liệu (${event.type})`);
        } else if (
          (incoming.type === 'comprehensive_exam' && (event.type === 'test_result' || event.type === 'imaging')) ||
          (event.type === 'comprehensive_exam' && (incoming.type === 'test_result' || incoming.type === 'imaging'))
        ) {
          score += 15;
          reasons.push(`Kết quả xét nghiệm/chẩn đoán hình ảnh bổ trợ cho hồ sơ khám (${incoming.type} & ${event.type})`);
        }
      }
    } else {
      // Khác ngày: khó có thể là sự kiện trùng lặp hoàn toàn
      continue;
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

    // Đánh giá ngưỡng trùng lặp
    const isDifferentSourceFile = Boolean(
      incoming.sourceFileId &&
      event.sourceFileId &&
      incoming.sourceFileId !== event.sourceFileId
    );
    // Nếu là 2 tệp nguồn khác nhau cùng đợt khám (VD: khám tổng quát + xét nghiệm máu), ghép dữ liệu khi hệ số tương đồng >= 75
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

  // 1. Gộp chẩn đoán (không trùng lặp)
  const diagSeen = new Set<string>();
  const mergedDiagnoses: string[] = [];
  for (const d of [...cleanExisting.diagnoses, ...cleanIncoming.diagnoses]) {
    const norm = normalizeMedicalText(d);
    if (!diagSeen.has(norm)) {
      diagSeen.add(norm);
      mergedDiagnoses.push(d);
    }
  }

  // 2. Gộp đơn thuốc (cập nhật hoặc bổ sung thuốc mới)
  const medMap = new Map<string, Medication>();
  for (const med of cleanExisting.medications) {
    const key = normalizeMedicationName(med.name) || normalizeMedicalText(med.name);
    medMap.set(key, med);
  }
  for (const med of cleanIncoming.medications) {
    const key = normalizeMedicationName(med.name) || normalizeMedicalText(med.name);
    const prev = medMap.get(key);
    if (!prev) {
      medMap.set(key, med);
    } else {
      medMap.set(key, {
        name: med.name.length >= prev.name.length ? med.name : prev.name,
        dosage: med.dosage || prev.dosage,
        frequency: med.frequency || prev.frequency,
        duration: med.duration || prev.duration,
      });
    }
  }

  // 3. Gộp chỉ số đo (Metrics) - Ưu tiên key theo standardKey nếu có
  const metricMap = new Map<string, HealthMetric>();
  for (const m of [...cleanExisting.metrics, ...cleanIncoming.metrics]) {
    const key = m.standardKey
      ? m.standardKey.trim().toUpperCase()
      : normalizeMetricName(m.name);
    const existing = metricMap.get(key);
    if (!existing || (!existing.refRange && m.refRange)) {
      metricMap.set(key, m);
    }
  }

  // 4. Gộp kết quả chẩn đoán hình ảnh (Imaging Results: Siêu âm, X-quang, CT, MRI, ECG...)
  const imgMap = new Map<string, ImagingResult>();
  for (const img of [...(cleanExisting.imagingResults || []), ...(cleanIncoming.imagingResults || [])]) {
    const modality = img.modality?.trim() || '';
    const findings = img.findings?.trim() || '';
    const conclusion = img.conclusion?.trim() || '';
    if (!modality && !findings && !conclusion) continue;

    const key = normalizeModalityKey(modality);
    const existing = imgMap.get(key);
    if (!existing) {
      imgMap.set(key, { modality: modality || 'Chẩn đoán hình ảnh', findings, conclusion });
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
        findings: mergedFindings,
        conclusion: mergedConclusion,
      });
    }
  }

  // 5. Gộp Khám thể lực (Physical Exam)
  const mergedPhysicalExam = cleanExisting.physicalExam || cleanIncoming.physicalExam
    ? {
        height_cm: cleanIncoming.physicalExam?.height_cm ?? cleanExisting.physicalExam?.height_cm,
        weight_kg: cleanIncoming.physicalExam?.weight_kg ?? cleanExisting.physicalExam?.weight_kg,
        bmi: cleanIncoming.physicalExam?.bmi ?? cleanExisting.physicalExam?.bmi,
        bp_mmHg: cleanIncoming.physicalExam?.bp_mmHg || cleanExisting.physicalExam?.bp_mmHg,
        pulse_bpm: cleanIncoming.physicalExam?.pulse_bpm ?? cleanExisting.physicalExam?.pulse_bpm,
        classification: cleanIncoming.physicalExam?.classification || cleanExisting.physicalExam?.classification,
      }
    : undefined;

  // 6. Lời dặn & Ghi chú (làm sạch trùng lặp)
  let mergedAdvice = cleanExisting.advice;
  if (cleanIncoming.advice && cleanIncoming.advice !== cleanExisting.advice) {
    mergedAdvice = cleanExisting.advice
      ? Array.from(new Set([...cleanExisting.advice.split('\n'), ...cleanIncoming.advice.split('\n')]))
          .filter(Boolean)
          .join('\n')
      : cleanIncoming.advice;
  }

  let mergedNotes = cleanExisting.notes;
  if (cleanIncoming.notes && cleanIncoming.notes !== cleanExisting.notes) {
    const rawNotes = [...(cleanExisting.notes?.split('\n') || []), ...(cleanIncoming.notes?.split('\n') || [])]
      .map(n => n.trim())
      .filter(n => n && !n.includes('Có dữ liệu được trích xuất'));
    mergedNotes = Array.from(new Set(rawNotes)).join('\n') || undefined;
  }

  // 7. Gộp danh sách các tệp nguồn liên kết (additionalSources)
  const existingSources = cleanExisting.additionalSources || (cleanExisting.sourceFileId ? [{ driveFileId: cleanExisting.sourceFileId, fileName: cleanExisting.sourceFileName }] : []);
  const incomingSources = cleanIncoming.additionalSources || (cleanIncoming.sourceFileId ? [{ driveFileId: cleanIncoming.sourceFileId, fileName: cleanIncoming.sourceFileName }] : []);
  
  const sourcesMap = new Map<string, { driveFileId: string; fileName: string }>();
  for (const s of [...existingSources, ...incomingSources]) {
    if (s.driveFileId && !sourcesMap.has(s.driveFileId)) {
      sourcesMap.set(s.driveFileId, s);
    }
  }
  const mergedSources = Array.from(sourcesMap.values());

  return {
    ...cleanExisting,
    title: cleanExisting.title || cleanIncoming.title,
    date: cleanIncoming.date || cleanExisting.date,
    type: cleanExisting.type === 'comprehensive_exam' ? cleanExisting.type : (cleanIncoming.type || cleanExisting.type),
    facility: cleanIncoming.facility || cleanExisting.facility,
    additionalSources: mergedSources.length > 1 ? mergedSources : cleanExisting.additionalSources,
    physicalExam: mergedPhysicalExam,
    diagnoses: mergedDiagnoses,
    medications: Array.from(medMap.values()),
    metrics: Array.from(metricMap.values()),
    imagingResults: Array.from(imgMap.values()),
    vaccinations: cleanIncoming.vaccinations?.length ? cleanIncoming.vaccinations : cleanExisting.vaccinations,
    hospitalization: cleanIncoming.hospitalization || cleanExisting.hospitalization,
    advice: mergedAdvice,
    notes: mergedNotes,
    nextFollowUp: cleanIncoming.nextFollowUp || cleanExisting.nextFollowUp,
    patientName: cleanIncoming.patientName || cleanExisting.patientName,
    patientBirthDate: cleanIncoming.patientBirthDate || cleanExisting.patientBirthDate,
    patientGender: cleanIncoming.patientGender || cleanExisting.patientGender,
    recordedAt: now,
  };
}
