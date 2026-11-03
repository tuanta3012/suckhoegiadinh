import React, { useState, useEffect, useMemo } from 'react';
import { useToast } from '../context/ToastContext';
import {
  X,
  Plus,
  Landmark,
  Tag,
  Check,
  Building2,
  SlidersHorizontal,
} from 'lucide-react';
import { SavingsBook, DepositType, RolloverOption } from '../types';
import {
  getBankById,
  getSortedBanksByUsage,
} from '../data/banks';
import { calculateMaturityDate, calculateInterest, getDaysBetween } from '../utils/calculator';
import {
  formatVND,
  formatDateVN,
  getOwnerLabel,
  getOwnerBadgeStyle,
} from '../utils/formatters';
import { buildSavingsBookBusinessId, getBankTagForBook } from '../utils/dataTranslator';
import { ManageBanksModal } from './ManageBanksModal';
import { BankSelectDropdown } from './BankSelectDropdown';
import { DatePickerVN } from './DatePickerVN';
import { CustomSelect } from './CustomSelect';

interface AddEditBookModalProps {
  isOpen: boolean;
  bookToEdit: SavingsBook | null;
  books?: SavingsBook[];
  currentDateStr: string;
  husbandName?: string;
  wifeName?: string;
  onClose: () => void;
  onSave: (book: SavingsBook) => void;
}

