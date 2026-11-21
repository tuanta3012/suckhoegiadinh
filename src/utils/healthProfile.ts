import type {
  FamilyMember,
  HealthDeletionTombstone,
  HealthEvent,
  HealthFamily,
  HealthMetric,
  HealthProfile,
  HealthSource,
  HealthSummaryExtractedEntry,
  JsonValue,
} from '../types';
import {
  cleanAndDeduplicateEventData,
  consolidateTimelineEvents,
  mergeHealthEvents,
} from './deduplicationService';
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
      (value.restoredAt === undefined || typeof value.restoredAt === 'string') &&
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
      (value.mergedIntoFileId === undefined || typeof value.mergedIntoFileId === 'string') &&
      (value.mergedIntoFileName === undefined || typeof value.mergedIntoFileName === 'string') &&
      (value.mergedDisposition === undefined || value.mergedDisposition === 'included' || value.mergedDisposition === 'duplicate') &&
      (value.mergedReason === undefined || typeof value.mergedReason === 'string') &&
      (value.sourceContributions === undefined ||
        (Array.isArray(value.sourceContributions) &&
          value.sourceContributions.every((contribution) =>
            isJsonRecord(contribution) &&
            typeof contribution.fileName === 'string' &&
            typeof contribution.fileHash === 'string' &&
            (contribution.hashAlgorithm === 'sha256' || contribution.hashAlgorithm === 'md5') &&
            typeof contribution.uploadedAt === 'string' &&
            (contribution.disposition === 'included' || contribution.disposition === 'duplicate') &&
            (contribution.reason === undefined || typeof contribution.reason === 'string') &&
            (contribution.fileSize === undefined || (typeof contribution.fileSize === 'number' && Number.isFinite(contribution.fileSize))) &&
            (contribution.totalPages === undefined || (typeof contribution.totalPages === 'number' && Number.isFinite(contribution.totalPages))) &&
            (contribution.mergedIntoEventId === undefined || typeof contribution.mergedIntoEventId === 'string') &&
            (contribution.sourceDriveFileId === undefined || typeof contribution.sourceDriveFileId === 'string')))),
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

export function upsertDeletionTombstones(
  ...collections: Array<HealthDeletionTombstone[] | undefined>
): HealthDeletionTombstone[] {
  const tombstones = new Map<string, HealthDeletionTombstone>();
  for (const item of collections.flatMap((collection) => collection || [])) {
    if (!item || typeof item.id !== 'string' || typeof item.deletedAt !== 'string') continue;
    const id = item.id.trim();
    const deletedAt = item.deletedAt.trim();
    if (!id || !deletedAt) continue;
    const previous = tombstones.get(id);
    if (!previous || isTimestampStrictlyAfter(deletedAt, previous.deletedAt)) {
      tombstones.set(id, { id, deletedAt });
    }
  }
  return [...tombstones.values()].sort(
    (left, right) => left.deletedAt.localeCompare(right.deletedAt) || left.id.localeCompare(right.id),
  );
}

