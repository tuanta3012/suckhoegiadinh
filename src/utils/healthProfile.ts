import type {
  FamilyMember,
  HealthEvent,
  HealthFamily,
  HealthMetric,
  HealthProfile,
  HealthSource,
} from '../types';
import { mergeHealthEvents } from './deduplicationService';
import {
  classifyHealthEventType,
  cleanHospitalizationRecord,
  HEALTH_EVENT_TYPES,
} from './healthEventType';

const EVENT_TYPES = new Set<HealthEvent['type']>(HEALTH_EVENT_TYPES);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isHealthMetric(value: unknown): value is HealthMetric {
  return Boolean(
    isJsonRecord(value) &&
      isNonEmptyString(value.name) &&
      ((typeof value.value === 'number' && Number.isFinite(value.value)) ||
        (typeof value.value === 'string' && value.value.trim().length > 0)) &&
      typeof value.unit === 'string',
  );
}

function isMedication(value: unknown): boolean {
  return Boolean(
    isJsonRecord(value) &&
      isNonEmptyString(value.name) &&
      ['dosage', 'frequency', 'duration'].every(
        (key) => value[key] === undefined || typeof value[key] === 'string',
      ),
  );
}

function isImagingResult(value: unknown): boolean {
  return Boolean(
    isJsonRecord(value) &&
      (typeof value.modality === 'string' || typeof value.findings === 'string' || typeof value.conclusion === 'string')
  );
}

function isHealthEvent(value: unknown): value is HealthEvent {
  if (!isJsonRecord(value)) return false;
  return Boolean(
    isNonEmptyString(value.id) &&
      isNonEmptyString(value.sourceFileId) &&
      typeof value.sourceFileName === 'string' &&
      typeof value.type === 'string' &&
      EVENT_TYPES.has(value.type as HealthEvent['type']) &&
      isNonEmptyString(value.title) &&
      typeof value.date === 'string' &&
      Array.isArray(value.diagnoses) &&
      value.diagnoses.every((item) => typeof item === 'string') &&
      Array.isArray(value.medications) &&
      value.medications.every(isMedication) &&
      Array.isArray(value.metrics) &&
      value.metrics.every(isHealthMetric) &&
      (value.imagingResults === undefined || (Array.isArray(value.imagingResults) && value.imagingResults.every(isImagingResult))) &&
      isNonEmptyString(value.recordedAt) &&
      ['facility', 'advice', 'nextFollowUp', 'notes', 'patientName', 'patientBirthDate', 'patientGender'].every(
        (key) => value[key] === undefined || typeof value[key] === 'string',
      ) &&
      (value.extractedData === undefined || isJsonRecord(value.extractedData)),
  );
}

function isHealthSource(value: unknown): value is HealthSource {
  return Boolean(
    isJsonRecord(value) &&
      isNonEmptyString(value.driveFileId) &&
      typeof value.fileName === 'string' &&
      typeof value.mimeType === 'string' &&
      isNonEmptyString(value.uploadedAt) &&
      (value.status === 'pending' || value.status === 'processed') &&
      (value.subjectStatus === undefined || value.subjectStatus === 'unresolved') &&
      (value.digitizedAt === undefined || typeof value.digitizedAt === 'string') &&
      (value.rawDeletedAt === undefined || typeof value.rawDeletedAt === 'string') &&
      (value.relocatedToMemberId === undefined || typeof value.relocatedToMemberId === 'string') &&
      (value.fileSize === undefined ||
        (typeof value.fileSize === 'number' && Number.isFinite(value.fileSize))) &&
      (value.fileHash === undefined || typeof value.fileHash === 'string') &&
      (value.totalPages === undefined || typeof value.totalPages === 'number') &&
      (value.processedPages === undefined || typeof value.processedPages === 'number') &&
      (value.contentIndexPages === undefined ||
        (Array.isArray(value.contentIndexPages) && value.contentIndexPages.every((page) => typeof page === 'string'))) &&
      (value.contentIndexComplete === undefined || typeof value.contentIndexComplete === 'boolean') &&
      (value.sourceContributions === undefined ||
        (Array.isArray(value.sourceContributions) &&
          value.sourceContributions.every((contribution) =>
            isJsonRecord(contribution) &&
            typeof contribution.fileName === 'string' &&
            typeof contribution.fileHash === 'string' &&
            (contribution.hashAlgorithm === 'sha256' || contribution.hashAlgorithm === 'md5') &&
            typeof contribution.uploadedAt === 'string' &&
            (contribution.disposition === 'included' || contribution.disposition === 'duplicate')))),
  );
}

