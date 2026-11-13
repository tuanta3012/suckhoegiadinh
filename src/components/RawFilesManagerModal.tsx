import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Share } from '@capacitor/share';
import {
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
import { formatDateTimeVN } from '../utils/formatters';

interface RawFilesManagerModalProps {
  isOpen: boolean;
  workspace: HealthDriveWorkspace | null;
  members: FamilyMember[];
  profiles: Record<string, HealthProfile>;
  localOwnerKey: string;
  isBatchBusy?: boolean;
  onClose: () => void;
  onRunOcrForSource: (member: FamilyMember, source: HealthSource) => Promise<void>;
  onRefreshWorkspace: () => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
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

export function RawFilesManagerModal({
  isOpen,
  workspace,
  members,
  profiles,
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

  if (!isOpen || !workspace) return null;

  // Gather active (non-relocated) sources across all family member profiles
  const allSources: Array<{ member: FamilyMember; source: HealthSource }> = [];
  const seenFileIds = new Set<string>();
  for (const member of members) {
    const prof = profiles[member.id];
    if (prof && Array.isArray(prof.sources)) {
      for (const source of prof.sources) {
        if (source.relocatedToMemberId || seenFileIds.has(source.driveFileId)) continue;
        seenFileIds.add(source.driveFileId);
        allSources.push({ member, source });
      }
    }
  }

  const processedCount = allSources.filter((s) => s.source.status === 'processed').length;
  const pendingCount = allSources.length - processedCount;

  async function handleViewSource(source: HealthSource) {
    if (source.rawDeletedAt) {
      showToast('Tệp raw đã được dọn vào Thùng rác sau khi gộp dữ liệu vào bản đầy đủ hơn.', 'info');
      return;
    }

    setViewingId(source.driveFileId);
    try {
      const downloaded = source.driveFileId.startsWith('local_file_')
        ? await fileFromLocalSource(source.driveFileId, localOwnerKey)
        : await downloadDriveFile(source.driveFileId);
      const mimeType = source.mimeType || downloaded.type || (source.fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
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
          const formattedUri = writeRes.uri.startsWith('file://') || writeRes.uri.startsWith('content://')
            ? writeRes.uri
            : `file://${writeRes.uri.startsWith('/') ? '' : '/'}${writeRes.uri}`;
          await Share.share({
            title: source.fileName,
            url: formattedUri,
            dialogTitle: 'Mở tài liệu bằng ứng dụng xem PDF / Ảnh',
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
        error instanceof Error ? `Không thể mở tài liệu: ${error.message}` : 'Không thể mở tài liệu gốc.',
        'error',
      );
    } finally {
      setViewingId(null);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-200"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="raw-manager-title"
        className="my-auto max-h-[90dvh] w-full max-w-3xl overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col border border-slate-100"
      >
        {/* Header */}
        <div className="bg-slate-900 text-white p-4 sm:p-5 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-teal-500/20 border border-teal-500/30 flex items-center justify-center text-teal-400 shrink-0">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 id="raw-manager-title" className="text-sm sm:text-base font-bold text-white truncate">
                Quản lý Tài liệu Gốc
              </h3>
              <p className="text-[11px] sm:text-xs text-slate-300">
                Tổng số: <strong>{allSources.length}</strong> tệp ({processedCount} đã số hóa, {pendingCount} đang chờ/dang dở)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={async () => {
                setIsRefreshing(true);
                try {
                  await onRefreshWorkspace();
                  showToast('Đã làm mới danh sách tài liệu từ Google Drive.', 'success');
                } catch {
                  showToast('Không thể làm mới danh sách từ Drive.', 'error');
                } finally {
                  setIsRefreshing(false);
                }
              }}
              disabled={isRefreshing}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition-colors"
              title="Làm mới từ Google Drive"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
              aria-label="Đóng"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body list */}
        <div className="p-4 sm:p-5 overflow-y-auto overscroll-y-contain space-y-3 flex-1 min-h-0 text-slate-800">
          {allSources.length === 0 ? (
            <div className="text-center py-12 space-y-2">
              <FileText className="w-12 h-12 text-slate-300 mx-auto" />
              <h4 className="font-bold text-slate-700 text-sm">Chưa có tài liệu gốc</h4>
              <p className="text-xs text-slate-500">Hãy tải lên tài liệu PDF hoặc ảnh chụp để hệ thống bắt đầu số hóa tự động.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {allSources.map(({ member, source }) => {
                const isProcessed = source.status === 'processed';
                const isProcessing = processingId === source.driveFileId;
                const isViewing = viewingId === source.driveFileId;
                const isDeletedRaw = Boolean(source.rawDeletedAt);
                const formattedSize = source.fileSize
                  ? source.fileSize > 1024 * 1024
                    ? `${(source.fileSize / (1024 * 1024)).toFixed(1)} MB`
                    : `${Math.round(source.fileSize / 1024)} KB`
                  : 'N/A';
                const isImage = source.mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(source.fileName);
                const indexedPageCount = source.contentIndexPages?.length || 0;
                const totalPages = typeof source.totalPages === 'number' && source.totalPages > 0
                  ? source.totalPages
                  : Math.max(indexedPageCount, isImage ? 1 : 1);
                const processedPages = isProcessed
                  ? Math.max(source.processedPages || 0, indexedPageCount, totalPages)
                  : Math.max(source.processedPages || 0, indexedPageCount);

                return (
                  <div
                    key={source.driveFileId}
                    className={`p-3.5 sm:p-4 rounded-2xl border transition-all flex flex-col gap-3 ${
                      isProcessed
                        ? 'bg-emerald-50/35 border-emerald-200/80'
                        : 'bg-amber-50/45 border-amber-200'
                    }`}
                  >
                    {/* Top band: icon + file details + concise status badge */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                            isProcessed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {isProcessed ? <CheckCircle2 className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4
                            className="text-xs sm:text-sm font-extrabold text-slate-900 break-words leading-snug"
                            title={source.fileName}
                          >
                            {source.fileName}
                          </h4>
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] sm:text-xs text-slate-600 mt-1">
                            <span className="whitespace-nowrap">
                              {source.subjectStatus === 'unresolved'
                                ? <strong className="text-amber-800">Chưa xác định chủ thể</strong>
                                : <>Thành viên: <strong className="text-slate-900">{member.name}</strong></>}
                            </span>
                            <span className="text-slate-300">·</span>
                            <span className="whitespace-nowrap">Dung lượng: <strong>{formattedSize}</strong></span>
                            <span className="text-slate-300">·</span>
                            <span className="whitespace-nowrap font-semibold text-slate-700">
                              Trang OCR: <strong className="text-slate-900 tabular-nums">{processedPages}/{totalPages} trang</strong>
                            </span>
                            <span className="text-slate-300">·</span>
                            <span className="whitespace-nowrap">Tải lên: {formatDateTimeVN(source.uploadedAt)}</span>
                          </div>
                        </div>
                      </div>

                      <span
                        className={`px-2.5 py-1 rounded-full text-[10px] sm:text-[11px] font-extrabold whitespace-nowrap shrink-0 ${
                          isDeletedRaw
                            ? 'bg-slate-100 text-slate-700 border border-slate-200'
                            : isProcessed
                              ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                              : 'bg-amber-100 text-amber-800 border border-amber-200'
                        }`}
                      >
                        {isDeletedRaw
                          ? 'Đã gộp · Raw đã dọn'
                          : isProcessed
                            ? `Đã số hóa (${processedPages}/${totalPages})`
                            : source.subjectStatus === 'unresolved'
                              ? 'Chưa rõ chủ thể'
                              : `Chờ số hóa (${processedPages}/${totalPages})`}
                      </span>
                    </div>

                    {/* Bottom action bar */}
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2.5 border-t border-slate-200/70">
                      <button
                        type="button"
                        disabled={isViewing || isDeletedRaw}
                        onClick={() => void handleViewSource(source)}
                        className="min-h-[40px] px-3.5 py-2 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all disabled:opacity-50"
                        title={isDeletedRaw ? 'Tệp raw đã được dọn vào Thùng rác' : 'Mở tài liệu gốc để xem'}
                      >
                        {isViewing ? (
                          <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                        <span>{isViewing ? 'Đang mở...' : 'Xem tài liệu'}</span>
                      </button>

                      <button
                        type="button"
                        disabled={isProcessing || isBatchBusy || isDeletedRaw}
                        onClick={async () => {
                          setProcessingId(source.driveFileId);
                          try {
                            await onRunOcrForSource(member, source);
                            showToast(`Đã chạy lại OCR thành công cho ${source.fileName}`, 'success');
                          } catch (error) {
                            showToast(error instanceof Error ? error.message : 'Lỗi khi chạy lại số hóa tệp.', 'error');
                          } finally {
                            setProcessingId(null);
                          }
                        }}
                        title={isBatchBusy ? 'Hãy đợi hàng đợi hiện tại hoàn tất trước khi chạy lại OCR' : 'Chạy lại OCR cho tệp này'}
                        className="min-h-[40px] px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-all shadow-xs disabled:opacity-50 active:scale-95"
                      >
                        {isProcessing ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            <span>Đang xử lý...</span>
                          </>
                        ) : (
                          <>
                            <PlayCircle className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Chạy lại OCR</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3 text-xs text-slate-500 shrink-0">
          <span className="leading-snug">Hệ thống tự động bỏ qua các tệp đã số hóa toàn bộ để tối ưu quota.</span>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold whitespace-nowrap shrink-0"
          >
            Đóng
          </button>
        </div>
      </section>
    </div>
  );
}