export function mergeHealthProfiles(
  current: HealthProfile,
  incoming: HealthProfile,
  now = new Date().toISOString(),
): HealthProfile {
  const deletedEventMap = new Map(
    upsertDeletionTombstones(current.deletedEvents, incoming.deletedEvents).map((item) => [item.id, item]),
  );
  const deletedSourceMap = new Map(
    upsertDeletionTombstones(current.deletedSources, incoming.deletedSources).map((item) => [item.id, item]),
  );

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

  for (const [eventId, event] of [...events.entries()]) {
    const tombstone = deletedEventMap.get(eventId);
    if (!tombstone) continue;
    if (isTimestampStrictlyAfter(event.recordedAt, tombstone.deletedAt)) {
      deletedEventMap.delete(eventId);
    } else {
      events.delete(eventId);
    }
  }

  const sources = new Map<string, HealthSource>();
  for (const source of [...current.sources, ...incoming.sources]) {
    const previous = sources.get(source.driveFileId);
    if (!previous) {
      sources.set(source.driveFileId, source);
      continue;
    }

    const rawContributions = [
      ...(previous.sourceContributions || []),
      ...(source.sourceContributions || []),
    ];
    const uniqueContributions = new Map<string, (typeof rawContributions)[0]>();
    for (const item of rawContributions) {
      const key = item.fileName.trim().toLowerCase();
      const existing = uniqueContributions.get(key);
      if (!existing || (item.uploadedAt || '') >= (existing.uploadedAt || '')) {
        uniqueContributions.set(key, item);
      }
    }
    const mergedContributions = [...uniqueContributions.values()];

    const selected = source.status === 'processed' ? source : previous;
    const latestRestoredAt = resolveLatestIsoTimestamp(previous.restoredAt, source.restoredAt);
    sources.set(source.driveFileId, {
      ...previous,
      ...selected,
      ...(latestRestoredAt ? { restoredAt: latestRestoredAt } : {}),
      subjectStatus: selected.status === 'processed'
        ? selected.subjectStatus
        : source.subjectStatus || previous.subjectStatus,
      rawDeletedAt: previous.rawDeletedAt || source.rawDeletedAt,
      relocatedToMemberId: source.relocatedToMemberId || previous.relocatedToMemberId,
      mergedIntoFileId: selected.mergedIntoFileId || source.mergedIntoFileId || previous.mergedIntoFileId,
      mergedIntoFileName: selected.mergedIntoFileName || source.mergedIntoFileName || previous.mergedIntoFileName,
      mergedDisposition: selected.mergedDisposition || source.mergedDisposition || previous.mergedDisposition,
      mergedReason: selected.mergedReason || source.mergedReason || previous.mergedReason,
      ...(mergedContributions.length > 0 ? { sourceContributions: mergedContributions } : {}),
    });
  }

  for (const [sourceId, source] of [...sources.entries()]) {
    const tombstone = deletedSourceMap.get(sourceId);
    if (!tombstone) continue;
    const sourceLatestAt = resolveLatestIsoTimestamp(source.restoredAt, source.digitizedAt, source.uploadedAt);
    if (isTimestampStrictlyAfter(sourceLatestAt, tombstone.deletedAt)) {
      deletedSourceMap.delete(sourceId);
    } else {
      sources.delete(sourceId);
    }
  }

  const timeline = [...events.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt),
  );
  const mergedSources = [...sources.values()].sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt));
  const mergedDeletedEvents = upsertDeletionTombstones([...deletedEventMap.values()]);
  const mergedDeletedSources = upsertDeletionTombstones([...deletedSourceMap.values()]);

  const changedFromCurrent = didTimelineEventsChange(current.timeline, timeline);
  const changedFromIncoming = didTimelineEventsChange(incoming.timeline, timeline);
  const timelineChangedOnBothSides = changedFromCurrent && changedFromIncoming;
  const maxEventRecordedAt = resolveLatestIsoTimestamp(
    ...timeline.map((item) => item.recordedAt),
  );

  let timelineUpdatedAt = resolveLatestIsoTimestamp(
    current.timelineUpdatedAt,
    incoming.timelineUpdatedAt,
  );
  if (timelineChangedOnBothSides) {
    timelineUpdatedAt = resolveLatestIsoTimestamp(timelineUpdatedAt, maxEventRecordedAt, now);
  } else if (changedFromCurrent || changedFromIncoming) {
    timelineUpdatedAt = resolveLatestIsoTimestamp(timelineUpdatedAt, maxEventRecordedAt);
  }

  let latestInvalidatedAt = resolveLatestIsoTimestamp(
    current.aiAnalysisInvalidatedAt,
    incoming.aiAnalysisInvalidatedAt,
    timelineChangedOnBothSides ? now : undefined,
  );
  // Handle legacy profiles where one device modified timeline without setting timelineUpdatedAt
  if (
    changedFromCurrent &&
    !incoming.timelineUpdatedAt &&
    !incoming.aiAnalysisInvalidatedAt &&
    current.aiDeepAnalysis
  ) {
    latestInvalidatedAt = resolveLatestIsoTimestamp(
      latestInvalidatedAt,
      incoming.updatedAt,
      maxEventRecordedAt,
    );
  }
  if (
    changedFromIncoming &&
    !current.timelineUpdatedAt &&
    !current.aiAnalysisInvalidatedAt &&
    incoming.aiDeepAnalysis
  ) {
    latestInvalidatedAt = resolveLatestIsoTimestamp(
      latestInvalidatedAt,
      current.updatedAt,
      maxEventRecordedAt,
    );
  }

  const chosenDeepAnalysis = pickNewerByTimestamp(
    current.aiDeepAnalysis,
    incoming.aiDeepAnalysis,
    (item) => item.analyzedAt,
  );
  const getAiBlockTs = (profile: HealthProfile) =>
    profile.aiAnalysis?.analyzedAt ||
    profile.aiDeepAnalysis?.analyzedAt ||
    profile.aiAnalysis?.lastAnalyzedDate;
  const chosenAiAnalysis =
    current.aiAnalysis && incoming.aiAnalysis
      ? isTimestampStrictlyAfter(getAiBlockTs(incoming), getAiBlockTs(current))
        ? incoming.aiAnalysis
        : isTimestampStrictlyAfter(getAiBlockTs(current), getAiBlockTs(incoming))
          ? current.aiAnalysis
          : incoming.aiAnalysis
      : incoming.aiAnalysis || current.aiAnalysis;

  const candidateAnalyzedAt = resolveLatestIsoTimestamp(
    chosenDeepAnalysis?.analyzedAt,
    chosenAiAnalysis?.analyzedAt,
    chosenAiAnalysis?.lastAnalyzedDate,
  );

  const shouldInvalidateAiAnalysis = Boolean(
    (chosenDeepAnalysis || chosenAiAnalysis) &&
      (timeline.length === 0 ||
        (latestInvalidatedAt &&
          (!candidateAnalyzedAt ||
            !isTimestampStrictlyAfter(candidateAnalyzedAt, latestInvalidatedAt))) ||
        (timelineUpdatedAt &&
          (!candidateAnalyzedAt ||
            isTimestampStrictlyAfter(timelineUpdatedAt, candidateAnalyzedAt)))),
  );

  const nextAiDeepAnalysis = shouldInvalidateAiAnalysis ? undefined : chosenDeepAnalysis;
  const nextAiAnalysis = shouldInvalidateAiAnalysis ? undefined : chosenAiAnalysis;
  const nextInvalidatedAt = shouldInvalidateAiAnalysis
    ? resolveLatestIsoTimestamp(latestInvalidatedAt, timelineUpdatedAt, timeline.length === 0 ? now : undefined)
    : !nextAiDeepAnalysis && !nextAiAnalysis
      ? latestInvalidatedAt
      : undefined;

  const currentMedHistoryTs = current.medicalHistory
    ? current.medicalHistoryUpdatedAt || current.updatedAt
    : undefined;
  const incomingMedHistoryTs = incoming.medicalHistory
    ? incoming.medicalHistoryUpdatedAt || incoming.updatedAt
    : undefined;

  let nextMedicalHistory = current.medicalHistory;
  let nextMedicalHistoryUpdatedAt = current.medicalHistoryUpdatedAt;
  if (incoming.medicalHistory && current.medicalHistory) {
    if (isTimestampStrictlyAfter(currentMedHistoryTs, incomingMedHistoryTs)) {
      nextMedicalHistory = current.medicalHistory;
      nextMedicalHistoryUpdatedAt = currentMedHistoryTs;
    } else {
      nextMedicalHistory = incoming.medicalHistory;
      nextMedicalHistoryUpdatedAt = incomingMedHistoryTs;
    }
  } else if (incoming.medicalHistory) {
    nextMedicalHistory = incoming.medicalHistory;
    nextMedicalHistoryUpdatedAt = incomingMedHistoryTs;
  } else if (current.medicalHistory) {
    nextMedicalHistory = current.medicalHistory;
    nextMedicalHistoryUpdatedAt = currentMedHistoryTs;
  }

  return {
    schemaVersion: 2,
    member: incoming.member || current.member,
    timeline,
    ...(timelineUpdatedAt ? { timelineUpdatedAt } : {}),
    sources: mergedSources,
    ...(mergedDeletedEvents.length > 0 ? { deletedEvents: mergedDeletedEvents } : {}),
    ...(mergedDeletedSources.length > 0 ? { deletedSources: mergedDeletedSources } : {}),
    summary: summarizeTimeline(timeline, incoming.summary.narrative || current.summary.narrative),
    aiAnalysis: nextAiAnalysis,
    aiDeepAnalysis: nextAiDeepAnalysis,
    ...(nextInvalidatedAt ? { aiAnalysisInvalidatedAt: nextInvalidatedAt } : {}),
    medicalHistory: nextMedicalHistory,
    ...(nextMedicalHistoryUpdatedAt ? { medicalHistoryUpdatedAt: nextMedicalHistoryUpdatedAt } : {}),
    createdAt: current.createdAt || incoming.createdAt,
    updatedAt: now,
  };
}

