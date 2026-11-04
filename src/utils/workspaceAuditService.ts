import type { DriveFile, HealthDriveWorkspace } from './healthDriveService';
import type { FamilyMember, HealthEvent, HealthProfile, HealthSource } from '../types';
import { parseHealthProfile, summarizeTimeline } from './healthProfile';
import { normalizeMedicalText, mergeHealthEvents } from './deduplicationService';

export interface WorkspaceAuditReport {
  scannedMembers: number;
  totalRawFiles: number;
  duplicateRawFiles: Array<{
    fileName: string;
    fileSize?: string;
    fileIds: string[];
    memberName: string;
  }>;
  duplicateTimelineEvents: Array<{
    title: string;
    date: string;
    count: number;
    memberNames: string[];
    eventIds: string[];
  }>;
  orphanSources: Array<{
    source: HealthSource;
    memberName: string;
  }>;
}

export interface AuditProgress {
  percent: number;
  message: string;
  currentMember: string;
  index: number;
  total: number;
}

export async function auditWorkspaceFolder(
  workspace: HealthDriveWorkspace,
  loadProfileFn: (fileId: string) => Promise<HealthProfile>,
  listRawFilesFn: (member: FamilyMember) => Promise<DriveFile[]>,
  onProgress?: (progress: AuditProgress) => void
): Promise<WorkspaceAuditReport> {
  const members = workspace.family.members || [];
  const total = members.length;
  let totalRawFiles = 0;
  const rawFileMap = new Map<string, Array<{ id: string; name: string; memberName: string; createdTime?: string }>>();
  const duplicateRawFiles: WorkspaceAuditReport['duplicateRawFiles'] = [];
  const duplicateTimelineEvents: WorkspaceAuditReport['duplicateTimelineEvents'] = [];
  const orphanSources: WorkspaceAuditReport['orphanSources'] = [];

  const eventSignatureMap = new Map<string, Array<{ title: string; date: string; memberName: string; id: string; event: HealthEvent }>>();

  if (total === 0) {
    onProgress?.({ percent: 100, message: 'Thư mục gia đình chưa có thành viên nào.', currentMember: '', index: 0, total: 0 });
    return { scannedMembers: 0, totalRawFiles: 0, duplicateRawFiles: [], duplicateTimelineEvents: [], orphanSources: [] };
  }

  for (let idx = 0; idx < total; idx++) {
    const member = members[idx];
    const percent = Math.round(((idx + 1) / total) * 85);
    onProgress?.({
      percent,
      message: `Đang quét tệp và hồ sơ của thành viên: ${member.name} (${idx + 1}/${total})...`,
      currentMember: member.name,
      index: idx + 1,
      total,
    });

    try {
      const rawFiles = await listRawFilesFn(member);
      totalRawFiles += rawFiles.length;

      for (const file of rawFiles) {
        const key = `${file.name.trim().toLowerCase()}_${file.size || 0}`;
        const existing = rawFileMap.get(key) || [];
        existing.push({ id: file.id, name: file.name, memberName: member.name, createdTime: file.createdTime });
        rawFileMap.set(key, existing);
      }

      const profileRaw = await loadProfileFn(member.profileFileId);
      const profile = parseHealthProfile(profileRaw, member);

      // Check orphan sources
      for (const source of profile.sources) {
        const linked = profile.timeline.some(
          (ev) => ev.sourceFileId === source.driveFileId || ev.sourceFileName === source.fileName
        );
        if (!linked) {
          orphanSources.push({ source, memberName: member.name });
        }
      }

      // Check timeline events
      for (const event of profile.timeline) {
        const diagSig = (event.diagnoses || []).map(normalizeMedicalText).sort().join('|');
        const sig = `${event.date}_${normalizeMedicalText(event.facility || '')}_${diagSig}`;
        const existingEvents = eventSignatureMap.get(sig) || [];
        existingEvents.push({ title: event.title, date: event.date, memberName: member.name, id: event.id, event });
        eventSignatureMap.set(sig, existingEvents);
      }
    } catch (err) {
      console.warn(`[Audit] Không thể quét thành viên ${member.name}:`, err);
    }
  }

  onProgress?.({ percent: 95, message: 'Đang tổng hợp kết quả phân tích trùng lặp...', currentMember: '', index: total, total });

  // Compile duplicate raw files
  for (const [, items] of rawFileMap.entries()) {
    if (items.length > 1) {
      duplicateRawFiles.push({
        fileName: items[0].name,
        fileIds: items.map((i) => i.id),
        memberName: items.map((i) => i.memberName).join(', '),
      });
    }
  }

  // Compile duplicate timeline events
  for (const [, items] of eventSignatureMap.entries()) {
    if (items.length > 1) {
      duplicateTimelineEvents.push({
        title: items[0].title,
        date: items[0].date,
        count: items.length,
        memberNames: Array.from(new Set(items.map((i) => i.memberName))),
        eventIds: items.map((i) => i.id),
      });
    }
  }

  onProgress?.({ percent: 100, message: 'Hoàn tất kiểm tra trùng lặp thư mục!', currentMember: '', index: total, total });

  return {
    scannedMembers: total,
    totalRawFiles,
    duplicateRawFiles,
    duplicateTimelineEvents,
    orphanSources,
  };
}

