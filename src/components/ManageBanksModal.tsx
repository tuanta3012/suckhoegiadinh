import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import { useConfirmDialog } from '../context/ConfirmDialogContext';
import {
  X,
  Plus,
  Edit2,
  Trash2,
  Search,
  Building2,
  Check,
  RotateCcw,
  Sparkles,
  CalendarCheck,
  CalendarX,
  ArrowLeft,
} from 'lucide-react';
import { BankInfo, SavingsBook } from '../types';
import {
  saveBank,
  deleteBank,
  resetBanksToDefault,
  getSortedBanksByUsage,
} from '../data/banks';
import { doesBankWorkOnSaturday } from '../utils/calculator';

interface ManageBanksModalProps {
  isOpen: boolean;
  onClose: () => void;
  books?: SavingsBook[];
  onBanksChanged?: () => void;
}

const PRESET_COLORS = [
  { primary: '#be123c', bg: '#ffe4e6', border: '#fecdd3', label: 'Đỏ thắm' },
  { primary: '#4338ca', bg: '#e0e7ff', border: '#c7d2fe', label: 'Tím Indigo' },
  { primary: '#d97706', bg: '#fef3c7', border: '#fde68a', label: 'Cam hổ phách' },
  { primary: '#15803d', bg: '#dcfce7', border: '#86efac', label: 'Xanh lục' },
  { primary: '#0e7490', bg: '#cffafe', border: '#a5f3fc', label: 'Xanh ngọc' },
  { primary: '#1d4ed8', bg: '#dbeafe', border: '#bfdbfe', label: 'Xanh lam đậm' },
  { primary: '#7e22ce', bg: '#f3e8ff', border: '#e9d5ff', label: 'Tím hoa cà' },
  { primary: '#16a34a', bg: '#dcfce7', border: '#86efac', label: 'Xanh lá tươi' },
  { primary: '#c2410c', bg: '#ffedd5', border: '#fed7aa', label: 'Cam đất' },
  { primary: '#0284c7', bg: '#e0f2fe', border: '#bae6fd', label: 'Xanh da trời' },
];