function parseComparableEpoch(value?: string): number | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? Date.parse(`${trimmed}T00:00:00.000Z`)
    : Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveLatestIsoTimestamp(...values: Array<string | undefined>): string | undefined {
  let latestValue: string | undefined;
  let latestEpoch = Number.NEGATIVE_INFINITY;
  for (const candidate of values) {
    if (!candidate || !candidate.trim()) continue;
    const epoch = parseComparableEpoch(candidate);
    if (epoch !== null) {
      if (latestValue === undefined || epoch > latestEpoch) {
        latestEpoch = epoch;
        latestValue = candidate;
      }
    } else if (latestValue === undefined || candidate > latestValue) {
      latestValue = candidate;
    }
  }
  return latestValue;
}

function isTimestampStrictlyAfter(later?: string, earlier?: string): boolean {
  if (!later || !later.trim()) return false;
  if (!earlier || !earlier.trim()) return true;
  const laterTrimmed = later.trim();
  const earlierTrimmed = earlier.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(earlierTrimmed) && !/^\d{4}-\d{2}-\d{2}$/.test(laterTrimmed)) {
    return laterTrimmed.slice(0, 10) > earlierTrimmed;
  }
  const laterEpoch = parseComparableEpoch(laterTrimmed);
  const earlierEpoch = parseComparableEpoch(earlierTrimmed);
  if (laterEpoch !== null && earlierEpoch !== null) {
    return laterEpoch > earlierEpoch;
  }
  return laterTrimmed > earlierTrimmed;
}

