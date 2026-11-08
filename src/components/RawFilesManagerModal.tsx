import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
  PlayCircle,
} from 'lucide-react';
import type { FamilyMember, HealthProfile, HealthSource } from '../types';
import { downloadDriveFile, type HealthDriveWorkspace } from '../utils/healthDriveService';

import { formatDateTimeVN } from '../utils/formatters';

interface RawFilesManagerModalProps {
  isOpen: boolean;
  workspace: HealthDriveWorkspace | null;
  members: FamilyMember[];
  profiles: Record<string, HealthProfile>;
  onClose: () => void;
  onRunOcrForSource: (member: FamilyMember, source: HealthSource) => Promise<void>;
  onRefreshWorkspace: () => Promise<void>;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

export function RawFilesManagerModal({
  isOpen,
  workspace,
  members,
  profiles,
  onClose,
  onRunOcrForSource,
  onRefreshWorkspace,
  showToast,
}: RawFilesManagerModalProps) {
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  if (!isOpen || !workspace) return null;

  // Gather all sources across all family member profiles
  const allSources: Array<{ member: FamilyMember; source: HealthSource }> = [];
  for (const member of members) {
    const prof = profiles[member.id];
    if (prof && Array.isArray(prof.sources)) {
      for (const source of prof.sources) {
        allSources.push({ member, source });
      }
    }
  }

  const processedCount = allSources.filter((s) => s.source.status === 'processed').length;
  const pendingCount = allSources.length - processedCount;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-3 overflow-y-auto animate-in fade-in duration-200"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="raw-manager-title"
        className="my-auto max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col border border-slate-100"
      >
        {/* Header */}
        <div className="bg-slate-900 text-white p-4 sm:p-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-teal-500/20 border border-teal-500/30 flex items-center justify-center text-teal-400">
              <FolderOpen className="w-5 h-5" />
            </div>
            <div>
              <h3 id="raw-manager-title" className="text-sm sm:text-base font-bold text-white">
                Quản lý Tài liệu Gốc
              </h3>
              <p className="text-[11px] text-slate-300">
                Tổng số: <strong>{allSources.length}</strong> tệp ({processedCount} đã số hóa, {pendingCount} đang chờ/dang dở)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
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
              className="p-2 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition-colors"
              title="Làm mới từ Google Drive"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body list */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-3 flex-1 text-slate-800">
          {allSources.length === 0 ? (
            <div className="text-center py-12 space-y-2">
              <FileText className="w-12 h-12 text-slate-300 mx-auto" />
              <h4 className="font-bold text-slate-700 text-sm">Chưa có tài liệu gốc</h4>
              <p className="text-xs text-slate-500">Hãy tải lên tài liệu PDF hoặc ảnh chụp để hệ thống bắt đầu số hóa tự động.</p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {allSources.map(({ member, source }) => {
                const isProcessed = source.status === 'processed';
                const isProcessing = processingId === source.driveFileId;
                const formattedSize = source.fileSize
                  ? source.fileSize > 1024 * 1024
                    ? `${(source.fileSize / (1024 * 1024)).toFixed(1)} MB`
                    : `${Math.round(source.fileSize / 1024)} KB`
                  : 'N/A';
                const isImage = source.mimeType?.startsWith('image/') || /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(source.fileName);
                const totalPages = typeof source.totalPages === 'number' && source.totalPages > 0 ? source.totalPages : (isImage ? 1 : 1);
                const processedPages = isProcessed ? (source.processedPages || totalPages) : (source.processedPages || 0);

                return (
                  <div
                    key={source.driveFileId}
                    className={`p-3.5 rounded-2xl border transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                      isProcessed
                        ? 'bg-emerald-50/30 border-emerald-200/80'
                        : 'bg-amber-50/40 border-amber-200'
                    }`}
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                          isProcessed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {isProcessed ? <CheckCircle2 className="w-5 h-5" /> : <Clock className="w-5 h-5" />}
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-xs sm:text-sm font-extrabold text-slate-900 truncate">
                          {source.fileName}
                        </h4>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500 mt-0.5">
                          <span>
                            {source.subjectStatus === 'unresolved'
                              ? <strong className="text-amber-800">Chưa xác định chủ thể</strong>
                              : <>Thành viên: <strong>{member.name}</strong></>}
                          </span>
                          <span>·</span>
                          <span>Dung lượng: {formattedSize}</span>
                          <span>·</span>
                          <span className="text-slate-700 font-semibold">Trang OCR: <strong className="text-slate-900">{processedPages}/{totalPages} trang</strong></span>
                          <span>·</span>
                          <span>Tải lên: {formatDateTimeVN(source.uploadedAt)}</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
                      <button
                        type="button"
                        disabled={viewingId === source.driveFileId}
                        onClick={async () => {
                          const previewWindow = window.open('', '_blank');
                          if (!previewWindow) {
                            showToast('Không thể mở tài liệu. Hãy cho phép cửa sổ bật lên rồi thử lại.', 'error');
                            return;
                          }
                          setViewingId(source.driveFileId);
                          try {
                            const downloaded = await downloadDriveFile(source.driveFileId);
                            const blob = source.mimeType
                              ? new Blob([downloaded], { type: source.mimeType })
                              : downloaded;
                            const url = URL.createObjectURL(blob);
                            previewWindow.location.href = url;
                            previewWindow.addEventListener(
                              'beforeunload',
                              () => URL.revokeObjectURL(url),
                              { once: true },
                            );
                          } catch (error) {
                            previewWindow.close();
                            showToast(
                              error instanceof Error ? `Không thể mở tài liệu: ${error.message}` : 'Không thể mở tài liệu gốc.',
                              'error',
                            );
                          } finally {
                            setViewingId(null);
                          }
                        }}
                        className="px-3 py-1.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-bold text-xs flex items-center gap-1.5 transition-all disabled:opacity-50"
                        title="Mở tài liệu gốc để xem"
                      >
                        {viewingId === source.driveFileId ? (
                          <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                        <span>{viewingId === source.driveFileId ? 'Đang mở...' : 'Xem tài liệu'}</span>
                      </button>
                      <span
                        className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold ${
                          isProcessed
                            ? 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                            : 'bg-amber-100 text-amber-800 border border-amber-200'
                        }`}
                      >
                        {isProcessed
                          ? `Đã số hóa xong (${processedPages}/${totalPages} trang)`
                          : source.subjectStatus === 'unresolved'
                            ? 'Chưa xác định chủ thể'
                            : `Chờ số hóa / Dang dở (${processedPages}/${totalPages} trang)`}
                      </span>

                      <button
                        type="button"
                        disabled={isProcessing}
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
                        className="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center gap-1.5 transition-all shadow-xs disabled:opacity-50 active:scale-95"
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
        <div className="p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <span>Hệ thống tự động bỏ qua các tệp đã số hóa toàn bộ để tối ưu quota.</span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold"
          >
            Đóng
          </button>
        </div>
      </section>
    </div>
  );
}