export const AddEditBookModal: React.FC<AddEditBookModalProps> = ({
  isOpen,
  bookToEdit,
  books = [],
  currentDateStr,
  husbandName,
  wifeName,
  onClose,
  onSave,
}) => {
  const { showToast } = useToast();
  const [bankId, setBankId] = useState<string>('seabank');
  const [owner, setOwner] = useState<string>(husbandName || 'Chồng');
  const [customOwnerInput, setCustomOwnerInput] = useState<string>('');
  const [showCustomOwnerField, setShowCustomOwnerField] = useState<boolean>(false);
  // Mặc định hình thức gửi là Tại quầy (Sổ giấy) theo yêu cầu
  const [depositType, setDepositType] = useState<DepositType>('counter');
  const [principal, setPrincipal] = useState<number>(200_000_000);
  const [principalStr, setPrincipalStr] = useState<string>('200');
  const [interestRate, setInterestRate] = useState<number>(5.6);
  const [interestRateStr, setInterestRateStr] = useState<string>('5.6');
  const [termMonths, setTermMonths] = useState<number>(12);
  const [startDate, setStartDate] = useState<string>(currentDateStr);
  const [rolloverOption, setRolloverOption] = useState<RolloverOption>('principal_and_interest');
  const [tag, setTag] = useState<string>('Tích lũy mua nhà');
  const [note, setNote] = useState<string>('');

  // Quản lý danh sách ngân hàng
  const [isManageBanksModalOpen, setIsManageBanksModalOpen] = useState<boolean>(false);
  const [bankListVersion, setBankListVersion] = useState<number>(0);

  // Danh sách ngân hàng được sắp xếp theo các ngân hàng hay gửi nhất
  const { frequentBanks, otherBanks } = useMemo(() => {
    return getSortedBanksByUsage(books);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, bankListVersion]);

  // Danh sách các tag chủ sổ gợi ý: mặc định (Chồng, Vợ, Bố, Mẹ, Con) + các tag đã có trong sổ cũ
  const availableOwnerTags = useMemo(() => {
    const set = new Set<string>([husbandName || 'Chồng', wifeName || 'Vợ', 'Bố', 'Mẹ', 'Con']);
    books.forEach((b) => {
      if (b.owner) {
        set.add(getOwnerLabel(b.owner));
      }
    });
    if (owner && !set.has(owner)) {
      set.add(owner);
    }
    return Array.from(set);
  }, [books, owner, husbandName, wifeName]);

  const prevIsOpenRef = React.useRef(false);
  const prevBookToEditIdRef = React.useRef<string | null>(null);

  useEffect(() => {
    const isOpening = isOpen && !prevIsOpenRef.current;
    const isBookChanged = (bookToEdit?.id || null) !== prevBookToEditIdRef.current;

    if (isOpen && (isOpening || isBookChanged)) {
      if (bookToEdit) {
        setBankId(bookToEdit.bankId);
        const normalizedOwner = getOwnerLabel(bookToEdit.owner || husbandName || 'Chồng');
        setOwner(normalizedOwner);
        setDepositType(bookToEdit.depositType);
        setPrincipal(bookToEdit.principal);
        setPrincipalStr((bookToEdit.principal / 1_000_000).toString());
        setInterestRate(bookToEdit.interestRate);
        setInterestRateStr(bookToEdit.interestRate.toString());
        setTermMonths(bookToEdit.termMonths);
        setStartDate(bookToEdit.startDate);
        setRolloverOption(bookToEdit.rolloverOption);
        setTag(bookToEdit.tag || '');
        setNote(bookToEdit.note || '');
        setShowCustomOwnerField(false);
        setCustomOwnerInput('');
      } else {
        // Mặc định chọn ngân hàng gửi nhiều nhất hiện có
        const topBank = frequentBanks[0]?.id || 'seabank';
        setBankId(topBank);
        setOwner(husbandName || 'Chồng');
        // Mặc định tại quầy
        setDepositType('counter');
        setPrincipal(200_000_000);
        setPrincipalStr('200');
        setInterestRate(5.6);
        setInterestRateStr('5.6');
        setTermMonths(12);
        setStartDate(currentDateStr);
        setRolloverOption('principal_and_interest');
        setTag('Tích lũy mua nhà');
        setNote('');
        setShowCustomOwnerField(false);
        setCustomOwnerInput('');
      }
    }

    prevIsOpenRef.current = isOpen;
    prevBookToEditIdRef.current = bookToEdit?.id || null;
  }, [isOpen, bookToEdit, currentDateStr, frequentBanks, husbandName]);

  if (!isOpen) return null;

  const calculatedMaturity = calculateMaturityDate(startDate, termMonths);
  const totalDays = Math.max(1, getDaysBetween(startDate, calculatedMaturity));
  const estimatedInterest = calculateInterest(principal, interestRate, totalDays);

  const handlePrincipalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawVal = e.target.value;
    setPrincipalStr(rawVal);
    // Allow digits, dots and commas for decimal values
    const sanitized = rawVal.replace(/[^0-9.,]/g, '').replace(',', '.');
    
    let num = parseFloat(sanitized);
    if (isNaN(num) || num <= 0) {
      setPrincipal(0);
    } else {
      // Nếu người dùng lỡ nhập dạng số tiền VND đầy đủ (> 100 triệu, ví dụ: 200000000)
      if (num >= 100_000_000) {
        num = num / 1_000_000;
      }
      setPrincipal(Math.round(num * 1_000_000));
    }
  };

  const handleInterestRateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setInterestRateStr(val);
    const parsed = parseFloat(val.replace(',', '.'));
    if (!isNaN(parsed)) {
      setInterestRate(parsed);
    } else {
      setInterestRate(0);
    }
  };

  const addPrincipal = (deltaVND: number) => {
    const currentVal = principal || 0;
    const next = currentVal + deltaVND;
    setPrincipal(next);
    setPrincipalStr((next / 1_000_000).toString());
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const finalPrincipal = principal;
    const finalRate = parseFloat(interestRateStr.replace(',', '.')) || interestRate;
    const bank = getBankById(bankId);
    const businessId = buildSavingsBookBusinessId({
      bankId,
      principal: finalPrincipal,
      startDate,
      termMonths,
      owner,
      depositType,
    });

    if (!bookToEdit && books.some((book) => book.id === businessId)) {
      showToast('Đã có sổ trùng ngân hàng, số tiền, ngày gửi, kỳ hạn, chủ sổ và loại sổ. Vui lòng kiểm tra lại.', 'error');
      return;
    }
    
    // Tự động tạo mã sổ ngầm định phía hệ thống mà không bắt người dùng nhập tay
    const tagCode = getBankTagForBook(bankId, owner, bank.code);
    const autoCode = bookToEdit
      ? bookToEdit.bookCode
      : `SO-${tagCode}-${Math.floor(1000 + Math.random() * 9000)}`;

    const newOrUpdatedBook: SavingsBook = {
      id: bookToEdit ? bookToEdit.id : businessId,
      bankId,
      bookCode: autoCode,
      owner,
      depositType,
      principal: finalPrincipal,
      interestRate: finalRate,
      termMonths,
      startDate,
      maturityDate: calculatedMaturity,
      rolloverOption,
      status: 'active',
      tag: tag.trim() || undefined,
      note: note.trim() || undefined,
    };
    onSave(newOrUpdatedBook);
    showToast(
      bookToEdit ? 'Đã cập nhật thông tin sổ tiết kiệm!' : 'Đã thêm sổ tiết kiệm mới thành công!'
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl border border-slate-200 max-w-lg w-full max-h-[92vh] overflow-y-auto shadow-2xl p-5 sm:p-6 space-y-4">
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b pb-3.5">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-800 flex items-center justify-center font-bold">
              {bookToEdit ? <Landmark className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
            </div>
            <div>
              <h3 className="font-bold text-slate-900 text-base">
                {bookToEdit ? 'Chỉnh Sửa Sổ Tiết Kiệm' : 'Thêm Sổ Tiết Kiệm Mới'}
              </h3>
              <p className="text-xs text-slate-500">
                Nhập thông tin tiền gửi để theo dõi gối đầu và tối ưu phương án huy động vốn
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Ngân hàng gửi - Sắp xếp theo các ngân hàng hay gửi nhất & Nút Quản lý Sửa / Thêm / Bớt */}
          <div className="bg-slate-50 p-3 rounded-2xl border border-slate-200 space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="font-bold text-slate-800 flex items-center space-x-1.5">
                <Building2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Ngân hàng gửi:</span>
              </label>

              <button
                type="button"
                onClick={() => setIsManageBanksModalOpen(true)}
                className="text-[11px] font-bold text-emerald-700 hover:text-emerald-800 bg-emerald-100/80 hover:bg-emerald-100 px-2.5 py-1 rounded-lg transition-colors flex items-center space-x-1 border border-emerald-300/60 shadow-2xs"
                title="Sửa thông tin, thêm mới hoặc xóa bớt ngân hàng trong danh sách"
              >
                <SlidersHorizontal className="w-3 h-3" />
                <span>Sửa / Thêm / Bớt ngân hàng</span>
              </button>
            </div>

            {/* Danh sách chọn ngân hàng đồng bộ hoàn toàn với giao diện app (không mở native popup) */}
            <BankSelectDropdown
              value={bankId}
              onChange={(newBankId) => setBankId(newBankId)}
              frequentBanks={frequentBanks}
              otherBanks={otherBanks}
              dropdownFullWidth={true}
              onOpenManageBanks={() => setIsManageBanksModalOpen(true)}
            />
          </div>

          {/* Người đứng tên sổ & Hình thức gửi */}
          <div className="space-y-3">
            {/* Người đứng tên (Chủ sổ) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="font-bold text-slate-700 text-sm flex items-center gap-1.5">
                  <Tag className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Chủ sổ (Người đứng tên):</span>
                </label>
                <button
                  type="button"
                  onClick={() => setShowCustomOwnerField(!showCustomOwnerField)}
                  className="text-xs text-emerald-700 font-semibold hover:underline flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  <span>{showCustomOwnerField ? 'Đóng nhập tay' : 'Thêm tên khác'}</span>
                </button>
              </div>

              {/* Tag suggestions */}
              <div className="flex flex-wrap gap-1.5 mb-2">
                {availableOwnerTags.map((tagItem) => {
                  const isSelected = owner === tagItem;
                  const badge = getOwnerBadgeStyle(tagItem);
                  return (
                    <button
                      key={tagItem}
                      type="button"
                      onClick={() => {
                        setOwner(tagItem);
                        setShowCustomOwnerField(false);
                      }}
                      className={`px-3 py-1.5 rounded-xl font-bold text-xs transition-all flex items-center gap-1.5 border cursor-pointer ${
                        isSelected
                          ? 'bg-emerald-600 text-white border-emerald-600 shadow-xs ring-2 ring-emerald-500/20'
                          : `${badge.badgeClass} hover:opacity-90`
                      }`}
                    >
                      {isSelected && <Check className="w-3.5 h-3.5" />}
                      <span>{tagItem}</span>
                    </button>
                  );
                })}
              </div>

              {/* Custom Owner Name Input */}
              {showCustomOwnerField && (
                <div className="flex items-center gap-2 p-2 bg-slate-50 border border-slate-200 rounded-xl animate-in fade-in duration-150">
                  <input
                    type="text"
                    placeholder="Nhập tên chủ sổ mới (VD: Bác Nam, Quỹ gia đình...)"
                    value={customOwnerInput}
                    onChange={(e) => setCustomOwnerInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        if (customOwnerInput.trim()) {
                          setOwner(customOwnerInput.trim());
                          setCustomOwnerInput('');
                          setShowCustomOwnerField(false);
                        }
                      }
                    }}
                    className="flex-1 px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (customOwnerInput.trim()) {
                        setOwner(customOwnerInput.trim());
                        setCustomOwnerInput('');
                        setShowCustomOwnerField(false);
                      }
                    }}
                    disabled={!customOwnerInput.trim()}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40 text-white rounded-lg text-xs font-bold transition-colors"
                  >
                    Chọn
                  </button>
                </div>
              )}
            </div>

            {/* Hình thức gửi - Mặc định Tại quầy */}
            <div>
              <label className="font-bold text-slate-700 block mb-1 text-sm">
                Hình thức gửi:
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setDepositType('counter')}
                  className={`py-2 px-3 rounded-xl font-bold border text-center transition-all cursor-pointer ${
                    depositType === 'counter'
                      ? 'bg-emerald-50 border-emerald-500 text-emerald-800 shadow-2xs'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50 bg-white'
                  }`}
                >
                  Tại quầy (Sổ giấy)
                </button>
                <button
                  type="button"
                  onClick={() => setDepositType('online')}
                  className={`py-2 px-3 rounded-xl font-bold border text-center transition-all cursor-pointer ${
                    depositType === 'online'
                      ? 'bg-emerald-50 border-emerald-500 text-emerald-800 shadow-2xs'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50 bg-white'
                  }`}
                >
                  Online (App)
                </button>
              </div>
            </div>
          </div>

          {/* Số tiền gốc (Triệu VNĐ) kèm nút cộng nhanh và xóa nhanh */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="font-bold text-slate-700 text-sm">
                Số tiền gốc (Triệu VNĐ):
              </label>
              <span className="font-black text-sm text-emerald-700">
                {principal > 0 ? formatVND(principal) : '0 đ'}
              </span>
            </div>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                required
                placeholder="Ví dụ: 550"
                value={principalStr}
                onChange={handlePrincipalChange}
                className="w-full px-3 py-2.5 pr-24 border border-slate-300 rounded-xl text-base font-bold text-slate-900 focus:ring-2 focus:ring-emerald-500 tracking-wide font-mono"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
                Triệu VNĐ
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              <button
                type="button"
                onClick={() => addPrincipal(50_000_000)}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-700 font-semibold text-xs transition-colors"
              >
                +50 Tr
              </button>
              <button
                type="button"
                onClick={() => addPrincipal(100_000_000)}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-700 font-semibold text-xs transition-colors"
              >
                +100 Tr
              </button>
              <button
                type="button"
                onClick={() => addPrincipal(200_000_000)}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-700 font-semibold text-xs transition-colors"
              >
                +200 Tr
              </button>
              <button
                type="button"
                onClick={() => addPrincipal(500_000_000)}
                className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 rounded-lg text-slate-700 font-semibold text-xs transition-colors"
              >
                +500 Tr
              </button>
              <button
                type="button"
                onClick={() => {
                  setPrincipal(0);
                  setPrincipalStr('');
                }}
                className="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg font-bold text-xs transition-colors ml-auto"
                title="Xóa trắng để nhập lại từ đầu"
              >
                Xóa hết
              </button>
            </div>
          </div>

          {/* Lãi suất & Kỳ hạn gửi */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="font-bold text-slate-700 block mb-1 text-sm">
                Lãi suất (% / năm):
              </label>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder="5.6"
                  required
                  value={interestRateStr}
                  onChange={handleInterestRateChange}
                  className="w-full px-3 py-2 pr-8 border border-slate-300 rounded-xl text-sm font-bold text-slate-900 focus:ring-2 focus:ring-emerald-500"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-slate-400">
                  %
                </span>
              </div>
            </div>

            <div>
              <label className="font-bold text-slate-700 block mb-1">
                Kỳ hạn gửi:
              </label>
              <CustomSelect
                value={termMonths}
                onChange={(val) => setTermMonths(Number(val))}
                options={[
                  { value: 1, label: '1 tháng (1T)' },
                  { value: 2, label: '2 tháng (2T)' },
                  { value: 3, label: '3 tháng (3T)' },
                  { value: 6, label: '6 tháng (6T)' },
                  { value: 9, label: '9 tháng (9T)' },
                  { value: 12, label: '12 tháng (1 năm)' },
                  { value: 13, label: '13 tháng' },
                  { value: 15, label: '15 tháng' },
                  { value: 18, label: '18 tháng' },
                  { value: 24, label: '24 tháng (2 năm)' },
                  { value: 36, label: '36 tháng (3 năm)' },
                ]}
              />
            </div>
          </div>

          {/* Ngày gửi tiền */}
          <div>
            <label className="font-bold text-slate-700 block mb-1">
              Ngày gửi tiền (Ngày/Tháng/Năm):
            </label>
            <DatePickerVN
              value={startDate}
              onChange={(val) => setStartDate(val)}
            />
          </div>

          {/* Khối dự tính kết quả tự động */}
          <div className="p-3 bg-emerald-50/80 rounded-2xl border border-emerald-200 space-y-1.5">
            <span className="text-[11px] font-bold text-emerald-900 uppercase tracking-wider block">
              Dự tính kết quả kỳ hạn:
            </span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-emerald-700">Ngày đáo hạn tự động:</span>
                <div className="font-bold text-slate-900 mt-0.5">
                  {formatDateVN(calculatedMaturity)} ({totalDays} ngày)
                </div>
              </div>
              <div className="text-right">
                <span className="text-emerald-700">Tiền lãi nhận về:</span>
                <div className="font-bold text-emerald-800 text-sm mt-0.5">
                  +{formatVND(estimatedInterest)}
                </div>
              </div>
            </div>
          </div>

          {/* Hành động */}
          <div className="flex items-center justify-end space-x-2 pt-2 border-t">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-slate-600 hover:bg-slate-100 font-semibold"
            >
              Hủy
            </button>
            <button
              type="submit"
              className="px-6 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold shadow-xs flex items-center space-x-1.5"
            >
              <Check className="w-4 h-4" />
              <span>{bookToEdit ? 'Lưu thay đổi' : 'Thêm vào danh mục'}</span>
            </button>
          </div>
        </form>
      </div>

      {/* Modal Quản lý ngân hàng (Sửa / Thêm / Bớt) */}
      <ManageBanksModal
        isOpen={isManageBanksModalOpen}
        onClose={() => setIsManageBanksModalOpen(false)}
        books={books}
        onBanksChanged={() => setBankListVersion((v) => v + 1)}
      />
    </div>
  );
};