function pickNewerByTimestamp<T>(
  current: T | undefined,
  incoming: T | undefined,
  getTimestamp: (value: T) => string | undefined,
): T | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentTs = getTimestamp(current);
  const incomingTs = getTimestamp(incoming);
  if (isTimestampStrictlyAfter(currentTs, incomingTs)) return current;
  return incoming;
}

function normalizeTimelineSignature(timeline: HealthEvent[]): string {
  return JSON.stringify(
    [...timeline]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        date: item.date,
        facility: item.facility || '',
        doctorName: item.doctorName || '',
        diagnoses: item.diagnoses || [],
        medications: item.medications || [],
        metrics: item.metrics || [],
        imagingResults: item.imagingResults || [],
        vaccinations: item.vaccinations || [],
        hospitalization: item.hospitalization || null,
        advice: item.advice || '',
        nextFollowUp: item.nextFollowUp || '',
        notes: item.notes || '',
        extractedData: item.extractedData || null,
      })),
  );
}

function didTimelineEventsChange(left: HealthEvent[], right: HealthEvent[]): boolean {
  if (left.length !== right.length) return true;
  return normalizeTimelineSignature(left) !== normalizeTimelineSignature(right);
}

function sameHealthEventContent(left: HealthEvent, right: HealthEvent): boolean {
  const { recordedAt: _leftRecordedAt, ...leftContent } = left;
  const { recordedAt: _rightRecordedAt, ...rightContent } = right;
  return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}

export function addHealthSource(profile: HealthProfile, source: HealthSource): HealthProfile {
  if (profile.sources.some((item) => item.driveFileId === source.driveFileId)) return profile;
  const hadTombstone = profile.deletedSources?.some((item) => item.id === source.driveFileId);
  const nextDeletedSources = profile.deletedSources?.filter((item) => item.id !== source.driveFileId);
  const nextSource: HealthSource = hadTombstone && !source.restoredAt
    ? { ...source, restoredAt: new Date().toISOString() }
    : source;
  return {
    ...profile,
    sources: [...profile.sources, nextSource],
    ...(nextDeletedSources && nextDeletedSources.length > 0
      ? { deletedSources: nextDeletedSources }
      : { deletedSources: undefined }),
    updatedAt: source.uploadedAt,
  };
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
  const nextDeletedEvents = profile.deletedEvents?.filter((item) => item.id !== event.id);
  const nextDeletedSources = profile.deletedSources?.filter((item) => item.id !== event.sourceFileId);
  return {
    ...profile,
    timeline,
    timelineUpdatedAt: now,
    sources,
    ...(nextDeletedEvents?.length ? { deletedEvents: nextDeletedEvents } : { deletedEvents: undefined }),
    ...(nextDeletedSources?.length ? { deletedSources: nextDeletedSources } : { deletedSources: undefined }),
    summary: summarizeTimeline(timeline, profile.summary.narrative),
    aiDeepAnalysis: undefined,
    aiAnalysis: undefined,
    aiAnalysisInvalidatedAt: now,
    updatedAt: now,
  };
}

