import React, { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Share } from '@capacitor/share';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  FolderOpen,
  LoaderCircle,
  PlayCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import type { FamilyMember, HealthProfile, HealthSource } from '../types';
import { downloadDriveFile, type HealthDriveWorkspace } from '../utils/healthDriveService';
import { fileFromLocalSource } from '../utils/localSyncOutbox';
import { formatDateVN } from '../utils/formatters';
import type { OcrRecoveryJob } from '../utils/ocrRecoveryStorage';
import { BackPriority, useBackHandler } from '../utils/backNavigation';

interface RawFilesManagerModalProps {
  isOpen: boolean;
  workspace: HealthDriveWorkspace | null;
  members: FamilyMember[];
  profiles: Record<string, HealthProfile>;
  selectedMemberId?: string;
  recoveryJobs?: OcrRecoveryJob[];
  localOwnerKey: string;
  isBatchBusy?: boolean;
  onClose: () => void;
  onRunOcrForSource: (member: FamilyMember, source: HealthSource) => Promise<void>;
  onRefreshWorkspace: () => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

type StatusFilter = 'all' | 'error_pending' | 'processed';

interface ManagedRawEntry {
  key: string;
  member: FamilyMember;
  source: HealthSource;
  recoveryJob?: OcrRecoveryJob;
  isProcessed: boolean;
  isErrorOrPending: boolean;
  errorHint?: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error('Không thể đọc dữ liệu tệp.'));
    reader.readAsDataURL(blob);
  });
}

