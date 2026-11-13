import type { DriveFile, HealthDriveWorkspace } from './healthDriveService';
import type { FamilyMember, HealthEvent, HealthProfile, HealthSource } from '../types';
import { parseHealthProfile, summarizeTimeline } from './healthProfile';
import {
  compareStructuredEventContainment,
  consolidateTimelineEvents,
  detectDuplicateEvent,
  normalizeMedicalText,
} from './deduplicationService';
import { compareDocumentContainment } from './documentContainment';

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
        const checksum = file.md5Checksum?.toLowerCase();
        if (!checksum || !/^[a-f0-9]{32}$/.test(checksum)) continue;
        const key = checksum;
        const existing = rawFileMap.get(key) || [];
        existing.push({ id: file.id, name: file.name, memberName: member.name, createdTime: file.createdTime });
        rawFileMap.set(key, existing);
      }

      const profileRaw = await loadProfileFn(member.profileFileId);
      const profile = parseHealthProfile(profileRaw, member);

      // Check orphan sources
      for (const source of profile.sources) {
        if (source.rawDeletedAt || source.relocatedToMemberId) continue;
        const linked = profile.timeline.some(
          (ev) =>
            ev.sourceFileId === source.driveFileId ||
            ev.sourceFileName === source.fileName ||
            ev.additionalSources?.some((item) => item.driveFileId === source.driveFileId),
        );
        if (!linked) {
          orphanSources.push({ source, memberName: member.name });
        }
      }

      // Check timeline events (exact signature + clinical episode containment/duplication)
      const matchedInMember = new Set<string>();
      for (let i = 0; i < profile.timeline.length; i++) {
        const event = profile.timeline[i];
        if (!matchedInMember.has(event.id)) {
          const cluster = [event];
          for (let j = i + 1; j < profile.timeline.length; j++) {
            const candidate = profile.timeline[j];
            if (matchedInMember.has(candidate.id)) continue;
            if (
              compareStructuredEventContainment(event, candidate) !== 'none' ||
              Boolean(detectDuplicateEvent([event], candidate))
            ) {
              cluster.push(candidate);
              matchedInMember.add(candidate.id);
            }
          }
          if (cluster.length > 1) {
            matchedInMember.add(event.id);
            const sortedCluster = [...cluster].sort((a, b) => b.date.localeCompare(a.date));
            duplicateTimelineEvents.push({
              title: sortedCluster[0].title,
              date: sortedCluster[0].date,
              count: sortedCluster.length,
              memberNames: [member.name],
              eventIds: sortedCluster.map((item) => item.id),
            });
            continue;
          }
        }

        if (matchedInMember.has(event.id)) continue;
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
  restoreFileFn?: (fileId: string) => Promise<void>,
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
      let profile = parseHealthProfile(await loadProfileFn(member.profileFileId), member);
      if (profile.syncPending) continue;
      const hashGroups = new Map<string, DriveFile[]>();
      for (const file of rawFiles) {
        const checksum = file.md5Checksum?.toLowerCase();
        if (!checksum || !/^[a-f0-9]{32}$/.test(checksum)) continue;
        const group = hashGroups.get(checksum) || [];
        group.push(file);
        hashGroups.set(checksum, group);
      }

      for (const [checksum, files] of hashGroups) {
        if (files.length < 2) continue;
        const sortedFiles = [...files].sort((a, b) =>
          (a.createdTime || '').localeCompare(b.createdTime || ''),
        );
        const canonical = sortedFiles.find((file) => {
          const source = profile.sources.find((item) => item.driveFileId === file.id);
          return source?.status === 'processed' &&
            Boolean(source.digitizedAt) &&
            profile.timeline.some((event) =>
              event.sourceFileId === file.id ||
              event.additionalSources?.some((item) => item.driveFileId === file.id),
            );
        });
        if (!canonical) continue;

        const duplicateFiles = sortedFiles.filter((file) => file.id !== canonical.id);
        const now = new Date().toISOString();
        const duplicateSourceIds = new Set(duplicateFiles.map((file) => file.id));
        const canonicalSource = profile.sources.find((source) => source.driveFileId === canonical.id);
        if (!canonicalSource) continue;
        const sourceContributions = [
          ...(canonicalSource.sourceContributions || []),
          ...duplicateFiles.map((file) => ({
            fileName: file.name,
            fileHash: file.md5Checksum || checksum,
            hashAlgorithm: 'md5' as const,
            uploadedAt: file.createdTime || now,
            disposition: 'duplicate' as const,
          })),
        ].filter((item, index, list) =>
          list.findIndex((candidate) =>
            candidate.fileHash === item.fileHash &&
            candidate.hashAlgorithm === item.hashAlgorithm &&
            candidate.fileName === item.fileName,
          ) === index,
        );
        const remappedTimeline = profile.timeline.map((event) => {
          if (!duplicateSourceIds.has(event.sourceFileId)) return event;
          const duplicate = duplicateFiles.find((file) => file.id === event.sourceFileId);
          const additionalSources = new Map(
            (event.additionalSources || []).map((source) => [source.driveFileId, source]),
          );
          additionalSources.set(event.sourceFileId, {
            driveFileId: event.sourceFileId,
            fileName: duplicate?.name || event.sourceFileName,
          });
          return {
            ...event,
            sourceFileId: canonical.id,
            sourceFileName: canonical.name,
            additionalSources: Array.from(additionalSources.values()),
          };
        });
        const preparedProfile: HealthProfile = {
          ...profile,
          timeline: remappedTimeline,
          sources: profile.sources.map((source) =>
            source.driveFileId === canonical.id
              ? { ...source, sourceContributions }
              : source,
          ),
          updatedAt: now,
        };
        let prepared = await saveProfileFn(member.profileFileId, preparedProfile);
        if (prepared.syncPending) continue;
        profile = prepared;

        for (const duplicate of duplicateFiles) {
          const deleteTime = new Date().toISOString();
          try {
            await deleteFileFn(duplicate.id);
            const markedProfile: HealthProfile = {
              ...prepared,
              sources: prepared.sources.map((source) =>
                source.driveFileId === duplicate.id
                  ? {
                      ...source,
                      status: 'processed' as const,
                      digitizedAt: source.digitizedAt || canonicalSource.digitizedAt,
                      rawDeletedAt: deleteTime,
                    }
                  : source,
              ),
              updatedAt: deleteTime,
            };
            const saved = await saveProfileFn(member.profileFileId, markedProfile);
            if (saved.syncPending) {
              prepared = saved;
              profile = saved;
              deletedRawFiles++;
              continue;
            }
            prepared = saved;
            profile = saved;
            deletedRawFiles++;
          } catch (error) {
            if (restoreFileFn) {
              try {
                await restoreFileFn(duplicate.id);
              } catch (restoreError) {
                console.error(
                  `[Cleanup Raw] Không thể khôi phục raw ${duplicate.id} sau lỗi lưu hồ sơ.`,
                  restoreError,
                );
              }
            }
            console.warn(`[Cleanup Raw] Không thể hoàn tất dọn raw ${duplicate.id}:`, error);
          }
        }
      }

      // 1b. Dọn dẹp các tệp raw có nội dung trùng lặp / bị bao trùm bởi bản đầy đủ hơn
      const activeProcessedSources = profile.sources.filter((source) =>
        source.status === 'processed' &&
        !source.rawDeletedAt &&
        !source.relocatedToMemberId &&
        Boolean(source.digitizedAt) &&
        profile.timeline.some((event) =>
          event.sourceFileId === source.driveFileId ||
          event.additionalSources?.some((item) => item.driveFileId === source.driveFileId),
        ),
      );
      const removedRedundantIds = new Set<string>();
      for (let leftIdx = 0; leftIdx < activeProcessedSources.length; leftIdx++) {
        const leftSource = activeProcessedSources[leftIdx];
        if (removedRedundantIds.has(leftSource.driveFileId)) continue;
        for (let rightIdx = leftIdx + 1; rightIdx < activeProcessedSources.length; rightIdx++) {
          const rightSource = activeProcessedSources[rightIdx];
          if (removedRedundantIds.has(rightSource.driveFileId)) continue;

          let containmentRelation: 'left_contains_right' | 'right_contains_left' | 'equivalent' | null = null;
          if (
            leftSource.contentIndexComplete &&
            leftSource.contentIndexPages?.length &&
            rightSource.contentIndexComplete &&
            rightSource.contentIndexPages?.length
          ) {
            const cmp = compareDocumentContainment(
              { pages: leftSource.contentIndexPages, complete: true },
              { pages: rightSource.contentIndexPages, complete: true },
            );
            if (
              cmp.relation === 'left_contains_right' ||
              cmp.relation === 'right_contains_left' ||
              cmp.relation === 'equivalent'
            ) {
              containmentRelation = cmp.relation;
            }
          }

          if (!containmentRelation) {
            const leftEvents = profile.timeline.filter((ev) => ev.sourceFileId === leftSource.driveFileId);
            const rightEvents = profile.timeline.filter((ev) => ev.sourceFileId === rightSource.driveFileId);
            for (const leftEv of leftEvents) {
              for (const rightEv of rightEvents) {
                const structCmp = compareStructuredEventContainment(leftEv, rightEv);
                if (structCmp !== 'none') {
                  containmentRelation = structCmp;
                  break;
                }
              }
              if (containmentRelation) break;
            }
          }

          if (!containmentRelation) continue;

          let canonical = leftSource;
          let redundant = rightSource;
          if (containmentRelation === 'right_contains_left') {
            canonical = rightSource;
            redundant = leftSource;
          } else if (containmentRelation === 'equivalent') {
            const leftScore = (leftSource.contentIndexPages?.length || 0) * 1_000_000 + (leftSource.fileSize || 0);
            const rightScore = (rightSource.contentIndexPages?.length || 0) * 1_000_000 + (rightSource.fileSize || 0);
            if (rightScore > leftScore) {
              canonical = rightSource;
              redundant = leftSource;
            }
          }

          const now = new Date().toISOString();
          const contribution = {
            fileName: redundant.fileName,
            fileHash: redundant.fileHash || '',
            hashAlgorithm: 'sha256' as const,
            uploadedAt: redundant.uploadedAt,
            disposition: (containmentRelation === 'equivalent' ? 'duplicate' : 'included') as 'duplicate' | 'included',
          };
          const canonicalContributions = [
            ...(canonical.sourceContributions || []),
            ...(redundant.sourceContributions || []),
            contribution,
          ].filter((item, index, list) =>
            list.findIndex((candidate) =>
              candidate.fileHash === item.fileHash &&
              candidate.hashAlgorithm === item.hashAlgorithm &&
              candidate.fileName === item.fileName,
            ) === index,
          );
          const remappedTimeline = profile.timeline.map((event) => {
            if (event.sourceFileId !== redundant.driveFileId) return event;
            const additionalSources = new Map(
              (event.additionalSources || []).map((source) => [source.driveFileId, source]),
            );
            additionalSources.set(redundant.driveFileId, {
              driveFileId: redundant.driveFileId,
              fileName: redundant.fileName,
            });
            return {
              ...event,
              sourceFileId: canonical.driveFileId,
              sourceFileName: canonical.fileName,
              additionalSources: Array.from(additionalSources.values()),
            };
          });

          const preparedProfile: HealthProfile = {
            ...profile,
            timeline: remappedTimeline,
            sources: profile.sources.map((source) =>
              source.driveFileId === canonical.driveFileId
                ? { ...source, sourceContributions: canonicalContributions }
                : source,
            ),
            updatedAt: now,
          };
          let prepared = await saveProfileFn(member.profileFileId, preparedProfile);
          if (prepared.syncPending) continue;
          profile = prepared;

          try {
            await deleteFileFn(redundant.driveFileId);
            const deleteTime = new Date().toISOString();
            const markedProfile: HealthProfile = {
              ...prepared,
              sources: prepared.sources.map((source) =>
                source.driveFileId === redundant.driveFileId
                  ? { ...source, rawDeletedAt: deleteTime }
                  : source,
              ),
              updatedAt: deleteTime,
            };
            const savedAfterTrash = await saveProfileFn(member.profileFileId, markedProfile);
            profile = savedAfterTrash;
            removedRedundantIds.add(redundant.driveFileId);
            deletedRawFiles++;
          } catch (error) {
            if (restoreFileFn) {
              try {
                await restoreFileFn(redundant.driveFileId);
              } catch {
                // ignore restore error
              }
            }
            console.warn(`[Cleanup Raw] Không thể dọn tệp trùng nội dung ${redundant.driveFileId}:`, error);
          }

          if (redundant.driveFileId === leftSource.driveFileId) break;
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

      const { timeline: nextTimeline, mergedCount: memberMergedCount } = consolidateTimelineEvents(timeline);

      if (memberMergedCount > 0) {
        mergedEvents += memberMergedCount;
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
