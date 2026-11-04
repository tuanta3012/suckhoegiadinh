import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Building2,
  Calendar,
  CheckCircle2,
  CloudUpload,
  FileText,
  Loader2,
  Pill,
  RefreshCw,
  Scan,
  Sparkles,
  Stethoscope,
  UserCheck,
  X,
} from 'lucide-react';
import type { FamilyMember, HealthEvent } from '../types';
import type { DriveFile } from '../utils/healthDriveService';

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
  onReview: () => void;
  onRetry: () => void;
  onManualEntry: () => void;
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
  onReview,
  onRetry,
  onManualEntry,
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

  // Matched member calculation
  const patientName = partialExtracted.patientName?.trim().toLowerCase();
  const matchedMember = patientName
    ? members.find((m) => {
        const mName = m.name.trim().toLowerCase();
        return mName === patientName || patientName.includes(mName) || mName.includes(patientName);
      })
    : null;

  const stepsList = [
    {
      id: 'uploading_drive',
      title: 'Lưu trữ Google Drive',
      desc: 'Lưu an toàn vào thư mục "Suc khoe gia dinh"',
      icon: CloudUpload,
      isDone:
        step === 'reading_document' ||
        step === 'extracting_content' ||
        step === 'matching_patient' ||
        step === 'completed' ||
        Boolean(driveFile),
      isActive: step === 'uploading_drive',
    },
    {
      id: 'reading_document',
      title: 'AI Vision & Đọc tài liệu (OCR)',
      desc: `Nhận dạng văn bản & chữ viết tay (${modelUsed})`,
      icon: Scan,
      isDone:
        step === 'extracting_content' ||
        step === 'matching_patient' ||
        step === 'completed',
      isActive: step === 'reading_document',
    },
    {
      id: 'extracting_content',
      title: 'Bóc tách dữ liệu y khoa',
      desc: 'Trích xuất chẩn đoán, toa thuốc, chỉ số sinh tồn',
      icon: Stethoscope,
      isDone: step === 'matching_patient' || step === 'completed',
      isActive: step === 'extracting_content',
    },
    {
      id: 'matching_patient',
      title: 'Đối chiếu với gia đình',
      desc: 'So khớp người bệnh với danh sách thành viên',
      icon: UserCheck,
      isDone: step === 'completed',
      isActive: step === 'matching_patient',
    },
  ];

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
              <div className="flex items-center gap-2">
                <h3 id="tracker-title" className="text-base sm:text-lg font-bold text-white truncate">
                  Tiến trình số hóa tài liệu y tế
                </h3>
              </div>
              <p className="text-xs text-slate-300 truncate max-w-xs mt-0.5 font-medium">
                {file.name} • <span className="text-slate-400">{formattedSize}</span>
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
              <span className="font-bold text-slate-700 flex items-center gap-1.5">
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

            <div className="h-2 w-full rounded-full bg-slate-100 overflow-hidden relative">
              <div
                className={`h-full transition-all duration-300 rounded-full ${
                  step === 'error'
                    ? 'bg-rose-500'
                    : 'bg-gradient-to-r from-emerald-500 to-teal-400'
                }`}
                style={{ width: `${Math.min(100, Math.max(5, progressPercent))}%` }}
              />
            </div>
          </div>

          {/* Error Banner if any */}
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-50 border border-rose-200 text-rose-900 text-xs space-y-1">
              <div className="font-bold flex items-center gap-1.5 text-rose-800">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
                <span>Không thể hoàn tất phân tích tự động</span>
              </div>
              <p className="text-[11px] leading-relaxed text-rose-700">{error}</p>
              <div className="pt-2 flex gap-2">
                <button
                  type="button"
                  onClick={onRetry}
                  className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px] flex items-center gap-1"
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

          {/* 4 Process Timeline Stages */}
          <div className="rounded-2xl bg-slate-50 border border-slate-200/80 p-3 sm:p-4 space-y-3">
            <h4 className="text-[11px] font-black uppercase tracking-wider text-slate-400">
              Các bước xử lý hệ thống
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {stepsList.map((s, idx) => {
                const IconComponent = s.icon;
                return (
                  <div
                    key={s.id}
                    className={`p-2.5 rounded-xl border transition-all flex items-start gap-2.5 ${
                      s.isDone
                        ? 'bg-emerald-50/60 border-emerald-200/80 text-emerald-950'
                        : s.isActive
                        ? 'bg-white border-emerald-400 shadow-sm ring-2 ring-emerald-500/10'
                        : 'bg-white/60 border-slate-200/60 text-slate-400'
                    }`}
                  >
                    <div
                      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold ${
                        s.isDone
                          ? 'bg-emerald-500 text-white'
                          : s.isActive
                          ? 'bg-emerald-100 text-emerald-700 animate-pulse'
                          : 'bg-slate-100 text-slate-400'
                      }`}
                    >
                      {s.isDone ? (
                        <CheckCircle2 className="w-4 h-4" />
                      ) : s.isActive ? (
                        <Loader2 className="w-4 h-4 animate-spin text-emerald-600" />
                      ) : (
                        idx + 1
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-bold text-slate-900 truncate flex items-center gap-1">
                        <span>{s.title}</span>
                      </div>
                      <p className="text-[10px] text-slate-500 truncate mt-0.5">{s.desc}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Real-Time Live Discovery Panel: "Nội dung AI đang nhận dạng được" */}
          <div className="rounded-2xl border border-emerald-200/80 bg-gradient-to-b from-emerald-50/40 to-white p-3.5 sm:p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 border-b border-emerald-100 pb-2">
              <div className="flex items-center gap-1.5">
                <Scan className="w-4 h-4 text-emerald-600" />
                <h4 className="text-xs font-black uppercase tracking-wider text-emerald-950">
                  Nội dung AI đã bóc tách từ tài liệu
                </h4>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                {modelUsed}
              </span>
            </div>

            <div className="space-y-2.5 text-xs">
              {/* Row 1: Patient Information */}
              <div className="p-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs space-y-1.5">
                <div className="flex items-center justify-between text-[11px] font-bold text-slate-500">
                  <span className="flex items-center gap-1">
                    <UserCheck className="w-3.5 h-3.5 text-indigo-500" />
                    <span>Người bệnh ghi trên phiếu:</span>
                  </span>
                  {matchedMember ? (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px] flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                      <span>Khớp với: {matchedMember.name}</span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-400">
                      Ghi nhận cho: {member.name}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <span className="text-[10px] text-slate-400 block font-bold uppercase">Họ và tên</span>
                    <span className="font-bold text-slate-900 block truncate">
                      {partialExtracted.patientName || (
                        <span className="text-slate-400 italic font-normal text-[11px]">
                          {step === 'completed' ? 'Chưa rõ' : 'Đang tìm...'}
                        </span>
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 block font-bold uppercase">Năm/Ngày sinh</span>
                    <span className="font-bold text-slate-900 block truncate">
                      {partialExtracted.patientBirthDate || (
                        <span className="text-slate-400 italic font-normal text-[11px]">
                          {step === 'completed' ? 'Chưa rõ' : 'Đang tìm...'}
                        </span>
                      )}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 block font-bold uppercase">Giới tính</span>
                    <span className="font-bold text-slate-900 block truncate">
                      {partialExtracted.patientGender || (
                        <span className="text-slate-400 italic font-normal text-[11px]">
                          {step === 'completed' ? 'Chưa rõ' : 'Đang tìm...'}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </div>

              {/* Row 2: Facility & Event Type */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="p-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs space-y-0.5">
                  <div className="flex items-center gap-1 text-[10px] text-slate-400 font-bold uppercase">
                    <Building2 className="w-3 h-3 text-sky-500" />
                    <span>Cơ sở khám bệnh</span>
                  </div>
                  <span className="font-bold text-slate-900 block truncate text-xs">
                    {partialExtracted.facility || (
                      <span className="text-slate-400 italic font-normal text-[11px]">
                        {step === 'completed' ? 'Chưa ghi nhận' : 'Đang nhận dạng...'}
                      </span>
                    )}
                  </span>
                </div>

                <div className="p-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs space-y-0.5">
                  <div className="flex items-center gap-1 text-[10px] text-slate-400 font-bold uppercase">
                    <Calendar className="w-3 h-3 text-amber-500" />
                    <span>Ngày khám / Sự kiện</span>
                  </div>
                  <span className="font-bold text-slate-900 block truncate text-xs">
                    {partialExtracted.date || (
                      <span className="text-slate-400 italic font-normal text-[11px]">
                        {step === 'completed' ? 'Chưa rõ ngày' : 'Đang nhận dạng...'}
                      </span>
                    )}
                  </span>
                </div>
              </div>

              {/* Row 3: Diagnoses & Medical Title */}
              {(partialExtracted.title || (partialExtracted.diagnoses && partialExtracted.diagnoses.length > 0)) && (
                <div className="p-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs space-y-1">
                  <div className="flex items-center gap-1 text-[10px] text-slate-400 font-bold uppercase">
                    <Stethoscope className="w-3 h-3 text-emerald-600" />
                    <span>Chẩn đoán & Tên sự kiện</span>
                  </div>
                  <div className="font-bold text-slate-900 text-xs">
                    {partialExtracted.title || 'Hồ sơ y tế'}
                  </div>
                  {partialExtracted.diagnoses && partialExtracted.diagnoses.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {partialExtracted.diagnoses.map((d, i) => (
                        <span
                          key={i}
                          className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-800 text-[10px] font-semibold border border-emerald-100"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Row 4: Detected Medications Count & List */}
              {partialExtracted.medications && partialExtracted.medications.length > 0 && (
                <div className="p-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs space-y-1">
                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-bold uppercase">
                    <span className="flex items-center gap-1 text-teal-700">
                      <Pill className="w-3 h-3 text-teal-600" />
                      <span>Đơn thuốc ({partialExtracted.medications.length} loại thuốc)</span>
                    </span>
                  </div>
                  <div className="space-y-1 pt-0.5 max-h-24 overflow-y-auto">
                    {partialExtracted.medications.map((m, i) => (
                      <div
                        key={i}
                        className="text-[11px] text-slate-800 flex items-center justify-between bg-slate-50 px-2 py-1 rounded-lg"
                      >
                        <span className="font-bold truncate max-w-[65%]">{m.name}</span>
                        <span className="text-[10px] text-slate-500 truncate">
                          {[m.dosage, m.frequency].filter(Boolean).join(' • ')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Row 5: Detected Metrics */}
              {partialExtracted.metrics && partialExtracted.metrics.length > 0 && (
                <div className="p-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs space-y-1">
                  <div className="flex items-center gap-1 text-[10px] text-slate-400 font-bold uppercase">
                    <Activity className="w-3 h-3 text-rose-500" />
                    <span>Chỉ số đo ({partialExtracted.metrics.length} chỉ số)</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {partialExtracted.metrics.map((m, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-900 text-[10px] font-bold border border-rose-100 flex items-center gap-1"
                      >
                        <span>{m.name}:</span>
                        <span className="text-rose-700">{m.value} {m.unit}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Row 6: Doctor's Advice */}
              {partialExtracted.advice && (
                <div className="p-2.5 rounded-xl bg-white border border-slate-200/90 shadow-2xs space-y-0.5">
                  <span className="text-[10px] text-slate-400 block font-bold uppercase">Lời dặn bác sĩ</span>
                  <p className="text-xs text-slate-700 italic line-clamp-2">
                    "{partialExtracted.advice}"
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-4 sm:p-5 bg-slate-50 border-t border-slate-100 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-2xl border border-slate-200 hover:bg-slate-100 text-xs font-bold text-slate-600 transition-colors"
          >
            Đóng
          </button>

          <div className="flex items-center gap-2">
            {step === 'completed' && (
              <button
                type="button"
                onClick={onReview}
                className="px-5 py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-lg shadow-emerald-600/25 flex items-center gap-1.5 transition-all transform active:scale-95"
              >
                <span>Kiểm tra & Ghi nhận vào hồ sơ</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            )}

            {step !== 'completed' && step !== 'error' && (
              <button
                type="button"
                onClick={onReview}
                className="px-4 py-2.5 rounded-2xl bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs flex items-center gap-1.5 transition-colors"
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
