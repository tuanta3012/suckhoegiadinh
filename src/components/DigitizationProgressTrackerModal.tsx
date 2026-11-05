import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Building2,
  Calendar,
  CheckCircle2,
  FileStack,
  FileText,
  Loader2,
  RefreshCw,
  Scan,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import type { FamilyMember, HealthEvent } from '../types';
import type { DriveFile } from '../utils/healthDriveService';
import { isSamePersonName } from '../utils/formatters';

export type TrackerStep =
  | 'uploading_drive'
  | 'reading_document'
  | 'extracting_content'
  | 'matching_patient'
  | 'completed'
  | 'error';

interface DigitizationProgressTrackerModalProps {
  isOpen: boolean;
  file: File | null;
  member: FamilyMember;
  members: FamilyMember[];
  step: TrackerStep;
  progressPercent: number;
  progressMessage: string;
  driveFile: DriveFile | null;
  modelUsed?: string;
  partialExtracted: Partial<HealthEvent>;
  error?: string | null;
  detectedMemberMatch?: FamilyMember | null;
  isRoutingDecisionRequired?: boolean;
  onReview: () => void;
  onRetry: () => void;
  onManualEntry: () => void;
  onSaveToDetected?: () => void;
  onCreateNewMember?: () => void;
  onClose: () => void;
}

