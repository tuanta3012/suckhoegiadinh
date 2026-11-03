import type {
  FamilyMember,
  HealthEvent,
  HealthMetric,
  HealthProfile,
  HealthSource,
} from '../types';

export function createHealthProfile(member: FamilyMember, now = new Date().toISOString()): HealthProfile {
  return {
    schemaVersion: 1,
    member,
    timeline: [],
    sources: [],
    summary: { latestDiagnoses: [], latestMetrics: {} },
    createdAt: now,
    updatedAt: now,
  };
}

export function mergeHealthProfiles(
  current: HealthProfile,
  incoming: HealthProfile,
  now = new Date().toISOString(),
): HealthProfile {
  const events = new Map<string, HealthEvent>();
  for (const event of [...current.timeline, ...incoming.timeline]) {
    const previous = events.get(event.id);
    if (previous && !sameHealthEventContent(previous, event)) {
      throw new Error(`Xung đột đồng bộ: sự kiện "${event.title}" có cùng mã nhưng nội dung khác nhau. Hãy tải lại hồ sơ và kiểm tra trước khi thử lại.`);
    }
    if (!previous || event.recordedAt > previous.recordedAt) events.set(event.id, event);
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
      rawDeletedAt: previous.rawDeletedAt || source.rawDeletedAt,
    });
  }

  const timeline = [...events.values()].sort(
    (left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt),
  );
  const mergedSources = [...sources.values()].sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt));
  return {
    schemaVersion: 1,
    member: incoming.member || current.member,
    timeline,
    sources: mergedSources,
    summary: summarizeTimeline(timeline, incoming.summary.narrative || current.summary.narrative),
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
  if (!event.title.trim() || !event.date) throw new Error('Cần nhập tiêu đề và ngày của tài liệu y tế.');
  if (profile.timeline.some((item) => item.id === event.id)) {
    throw new Error('Sự kiện này đã có trong dòng thời gian.');
  }

  const timeline = [...profile.timeline, { ...event, title: event.title.trim() }].sort(
    (left, right) => left.date.localeCompare(right.date) || left.recordedAt.localeCompare(right.recordedAt),
  );
  const sources = profile.sources.map((item) =>
    item.driveFileId === event.sourceFileId
      ? { ...item, status: 'processed' as const, digitizedAt: now }
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
      source.digitizedAt &&
      profile.timeline.some((event) => event.sourceFileId === sourceFileId),
  );
}

export function summarizeTimeline(
  timeline: HealthEvent[],
  narrative?: string,
): HealthProfile['summary'] {
  const latest = [...timeline].sort((a, b) => b.date.localeCompare(a.date))[0];
  const latestMetrics: Record<string, HealthMetric & { date: string }> = {};
  for (const event of timeline) {
    for (const metric of event.metrics) {
      const previous = latestMetrics[metric.name];
      if (!previous || event.date >= previous.date) latestMetrics[metric.name] = { ...metric, date: event.date };
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

export function parseHealthProfile(value: unknown, member: FamilyMember): HealthProfile {
  if (!value || typeof value !== 'object') throw new Error('Tệp hồ sơ trên Drive không phải JSON hợp lệ.');
  const data = value as Partial<HealthProfile>;
  if (data.schemaVersion !== 1 || !Array.isArray(data.timeline) || !Array.isArray(data.sources)) {
    throw new Error('Phiên bản hoặc cấu trúc hồ sơ sức khỏe không được hỗ trợ.');
  }
  if (data.timeline.some((event) => !event || typeof event.id !== 'string' || typeof event.date !== 'string')) {
    throw new Error('Hồ sơ có sự kiện thiếu mã hoặc ngày ghi nhận.');
  }

  const normalized: HealthProfile = {
    schemaVersion: 1,
    member: { ...(data.member || member), ...member },
    timeline: data.timeline,
    sources: data.sources,
    summary: data.summary || { latestDiagnoses: [], latestMetrics: {} },
    createdAt: data.createdAt || new Date().toISOString(),
    updatedAt: data.updatedAt || new Date().toISOString(),
  };
  return {
    ...normalized,
    summary: summarizeTimeline(normalized.timeline, normalized.summary.narrative),
  };
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