export function updateTimelineEventInProfile(
  profile: HealthProfile,
  editedEvent: HealthEvent,
  now = new Date().toISOString(),
): HealthProfile {
  const index = profile.timeline.findIndex((item) => item.id === editedEvent.id);
  if (index === -1) {
    throw new Error('Không tìm thấy sự kiện y tế cần chỉnh sửa.');
  }

  const existing = profile.timeline[index];
  const trimmedTitle = editedEvent.title.trim();
  if (!trimmedTitle) {
    throw new Error('Cần nhập tiêu đề sự kiện y tế.');
  }

  const normalized = cleanAndDeduplicateEventData({
    ...existing,
    ...editedEvent,
    id: existing.id,
    sourceFileId: existing.sourceFileId,
    sourceFileName: existing.sourceFileName,
    ...(existing.additionalSources ? { additionalSources: existing.additionalSources } : {}),
    title: trimmedTitle,
    date: editedEvent.date.trim(),
    facility: editedEvent.facility?.trim() || undefined,
    doctorName: editedEvent.doctorName?.trim() || undefined,
    advice: editedEvent.advice?.trim() || undefined,
    nextFollowUp: editedEvent.nextFollowUp?.trim() || undefined,
    notes: editedEvent.notes?.trim() || undefined,
    recordedAt: now,
  });

  const nextTimeline = profile.timeline
    .map((item) => (item.id === existing.id ? normalized : item))
    .sort((left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt));

  return {
    ...profile,
    timeline: nextTimeline,
    timelineUpdatedAt: now,
    summary: summarizeTimeline(nextTimeline, profile.summary.narrative),
    aiDeepAnalysis: undefined,
    aiAnalysis: undefined,
    aiAnalysisInvalidatedAt: now,
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

function normalizeExtractedKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isBloodGroupExtractedKey(normalizedKey: string): boolean {
  return (
    normalizedKey === 'nhom_mau' ||
    normalizedKey === 'nhom_mau_abo' ||
    normalizedKey === 'nhom_mau_he_abo' ||
    normalizedKey === 'blood_group' ||
    normalizedKey === 'blood_type' ||
    normalizedKey === 'abo' ||
    normalizedKey === 'abo_group'
  );
}

function isRhesusExtractedKey(normalizedKey: string): boolean {
  return (
    normalizedKey === 'rhesus_factor' ||
    normalizedKey === 'rhesus' ||
    normalizedKey === 'rh_factor' ||
    normalizedKey === 'rh' ||
    normalizedKey === 'yeu_to_rh' ||
    normalizedKey === 'yeu_to_rhesus' ||
    normalizedKey === 'nhom_mau_rh'
  );
}

function isNonEmptySummaryValue(value: unknown): value is JsonValue {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (isJsonRecord(value)) return Object.keys(value).length > 0;
  return false;
}

function extractBloodInfoFromNotes(notes?: string): { bloodGroup?: string; rhFactor?: string } {
  if (!notes || typeof notes !== 'string') return {};
  const aboMatch = notes.match(
    /nh[óo]m\s*m[áa]u(?:\s*\([^)]*\))?(?:\s*t[ựư]\s*[đd][ộo]ng)?\s*[:=]\s*(AB|A|B|O)\b(?:\s*([+-]|Rh\s*(?:Dương|Âm|[+-])))?/i,
  );
  const rhMatch = notes.match(
    /(?:rhesus(?:\s*factor)?|y[ếe]u\s*t[ốo]\s*rh(?:esus)?)\s*[:=]\s*(Dương(?:\s*tính)?|Âm(?:\s*tính)?|Positive|Negative|[+-])/i,
  );
  return {
    bloodGroup: aboMatch?.[1]?.toUpperCase(),
    rhFactor: rhMatch?.[1]?.trim() || aboMatch?.[2]?.replace(/^Rh\s*/i, '').trim(),
  };
}

export function summarizeTimeline(
  timeline: HealthEvent[],
  narrative?: string,
): HealthProfile['summary'] {
  const chronologicalTimeline = [...timeline].sort((a, b) =>
    (a?.date || a?.recordedAt || '').localeCompare(b?.date || b?.recordedAt || ''),
  );
  const latest = [...timeline]
    .filter((event) => event.date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const latestMetrics: Record<string, HealthMetric & { date: string }> = {};
  const latestExtractedData: Record<string, HealthSummaryExtractedEntry> = {};

  for (const event of chronologicalTimeline) {
    if (!event) continue;
    const eventDate = event.date || '';

    if (Array.isArray(event.metrics)) {
      for (const metric of event.metrics) {
        if (!metric) continue;
        let resolvedValue: number | string | undefined;
        if (typeof metric.value === 'number' && Number.isFinite(metric.value)) {
          resolvedValue = metric.value;
        } else if (typeof metric.value === 'string') {
          const trimmedVal = metric.value.trim();
          if (!trimmedVal) continue;
          if (/^-?\d+(?:[.,]\d+)?$/.test(trimmedVal)) {
            const parsedNum = Number(trimmedVal.replace(',', '.'));
            resolvedValue = Number.isFinite(parsedNum) ? parsedNum : trimmedVal;
          } else {
            resolvedValue = trimmedVal;
          }
        }
        if (resolvedValue === undefined) continue;

        const rawKey = metric.standardKey || metric.name || '';
        const stdKey = standardizeMetricKey(rawKey, metric.unit || '', metric.name);
        if (!stdKey) continue;

        const previous = latestMetrics[stdKey];
        if (!previous || !previous.date || (eventDate && eventDate >= previous.date)) {
          latestMetrics[stdKey] = {
            ...metric,
            value: resolvedValue,
            standardKey: stdKey,
            date: eventDate,
          };
        }
      }
    }

    if (isJsonRecord(event.extractedData)) {
      for (const [rawKey, rawVal] of Object.entries(event.extractedData)) {
        const cleanKey = rawKey.trim();
        if (!cleanKey || !isNonEmptySummaryValue(rawVal)) continue;

        const existingEntry = latestExtractedData[cleanKey];
        if (!existingEntry || !existingEntry.date || (eventDate && eventDate >= existingEntry.date)) {
          latestExtractedData[cleanKey] = {
            key: cleanKey,
            value: typeof rawVal === 'string' ? rawVal.trim() : rawVal,
            date: eventDate,
            ...(event.title ? { eventTitle: event.title } : {}),
          };
        }

        const normKey = normalizeExtractedKey(cleanKey);
        const strVal = typeof rawVal === 'string' ? rawVal.trim() : '';
        if (strVal && isBloodGroupExtractedKey(normKey)) {
          const prevBg = latestMetrics.BLOOD_GROUP;
          if (!prevBg || !prevBg.date || (eventDate && eventDate >= prevBg.date)) {
            latestMetrics.BLOOD_GROUP = {
              name: 'Nhóm máu',
              standardKey: 'BLOOD_GROUP',
              value: strVal,
              unit: '',
              date: eventDate,
            };
          }
        } else if (strVal && isRhesusExtractedKey(normKey)) {
          const prevRh = latestMetrics.RH_FACTOR;
          if (!prevRh || !prevRh.date || (eventDate && eventDate >= prevRh.date)) {
            latestMetrics.RH_FACTOR = {
              name: 'Yếu tố Rh',
              standardKey: 'RH_FACTOR',
              value: strVal,
              unit: '',
              date: eventDate,
            };
          }
        }
      }
    }

    const fromNotes = extractBloodInfoFromNotes(event.notes);
    if (fromNotes.bloodGroup) {
      const prevBg = latestMetrics.BLOOD_GROUP;
      if (!prevBg || !prevBg.date || (eventDate && eventDate > prevBg.date)) {
        latestMetrics.BLOOD_GROUP = {
          name: 'Nhóm máu',
          standardKey: 'BLOOD_GROUP',
          value: fromNotes.bloodGroup,
          unit: '',
          date: eventDate,
        };
      }
    }
    if (fromNotes.rhFactor) {
      const prevRh = latestMetrics.RH_FACTOR;
      if (!prevRh || !prevRh.date || (eventDate && eventDate > prevRh.date)) {
        latestMetrics.RH_FACTOR = {
          name: 'Yếu tố Rh',
          standardKey: 'RH_FACTOR',
          value: fromNotes.rhFactor,
          unit: '',
          date: eventDate,
        };
      }
    }
  }

  const bloodGroupValue =
    typeof latestMetrics.BLOOD_GROUP?.value === 'string'
      ? latestMetrics.BLOOD_GROUP.value.trim()
      : '';
  const rhFactorValue =
    typeof latestMetrics.RH_FACTOR?.value === 'string'
      ? latestMetrics.RH_FACTOR.value.trim()
      : '';
  const bloodType = bloodGroupValue
    ? rhFactorValue && !/rh|[+-]|dương|âm/i.test(bloodGroupValue)
      ? `${bloodGroupValue} (Rh ${rhFactorValue})`
      : bloodGroupValue
    : undefined;

  const followUp = [...timeline]
    .reverse()
    .map((event) => event.nextFollowUp)
    .find((value): value is string => typeof value === 'string' && value.length > 0);

  return {
    latestEventDate: latest?.date,
    latestDiagnoses: latest?.diagnoses || [],
    latestMetrics,
    ...(Object.keys(latestExtractedData).length > 0 ? { latestExtractedData } : {}),
    ...(bloodType ? { bloodType } : {}),
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
  return cleanAndDeduplicateEventData({
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
  }) as HealthEvent;
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
    restoredAt: raw.restoredAt ? String(raw.restoredAt) : undefined,
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
    mergedIntoFileId: raw.mergedIntoFileId ? String(raw.mergedIntoFileId) : undefined,
    mergedIntoFileName: raw.mergedIntoFileName ? String(raw.mergedIntoFileName) : undefined,
    mergedDisposition:
      raw.mergedDisposition === 'duplicate' || raw.mergedDisposition === 'included'
        ? raw.mergedDisposition
        : undefined,
    mergedReason: raw.mergedReason ? String(raw.mergedReason) : undefined,
    sourceContributions: Array.isArray(raw.sourceContributions)
      ? (() => {
          const valid = (raw.sourceContributions.filter((contribution: unknown) =>
            isJsonRecord(contribution) &&
            typeof contribution.fileName === 'string' &&
            typeof contribution.fileHash === 'string' &&
            (contribution.hashAlgorithm === 'sha256' || contribution.hashAlgorithm === 'md5') &&
            typeof contribution.uploadedAt === 'string' &&
            (contribution.disposition === 'included' || contribution.disposition === 'duplicate'),
          ) as NonNullable<HealthSource['sourceContributions']>).map((contribution) => ({
            fileName: contribution.fileName,
            fileHash: contribution.fileHash,
            hashAlgorithm: contribution.hashAlgorithm,
            uploadedAt: contribution.uploadedAt,
            disposition: contribution.disposition,
            ...(typeof contribution.reason === 'string' ? { reason: contribution.reason } : {}),
            ...(typeof contribution.fileSize === 'number' && Number.isFinite(contribution.fileSize)
              ? { fileSize: contribution.fileSize }
              : {}),
            ...(typeof contribution.totalPages === 'number' && Number.isFinite(contribution.totalPages)
              ? { totalPages: contribution.totalPages }
              : {}),
            ...(typeof contribution.mergedIntoEventId === 'string'
              ? { mergedIntoEventId: contribution.mergedIntoEventId }
              : {}),
            ...(typeof contribution.sourceDriveFileId === 'string'
              ? { sourceDriveFileId: contribution.sourceDriveFileId }
              : {}),
          }));

          const uniqueByFileName = new Map<string, (typeof valid)[0]>();
          for (const item of valid) {
            const key = item.fileName.trim().toLowerCase();
            const existing = uniqueByFileName.get(key);
            if (!existing || (item.uploadedAt || '') >= (existing.uploadedAt || '')) {
              uniqueByFileName.set(key, item);
            }
          }
          return [...uniqueByFileName.values()];
        })()
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

  const deletedEvents = upsertDeletionTombstones(
    Array.isArray(data.deletedEvents) ? data.deletedEvents : undefined,
  );
  const deletedSources = upsertDeletionTombstones(
    Array.isArray(data.deletedSources) ? data.deletedSources : undefined,
  );

  const normalized: HealthProfile = {
    schemaVersion: 2,
    member: { ...(data.member || member), ...member },
    timeline,
    ...(typeof data.timelineUpdatedAt === 'string' ? { timelineUpdatedAt: data.timelineUpdatedAt } : {}),
    sources,
    ...(deletedEvents.length > 0 ? { deletedEvents } : {}),
    ...(deletedSources.length > 0 ? { deletedSources } : {}),
    summary: data.summary || { latestDiagnoses: [], latestMetrics: {} },
    aiAnalysis: data.aiAnalysis,
    aiDeepAnalysis: data.aiDeepAnalysis,
    ...(typeof data.aiAnalysisInvalidatedAt === 'string'
      ? { aiAnalysisInvalidatedAt: data.aiAnalysisInvalidatedAt }
      : {}),
    medicalHistory: data.medicalHistory,
    ...(typeof data.medicalHistoryUpdatedAt === 'string'
      ? { medicalHistoryUpdatedAt: data.medicalHistoryUpdatedAt }
      : {}),
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

export function mergeDuplicateMemberProfiles(
  primary: FamilyMember,
  primaryProfile: HealthProfile,
  duplicate: FamilyMember,
  duplicateProfile: HealthProfile,
  now = new Date().toISOString(),
): {
  mergedMember: FamilyMember;
  mergedProfile: HealthProfile;
  absorbedEventIds: string[];
} {
  const mergedMember: FamilyMember = {
    ...primary,
    email: primary.email?.trim() || duplicate.email?.trim() || undefined,
    birthDate: primary.birthDate?.trim() || duplicate.birthDate?.trim() || undefined,
    gender:
      primary.gender && primary.gender !== 'other'
        ? primary.gender
        : duplicate.gender || primary.gender,
    role:
      primary.role && primary.role !== 'other'
        ? primary.role
        : duplicate.role || primary.role,
    avatarUrl: primary.avatarUrl || duplicate.avatarUrl,
  };

  const sourcesById = new Map<string, HealthSource>();
  for (const source of [...primaryProfile.sources, ...duplicateProfile.sources]) {
    const sanitizedSource: HealthSource =
      source.relocatedToMemberId === primary.id || source.relocatedToMemberId === duplicate.id
        ? { ...source, relocatedToMemberId: undefined }
        : source;
    const previous = sourcesById.get(sanitizedSource.driveFileId);
    if (!previous) {
      sourcesById.set(sanitizedSource.driveFileId, sanitizedSource);
      continue;
    }
    const rawContributions = [
      ...(previous.sourceContributions || []),
      ...(sanitizedSource.sourceContributions || []),
    ];
    const uniqueContributions = new Map<string, (typeof rawContributions)[0]>();
    for (const item of rawContributions) {
      const key = item.fileName.trim().toLowerCase();
      const existing = uniqueContributions.get(key);
      if (!existing || (item.uploadedAt || '') >= (existing.uploadedAt || '')) {
        uniqueContributions.set(key, item);
      }
    }
    const mergedContributions = [...uniqueContributions.values()];
    const selected = sanitizedSource.status === 'processed' ? sanitizedSource : previous;
    sourcesById.set(sanitizedSource.driveFileId, {
      ...previous,
      ...selected,
      subjectStatus:
        selected.status === 'processed'
          ? selected.subjectStatus
          : sanitizedSource.subjectStatus || previous.subjectStatus,
      ...(mergedContributions.length > 0 ? { sourceContributions: mergedContributions } : {}),
    });
  }

  const eventsById = new Map<string, HealthEvent>();
  for (const event of [...primaryProfile.timeline, ...duplicateProfile.timeline]) {
    const previous = eventsById.get(event.id);
    if (!previous) {
      eventsById.set(event.id, event);
    } else if (event.recordedAt > previous.recordedAt) {
      eventsById.set(event.id, event);
    } else if (previous.recordedAt === event.recordedAt && !sameHealthEventContent(previous, event)) {
      eventsById.set(event.id, mergeHealthEvents(previous, event, now));
    }
  }

  const consolidated = consolidateTimelineEvents([...eventsById.values()]);
  const consolidatedTimeline = [...consolidated.timeline].sort(
    (left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt),
  );
  const absorbedEventIds = duplicateProfile.timeline.map((event) => event.id);

  const activeEventIds = new Set(consolidatedTimeline.map((event) => event.id));
  const activeSourceIds = new Set(sourcesById.keys());
  const mergedDeletedEvents = upsertDeletionTombstones(
    primaryProfile.deletedEvents,
    duplicateProfile.deletedEvents,
  ).filter((item) => !activeEventIds.has(item.id));
  const mergedDeletedSources = upsertDeletionTombstones(
    primaryProfile.deletedSources,
    duplicateProfile.deletedSources,
  ).filter((item) => !activeSourceIds.has(item.id));

  const primarySurgeries = primaryProfile.medicalHistory?.surgeries || [];
  const dupSurgeries = duplicateProfile.medicalHistory?.surgeries || [];
  const surgeryMap = new Map<string, (typeof primarySurgeries)[number]>();
  for (const item of [...primarySurgeries, ...dupSurgeries]) {
    const key = `${item.procedure.trim().toLowerCase()}::${(item.year || '').trim()}`;
    if (!surgeryMap.has(key)) surgeryMap.set(key, item);
  }

  const primaryConditions = primaryProfile.medicalHistory?.chronicConditions || [];
  const dupConditions = duplicateProfile.medicalHistory?.chronicConditions || [];
  const conditionMap = new Map<string, (typeof primaryConditions)[number]>();
  for (const item of [...primaryConditions, ...dupConditions]) {
    const key = item.condition.trim().toLowerCase();
    if (!conditionMap.has(key)) conditionMap.set(key, item);
  }

  const mergedMedicalHistory =
    surgeryMap.size > 0 || conditionMap.size > 0
      ? {
          surgeries: [...surgeryMap.values()],
          chronicConditions: [...conditionMap.values()],
        }
      : undefined;

  const timelineGrew =
    duplicateProfile.timeline.length > 0 ||
    didTimelineEventsChange(primaryProfile.timeline, consolidatedTimeline);

  const mergedProfile: HealthProfile = {
    schemaVersion: 2,
    member: mergedMember,
    timeline: consolidatedTimeline,
    ...(timelineGrew
      ? { timelineUpdatedAt: now }
      : primaryProfile.timelineUpdatedAt
        ? { timelineUpdatedAt: primaryProfile.timelineUpdatedAt }
        : {}),
    sources: [...sourcesById.values()].sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt)),
    ...(mergedDeletedEvents.length > 0 ? { deletedEvents: mergedDeletedEvents } : {}),
    ...(mergedDeletedSources.length > 0 ? { deletedSources: mergedDeletedSources } : {}),
    summary: summarizeTimeline(
      consolidatedTimeline,
      primaryProfile.summary.narrative || duplicateProfile.summary.narrative,
    ),
    ...(timelineGrew
      ? {
          aiAnalysis: undefined,
          aiDeepAnalysis: undefined,
          aiAnalysisInvalidatedAt: now,
        }
      : {
          aiAnalysis: primaryProfile.aiAnalysis,
          aiDeepAnalysis: primaryProfile.aiDeepAnalysis,
          ...(primaryProfile.aiAnalysisInvalidatedAt
            ? { aiAnalysisInvalidatedAt: primaryProfile.aiAnalysisInvalidatedAt }
            : {}),
        }),
    medicalHistory: mergedMedicalHistory,
    ...(mergedMedicalHistory
      ? {
          medicalHistoryUpdatedAt: resolveLatestIsoTimestamp(
            primaryProfile.medicalHistoryUpdatedAt,
            duplicateProfile.medicalHistoryUpdatedAt,
            now,
          ),
        }
      : {}),
    createdAt: primaryProfile.createdAt || duplicateProfile.createdAt || now,
    updatedAt: now,
  };

  return {
    mergedMember,
    mergedProfile,
    absorbedEventIds,
  };
}

