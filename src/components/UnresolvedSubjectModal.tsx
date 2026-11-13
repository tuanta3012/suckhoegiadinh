import { useState } from 'react';
import { FileText, UserCheck, UserPlus, X, OctagonX, ChevronRight, AlertCircle } from 'lucide-react';
import type { FamilyMember } from '../types';
import { getWorkspaceMemberRole } from '../utils/memberOrdering';
import { isRecognizablePatientName } from '../utils/ocrSubjectRouting';

interface UnresolvedSubjectModalProps {
  fileName: string;
  isSaving: boolean;
  error?: string;
  members?: FamilyMember[];
  adminEmail?: string | null;
  batchStatus?: { current: number; total: number } | null;
  existingMemberName?: string;
  suggestedSubjectName?: string;
  onDefer: () => void;
  onSelectExistingMember?: (member: FamilyMember) => void;
  onCreateMember: (name: string) => void;
  onCancelQueue?: () => void;
}

export function UnresolvedSubjectModal({
  fileName,
  isSaving,
  error,
  members = [],
  adminEmail,
  batchStatus,
  existingMemberName,
  suggestedSubjectName,
  onDefer,
  onSelectExistingMember,
  onCreateMember,
  onCancelQueue,
}: UnresolvedSubjectModalProps) {
  const [name, setName] = useState(suggestedSubjectName || '');
  const [showAddForm, setShowAddForm] = useState(members.length === 0);
  const memberName = name.trim();
  const canResolveSubject = isRecognizablePatientName(suggestedSubjectName);
  const canCreateMember = isRecognizablePatientName(memberName);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-xs p-3 overflow-y-auto animate-in fade-in duration-200"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onDefer();
      }}
    >
      <section
        className="my-auto w-full max-w-lg space-y-4 rounded-3xl bg-white p-5 shadow-2xl border border-slate-100 animate-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unresolved-subject-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-extrabold text-amber-800">
                <AlertCircle className="w-3 h-3 text-amber-600" />
                Cần chọn người bệnh
              </span>
              {batchStatus && (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-extrabold text-slate-600">
                  Tệp {batchStatus.current}/{batchStatus.total} trong hàng đợi
                </span>
              )}
            </div>
            <h2 id="unresolved-subject-title" className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Chưa xác định được người bệnh
            </h2>
            <p className="mt-1 text-xs text-slate-600 font-medium flex items-center gap-1.5 truncate">
              <FileText className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>Tệp:</span>
              <strong className="text-slate-900 truncate font-extrabold">{fileName}</strong>
            </p>
            {suggestedSubjectName && (
              <p className="mt-1 text-xs text-amber-800">
                Gợi ý OCR: <strong className="font-bold text-amber-950">{suggestedSubjectName}</strong>
              </p>
            )}
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50 transition-colors"
            aria-label="Đóng"
            disabled={isSaving}
            onClick={onDefer}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Existing Member Selection */}
        {members.length > 0 && (
          <div className="space-y-2">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-500">
              1. Chọn thành viên có sẵn:
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
              {members.map((member) => {
                const memberRole = getWorkspaceMemberRole(member, adminEmail);
                return (
                <button
                  key={member.id}
                  type="button"
                  disabled={isSaving}
                  onClick={() => onSelectExistingMember?.(member)}
                  className="flex items-center gap-2.5 p-2.5 rounded-2xl border border-slate-200 bg-slate-50/50 hover:bg-emerald-50 hover:border-emerald-300 hover:text-emerald-950 transition-all text-left group disabled:opacity-50"
                >
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-black text-xs shrink-0 group-hover:scale-105 transition-transform">
                    {member.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-xs text-slate-800 truncate group-hover:text-emerald-900">
                      {member.name}
                    </div>
                    <div className="text-[10px] text-slate-400 font-medium">
                      {memberRole}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-emerald-600 shrink-0" />
                </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Create New Member Form */}
        {existingMemberName && (
          <p className="rounded-2xl bg-emerald-50 border border-emerald-200 px-3.5 py-2 text-xs font-semibold text-emerald-900">
            Hồ sơ vừa tạo: <strong className="font-extrabold text-emerald-950">{existingMemberName}</strong>. Chọn hồ sơ này ở trên để tiếp tục gán.
          </p>
        )}

        <div className="space-y-2 pt-1 border-t border-slate-100">
          {members.length > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                2. Hoặc tạo thành viên mới:
              </span>
              <button
                type="button"
                onClick={() => setShowAddForm(!showAddForm)}
                className="text-xs font-bold text-emerald-700 hover:text-emerald-800 flex items-center gap-1"
              >
                <UserPlus className="w-3.5 h-3.5" />
                <span>{showAddForm ? 'Thu gọn' : 'Tạo thành viên mới'}</span>
              </button>
            </div>
          )}

          {(showAddForm || members.length === 0) && (
            <div className="space-y-2 bg-slate-50/80 p-2.5 rounded-2xl border border-slate-200">
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && canCreateMember && !isSaving) {
                      onCreateMember(memberName);
                    }
                  }}
                  placeholder="Nhập họ tên thành viên mới"
                  disabled={isSaving}
                  className="flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-900 placeholder:font-normal focus:border-emerald-500 focus:outline-none disabled:bg-slate-100"
                />
                <button
                  type="button"
                  disabled={isSaving || !canCreateMember}
                  onClick={() => onCreateMember(memberName)}
                  className="rounded-xl bg-emerald-600 hover:bg-emerald-700 px-3.5 py-2 text-xs font-bold text-white shrink-0 disabled:opacity-50 flex items-center gap-1 transition-colors"
                >
                  <UserCheck className="w-3.5 h-3.5" />
                  <span>Tạo & Gán</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="rounded-2xl bg-rose-50 border border-rose-200 px-3.5 py-2 text-xs font-semibold text-rose-700">
            {error}
          </p>
        )}

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3 flex-wrap">
          {onCancelQueue ? (
            <button
              type="button"
              disabled={isSaving}
              onClick={onCancelQueue}
              className="rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 px-3 py-2 text-xs font-bold disabled:opacity-50 flex items-center gap-1.5 transition-colors"
            >
              <OctagonX className="w-4 h-4 shrink-0 text-rose-600" />
              <span>Dừng hàng đợi</span>
            </button>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={onDefer}
              className="rounded-xl border border-slate-200 bg-slate-100 hover:bg-slate-200 px-3.5 py-2 text-xs font-bold text-slate-700 disabled:opacity-50 transition-colors"
            >
              {batchStatus ? 'Bỏ qua tệp này' : 'Để sau'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