function sanitizeNativeFileName(fileName: string, driveFileId: string): string {
  const cleanBase = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${driveFileId.slice(-8)}_${cleanBase || 'document.pdf'}`;
}

function formatCompactSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function RawFilesManagerModal({
  isOpen,
  workspace,
  members,
  profiles,
  selectedMemberId,
  recoveryJobs = [],
  localOwnerKey,
  isBatchBusy = false,
  onClose,
  onRunOcrForSource,
  onRefreshWorkspace,
  showToast,
}: RawFilesManagerModalProps) {
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [memberFilter, setMemberFilter] = useState<string>(selectedMemberId || 'all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    if (isOpen) {
      setMemberFilter(selectedMemberId || 'all');
      setStatusFilter('all');
    }
  }, [isOpen, selectedMemberId]);

  const recoveryByFileId = useMemo(() => {
    const map = new Map<string, OcrRecoveryJob>();
    for (const job of recoveryJobs) {
      map.set(job.driveFileId, job);
    }
    return map;
  }, [recoveryJobs]);

  const allEntries = useMemo<ManagedRawEntry[]>(() => {
    const entries: ManagedRawEntry[] = [];
    const seenFileIds = new Set<string>();

    for (const member of members) {
      const prof = profiles[member.id];
      const sources = Array.isArray(prof?.sources) ? prof.sources : [];
      const linkedSourceIds = new Set(
        (prof?.timeline || []).flatMap((event) => [
          event.sourceFileId,
          ...(event.additionalSources || []).map((item) => item.driveFileId),
        ]),
      );

      for (const source of sources) {
        if (source.relocatedToMemberId || seenFileIds.has(source.driveFileId)) continue;
        seenFileIds.add(source.driveFileId);

        const recoveryJob = recoveryByFileId.get(source.driveFileId);
        const isDeletedRaw = Boolean(source.rawDeletedAt);
        const hasLinkedEvent = linkedSourceIds.has(source.driveFileId);
        const isProcessed = source.status === 'processed' && (hasLinkedEvent || isDeletedRaw);
        const isUnresolved = source.subjectStatus === 'unresolved';
        const isErrorOrPending =
          !isProcessed ||
          isUnresolved ||
          (Boolean(recoveryJob) && recoveryJob?.status !== 'processing');

        let errorHint: string | undefined;
        if (isUnresolved || recoveryJob?.status === 'needs_review') {
          errorHint = 'Chưa xác định được thành viên';
        } else if (recoveryJob?.status === 'interrupted') {
          errorHint =
            recoveryJob.totalPages && typeof recoveryJob.processedPages === 'number'
              ? `OCR gián đoạn (${recoveryJob.processedPages}/${recoveryJob.totalPages} trang) — cần chạy lại`
              : 'OCR bị gián đoạn — cần chạy lại';
        } else if (source.status === 'processed' && !hasLinkedEvent && !isDeletedRaw) {
          errorHint = 'Đã đọc OCR nhưng chưa gắn vào dòng thời gian';
        } else if (source.status !== 'processed') {
          errorHint = 'Chưa hoàn tất số hóa OCR';
        }

        entries.push({
          key: source.driveFileId,
          member,
          source,
          recoveryJob,
          isProcessed,
          isErrorOrPending,
          errorHint,
        });
      }
    }

    // Surface any orphan recovery jobs not yet represented in profile.sources
    for (const job of recoveryJobs) {
      if (seenFileIds.has(job.driveFileId)) continue;
      const member = members.find((m) => m.id === selectedMemberId) || members[0];
      if (!member) continue;
      seenFileIds.add(job.driveFileId);
      entries.push({
        key: job.driveFileId,
        member,
        source: {
          driveFileId: job.driveFileId,
          fileName: job.fileName || 'Tài liệu đang xử lý',
          mimeType: 'application/pdf',
          uploadedAt: new Date(job.updatedAt || Date.now()).toISOString(),
          status: 'pending',
          subjectStatus: job.status === 'needs_review' ? 'unresolved' : undefined,
          totalPages: job.totalPages,
          processedPages: job.processedPages,
        },
        recoveryJob: job,
        isProcessed: false,
        isErrorOrPending: true,
        errorHint:
          job.status === 'needs_review'
            ? 'Chưa rõ chủ thể — cần chọn thành viên'
            : job.totalPages && typeof job.processedPages === 'number'
              ? `OCR gián đoạn (${job.processedPages}/${job.totalPages} trang) — chờ chạy lại`
              : 'Đang lỗi hoặc chờ chạy lại OCR',
      });
    }

    return entries.sort((a, b) => {
      if (a.isErrorOrPending !== b.isErrorOrPending) return a.isErrorOrPending ? -1 : 1;
      return (b.source.uploadedAt || '').localeCompare(a.source.uploadedAt || '');
    });
  }, [members, profiles, recoveryByFileId, recoveryJobs, selectedMemberId]);

  const memberCounts = useMemo(() => {
    const map = new Map<string, { total: number; errorPending: number }>();
    for (const entry of allEntries) {
      const prev = map.get(entry.member.id) || { total: 0, errorPending: 0 };
      map.set(entry.member.id, {
        total: prev.total + 1,
        errorPending: prev.errorPending + (entry.isErrorOrPending ? 1 : 0),
      });
    }
    return map;
  }, [allEntries]);

  const memberScopedEntries = useMemo(() => {
    if (memberFilter === 'all') return allEntries;
    return allEntries.filter((entry) => entry.member.id === memberFilter);
  }, [allEntries, memberFilter]);

  const errorPendingCount = memberScopedEntries.filter((entry) => entry.isErrorOrPending).length;
  const processedCount = memberScopedEntries.length - errorPendingCount;

  const visibleEntries = useMemo(() => {
    if (statusFilter === 'error_pending') {
      return memberScopedEntries.filter((entry) => entry.isErrorOrPending);
    }
    if (statusFilter === 'processed') {
      return memberScopedEntries.filter((entry) => !entry.isErrorOrPending);
    }
    return memberScopedEntries;
  }, [memberScopedEntries, statusFilter]);

  useBackHandler(
    isOpen && Boolean(workspace),
    () => {
      if (!processingId && !viewingId) onClose();
      return true;
    },
    BackPriority.MODAL,
  );

  if (!isOpen || !workspace) return null;

  async function handleViewSource(source: HealthSource) {
    if (source.rawDeletedAt) {
      showToast('Tệp gốc trùng/đã gộp đã được dọn vào Thùng rác.', 'info');
      return;
    }

    setViewingId(source.driveFileId);
    try {
      const downloaded = source.driveFileId.startsWith('local_file_')
        ? await fileFromLocalSource(source.driveFileId, localOwnerKey)
        : await downloadDriveFile(source.driveFileId);
      const mimeType =
        source.mimeType ||
        downloaded.type ||
        (source.fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
      const blob = new Blob([downloaded], { type: mimeType });

      if (Capacitor.isNativePlatform()) {
        const base64Data = await blobToBase64(blob);
        const safeName = sanitizeNativeFileName(source.fileName, source.driveFileId);
        const writeRes = await Filesystem.writeFile({
          path: safeName,
          data: base64Data,
          directory: Directory.Cache,
        });
        try {
          await FileOpener.open({
            filePath: writeRes.uri,
            contentType: mimeType,
          });
        } catch {
          const formattedUri =
            writeRes.uri.startsWith('file://') || writeRes.uri.startsWith('content://')
              ? writeRes.uri
              : `file://${writeRes.uri.startsWith('/') ? '' : '/'}${writeRes.uri}`;
          await Share.share({
            title: source.fileName,
            url: formattedUri,
            dialogTitle: 'Mở tài liệu',
          });
        }
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      showToast(
        error instanceof Error ? `Không thể mở tệp: ${error.message}` : 'Không thể mở tài liệu.',
        'error',
      );
    } finally {
      setViewingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-2.5 sm:p-4 overflow-y-auto animate-in fade-in duration-150"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="raw-manager-title"
        className="my-auto max-h-[92dvh] w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col border border-slate-100"
      >
        {/* Compact Header */}
        <div className="bg-slate-900 text-white px-4 py-3 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-teal-500/20 border border-teal-500/30 flex items-center justify-center text-teal-400 shrink-0">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 id="raw-manager-title" className="text-sm font-bold text-white leading-tight">
                Tài liệu gốc
              </h3>
              <p className="text-[11px] text-slate-300 tabular-nums">
                {memberScopedEntries.length} tệp · {processedCount} xong
                {errorPendingCount > 0 ? ` · ${errorPendingCount} lỗi/chờ` : ''}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={async () => {
                setIsRefreshing(true);
                try {
                  await onRefreshWorkspace();
                  showToast('Đã làm mới danh sách tài liệu.', 'success');
                } catch {
                  showToast('Không thể làm mới danh sách.', 'error');
                } finally {
                  setIsRefreshing(false);
                }
              }}
              disabled={isRefreshing}
              className="h-9 w-9 flex items-center justify-center rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition-colors"
              aria-label="Làm mới"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 w-9 flex items-center justify-center rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
              aria-label="Đóng"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Member & Status Filter Bar */}
        <div className="px-3 py-2.5 bg-slate-50 border-b border-slate-200/80 space-y-2 shrink-0">
          {members.length > 1 && (
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              {members.map((member) => {
                const counts = memberCounts.get(member.id) || { total: 0, errorPending: 0 };
                const active = memberFilter === member.id;
                return (
                  <button
                    key={member.id}
                    type="button"
                    onClick={() => setMemberFilter(member.id)}
                    className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors ${
                      active
                        ? 'bg-emerald-600 text-white shadow-2xs'
                        : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {member.name} ({counts.total})
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setMemberFilter('all')}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors ${
                  memberFilter === 'all'
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                }`}
              >
                Tất cả ({allEntries.length})
              </button>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                statusFilter === 'all'
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              Tất cả ({memberScopedEntries.length})
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('error_pending')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors flex items-center gap-1 ${
                statusFilter === 'error_pending'
                  ? 'bg-amber-600 text-white'
                  : errorPendingCount > 0
                    ? 'bg-amber-50 border border-amber-300 text-amber-900 hover:bg-amber-100'
                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              {errorPendingCount > 0 && <AlertTriangle className="w-3 h-3" />}
              <span>Lỗi / Chờ ({errorPendingCount})</span>
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('processed')}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                statusFilter === 'processed'
                  ? 'bg-emerald-700 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
              }`}
            >
              Đã xong ({processedCount})
            </button>
          </div>
        </div>

        {/* Dense Multi-Row File List */}
        <div className="p-2.5 sm:p-3 overflow-y-auto overscroll-y-contain flex-1 min-h-0 text-slate-800 divide-y divide-slate-100">
          {visibleEntries.length === 0 ? (
            <div className="text-center py-10 space-y-1.5">
              <FileText className="w-10 h-10 text-slate-300 mx-auto" />
              <p className="font-bold text-slate-700 text-sm">
                {statusFilter === 'error_pending'
                  ? 'Không có tài liệu lỗi hoặc chờ xử lý'
                  : 'Chưa có tài liệu nào'}
              </p>
            </div>
          ) : (
            visibleEntries.map(({ key, member, source, isProcessed, isErrorOrPending, errorHint }) => {
              const isProcessing = processingId === source.driveFileId;
              const isViewing = viewingId === source.driveFileId;
              const isDeletedRaw = Boolean(source.rawDeletedAt);
              const indexedPageCount = source.contentIndexPages?.length || 0;
              const totalPages =
                typeof source.totalPages === 'number' && source.totalPages > 0
                  ? source.totalPages
                  : Math.max(indexedPageCount, 1);
              const processedPages = isProcessed
                ? Math.max(source.processedPages || 0, indexedPageCount, totalPages)
                : Math.max(source.processedPages || 0, indexedPageCount);

              return (
                <div
                  key={key}
                  className={`py-2.5 px-2 rounded-xl transition-colors ${
                    isErrorOrPending ? 'bg-amber-50/50 my-1' : 'hover:bg-slate-50/80'
                  }`}
                >
                  {/* Line 1: Icon + Filename + Compact Badge */}
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span
                        className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
                          isDeletedRaw
                            ? 'bg-slate-100 text-slate-500'
                            : isErrorOrPending
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-100 text-emerald-700'
                        }`}
                      >
                        {isErrorOrPending ? (
                          <Clock className="w-3.5 h-3.5" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        )}
                      </span>
                      <span
                        className="text-xs font-bold text-slate-900 truncate"
                        title={source.fileName}
                      >
                        {source.fileName}
                      </span>
                    </div>

                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap shrink-0 tabular-nums ${
                        isDeletedRaw
                          ? 'bg-slate-100 text-slate-600'
                          : isErrorOrPending
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-emerald-100 text-emerald-800'
                      }`}
                    >
                      {isDeletedRaw
                        ? 'Đã gộp'
                        : isErrorOrPending
                          ? source.subjectStatus === 'unresolved'
                            ? 'Chưa rõ chủ thể'
                            : `Chờ ${processedPages}/${totalPages}`
                          : `Xong ${processedPages}/${totalPages}`}
                    </span>
                  </div>

                  {/* Optional concise error hint */}
                  {errorHint && !isDeletedRaw && (
                    <p className="mt-1 pl-8 text-[11px] font-medium text-amber-800 truncate">
                      {errorHint}
                    </p>
                  )}

                  {/* Line 2: Compact inline metadata + action buttons */}
                  <div className="mt-1.5 pl-8 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-500 truncate tabular-nums">
                      {[
                        memberFilter === 'all' ? member.name : null,
                        formatCompactSize(source.fileSize),
                        `${totalPages} tr`,
                        source.uploadedAt ? formatDateVN(source.uploadedAt) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={isViewing || isDeletedRaw}
                        onClick={() => void handleViewSource(source)}
                        className="min-h-[34px] px-2.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-[11px] inline-flex items-center gap-1 whitespace-nowrap disabled:opacity-45"
                      >
                        {isViewing ? (
                          <LoaderCircle className="w-3 h-3 animate-spin" />
                        ) : (
                          <Eye className="w-3 h-3" />
                        )}
                        <span>Xem</span>
                      </button>

                      <button
                        type="button"
                        disabled={isProcessing || isBatchBusy || isDeletedRaw}
                        onClick={async () => {
                          setProcessingId(source.driveFileId);
                          try {
                            await onRunOcrForSource(member, source);
                            showToast(`Đã chạy lại OCR cho ${source.fileName}`, 'success');
                          } catch (error) {
                            showToast(error instanceof Error ? error.message : 'Lỗi chạy lại OCR.', 'error');
                          } finally {
                            setProcessingId(null);
                          }
                        }}
                        className="min-h-[34px] px-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-[11px] inline-flex items-center gap-1 whitespace-nowrap disabled:opacity-45 active:scale-95"
                      >
                        {isProcessing ? (
                          <RefreshCw className="w-3 h-3 animate-spin" />
                        ) : (
                          <PlayCircle className="w-3 h-3 text-emerald-400" />
                        )}
                        <span>{isProcessing ? 'Đang OCR' : 'OCR lại'}</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Compact Footer */}
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-100 flex justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[38px] px-4 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-bold"
          >
            Đóng
          </button>
        </div>
      </section>
    </div>
  );
}
