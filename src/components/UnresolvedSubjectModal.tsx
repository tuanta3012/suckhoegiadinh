import { useState } from 'react';
import { X } from 'lucide-react';

interface UnresolvedSubjectModalProps {
  fileName: string;
  isSaving: boolean;
  error?: string;
  existingMemberName?: string;
  onDefer: () => void;
  onCreateMember: (name: string) => void;
}

export function UnresolvedSubjectModal({
  fileName,
  isSaving,
  error,
  existingMemberName,
  onDefer,
  onCreateMember,
}: UnresolvedSubjectModalProps) {
  const [name, setName] = useState('');
  const memberName = existingMemberName || name.trim();

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onDefer();
      }}
    >
      <section
        className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unresolved-subject-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="unresolved-subject-title" className="text-lg font-extrabold text-slate-900">
              Chưa nhận diện được chủ thể
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Tạo thành viên mới để gán dữ liệu OCR. Tài liệu: {fileName}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Để sau"
            disabled={isSaving}
            onClick={onDefer}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {existingMemberName ? (
          <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Đã tạo thành viên <strong>{existingMemberName}</strong>. Tiếp tục để lưu dữ liệu OCR vào hồ sơ này.
          </p>
        ) : (
          <label className="block space-y-1.5 text-sm font-semibold text-slate-700">
            <span>Họ và tên thành viên mới</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && memberName && !isSaving) {
                  onCreateMember(memberName);
                }
              }}
              placeholder="Nhập họ và tên"
              disabled={isSaving}
              className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm disabled:bg-slate-50"
            />
          </label>
        )}

        {error && (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            disabled={isSaving}
            onClick={onDefer}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            Để sau
          </button>
          <button
            type="button"
            disabled={isSaving || !memberName}
            onClick={() => onCreateMember(memberName)}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            {isSaving ? 'Đang tạo và lưu…' : existingMemberName ? 'Lưu vào hồ sơ thành viên' : 'Tạo thành viên và gán dữ liệu'}
          </button>
        </div>
      </section>
    </div>
  );
}
