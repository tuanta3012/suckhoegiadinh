import { useState } from 'react';
import { X } from 'lucide-react';
import type { FamilyMember } from '../types';

interface SubjectResolutionModalProps {
  fileName: string;
  members: FamilyMember[];
  isSaving: boolean;
  error?: string;
  onClose: () => void;
  onSelectMember: (memberId: string) => void;
  onCreateMember: (name: string) => void;
}

export function SubjectResolutionModal({
  fileName,
  members,
  isSaving,
  error,
  onClose,
  onSelectMember,
  onCreateMember,
}: SubjectResolutionModalProps) {
  const [memberId, setMemberId] = useState(members[0]?.id || '');
  const [newMemberName, setNewMemberName] = useState('');
  const [createNew, setCreateNew] = useState(false);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/60 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <section
        className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subject-resolution-title"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="subject-resolution-title" className="text-lg font-extrabold text-slate-900">
              Chưa nhận diện được chủ thể
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Chọn hồ sơ phù hợp hoặc nhập tên để tạo hồ sơ mới. Tài liệu: {fileName}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Đóng"
            disabled={isSaving}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input
            type="radio"
            checked={!createNew}
            onChange={() => setCreateNew(false)}
            disabled={members.length === 0 || isSaving}
          />
          Chọn thành viên có sẵn
        </label>
        <select
          value={memberId}
          onChange={(event) => setMemberId(event.target.value)}
          disabled={createNew || isSaving || members.length === 0}
          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm disabled:bg-slate-50"
        >
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input
            type="radio"
            checked={createNew}
            onChange={() => setCreateNew(true)}
            disabled={isSaving}
          />
          Tạo thành viên mới
        </label>
        <input
          value={newMemberName}
          onChange={(event) => setNewMemberName(event.target.value)}
          onFocus={() => setCreateNew(true)}
          placeholder="Nhập họ và tên thành viên"
          disabled={!createNew || isSaving}
          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm disabled:bg-slate-50"
        />

        {error && (
          <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            Để sau
          </button>
          <button
            type="button"
            disabled={isSaving || (createNew ? !newMemberName.trim() : !memberId)}
            onClick={() => {
              if (createNew) onCreateMember(newMemberName.trim());
              else onSelectMember(memberId);
            }}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            {isSaving ? 'Đang lưu…' : 'Gán và lưu tài liệu'}
          </button>
        </div>
      </section>
    </div>
  );
}