export function createHealthProfile(member: FamilyMember, now = new Date().toISOString()): HealthProfile {
  return {
    schemaVersion: 2,
    member,
    timeline: [],
    sources: [],
    summary: { latestDiagnoses: [], latestMetrics: {} },
    createdAt: now,
    updatedAt: now,
  };
}

export function mergeFamilyMembers(
  current: FamilyMember[],
  incoming: FamilyMember[],
  baseline: FamilyMember[] = current,
): FamilyMember[] {
  const members = new Map(current.map((member) => [member.id, member]));
  const baselineById = new Map(baseline.map((member) => [member.id, member]));
  for (const member of incoming) {
    const latest = members.get(member.id);
    const previous = baselineById.get(member.id);
    if (!latest) {
      members.set(member.id, member);
      continue;
    }
    if (!previous) {
      if (JSON.stringify(latest) !== JSON.stringify(member)) {
        throw new Error(`Xung đột đồng bộ: hồ sơ thành viên "${member.name}" có cùng mã nhưng thông tin khác nhau.`);
      }
      continue;
    }

    const mergeField = <K extends keyof FamilyMember>(field: K): FamilyMember[K] => {
      const latestChanged = latest[field] !== previous[field];
      const incomingChanged = member[field] !== previous[field];
      if (latestChanged && incomingChanged && latest[field] !== member[field]) {
        throw new Error(`Xung đột đồng bộ: trường "${String(field)}" của thành viên "${member.name}" đã được sửa trên nhiều thiết bị.`);
      }
      return incomingChanged ? member[field] : latest[field];
    };

    members.set(member.id, {
      id: latest.id,
      name: mergeField('name'),
      email: mergeField('email'),
      gender: mergeField('gender'),
      birthDate: mergeField('birthDate'),
      role: mergeField('role'),
      driveFolderId: mergeField('driveFolderId'),
      profileFileId: mergeField('profileFileId'),
      avatarUrl: mergeField('avatarUrl'),
    });
  }
  return [...members.values()];
}

export function mergeFamilyMemberTombstones(
  ...collections: Array<HealthFamily['deletedMembers']>
): NonNullable<HealthFamily['deletedMembers']> {
  const tombstones = new Map<string, NonNullable<HealthFamily['deletedMembers']>[number]>();
  for (const tombstone of collections.flatMap((collection) => collection || [])) {
    const previous = tombstones.get(tombstone.memberId);
    if (!previous || tombstone.deletedAt > previous.deletedAt) {
      tombstones.set(tombstone.memberId, tombstone);
    }
  }
  return [...tombstones.values()];
}

export function excludeDeletedFamilyMembers(
  members: FamilyMember[],
  tombstones: HealthFamily['deletedMembers'],
): FamilyMember[] {
  const deletedIds = new Set((tombstones || []).map((tombstone) => tombstone.memberId));
  return members.filter((member) => !deletedIds.has(member.id));
}

