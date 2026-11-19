import type { DriveFile, HealthDriveWorkspace } from './healthDriveService';
import type { FamilyMember, HealthProfile } from '../types';
import { parseHealthProfile, summarizeTimeline, upsertDeletionTombstones } from './healthProfile';
import {
  compareStructuredEventContainment,
  consolidateTimelineEvents,
} from './deduplicationService';
import { compareDocumentContainment } from './documentContainment';

function applyTimelineConsolidationWithTombstones(
  profile: HealthProfile,
  now = new Date().toISOString(),
): {
  profile: HealthProfile;
  mergedCount: number;
  absorbedEventIds: string[];
  mergedEventIdMap: Record<string, string>;
} {
  const { timeline: nextTimeline, mergedCount, absorbedEventIds, mergedEventIdMap } =
    consolidateTimelineEvents(profile.timeline);
  if (mergedCount === 0 && absorbedEventIds.length === 0) {
    return { profile, mergedCount: 0, absorbedEventIds: [], mergedEventIdMap: {} };
  }

  const tombstones = absorbedEventIds.map((id) => ({ id, deletedAt: now }));
  const updatedSources = profile.sources.map((source) => {
    if (!source.sourceContributions?.length) return source;
    let changed = false;
    const nextContributions = source.sourceContributions.map((contribution) => {
      const remappedId = contribution.mergedIntoEventId
        ? mergedEventIdMap[contribution.mergedIntoEventId]
        : undefined;
      if (remappedId && remappedId !== contribution.mergedIntoEventId) {
        changed = true;
        return { ...contribution, mergedIntoEventId: remappedId };
      }
      return contribution;
    });
    return changed ? { ...source, sourceContributions: nextContributions } : source;
  });

  return {
    mergedCount,
    absorbedEventIds,
    mergedEventIdMap,
    profile: {
      ...profile,
      timeline: nextTimeline,
      sources: updatedSources,
      deletedEvents: upsertDeletionTombstones(profile.deletedEvents, tombstones),
      summary: summarizeTimeline(nextTimeline, profile.summary.narrative),
      timelineUpdatedAt: now,
      aiDeepAnalysis: undefined,
      aiAnalysis: undefined,
      aiAnalysisInvalidatedAt: now,
      updatedAt: now,
    },
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
          ...duplicateFiles.map((file) => {
            const dupSource = profile.sources.find((item) => item.driveFileId === file.id);
            return {
              fileName: file.name,
              fileHash: file.md5Checksum || checksum,
              hashAlgorithm: 'md5' as const,
              uploadedAt: file.createdTime || now,
              disposition: 'duplicate' as const,
              reason: 'Trùng chính xác checksum MD5 với tệp gốc đã lưu',
              fileSize: dupSource?.fileSize ?? (file.size ? Number(file.size) : undefined),
              totalPages: dupSource?.totalPages,
              sourceDriveFileId: file.id,
            };
          }),
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
        const remappedProfile: HealthProfile = {
          ...profile,
          timeline: remappedTimeline,
          sources: profile.sources.map((source) =>
            source.driveFileId === canonical.id
              ? { ...source, sourceContributions }
              : source,
          ),
          updatedAt: now,
        };
        const consolidated = applyTimelineConsolidationWithTombstones(remappedProfile, now);
        mergedEvents += consolidated.mergedCount;
        const preparedProfile = consolidated.profile;
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
                      mergedIntoFileId: canonical.id,
                      mergedIntoFileName: canonical.name,
                      mergedDisposition: 'duplicate' as const,
                      mergedReason: 'Trùng chính xác nội dung tệp gốc trên Drive',
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
          const disposition = (containmentRelation === 'equivalent' ? 'duplicate' : 'included') as 'duplicate' | 'included';
          const reason =
            disposition === 'duplicate'
              ? 'Trùng toàn bộ nội dung với tài liệu đã lưu'
              : 'Nội dung nằm trọn trong tài liệu đầy đủ hơn';
          const contribution = {
            fileName: redundant.fileName,
            fileHash: redundant.fileHash || '',
            hashAlgorithm: 'sha256' as const,
            uploadedAt: redundant.uploadedAt,
            disposition,
            reason,
            fileSize: redundant.fileSize,
            totalPages: redundant.totalPages,
            sourceDriveFileId: redundant.driveFileId,
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

          const remappedProfile: HealthProfile = {
            ...profile,
            timeline: remappedTimeline,
            sources: profile.sources.map((source) =>
              source.driveFileId === canonical.driveFileId
                ? { ...source, sourceContributions: canonicalContributions }
                : source,
            ),
            updatedAt: now,
          };
          const consolidated = applyTimelineConsolidationWithTombstones(remappedProfile, now);
          mergedEvents += consolidated.mergedCount;
          const preparedProfile = consolidated.profile;
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
                  ? {
                      ...source,
                      rawDeletedAt: deleteTime,
                      mergedIntoFileId: canonical.driveFileId,
                      mergedIntoFileName: canonical.fileName,
                      mergedDisposition: disposition,
                      mergedReason: reason,
                    }
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

      const consolidationNow = new Date().toISOString();
      const consolidated = applyTimelineConsolidationWithTombstones(profile, consolidationNow);

      if (consolidated.mergedCount > 0 || consolidated.absorbedEventIds.length > 0) {
        mergedEvents += consolidated.mergedCount;
        await saveProfileFn(member.profileFileId, consolidated.profile);
      }
    } catch (err) {
      console.warn(`[Cleanup Timeline] Lỗi dọn hồ sơ của ${member.name}:`, err);
    }
  }

  onProgress?.({ percent: 100, message: 'Đã dọn dẹp thành công toàn bộ thư mục về trạng thái duy nhất!' });
  return { deletedRawFiles, mergedEvents };
}