export function DigitizationProgressTrackerModal({
  isOpen,
  file,
  member,
  members,
  step,
  progressPercent,
  progressMessage,
  driveFile,
  modelUsed = 'gemini-3.5-flash-lite',
  partialExtracted,
  error,
  detectedMemberMatch,
  isRoutingDecisionRequired,
  onReview,
  onRetry,
  onManualEntry,
  onSaveToDetected,
  onCreateNewMember,
  onClose,
}: DigitizationProgressTrackerModalProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  // Generate local image preview thumbnail if file is an image
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    if (file.type.startsWith('image/')) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [file]);

  // Elapsed timer
  useEffect(() => {
    if (!isOpen || step === 'completed' || step === 'error') {
      return;
    }
    const timer = setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [isOpen, step]);

  if (!isOpen || !file) return null;

  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  const formattedSize =
    file.size > 1024 * 1024
      ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.round(file.size / 1024)} KB`;

  // Matched member calculation using intelligent Vietnamese name matching
  const patientNameOnDoc = partialExtracted.patientName?.trim() || '';
  const isMatchCurrent = !patientNameOnDoc || isSamePersonName(patientNameOnDoc, member.name);

  // Check if matches another existing family member
  const otherMatch = members.find(
    (m) => m.id !== member.id && isSamePersonName(patientNameOnDoc, m.name)
  );
  const effectiveDetectedMatch = detectedMemberMatch || otherMatch || null;

  const isMismatch = Boolean(!isMatchCurrent && effectiveDetectedMatch && effectiveDetectedMatch.id !== member.id);
  const isNewPersonDetected = Boolean(!isMatchCurrent && !effectiveDetectedMatch && patientNameOnDoc.length > 3);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-3 overflow-y-auto animate-in fade-in duration-200"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="tracker-title"
        className="my-auto max-h-[94vh] w-full max-w-xl overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col border border-slate-100"
      >
        {/* Header Bar */}
        <div className="bg-slate-900 text-white p-4 sm:p-5 flex items-start justify-between gap-3 relative overflow-hidden">
          <div className="absolute -right-12 -top-12 w-40 h-40 bg-emerald-500/10 rounded-full blur-2xl pointer-events-none" />
          
          <div className="flex items-center gap-3 min-w-0">
            {/* File Icon / Thumbnail */}
            <div className="w-12 h-12 rounded-2xl bg-slate-800 border border-slate-700/80 flex items-center justify-center shrink-0 overflow-hidden relative shadow-inner">
              {previewUrl ? (
                <img src={previewUrl} alt="Preview" className="w-full h-full object-cover" />
              ) : isPdf ? (
                <div className="flex flex-col items-center justify-center">
                  <FileText className="w-5 h-5 text-rose-400" />
                  <span className="text-[9px] font-black text-rose-300 uppercase tracking-tighter">PDF</span>
                </div>
              ) : (
                <FileText className="w-6 h-6 text-emerald-400" />
              )}
            </div>

            <div className="min-w-0">
              <h3 id="tracker-title" className="text-sm sm:text-base font-bold text-white truncate">
                Số hóa tài liệu
              </h3>
              <p className="text-[11px] text-slate-300 truncate max-w-[200px] sm:max-w-xs font-medium">
                {file.name} · <span className="text-slate-400">{formattedSize}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {step !== 'completed' && step !== 'error' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-[11px] font-semibold">
                <Loader2 className="w-3 h-3 animate-spin text-emerald-400" />
                <span>{elapsedSec}s</span>
              </span>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
              title="Đóng"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-5 text-slate-800">
          {/* Progress Bar & Status Pill */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-bold text-slate-800 flex items-center gap-1.5">
                {step === 'completed' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                ) : step === 'error' ? (
                  <AlertCircle className="w-4 h-4 text-rose-600" />
                ) : (
                  <Sparkles className="w-4 h-4 text-emerald-600 animate-pulse" />
                )}
                <span>{progressMessage}</span>
              </span>
              <span className="font-bold font-mono text-emerald-600 text-sm">
                {progressPercent}%
              </span>
            </div>

            <div className="h-2.5 w-full rounded-full bg-slate-100 overflow-hidden relative shadow-inner">
              <div
                className={`h-full transition-all duration-300 rounded-full ${
                  step === 'error'
                    ? 'bg-rose-500'
                    : 'bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-400'
                }`}
                style={{ width: `${Math.min(100, Math.max(5, progressPercent))}%` }}
              />
            </div>
          </div>

          {/* Sequential Multi-Page Page Badges for PDFs */}
          {(() => {
            const pageMatch = progressMessage.match(/trang\s*(\d+)\/(\d+)/i);
            const curPage = pageMatch ? parseInt(pageMatch[1], 10) : (step === 'completed' ? (isPdf ? 1 : 1) : 0);
            const totPages = pageMatch ? parseInt(pageMatch[2], 10) : 0;
            
            if (totPages > 1 || (isPdf && curPage > 0)) {
              const pagesCount = totPages || Math.max(curPage, 1);
              return (
                <div className="p-3 rounded-2xl bg-slate-900 text-white space-y-2 shadow-sm border border-slate-800 animate-in fade-in duration-200">
                  <div className="flex items-center justify-between text-xs font-bold text-emerald-400">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <FileStack className="w-4 h-4 shrink-0 text-emerald-400" />
                      <span className="truncate">Tiến độ số hóa từng trang ({curPage}/{pagesCount})</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {Array.from({ length: pagesCount }, (_, idx) => {
                      const pageNum = idx + 1;
                      const isDone = pageNum < curPage || step === 'completed';
                      const isCurrent = pageNum === curPage && step !== 'completed';
                      return (
                        <div
                          key={pageNum}
                          className={`px-2.5 py-1 rounded-xl text-[11px] font-bold flex items-center gap-1.5 transition-all ${
                            isDone
                              ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                              : isCurrent
                              ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/30 ring-2 ring-emerald-400/50 animate-pulse'
                              : 'bg-slate-800/80 text-slate-400 border border-slate-700/60'
                          }`}
                        >
                          {isDone ? (
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          ) : isCurrent ? (
                            <Loader2 className="w-3 h-3 animate-spin text-white" />
                          ) : (
                            <span className="w-3 h-3 rounded-full bg-slate-700 text-[9px] flex items-center justify-center font-mono">{pageNum}</span>
                          )}
                          <span>Trang {pageNum}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            }
            return null;
          })()}

          {/* Error Banner if any */}
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-900 text-xs space-y-1.5">
              <div className="font-bold flex items-center gap-1.5 text-rose-800">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>Không thể hoàn tất phân tích tự động</span>
              </div>
              <p className="text-[11px] leading-relaxed text-rose-700">{error}</p>
              <div className="pt-1 flex gap-2">
                <button
                  type="button"
                  onClick={onRetry}
                  className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px] flex items-center gap-1 active:scale-95"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Thử lại với AI</span>
                </button>
                <button
                  type="button"
                  onClick={onManualEntry}
                  className="px-3 py-1.5 rounded-xl bg-white border border-rose-300 hover:bg-rose-100 text-rose-800 font-bold text-[11px]"
                >
                  Nhập thông tin thủ công
                </button>
              </div>
            </div>
          )}

          {/* Smart Routing Decision Banners */}
          {step === 'matching_patient' && isRoutingDecisionRequired && (
            <div className="animate-in slide-in-from-bottom-2 duration-300">
              {isMismatch && detectedMemberMatch && (
                <div className="p-3.5 rounded-2xl bg-amber-50 border border-amber-200 space-y-2.5 shadow-sm">
                  <div className="flex items-start gap-2.5">
                    <div className="p-1.5 rounded-xl bg-amber-100 shrink-0 mt-0.5">
                      <UserCheck className="w-4 h-4 text-amber-700" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-amber-900">Phát hiện hồ sơ không khớp thành viên đang chọn</h4>
                      <p className="text-[11px] text-amber-800 mt-0.5 leading-relaxed">
                        Tên trên phiếu là <b>{patientNameOnDoc}</b>. Hệ thống khuyên bạn nên lưu vào hồ sơ của <b>{detectedMemberMatch.name}</b>.
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={onSaveToDetected}
                      className="px-3.5 py-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-md transition-all active:scale-95"
                    >
                      Chuyển sang: {detectedMemberMatch.name}
                    </button>
                    <button
                      type="button"
                      onClick={onReview}
                      className="px-3.5 py-1.5 rounded-xl bg-white border border-amber-300 text-amber-700 font-bold text-xs hover:bg-amber-100 transition-all"
                    >
                      Vẫn lưu vào: {member.name}
                    </button>
                  </div>
                </div>
              )}

              {isNewPersonDetected && !detectedMemberMatch && (
                <div className="p-3.5 rounded-2xl bg-blue-50 border border-blue-200 space-y-2.5 shadow-sm">
                  <div className="flex items-start gap-2.5">
                    <div className="p-1.5 rounded-xl bg-blue-100 shrink-0 mt-0.5">
                      <Sparkles className="w-4 h-4 text-blue-700" />
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-blue-900">Phát hiện người bệnh mới</h4>
                      <p className="text-[11px] text-blue-800 mt-0.5 leading-relaxed">
                        Tên <b>{patientNameOnDoc}</b> chưa có trong danh sách gia đình. Tạo hồ sơ mới cho người này?
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={onCreateNewMember}
                      className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs shadow-md transition-all active:scale-95"
                    >
                      Tạo hồ sơ mới: {patientNameOnDoc}
                    </button>
                    <button
                      type="button"
                      onClick={onReview}
                      className="px-3.5 py-1.5 rounded-xl bg-white border border-blue-300 text-blue-700 font-bold text-xs hover:bg-amber-100 transition-all"
                    >
                      Lưu tạm vào: {member.name}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Real-Time Extracted Content Summary (Clean & Visual - No empty placeholders) */}
          <div className="rounded-2xl border border-emerald-200/80 bg-white p-3.5 sm:p-4 space-y-3 shadow-xs">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
              <div className="flex items-center gap-1.5">
                <Scan className="w-4 h-4 text-emerald-600" />
                <h4 className="text-xs font-bold uppercase tracking-wide text-slate-900">
                  Dữ liệu AI đã trích xuất
                </h4>
              </div>
              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200/60">
                Lưu vào: {member.name}
              </span>
            </div>

            <div className="space-y-2 text-xs">
              {/* Patient Name if extracted */}
              {partialExtracted.patientName && (
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 flex items-center justify-between">
                  <span className="text-[11px] text-slate-500 font-medium">Bệnh nhân ghi trên phiếu:</span>
                  <span className="font-extrabold text-slate-900">{partialExtracted.patientName}</span>
                </div>
              )}

              {/* Event Title, Facility, Date */}
              {(partialExtracted.title || partialExtracted.facility || partialExtracted.date) && (
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                  <div className="font-bold text-slate-900 text-xs">
                    {partialExtracted.title || 'Hồ sơ y tế mới'}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
                    {partialExtracted.facility && (
                      <span className="flex items-center gap-1">
                        <Building2 className="w-3 h-3 text-sky-600" />
                        <span>{partialExtracted.facility}</span>
                      </span>
                    )}
                    {partialExtracted.date && (
                      <span className="flex items-center gap-1 font-semibold text-slate-800">
                        <Calendar className="w-3 h-3 text-amber-600" />
                        <span>{partialExtracted.date}</span>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Diagnoses */}
              {partialExtracted.diagnoses && partialExtracted.diagnoses.length > 0 && (
                <div className="p-2.5 rounded-xl bg-emerald-50/50 border border-emerald-100 space-y-1">
                  <span className="text-[10px] font-bold uppercase text-emerald-900 block">Chẩn đoán</span>
                  <div className="flex flex-wrap gap-1">
                    {partialExtracted.diagnoses.map((d, i) => (
                      <span key={i} className="px-2 py-0.5 rounded-md bg-white border border-emerald-200 text-emerald-900 text-[11px] font-bold">
                        {d}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Metrics */}
              {partialExtracted.metrics && partialExtracted.metrics.length > 0 && (
                <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 space-y-1">
                  <span className="text-[10px] font-bold uppercase text-slate-500 block">Chỉ số xét nghiệm ({partialExtracted.metrics.length})</span>
                  <div className="flex flex-wrap gap-1.5">
                    {partialExtracted.metrics.map((m, i) => (
                      <span key={i} className="px-2 py-0.5 rounded-md bg-white border border-slate-200 text-slate-900 text-[11px] font-semibold tabular-nums">
                        {m.name}: <strong className="text-emerald-700">{m.value}</strong> {m.unit}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Medications */}
              {partialExtracted.medications && partialExtracted.medications.length > 0 && (
                <div className="p-2.5 rounded-xl bg-teal-50/50 border border-teal-100 space-y-1">
                  <span className="text-[10px] font-bold uppercase text-teal-900 block">Đơn thuốc ({partialExtracted.medications.length} thuốc)</span>
                  <div className="space-y-1 max-h-24 overflow-y-auto">
                    {partialExtracted.medications.map((m, i) => (
                      <div key={i} className="text-[11px] text-slate-800 flex items-center justify-between bg-white px-2 py-1 rounded-lg border border-teal-100">
                        <span className="font-bold truncate max-w-[65%]">{m.name}</span>
                        <span className="text-[10px] text-slate-500 truncate">{[m.dosage, m.frequency].filter(Boolean).join(' • ')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Advice */}
              {partialExtracted.advice && (
                <div className="p-2.5 rounded-xl bg-amber-50/50 border border-amber-100 space-y-0.5">
                  <span className="text-[10px] font-bold uppercase text-amber-900 block">Lời dặn bác sĩ</span>
                  <p className="text-[11px] text-slate-800 leading-relaxed font-medium">"{partialExtracted.advice}"</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-3.5 sm:p-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl border border-slate-200 hover:bg-slate-100 text-xs font-bold text-slate-600 transition-colors"
          >
            Đóng
          </button>

          <div className="flex items-center gap-2">
            {step === 'completed' && (
              <button
                type="button"
                onClick={onReview}
                className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md shadow-emerald-600/20 flex items-center gap-1.5 transition-all transform active:scale-95"
              >
                <span>Kiểm tra & Ghi nhận vào hồ sơ</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            {step !== 'completed' && step !== 'error' && (
              <button
                type="button"
                onClick={onReview}
                className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs flex items-center gap-1.5 transition-colors"
              >
                <span>Mở biểu mẫu ngay</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