export function mergeHealthProfiles(
  current: HealthProfile,
  incoming: HealthProfile,
  now = new Date().toISOString(),
): HealthProfile {
  const events = new Map<string, HealthEvent>();
  for (const event of [...current.timeline, ...incoming.timeline]) {
    const previous = events.get(event.id);
    if (!previous) {
      events.set(event.id, event);
      continue;
    }
    if (sameHealthEventContent(previous, event)) {
      if (event.recordedAt > previous.recordedAt) {
        events.set(event.id, event);
      }
      continue;
    }
    // Trùng ID nhưng nội dung khác nhau:
    // Đây là trường hợp một sự kiện đã được chỉnh sửa hoặc hợp nhất (merge/deduplicate).
    // - Nếu một bản ghi có mốc recordedAt mới hơn, ưu tiên bản ghi mới hơn (Last-Write-Wins).
    // - Nếu cả hai có cùng recordedAt, hợp nhất thông minh dữ liệu y tế (mergeHealthEvents)
    //   để bảo toàn trọn vẹn chỉ số, thuốc, chẩn đoán mà không làm mất dữ liệu và không báo lỗi xung đột giả.
    if (event.recordedAt > previous.recordedAt) {
      events.set(event.id, event);
    } else if (previous.recordedAt > event.recordedAt) {
      events.set(event.id, previous);
    } else {
      events.set(event.id, mergeHealthEvents(previous, event, now));
    }
  }

  const sources = new Map<string, HealthSource>();
  for (const source of [...current.sources, ...incoming.sources]) {
    const previous = sources.get(source.driveFileId);
    if (!previous) {
      sources.set(source.driveFileId, source);
      continue;
    }

    const selected = source.status === 'processed' ? source : previous;
    sources.set(source.driveFileId, {
      ...previous,
      ...selected,
      subjectStatus: selected.status === 'processed'
        ? selected.subjectStatus
        : source.subjectStatus || previous.subjectStatus,
      rawDeletedAt: previous.rawDeletedAt || source.rawDeletedAt,
      relocatedToMemberId: source.relocatedToMemberId || previous.relocatedToMemberId,
    });
  }

  const timeline = [...events.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt),
  );
  const mergedSources = [...sources.values()].sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt));
  return {
    schemaVersion: 2,
    member: incoming.member || current.member,
    timeline,
    sources: mergedSources,
    summary: summarizeTimeline(timeline, incoming.summary.narrative || current.summary.narrative),
    aiAnalysis: incoming.aiAnalysis || current.aiAnalysis,
    aiDeepAnalysis: incoming.aiDeepAnalysis || current.aiDeepAnalysis,
    medicalHistory: incoming.medicalHistory || current.medicalHistory,
    createdAt: current.createdAt || incoming.createdAt,
    updatedAt: now,
  };
}

function sameHealthEventContent(left: HealthEvent, right: HealthEvent): boolean {
  const { recordedAt: _leftRecordedAt, ...leftContent } = left;
  const { recordedAt: _rightRecordedAt, ...rightContent } = right;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}

export function addHealthSource(profile: HealthProfile, source: HealthSource): HealthProfile {
  if (profile.sources.some((item) => item.driveFileId === source.driveFileId)) return profile;
  return { ...profile, sources: [...profile.sources, source], updatedAt: source.uploadedAt };
}

export function digitizeHealthSource(
  profile: HealthProfile,
  event: HealthEvent,
  now = new Date().toISOString(),
): HealthProfile {
  const source = profile.sources.find((item) => item.driveFileId === event.sourceFileId);
  if (!source) throw new Error('Không tìm thấy tài liệu gốc trong hồ sơ thành viên.');
  if (!event.title.trim()) throw new Error('Cần nhập tiêu đề của tài liệu y tế.');
  if (profile.timeline.some((item) => item.id === event.id)) {
    throw new Error('Sự kiện này đã có trong dòng thời gian.');
  }

  const timeline = [...profile.timeline, { ...event, title: event.title.trim() }].sort(
    (left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt),
  );
  const sources = profile.sources.map((item) =>
    item.driveFileId === event.sourceFileId
      ? { ...item, status: 'processed' as const, subjectStatus: undefined, digitizedAt: now }
      : item,
  );
  return {
    ...profile,
    timeline,
    sources,
    summary: summarizeTimeline(timeline, profile.summary.narrative),
    updatedAt: now,
  };
}

