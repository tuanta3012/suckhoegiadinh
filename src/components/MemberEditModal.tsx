import { useState } from 'react';
import { X } from 'lucide-react';
import type { FamilyMember } from '../types';
import { DatePickerVN } from './DatePickerVN';

export type EditableFamilyMember = Pick<
  FamilyMember,
  'name' | 'email' | 'gender' | 'birthDate'
>;

interface MemberEditModalProps {
  member: FamilyMember;
  isSaving: boolean;
  onClose: () => void;
  onSave: (updates: EditableFamilyMember) => void;
}

function toDateInputValue(value?: string): string {
  if (!value) return '';
  const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return value;
  const vnDate = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (vnDate) return `${vnDate[3]}-${vnDate[2].padStart(2, '0')}-${vnDate[1].padStart(2, '0')}`;
  return value;
}

export function MemberEditModal({
  member,
  isSaving,
  onClose,
  onSave,
}: MemberEditModalProps) {
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email || '');
  const [birthDate, setBirthDate] = useState(toDateInputValue(member.birthDate));
  const [gender, setGender] = useState<NonNullable<FamilyMember['gender']>>(member.gender || 'other');

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) onClose();
      }}
    >
      <form
        className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-member-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({
            name: name.trim(),
            email: email.trim().toLowerCase() || undefined,
            birthDate: birthDate || undefined,
            gender,
          });
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="edit-member-title" className="text-lg font-extrabold text-slate-900">
              Chỉnh sửa thành viên
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Cập nhật thông tin trong Workspace và hồ sơ Drive.
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

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-slate-700 sm:col-span-2">
            Họ và tên *
            <input
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal"
              autoFocus
            />
          </label>
          <label className="text-xs font-semibold text-slate-700">
            Gmail
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal"
            />
          </label>
          <div className="text-xs font-semibold text-slate-700">
            <span className="block mb-1">Ngày sinh</span>
            <DatePickerVN
              value={birthDate}
              onChange={(val) => setBirthDate(val)}
            />
          </div>
          <label className="text-xs font-semibold text-slate-700">
            Giới tính
            <select
              value={gender}
              onChange={(event) => setGender(event.target.value as NonNullable<FamilyMember['gender']>)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal"
            >
              <option value="other">Khác / chưa xác định</option>
              <option value="male">Nam</option>
              <option value="female">Nữ</option>
            </select>
          </label>

        </div>

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button
            type="button"
            disabled={isSaving}
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="submit"
            disabled={isSaving || !name.trim()}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            {isSaving ? 'Đang lưu…' : 'Lưu thay đổi'}
          </button>
        </div>
      </form>
    </div>
  );
}