export async function cleanupWorkspaceDuplicates(
  workspace: HealthDriveWorkspace,
  loadProfileFn: (fileId: string) => Promise<HealthProfile>,
  saveProfileFn: (fileId: string, profile: HealthProfile) => Promise<HealthProfile>,
  listRawFilesFn: (member: FamilyMember) => Promise<DriveFile[]>,
  deleteFileFn: (fileId: string) => Promise<void>,
  onProgress?: (progress: { percent: number; message: string }) => void
): Promise<{ deletedRawFiles: number; mergedEvents: number }> {
  const members = workspace.family.members || [];
  let deletedRawFiles = 0;
  let mergedEvents = 0;

  onProgress?.({ percent: 10, message: 'Đang rà soát tệp raw trùng lặp trên Google Drive...' });

  // 1. Dọn dẹp tệp Raw trùng lặp trên Drive cho từng thành viên
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    try {
      const rawFiles = await listRawFilesFn(member);
      const seenNames = new Map<string, DriveFile>();

      // Sắp xếp theo createdTime cũ nhất lên đầu (giữ bản đầu tiên, xóa bản sau)
      const sortedFiles = [...rawFiles].sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || ''));

      for (const file of sortedFiles) {
        const key = `${file.name.trim().toLowerCase()}_${file.size || '0'}`;
        if (seenNames.has(key)) {
          // Trùng lặp! Xóa tệp thừa trên Drive
          await deleteFileFn(file.id);
          deletedRawFiles++;
        } else {
          seenNames.set(key, file);
        }
      }
    } catch (err) {
      console.warn(`[Cleanup Raw] Lỗi dọn tệp của ${member.name}:`, err);
    }
  }

  onProgress?.({ percent: 50, message: 'Đang dọn dẹp và hợp nhất sự kiện y tế trùng lặp trong dòng thời gian...' });

  // 2. Dọn dẹp và hợp nhất sự kiện trùng lặp trong hồ sơ từng thành viên
  for (let i = 0; i < members.length; i++) {
    const member = members[i];
    try {
      const profileRaw = await loadProfileFn(member.profileFileId);
      const profile = parseHealthProfile(profileRaw, member);
      const timeline = profile.timeline;

      if (!timeline || timeline.length <= 1) continue;

      const uniqueEventsMap = new Map<string, HealthEvent>();
      let memberMergedCount = 0;

      for (const event of timeline) {
        const diagSig = (event.diagnoses || []).map(normalizeMedicalText).sort().join('|');
        const sig = `${event.date}_${normalizeMedicalText(event.facility || '')}_${diagSig}`;

        const existing = uniqueEventsMap.get(sig);
        if (!existing) {
          uniqueEventsMap.set(sig, event);
        } else {
          // Đã có sự kiện trùng, tiến hành hợp nhất thông minh vào bản độc nhất
          const merged = mergeHealthEvents(existing, event);
          uniqueEventsMap.set(sig, merged);
          memberMergedCount++;
          mergedEvents++;
        }
      }

      if (memberMergedCount > 0) {
        const nextTimeline = Array.from(uniqueEventsMap.values()).sort(
          (l, r) => l.date.localeCompare(r.date) || l.recordedAt.localeCompare(r.recordedAt)
        );
        const nextProfile: HealthProfile = {
          ...profile,
          timeline: nextTimeline,
          summary: summarizeTimeline(nextTimeline, profile.summary.narrative),
          updatedAt: new Date().toISOString(),
        };
        await saveProfileFn(member.profileFileId, nextProfile);
      }
    } catch (err) {
      console.warn(`[Cleanup Timeline] Lỗi dọn hồ sơ của ${member.name}:`, err);
    }
  }

  onProgress?.({ percent: 100, message: 'Đã dọn dẹp thành công toàn bộ thư mục về trạng thái duy nhất!' });
  return { deletedRawFiles, mergedEvents };
}