export function canDeleteRawSource(profile: HealthProfile, sourceFileId: string): boolean {
  const source = profile.sources.find((item) => item.driveFileId === sourceFileId);
  return Boolean(
    source &&
      source.status === 'processed' &&
      !source.relocatedToMemberId &&
      source.digitizedAt &&
      profile.timeline.some((event) => event.sourceFileId === sourceFileId),
  );
}

import { standardizeMetricKey } from './healthRecordService';

export function summarizeTimeline(
  timeline: HealthEvent[],
  narrative?: string,
): HealthProfile['summary'] {
  const latest = [...timeline]
    .filter((event) => event.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const latestMetrics: Record<string, HealthMetric & { date: string }> = {};
  
  for (const event of timeline) {
    if (!event || !Array.isArray(event.metrics)) continue;
    const eventDate = event.date || '';

    for (const metric of event.metrics) {
      if (!metric || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
      
      const rawKey = metric.standardKey || metric.name || '';
      const stdKey = standardizeMetricKey(rawKey, metric.unit || '', metric.name);
      
      if (!stdKey) continue; 

      const previous = latestMetrics[stdKey];
      // Strictly one entry per standardized key, prioritized by latest date
      if (!previous || eventDate >= previous.date) {
        latestMetrics[stdKey] = {
          ...metric,
          standardKey: stdKey,
          date: eventDate,
        };
      }
    }
  }

  const followUp = [...timeline]
    .reverse()
    .map((event) => event.nextFollowUp)
    .find((value): value is string => typeof value === 'string' && value.length > 0);

  return {
    latestEventDate: latest?.date,
    latestDiagnoses: latest?.diagnoses || [],
    latestMetrics,
    nextFollowUp: followUp,
    narrative,
  };
}

function sanitizeTimelineEvent(raw: any): HealthEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const type = classifyHealthEventType(raw, raw.sourceFileName) ||
    (EVENT_TYPES.has(raw.type) ? raw.type : 'medical_report');
  const rawPhysicalExam = isJsonRecord(raw.physicalExam)
    ? {
        height_cm: typeof raw.physicalExam.height_cm === 'number' ? raw.physicalExam.height_cm : undefined,
        weight_kg: typeof raw.physicalExam.weight_kg === 'number' ? raw.physicalExam.weight_kg : undefined,
        bmi: typeof raw.physicalExam.bmi === 'number' ? raw.physicalExam.bmi : undefined,
        bp_mmHg: typeof raw.physicalExam.bp_mmHg === 'string' && raw.physicalExam.bp_mmHg.trim()
          ? raw.physicalExam.bp_mmHg.trim()
          : undefined,
        pulse_bpm: typeof raw.physicalExam.pulse_bpm === 'number' ? raw.physicalExam.pulse_bpm : undefined,
        classification: typeof raw.physicalExam.classification === 'string' && raw.physicalExam.classification.trim()
          ? raw.physicalExam.classification.trim()
          : undefined,
      }
    : undefined;
  const physicalExam =
    rawPhysicalExam && Object.values(rawPhysicalExam).some((item) => item !== undefined)
      ? rawPhysicalExam
      : undefined;
  const vaccinations = Array.isArray(raw.vaccinations)
    ? raw.vaccinations.flatMap((item: any) => {
        if (!isJsonRecord(item) || !isNonEmptyString(item.vaccineName)) return [];
        return [{
          vaccineName: item.vaccineName,
          targetDisease: typeof item.targetDisease === 'string' ? item.targetDisease : undefined,
          doseNumber: typeof item.doseNumber === 'string' || typeof item.doseNumber === 'number'
            ? item.doseNumber
            : undefined,
          lotNumber: typeof item.lotNumber === 'string' ? item.lotNumber : undefined,
          manufacturer: typeof item.manufacturer === 'string' ? item.manufacturer : undefined,
          injectionSite: typeof item.injectionSite === 'string' ? item.injectionSite : undefined,
          administeredDate: typeof item.administeredDate === 'string' ? item.administeredDate : '',
          nextDoseDate: typeof item.nextDoseDate === 'string' ? item.nextDoseDate : null,
          reactionNotes: typeof item.reactionNotes === 'string' ? item.reactionNotes : undefined,
        }];
      })
    : [];
  const additionalSources = Array.isArray(raw.additionalSources)
    ? raw.additionalSources.flatMap((item: any) => {
        if (!isJsonRecord(item) || !isNonEmptyString(item.driveFileId)) return [];
        return [{
          driveFileId: String(item.driveFileId),
          fileName:
            typeof item.fileName === 'string' && item.fileName.trim()
              ? item.fileName
              : 'Tài liệu y tế',
        }];
      })
    : [];
  const hospitalization = cleanHospitalizationRecord(raw.hospitalization);
  return {
    id: String(raw.id || `event_${crypto.randomUUID().slice(0, 8)}`),
    sourceFileId: String(raw.sourceFileId || 'legacy_source'),
    sourceFileName: String(raw.sourceFileName || 'Tài liệu y tế'),
    ...(additionalSources.length > 0 ? { additionalSources } : {}),
    type,
    title: String(raw.title || 'Kết quả khám y tế'),
    date: typeof raw.date === 'string' ? raw.date : '',
    diagnoses: Array.isArray(raw.diagnoses) ? raw.diagnoses.map(String) : [],
    medications: Array.isArray(raw.medications) ? raw.medications : [],
    metrics: Array.isArray(raw.metrics) ? raw.metrics : [],
    imagingResults: Array.isArray(raw.imagingResults) ? raw.imagingResults : [],
    vaccinations,
    hospitalization,
    recordedAt: String(raw.recordedAt || new Date().toISOString()),
    facility: raw.facility ? String(raw.facility) : undefined,
    doctorName: raw.doctorName ? String(raw.doctorName) : undefined,
    customCategory: raw.customCategory ? String(raw.customCategory) : undefined,
    physicalExam,
    advice: raw.advice ? String(raw.advice) : undefined,
    nextFollowUp: raw.nextFollowUp ? String(raw.nextFollowUp) : undefined,
    notes: raw.notes ? String(raw.notes) : undefined,
    patientName: raw.patientName ? String(raw.patientName) : undefined,
    patientBirthDate: raw.patientBirthDate ? String(raw.patientBirthDate) : undefined,
    patientGender: raw.patientGender ? String(raw.patientGender) : undefined,
    extractedData: raw.extractedData || undefined,
  };
}

function sanitizeHealthSource(raw: any): HealthSource | null {
  if (!raw || typeof raw !== 'object' || !raw.driveFileId) return null;
  return {
    driveFileId: String(raw.driveFileId),
    fileName: String(raw.fileName || 'Tài liệu y tế'),
    mimeType: String(raw.mimeType || 'application/octet-stream'),
    uploadedAt: String(raw.uploadedAt || new Date().toISOString()),
    status: raw.status === 'processed' ? 'processed' : 'pending',
    subjectStatus: raw.subjectStatus === 'unresolved' ? 'unresolved' : undefined,
    digitizedAt: raw.digitizedAt ? String(raw.digitizedAt) : undefined,
    rawDeletedAt: raw.rawDeletedAt ? String(raw.rawDeletedAt) : undefined,
    relocatedToMemberId: raw.relocatedToMemberId ? String(raw.relocatedToMemberId) : undefined,
    fileSize: typeof raw.fileSize === 'number' ? raw.fileSize : undefined,
    fileHash: raw.fileHash ? String(raw.fileHash) : undefined,
    totalPages: typeof raw.totalPages === 'number' ? raw.totalPages : undefined,
    processedPages: typeof raw.processedPages === 'number' ? raw.processedPages : undefined,
    contentIndexPages: Array.isArray(raw.contentIndexPages)
      ? raw.contentIndexPages.filter((page: unknown): page is string => typeof page === 'string')
      : undefined,
    contentIndexComplete: typeof raw.contentIndexComplete === 'boolean' ? raw.contentIndexComplete : undefined,
    sourceContributions: Array.isArray(raw.sourceContributions)
      ? raw.sourceContributions.filter((contribution: unknown) =>
          isJsonRecord(contribution) &&
          typeof contribution.fileName === 'string' &&
          typeof contribution.fileHash === 'string' &&
          (contribution.hashAlgorithm === 'sha256' || contribution.hashAlgorithm === 'md5') &&
          typeof contribution.uploadedAt === 'string' &&
          (contribution.disposition === 'included' || contribution.disposition === 'duplicate'),
        ) as HealthSource['sourceContributions']
      : undefined,
  };
}

export function parseHealthProfile(value: unknown, member: FamilyMember): HealthProfile {
  if (!value || typeof value !== 'object') throw new Error('Tệp hồ sơ trên Drive không phải JSON hợp lệ.');
  const data = value as any;
  if (data.timeline !== undefined && !Array.isArray(data.timeline)) {
    throw new Error('Danh sách sự kiện trong hồ sơ không hợp lệ.');
  }
  if (data.sources !== undefined && !Array.isArray(data.sources)) {
    throw new Error('Danh sách tài liệu nguồn trong hồ sơ không hợp lệ.');
  }
  const rawTimeline = Array.isArray(data.timeline) ? data.timeline : [];
  const rawSources = Array.isArray(data.sources) ? data.sources : [];

  const timeline: HealthEvent[] = rawTimeline.map((item: any) => {
    if (!isJsonRecord(item) || (item.metrics !== undefined && !Array.isArray(item.metrics)) ||
      (item.diagnoses !== undefined && !Array.isArray(item.diagnoses)) ||
      (item.medications !== undefined && !Array.isArray(item.medications)) ||
      (item.imagingResults !== undefined && !Array.isArray(item.imagingResults))) {
      throw new Error('Hồ sơ có sự kiện thiếu trường bắt buộc hoặc chứa dữ liệu không hợp lệ.');
    }
    const event = sanitizeTimelineEvent(item);
    if (!event || !isHealthEvent(event)) {
      throw new Error('Hồ sơ có sự kiện thiếu trường bắt buộc hoặc chứa dữ liệu không hợp lệ.');
    }
    return event;
  });

  const sources: HealthSource[] = rawSources.map((item: any) => {
    if (!isJsonRecord(item) || !isNonEmptyString(item.driveFileId) ||
      !isNonEmptyString(item.fileName) || !isNonEmptyString(item.mimeType) ||
      !isNonEmptyString(item.uploadedAt) ||
      (item.status !== 'pending' && item.status !== 'processed')) {
      throw new Error('Hồ sơ có tài liệu nguồn thiếu trường bắt buộc hoặc chứa dữ liệu không hợp lệ.');
    }
    const source = sanitizeHealthSource(item);
    if (!source || !isHealthSource(source)) {
      throw new Error('Hồ sơ có tài liệu nguồn thiếu trường bắt buộc hoặc chứa dữ liệu không hợp lệ.');
    }
    return source;
  });

  const normalized: HealthProfile = {
    schemaVersion: 2,
    member: { ...(data.member || member), ...member },
    timeline,
    sources,
    summary: data.summary || { latestDiagnoses: [], latestMetrics: {} },
    aiAnalysis: data.aiAnalysis,
    aiDeepAnalysis: data.aiDeepAnalysis,
    medicalHistory: data.medicalHistory,
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
  return {
    ...normalized,
    summary: summarizeTimeline(normalized.timeline, normalized.summary?.narrative),
  };
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