export const ManageBanksModal: React.FC<ManageBanksModalProps> = ({
  isOpen,
  onClose,
  books = [],
  onBanksChanged,
}) => {
  const { showToast } = useToast();
  const { confirm } = useConfirmDialog();
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [editingBankId, setEditingBankId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState<boolean>(false);
  const [version, setVersion] = useState<number>(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Form State
  const [formName, setFormName] = useState<string>('');
  const [formShortName, setFormShortName] = useState<string>('');
  const [formCode, setFormCode] = useState<string>('');
  const [formMargin, setFormMargin] = useState<string>('1.5');
  const [formLTV, setFormLTV] = useState<string>('100');
  const [selectedColorIndex, setSelectedColorIndex] = useState<number>(0);
  const [formWorksOnSaturday, setFormWorksOnSaturday] = useState<boolean>(false);

  // Reset scroll position when form opens or closes to eliminate unwanted scroll jumping
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, [isFormOpen]);

  // Lắng nghe sự kiện cấu hình ngân hàng được cập nhật từ Firestore / thiết bị khác
  useEffect(() => {
    const handleRemoteUpdate = () => {
      setVersion((v) => v + 1);
      onBanksChanged?.();
    };
    window.addEventListener('banks-updated', handleRemoteUpdate);
    return () => {
      window.removeEventListener('banks-updated', handleRemoteUpdate);
    };
  }, [onBanksChanged]);

  // Danh sách ngân hàng được phân loại
  const { frequentBanks, allSorted } = useMemo(() => {
    return getSortedBanksByUsage(books);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, version]);

  const filteredBanks = useMemo(() => {
    if (!searchQuery.trim()) return allSorted;
    const q = searchQuery.toLowerCase().trim();
    return allSorted.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.shortName.toLowerCase().includes(q) ||
        b.code.toLowerCase().includes(q)
    );
  }, [allSorted, searchQuery]);

  if (!isOpen) return null;

  const handleOpenAdd = () => {
    setEditingBankId(null);
    setFormName('');
    setFormShortName('');
    setFormCode('');
    setFormMargin('1.5');
    setFormLTV('100');
    setSelectedColorIndex(0);
    setFormWorksOnSaturday(false);
    setIsFormOpen(true);
  };

  const handleOpenEdit = (bank: BankInfo) => {
    setEditingBankId(bank.id);
    setFormName(bank.name);
    setFormShortName(bank.shortName);
    setFormCode(bank.code);
    setFormMargin(bank.defaultLoanMargin.toString());
    setFormLTV(Math.round(bank.maxLTV * 100).toString());
    setFormWorksOnSaturday(bank.worksOnSaturday !== undefined ? !!bank.worksOnSaturday : doesBankWorkOnSaturday(bank.id));

    const colorIdx = PRESET_COLORS.findIndex(
      (c) => c.primary.toLowerCase() === bank.primaryColor.toLowerCase()
    );
    setSelectedColorIndex(colorIdx >= 0 ? colorIdx : 0);
    setIsFormOpen(true);
  };

  const handleSaveForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim() || !formShortName.trim()) return;

    const parsedMargin = parseFloat(formMargin.replace(',', '.')) || 1.5;
    const parsedLTV = parseInt(formLTV, 10) || 100;
    const chosenColor = PRESET_COLORS[selectedColorIndex];
    saveBank({
      id: editingBankId || undefined,
      name: formName.trim(),
      shortName: formShortName.trim(),
      code: (formCode.trim() || formShortName.trim().slice(0, 4)).toUpperCase(),
      defaultLoanMargin: parsedMargin,
      maxLTV: parsedLTV / 100,
      primaryColor: chosenColor.primary,
      bgLight: chosenColor.bg,
      borderColor: chosenColor.border,
      worksOnSaturday: formWorksOnSaturday,
    });

    setIsFormOpen(false);
    setEditingBankId(null);
    setVersion((v) => v + 1);
    showToast(editingBankId ? 'Đã cập nhật thông tin ngân hàng!' : 'Đã thêm ngân hàng mới vào danh sách!');
    if (onBanksChanged) onBanksChanged();
  };

  const handleDelete = async (bank: BankInfo) => {
    const bankUsage = books.filter(
      (b) => b.bankId.toLowerCase() === bank.id.toLowerCase() && b.status === 'active'
    );

    const message = bankUsage.length > 0
      ? `${bank.shortName} có ${bankUsage.length} sổ. Dữ liệu sổ vẫn được giữ.`
      : `Xóa ngân hàng ${bank.shortName}?`;
    if (!(await confirm({ title: 'Xóa ngân hàng?', message }))) return;

    deleteBank(bank.id);
    setVersion((v) => v + 1);
    if (editingBankId === bank.id) {
      setIsFormOpen(false);
      setEditingBankId(null);
    }
    showToast(`Đã xóa ngân hàng ${bank.shortName}`);
    if (onBanksChanged) onBanksChanged();
  };

  const handleResetDefaults = async () => {
    if (!(await confirm({
      title: 'Khôi phục ngân hàng mặc định?',
      message: 'Danh sách ngân hàng tùy chỉnh sẽ bị xóa.',
      confirmLabel: 'Khôi phục',
    }))) return;

    resetBanksToDefault();
    setVersion((v) => v + 1);
    setIsFormOpen(false);
    setEditingBankId(null);
    showToast('Đã khôi phục danh sách ngân hàng mặc định');
    if (onBanksChanged) onBanksChanged();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="bg-white rounded-2xl border border-slate-200 max-w-2xl w-full max-h-[90vh] overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 sm:px-5 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
              <Building2 className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-sm sm:text-base leading-tight">
                Quản Lý Ngân Hàng
              </h3>
              <p className="text-[11px] text-slate-500 font-medium">
                {allSorted.length} ngân hàng hệ thống &bull; {frequentBanks.length} ngân hàng có sổ
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Toolbar (Only when list is visible) */}
        {!isFormOpen && (
          <div className="px-4 py-2.5 border-b border-slate-100 bg-white">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Tìm theo tên, mã viết tắt (VCB, TCB...)"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-none focus:ring-1.5 focus:ring-emerald-500"
                />
              </div>

              <button
                type="button"
                onClick={handleOpenAdd}
                className="flex items-center space-x-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition-colors shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Thêm</span>
              </button>

              <button
                type="button"
                onClick={handleResetDefaults}
                title="Khôi phục mặc định"
                className="p-1.5 text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg text-xs transition-colors shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Scrollable Body: Form or Compact Bank Grid */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-3 sm:p-4">
          {isFormOpen ? (
            /* Streamlined & Compact Edit Form */
            <form
              onSubmit={handleSaveForm}
              className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 sm:p-4 space-y-3.5 animate-in fade-in duration-100"
            >
              {/* Form Title & Back Button */}
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setIsFormOpen(false)}
                    className="p-1 hover:bg-slate-200 rounded text-slate-500 transition-colors"
                    title="Quay lại danh sách"
                  >
                    <ArrowLeft className="w-4 h-4" />
                  </button>
                  <span className="font-bold text-xs sm:text-sm text-slate-900 flex items-center space-x-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
                    <span>{editingBankId ? `Sửa: ${formShortName}` : 'Thêm ngân hàng mới'}</span>
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="text-slate-400 hover:text-slate-600 p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Row 1: Name & Code */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    Tên ngân hàng
                  </label>
                  <input
                    type="text"
                    required
                    value={formShortName}
                    onChange={(e) => {
                      setFormShortName(e.target.value);
                      setFormName(e.target.value);
                      if (!formCode) {
                        setFormCode(
                          e.target.value.replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase()
                        );
                      }
                    }}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    Mã viết tắt
                  </label>
                  <input
                    type="text"
                    required
                    value={formCode}
                    onChange={(e) => setFormCode(e.target.value.toUpperCase())}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-mono font-bold text-slate-900 uppercase focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {/* Row 2: Loan Margin & LTV */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    Biên độ vay (+%/năm)
                  </label>
                  <input
                    type="text"
                    inputMode="decimal"
                    required
                    value={formMargin}
                    onChange={(e) => setFormMargin(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    Tỷ lệ vay LTV (%)
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    required
                    value={formLTV}
                    onChange={(e) => setFormLTV(e.target.value.replace(/\D/g, ''))}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {/* Row 3: Saturday Schedule Toggle */}
              <div className="flex items-center justify-between p-2.5 bg-white border border-slate-200 rounded-lg">
                <div className="flex items-center space-x-2">
                  {formWorksOnSaturday ? (
                    <CalendarCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <CalendarX className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                  <div>
                    <span className="text-xs font-bold text-slate-800 block leading-tight">
                      Làm việc Thứ Bảy (quầy giao dịch)
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {formWorksOnSaturday
                        ? 'Sổ quầy đáo hạn Thứ 7 sẽ tất toán đúng Thứ 7'
                        : 'Sổ quầy đáo hạn Thứ 7/CN dời sang Thứ Hai'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setFormWorksOnSaturday(!formWorksOnSaturday)}
                  className={`px-3 py-1 rounded-full text-[11px] font-bold transition-all ${
                    formWorksOnSaturday
                      ? 'bg-emerald-600 text-white shadow-xs'
                      : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
                  }`}
                >
                  {formWorksOnSaturday ? 'Đang BẬT' : 'Đang TẮT'}
                </button>
              </div>

              {/* Row 4: Colors */}
              <div>
                <label className="text-[11px] font-bold text-slate-700 block mb-1.5">
                  Màu nhận diện
                </label>
                <div className="flex flex-wrap gap-2">
                  {PRESET_COLORS.map((col, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedColorIndex(idx)}
                      title={col.label}
                      style={{ backgroundColor: col.primary }}
                      className={`w-6 h-6 rounded-full flex items-center justify-center transition-transform ${
                        selectedColorIndex === idx
                          ? 'ring-2 ring-offset-2 ring-emerald-600 scale-110'
                          : 'opacity-80 hover:opacity-100'
                      }`}
                    >
                      {selectedColorIndex === idx && <Check className="w-3.5 h-3.5 text-white" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setIsFormOpen(false)}
                  className="px-3.5 py-1.5 text-xs text-slate-600 hover:text-slate-800 font-semibold rounded-lg hover:bg-slate-200"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold shadow-xs transition-colors"
                >
                  {editingBankId ? 'Lưu thay đổi' : 'Thêm ngân hàng'}
                </button>
              </div>
            </form>
          ) : filteredBanks.length === 0 ? (
            <div className="p-8 text-center text-slate-400 text-xs">
              Không tìm thấy ngân hàng nào khớp với "{searchQuery}"
            </div>
          ) : (
            /* Compact 2-Column Responsive Grid */
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {filteredBanks.map((bank) => {
                const isFrequent = bank.bookCount > 0;
                const worksSaturday = doesBankWorkOnSaturday(bank.id);

                return (
                  <div
                    key={bank.id}
                    className={`p-2 rounded-xl border flex items-center justify-between gap-2 transition-all ${
                      isFrequent
                        ? 'bg-slate-50/80 border-slate-300/80 hover:border-emerald-400'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {/* Left: Code badge + Compact Bank details */}
                    <div className="flex items-center space-x-2 min-w-0 flex-1">
                      <div
                        style={{ backgroundColor: bank.primaryColor }}
                        className="w-7 h-7 rounded-lg text-white font-mono font-black text-[10px] flex items-center justify-center shrink-0 shadow-2xs"
                      >
                        {bank.code}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 leading-tight">
                          <span className="font-bold text-slate-900 text-xs truncate">
                            {bank.shortName}
                          </span>
                          {isFrequent && (
                            <span className="text-[10px] font-black text-amber-700 bg-amber-100/80 px-1 py-0.2 rounded shrink-0">
                              {bank.bookCount} sổ
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-slate-500 font-medium">
                          <span>+{bank.defaultLoanMargin}%</span>
                          <span className="text-slate-300">&bull;</span>
                          <span>LTV {Math.round(bank.maxLTV * 100)}%</span>
                          <span className="text-slate-300">&bull;</span>
                          <span
                            className={
                              worksSaturday
                                ? 'text-emerald-700 font-bold'
                                : 'text-slate-400'
                            }
                          >
                            {worksSaturday ? 'T7: Có' : 'T7: Nghỉ'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div className="flex items-center space-x-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(bank)}
                        title="Sửa"
                        className="p-1 text-slate-400 hover:text-emerald-700 hover:bg-emerald-50 rounded transition-colors"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => handleDelete(bank)}
                        title="Xóa"
                        className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between text-xs text-slate-500">
          <span className="text-[11px] font-medium">
            Hiển thị <strong>{filteredBanks.length}</strong> ngân hàng
          </span>

          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-semibold"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
