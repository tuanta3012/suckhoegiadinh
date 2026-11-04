import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Eye,
  FileText,
  FolderOpen,
  RefreshCw,
  Sparkles,
  Upload,
  User,
  X,
} from 'lucide-react';
import type { HealthEvent } from '../types';
import type { FileDuplicateMatch } from '../utils/deduplicationService';

interface DuplicateDocumentModalProps {
  isOpen: boolean;
  file: File | null;
  match: FileDuplicateMatch | null;
  currentMemberName: string;
  onViewExisting: (linkedEvent: HealthEvent, memberId?: string) => void;
  onProceedReScan: () => void;
  onProceedForceNew: () => void;
  onCancel: () => void;
}

export function DuplicateDocumentModal({
  isOpen,
  file,
  match,
  currentMemberName,
  onViewExisting,
  onProceedReScan,
  onProceedForceNew,
  onCancel,
}: DuplicateDocumentModalProps) {
  if (!isOpen || !file || !match) return null;

  const isCrossMember = match.memberName && match.memberName !== currentMemberName;
  const isProcessed = match.existingSource.status === 'processed';
  const linkedEvent = match.linkedEvent;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-white border border-amber-200/80 w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-amber-100 bg-amber-50/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-amber-500 text-white flex items-center justify-center shadow-md shadow-amber-500/20">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base sm:text-lg text-slate-900 flex items-center gap-2">
                Phát hiện tài liệu đã tồn tại
              </h3>
              <p className="text-xs text-amber-900/80">
                {isCrossMember
                  ? `Tệp này đã có trong hồ sơ của ${match.memberName}`
                  : `Tệp này đã có trong hồ sơ của ${currentMemberName}`}
              </p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-2 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-amber-100/60 transition-colors"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-4 text-slate-700 text-xs sm:text-sm">
          {/* File summary card */}
          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-2xl space-y-2">
            <div className="flex items-start gap-2.5">
              <FileText className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="font-bold text-slate-900 block truncate text-xs sm:text-sm">
                  {file.name}
                </span>
                <span className="text-[11px] text-slate-500">
                  Kích thước: {(file.size / 1024).toFixed(1)} KB • {file.type || 'Tài liệu y tế'}
                </span>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
              <span className="flex items-center gap-1">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                Đã tải lên lúc: {new Date(match.existingSource.uploadedAt).toLocaleDateString('vi-VN')}
              </span>
              <span
                className={`px-2 py-0.5 rounded-full font-bold text-[10px] ${
                  isProcessed
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {isProcessed ? '✓ Đã số hóa vào dòng thời gian' : 'Đang chờ số hóa'}
              </span>
            </div>
          </div>

          {/* Linked Event Preview (if already digitized) */}
          {linkedEvent && (
            <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-2xl space-y-2">
              <div className="flex items-center gap-1.5 text-emerald-900 font-bold text-xs uppercase tracking-wide">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>Hồ sơ đã được số hóa trước đó:</span>
              </div>
              <div className="bg-white p-2.5 rounded-xl border border-emerald-100 text-xs space-y-1">
                <div className="font-bold text-slate-900 flex items-center justify-between">
                  <span>{linkedEvent.title}</span>
                  <span className="text-emerald-700 font-mono text-[11px]">{linkedEvent.date}</span>
                </div>
                {linkedEvent.facility && (
                  <div className="text-slate-500 text-[11px]">Tại: {linkedEvent.facility}</div>
                )}
                {linkedEvent.diagnoses && linkedEvent.diagnoses.length > 0 && (
                  <div className="text-slate-600 text-[11px] truncate">
                    Chẩn đoán: {linkedEvent.diagnoses.join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Cross Member Notice */}
          {isCrossMember && (
            <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-xl text-indigo-900 text-xs flex items-start gap-2">
              <User className="w-4 h-4 text-indigo-600 mt-0.5 shrink-0" />
              <div>
                <b>Lưu ý thành viên:</b> Tệp này trước đây được lưu cho{' '}
                <b>{match.memberName}</b>, trong khi bạn đang chọn <b>{currentMemberName}</b>.
              </div>
            </div>
          )}

          {/* Resolution Options */}
          <div className="space-y-2 pt-2">
            <span className="text-xs font-bold text-slate-900 block">
              Bạn muốn xử lý tệp này thế nào?
            </span>

            {/* Option 1: View Existing Event */}
            {linkedEvent && (
              <button
                type="button"
                onClick={() => onViewExisting(linkedEvent, match.memberId)}
                className="w-full text-left p-3 rounded-2xl border-2 border-emerald-500 bg-emerald-50/50 hover:bg-emerald-50 active:scale-[0.99] transition-all flex items-center justify-between gap-3 group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                    <Eye className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="font-bold text-emerald-950 block text-xs sm:text-sm">
                      Xem lại hồ sơ đã lưu (Khuyên dùng)
                    </span>
                    <span className="text-[11px] text-emerald-800 block">
                      Không tải trùng lặp, mở ngay sự kiện trong dòng thời gian.
                    </span>
                  </div>
                </div>
                <ArrowRight className="w-4 h-4 text-emerald-600 group-hover:translate-x-0.5 transition-transform shrink-0" />
              </button>
            )}

            {/* Option 2: Re-scan and Update */}
            <button
              type="button"
              onClick={onProceedReScan}
              className="w-full text-left p-3 rounded-2xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 active:scale-[0.99] transition-all flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
                  <RefreshCw className="w-4 h-4" />
                </div>
                <div>
                  <span className="font-bold text-slate-900 block text-xs sm:text-sm">
                    Quét lại & Cập nhật dữ liệu
                  </span>
                  <span className="text-[11px] text-slate-500 block">
                    Chạy lại AI để nhận dạng thêm thông tin và cập nhật vào hồ sơ.
                  </span>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
            </button>

            {/* Option 3: Force New Upload */}
            <button
              type="button"
              onClick={onProceedForceNew}
              className="w-full text-left p-3 rounded-2xl border border-slate-200 hover:border-slate-300 hover:bg-slate-50 active:scale-[0.99] transition-all flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                  <Upload className="w-4 h-4" />
                </div>
                <div>
                  <span className="font-semibold text-slate-800 block text-xs">
                    Vẫn tải lên như tệp riêng biệt mới
                  </span>
                  <span className="text-[11px] text-slate-400 block">
                    Lưu bản sao mới lên Google Drive và tạo hồ sơ độc lập.
                  </span>
                </div>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400 shrink-0" />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl border border-slate-200 font-bold text-xs text-slate-600 hover:bg-slate-100 transition-colors"
          >
            Hủy thao tác
          </button>
        </div>
      </div>
    </div>
  );
}
