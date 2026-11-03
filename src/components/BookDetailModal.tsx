import React, { useState, useEffect } from 'react';
import { useToast } from '../context/ToastContext';
import {
  X,
  Landmark,
  Sparkles,
  Check,
  ChevronDown,
  Eye,
} from 'lucide-react';
import { SavingsBook, AppSettings, canEditData } from '../types';
import { getBankById } from '../data/banks';
import {
  formatMillionVND,
  formatDateVN,
  getOwnerLabel,
  getOwnerBadgeStyle,
} from '../utils/formatters';
import {
  analyzeBookMobilization,
  getDaysBetween,
  calculateMaturityDate,
  getAdjustedMaturityDate,
} from '../utils/calculator';
import { getBankTagForBook } from '../utils/dataTranslator';
import { CustomSelect } from './CustomSelect';

interface BookDetailModalProps {
  book: SavingsBook | null;
  books?: SavingsBook[];
  currentDateStr: string;
  settings: AppSettings;
  onClose: () => void;
  onUpdateBook?: (updatedBook: SavingsBook) => void;
  onSettleBook?: (bookId: string, extra?: { isEarlySettled: boolean; settlementDate: string; actualInterestVND: number }) => void;
  onRolloverBook?: (oldBookId: string, config: {
    newPrincipal: number;
    newInterestRate: number;
    newTermMonths: number;
    newStartDate: string;
    newMaturityDate: string;
  }) => void;
}

export const BookDetailModal: React.FC<BookDetailModalProps> = ({
  book,
  currentDateStr,
  settings,
  onClose,
  onUpdateBook,
  onSettleBook,
  onRolloverBook,
}) => {
  const { showToast } = useToast();
  // Local state for instant reactive UI updates
  const [localBook, setLocalBook] = useState<SavingsBook | null>(book);

  // States for settlement & rollover interactive actions
  const [showSettleConfirm, setShowSettleConfirm] = useState(false);
  const [isEarlySettle, setIsEarlySettle] = useState(false);
  const [showRolloverForm, setShowRolloverForm] = useState(false);
  const [showDepositTypeDropdown, setShowDepositTypeDropdown] = useState(false);
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);
  
  const [newPrincipal, setNewPrincipal] = useState<number>(book ? book.principal : 0);
  const [newPrincipalMillionsStr, setNewPrincipalMillionsStr] = useState<string>(book ? (book.principal / 1_000_000).toString() : '0');
  const [newTermMonths, setNewTermMonths] = useState<number>(book ? book.termMonths : 12);
  const [newInterestRateStr, setNewInterestRateStr] = useState<string>(book ? book.interestRate.toString() : '6.0');
  const [newStartDate, setNewStartDate] = useState<string>(book ? book.maturityDate : currentDateStr);
  const [newMaturityDate, setNewMaturityDate] = useState<string>('');

  useEffect(() => {
    setLocalBook(book);
  }, [book]);

  const activeBook = localBook || book;

  const handleOwnerChange = (newOwner: string) => {
    if (!activeBook) return;

    const updatedBook: SavingsBook = {
      ...activeBook,
      owner: newOwner,
    };
    setLocalBook(updatedBook);
    onUpdateBook?.(updatedBook);
  };

  const handleDepositTypeChange = (newType: 'online' | 'counter') => {
    if (!activeBook) return;
    const updatedBook: SavingsBook = {
      ...activeBook,
      depositType: newType,
    };
    setLocalBook(updatedBook);
    onUpdateBook?.(updatedBook);
    showToast(`Đã chuyển hình thức gửi sang: ${newType === 'online' ? 'Online (App)' : 'Tại quầy (Sổ giấy)'}`);
  };

  const calculateNewMaturityDate = (startDateStr: string, months: number): string => {
    try {
      return calculateMaturityDate(startDateStr, months);
    } catch {
      return startDateStr;
    }
  };

  useEffect(() => {
    if (book) {
      setNewPrincipal(book.principal);
      setNewPrincipalMillionsStr((book.principal / 1_000_000).toString());
      setNewTermMonths(book.termMonths || 12);
      setNewInterestRateStr((book.interestRate || 6.0).toString());
      setNewStartDate(book.maturityDate || currentDateStr);
      setNewMaturityDate(calculateNewMaturityDate(book.maturityDate || currentDateStr, book.termMonths || 12));
      setShowSettleConfirm(false);
      setIsEarlySettle(false);
      setShowRolloverForm(false);
    }
  }, [book, currentDateStr]);

  if (!book || !activeBook) return null;

  const bank = getBankById(activeBook.bankId);
  const isVip = settings.isVipMode ?? true;

  const analysis = analyzeBookMobilization(
    activeBook,
    currentDateStr,
    settings.defaultLoanMargin || 1.5,
    settings.defaultDemandRate || 0.2,
    isVip ? 1.0 : (settings.defaultLTV || 0.95),
    settings.bankLoanMargins,
    isVip
  );

  const adjustedMaturityDate = activeBook
    ? getAdjustedMaturityDate(activeBook.maturityDate, activeBook.depositType, activeBook.bankId)
    : '';
  const effectiveMaturityDate = adjustedMaturityDate || (activeBook ? activeBook.maturityDate : '');

  const daysToMaturity = effectiveMaturityDate ? getDaysBetween(currentDateStr, effectiveMaturityDate) : 0;
  const isOriginalMatured = daysToMaturity <= 0;

  // Safeguard: If the book is matured or overdue, we strictly forbid early settlement
  const effectiveIsEarlySettle = !isOriginalMatured ? isEarlySettle : false;
  const ownerBadge = getOwnerBadgeStyle(activeBook.owner);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 bg-slate-950/60 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl border border-slate-200 max-w-[435px] w-full max-h-[90vh] overflow-y-auto shadow-2xl p-3 sm:p-3.5 space-y-2.5">
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-slate-100 pb-2">
          <div className="flex items-center space-x-2.5">
            <div
              className="w-8.5 h-8.5 rounded-xl flex items-center justify-center font-bold text-sm shadow-2xs"
              style={{ backgroundColor: bank.primaryColor, color: bank.textColor }}
            >
              <Landmark className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-1.5">
                <h3 className="font-bold text-slate-900 text-sm">
                  {bank.shortName}
                </h3>
                <span className="text-[10px] font-mono px-1 py-0.2 rounded font-bold text-slate-600 bg-slate-100">
                  {getBankTagForBook(activeBook.bankId, activeBook.owner, bank.code)}
                </span>
              </div>
              <p className="text-[10.5px] text-slate-500 flex items-center space-x-1.5 mt-0.5">
                <span>Chủ sổ: <strong className={`font-bold px-1.2 py-0.3 rounded ${ownerBadge.bg} ${ownerBadge.text}`}>{getOwnerLabel(activeBook.owner)}</strong></span>
                <span>&bull;</span>
                <span>{activeBook.depositType === 'online' ? 'Gửi Online' : 'Tại quầy'}</span>
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Core Book Info Summary - Balanced & Perfectly Structured Layout */}
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3.5 sm:p-4 shadow-3xs space-y-3">
          {/* Row 1: Giant Financial Numbers */}
          <div className="grid grid-cols-2 gap-3 pb-3 border-b border-slate-200">
            <div>
              <span className="text-slate-400 block text-[10.5px] uppercase font-extrabold tracking-wider">
                Số tiền gốc
              </span>
              <span className="text-[20px] sm:text-[23px] font-black text-slate-950 font-mono mt-1 block leading-none">
                {formatMillionVND(activeBook.principal, settings.privacyMode)}
              </span>
            </div>

            <div>
              <span className="text-slate-400 block text-[10.5px] uppercase font-extrabold tracking-wider">
                Tiền lãi nhận
              </span>
              <span className="text-[20px] sm:text-[23px] font-black text-emerald-700 font-mono mt-1 block leading-none">
                +{formatMillionVND(analysis.fullTermInterest, settings.privacyMode)}
              </span>
            </div>
          </div>

          {/* Row 2: Parameters & Dates (Balanced 2x2 Grid) */}
          <div className="grid grid-cols-2 gap-2">
            {/* Box 1: Lãi suất & Kỳ hạn */}
            <div className="bg-white p-2.5 rounded-xl border border-slate-200/90 flex flex-col justify-between space-y-1">
              <span className="text-slate-400 block text-[10px] uppercase font-extrabold tracking-wider">
                Lãi suất &amp; Kỳ hạn
              </span>
              <div className="flex items-baseline gap-1">
                <span className="text-[16px] sm:text-[18px] font-black text-amber-700 font-mono leading-none">
                  {activeBook.interestRate}%
                </span>
                <span className="text-[10.5px] text-slate-500 font-bold">/năm</span>
              </div>
              <span className="text-[10.5px] text-slate-600 font-medium">
                Kỳ hạn: <strong className="text-slate-900 font-bold">{activeBook.termMonths} tháng</strong>
              </span>
            </div>

            {/* Box 2: Ngày gửi tiền */}
            <div className="bg-white p-2.5 rounded-xl border border-slate-200/90 flex flex-col justify-between space-y-1">
              <span className="text-slate-400 block text-[10px] uppercase font-extrabold tracking-wider">
                Ngày gửi tiền
              </span>
              <div>
                <span className="text-[14px] sm:text-[15px] font-black text-slate-900 font-mono leading-none">
                  {formatDateVN(activeBook.startDate)}
                </span>
              </div>
              <span className="text-[10.5px] text-slate-600 font-medium truncate">
                Hình thức: <strong className="text-slate-900 font-bold">{activeBook.depositType === 'online' ? 'Online' : 'Tại quầy'}</strong>
              </span>
            </div>

            {/* Box 3: Ngày đáo hạn */}
            <div className="bg-white p-2.5 rounded-xl border border-slate-200/90 flex flex-col justify-between space-y-1">
              <span className="text-slate-400 block text-[10px] uppercase font-extrabold tracking-wider">
                Ngày đáo hạn
              </span>
              <div>
                <span className={`text-[14px] sm:text-[15px] font-black font-mono leading-none ${daysToMaturity <= 30 ? 'text-rose-700' : 'text-slate-900'}`}>
                  {formatDateVN(effectiveMaturityDate)}
                </span>
              </div>
              <span className="text-[10.5px] text-slate-600 font-medium truncate">
                Tái tục: <strong className="text-slate-900 font-bold">{
                  activeBook.rolloverOption === 'principal_and_interest'
                    ? 'Gốc & lãi'
                    : activeBook.rolloverOption === 'principal_only'
                    ? 'Chỉ gốc'
                    : 'Không'
                }</strong>
              </span>
            </div>

            {/* Box 4: Thời gian còn lại & Badge đếm ngược */}
            <div className="bg-white p-2.5 rounded-xl border border-slate-200/90 flex flex-col justify-between space-y-1">
              <div className="flex items-center justify-between gap-1">
                <span className="text-slate-400 block text-[10px] uppercase font-extrabold tracking-wider truncate">
                  Thời gian
                </span>
                <span className={`text-[9.5px] px-1.5 py-0.2 rounded font-black font-mono shrink-0 ${
                  daysToMaturity < 0
                    ? 'bg-rose-100 text-rose-800'
                    : daysToMaturity === 0
                    ? 'bg-rose-600 text-white animate-pulse'
                    : daysToMaturity <= 30
                    ? 'bg-rose-100 text-rose-700 animate-pulse'
                    : 'bg-emerald-100 text-emerald-800'
                }`}>
                  {daysToMaturity < 0
                    ? `Quá ${Math.abs(daysToMaturity)}N`
                    : daysToMaturity === 0
                    ? 'Hôm nay'
                    : `Còn ${daysToMaturity}N`}
                </span>
              </div>
              <div>
                <span className={`text-[13px] sm:text-[14px] font-black font-mono leading-none ${daysToMaturity <= 30 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {daysToMaturity < 0
                    ? `Quá ${Math.abs(daysToMaturity)} ngày`
                    : daysToMaturity === 0
                    ? 'Đáo hạn hôm nay!'
                    : `${daysToMaturity} ngày`}
                </span>
              </div>
              <span className="text-[10.5px] text-slate-600 font-medium">
                {daysToMaturity > 0 ? `(~${Math.max(1, Math.round(daysToMaturity / 30.417))}T)` : 'Đã đến hạn'}
              </span>
            </div>
          </div>
        </div>

        {/* Điều chỉnh thuộc tính Người đứng tên sổ & Loại sổ (Online / Tại quầy) - Cô đọng và giảm chiều cao */}
        {activeBook.status !== 'settled' && (
          <div className="bg-slate-50 p-2.5 rounded-xl border border-slate-200 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-slate-500 font-bold uppercase mb-1">
                  Chủ sở hữu sổ
                </label>
                <input
                  type="text"
                  value={activeBook.owner}
                  onChange={(e) => handleOwnerChange(e.target.value)}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  placeholder="Nhập tên chủ sổ..."
                />
              </div>

              <div className="relative">
                <label className="block text-[10px] text-slate-500 font-bold uppercase mb-1">
                  Hình thức gửi
                </label>
                <button
                  type="button"
                  onClick={() => setShowDepositTypeDropdown(!showDepositTypeDropdown)}
                  className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-bold text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-500 flex items-center justify-between cursor-pointer"
                >
                  <span>{activeBook.depositType === 'online' ? 'Online' : 'Tại quầy'}</span>
                  <ChevronDown className="w-3.5 h-3.5 text-slate-500 transition-transform duration-200" style={{ transform: showDepositTypeDropdown ? 'rotate(180deg)' : 'none' }} />
                </button>

                {showDepositTypeDropdown && (
                  <>
                    <div 
                      className="fixed inset-0 z-10" 
                      onClick={() => setShowDepositTypeDropdown(false)}
                    />
                    <div className="absolute right-0 left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 z-20 animate-in fade-in slide-in-from-top-1 duration-100">
                      <button
                        type="button"
                        onClick={() => {
                          handleDepositTypeChange('online');
                          setShowDepositTypeDropdown(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-xs font-bold hover:bg-slate-50 flex items-center justify-between ${
                          activeBook.depositType === 'online' ? 'text-emerald-600 bg-emerald-50/50' : 'text-slate-700'
                        }`}
                      >
                        <span>Online</span>
                        {activeBook.depositType === 'online' && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleDepositTypeChange('counter');
                          setShowDepositTypeDropdown(false);
                        }}
                        className={`w-full text-left px-3 py-2 text-xs font-bold hover:bg-slate-50 flex items-center justify-between ${
                          activeBook.depositType === 'counter' ? 'text-emerald-600 bg-emerald-50/50' : 'text-slate-700'
                        }`}
                      >
                        <span>Tại quầy</span>
                        {activeBook.depositType === 'counter' && <Check className="w-3.5 h-3.5 text-emerald-600" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* SECTION: QUYẾT TOÁN & TÁI TỤC */}
        <div className="p-3.5 bg-slate-50 rounded-xl border border-slate-200 text-xs space-y-3">
          <h5 className="font-bold text-slate-800 flex items-center justify-between text-xs sm:text-sm">
            <span className="flex items-center">
              <Sparkles className="w-4 h-4 mr-1 text-emerald-600" />
              Tất Toán &amp; Tái Tục Sổ
            </span>
            {activeBook.status === 'settled' && (
              <span className="px-2 py-0.5 bg-slate-200 text-slate-700 text-[10px] rounded font-bold uppercase">
                Đã tất toán
              </span>
            )}
            {activeBook.status === 'active' && isOriginalMatured && (
              <span className="px-2 py-0.5 bg-rose-500 text-white text-[10px] rounded font-bold animate-pulse">
                {daysToMaturity < 0 ? 'Quá hạn' : 'Đến hạn'}
              </span>
            )}
          </h5>

          {activeBook.status === 'settled' ? (
            <div className="space-y-1">
              <p className="text-slate-600 text-[11px]">
                Sổ đã tất toán thành công và được lưu vào nhật ký giao dịch để đối soát và tính toán.
              </p>
            </div>
          ) : (
            <>
              {/* Active Book: Show Actions */}
              {!showSettleConfirm && !showRolloverForm && (
                <div className="space-y-2.5">
                  {isOriginalMatured && (
                    <div className="p-2.5 bg-amber-50 border border-amber-200 text-amber-900 rounded-lg text-[11px]">
                      Sổ đã {daysToMaturity < 0 ? `quá hạn ${Math.abs(daysToMaturity)} ngày` : 'đến hạn hôm nay'} (đáo hạn {formatDateVN(activeBook.maturityDate)}).
                    </div>
                  )}
                  
                  {!canEditData(settings.currentRole) ? (
                    <div className="p-3 bg-amber-500/10 border border-amber-500/30 text-amber-800 rounded-xl text-xs font-semibold flex items-center space-x-2">
                      <Eye className="w-4 h-4 text-amber-600 shrink-0" />
                      <span>Tài khoản ở vai trò <strong>Chỉ xem (Viewer)</strong> — Bạn không có quyền tất toán, tái tục hay tác động dữ liệu.</span>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {!isOriginalMatured ? (
                        <button
                          onClick={() => {
                            setIsEarlySettle(true);
                            setShowSettleConfirm(true);
                          }}
                          className="px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs transition-colors cursor-pointer flex items-center space-x-1"
                        >
                          <span>⚠️ Tất toán trước hạn (Rút sớm)</span>
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setIsEarlySettle(false);
                              setShowSettleConfirm(true);
                            }}
                            className="px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition-colors cursor-pointer"
                          >
                            {daysToMaturity < 0 ? '✅ Tất toán quá hạn' : '✅ Tất toán đúng hạn'}
                          </button>
                          <button
                            onClick={() => {
                              setNewPrincipal(activeBook.principal);
                              setNewPrincipalMillionsStr((activeBook.principal / 1_000_000).toString());
                              setShowRolloverForm(true);
                            }}
                            className="px-3.5 py-2 rounded-lg bg-teal-600 hover:bg-teal-700 text-white font-bold text-xs transition-colors cursor-pointer"
                          >
                            Tái tục (Mở sổ mới) 🔄
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Action 1: Settle Confirmation */}
              {showSettleConfirm && (
                <div className={`p-3 border rounded-xl space-y-2.5 animate-in fade-in duration-150 ${
                  effectiveIsEarlySettle 
                    ? 'bg-rose-50 border-rose-200 text-rose-900' 
                    : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                }`}>
                  <h6 className="font-bold text-xs">
                    {effectiveIsEarlySettle 
                      ? '⚠️ Xác nhận Tất toán TRƯỚC HẠN' 
                      : (daysToMaturity < 0 ? 'Xác nhận Tất toán QUÁ HẠN' : 'Xác nhận Tất toán ĐÚNG HẠN')
                    }
                  </h6>
                  <p className="text-[11px] leading-relaxed">
                    {effectiveIsEarlySettle 
                      ? `Áp dụng lãi suất không kỳ hạn (${settings.defaultDemandRate || 0.2}%/năm) tính đến hôm nay.`
                      : `Ghi nhận toàn bộ tiền lãi trọn kỳ (${activeBook.interestRate}%/năm).`
                    }
                  </p>
                  <div className="bg-white p-2.5 rounded-lg border border-slate-200 text-slate-700 space-y-1 text-xs">
                    <div className="flex justify-between">
                      <span>Tiền gốc:</span>
                      <span className="font-bold font-mono">{formatMillionVND(activeBook.principal, settings.privacyMode)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Lãi suất:</span>
                      <span className="font-bold text-indigo-700 font-mono">
                        {effectiveIsEarlySettle ? `${settings.defaultDemandRate || 0.2}%/năm (KKH)` : `${activeBook.interestRate}%/năm`}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Tiền lãi nhận:</span>
                      <span className="font-bold text-emerald-600 font-mono">
                        {effectiveIsEarlySettle 
                          ? formatMillionVND(analysis.passedDemandInterestEarned, settings.privacyMode) 
                          : formatMillionVND(analysis.fullTermInterest, settings.privacyMode)}
                      </span>
                    </div>
                    <div className="flex justify-between border-t border-slate-100 pt-1 font-bold text-slate-900">
                      <span>Tổng thực nhận:</span>
                      <span className={`font-mono ${effectiveIsEarlySettle ? 'text-rose-600' : 'text-emerald-600'}`}>
                        {effectiveIsEarlySettle
                          ? formatMillionVND(activeBook.principal + analysis.passedDemandInterestEarned, settings.privacyMode)
                          : formatMillionVND(activeBook.principal + analysis.fullTermInterest, settings.privacyMode)}
                      </span>
                    </div>
                  </div>
                  <div className="flex space-x-2 pt-0.5">
                    <button
                      disabled={isSubmittingAction}
                      onClick={() => {
                        if (isSubmittingAction) return;
                        setIsSubmittingAction(true);
                        if (onSettleBook) {
                          onSettleBook(activeBook.id, {
                            isEarlySettled: effectiveIsEarlySettle,
                            settlementDate: effectiveIsEarlySettle ? currentDateStr : (daysToMaturity < 0 ? currentDateStr : adjustedMaturityDate),
                            actualInterestVND: effectiveIsEarlySettle ? analysis.passedDemandInterestEarned : analysis.fullTermInterest,
                          });
                        }
                        setTimeout(() => setIsSubmittingAction(false), 800);
                      }}
                      className={`px-3.5 py-1.5 text-white font-bold rounded-lg text-xs transition-colors ${
                        isSubmittingAction ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                      } ${
                        effectiveIsEarlySettle 
                          ? 'bg-rose-600 hover:bg-rose-700' 
                          : 'bg-emerald-600 hover:bg-emerald-700'
                      }`}
                    >
                      {effectiveIsEarlySettle ? 'Xác nhận Rút trước hạn' : 'Xác nhận Tất toán'}
                    </button>
                    <button
                      onClick={() => setShowSettleConfirm(false)}
                      className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold rounded-lg cursor-pointer text-xs"
                    >
                      Hủy bỏ
                    </button>
                  </div>
                </div>
              )}

              {/* Action 2: Rollover Form */}
              {showRolloverForm && (
                <div className="p-3 bg-teal-50 border border-teal-200 rounded-xl space-y-3 animate-in fade-in duration-150">
                  <h6 className="font-bold text-teal-950 text-xs">
                    Cấu hình Tái tục (Mở chu kỳ gửi mới)
                  </h6>
                  <p className="text-teal-900 text-[11px]">
                    Sổ cũ được lưu vào <strong>Nhật ký biến động</strong>. Bạn có thể điều chỉnh số tiền gốc, lãi suất và kỳ hạn cho sổ mới bên dưới:
                  </p>

                  <div className="space-y-2.5 text-slate-800 text-xs">
                    {/* Editable Principal for new book */}
                    <div className="p-2.5 bg-white border border-teal-100 rounded-lg space-y-1.5">
                      <div className="flex justify-between items-center">
                        <label className="block text-[11px] font-bold text-slate-700 uppercase">
                          Tiền gốc chu kỳ mới (Triệu VNĐ):
                        </label>
                        <span className="text-[11px] font-bold text-teal-700 font-mono">
                          {newPrincipal > 0 ? formatMillionVND(newPrincipal, settings.privacyMode) : '0 Tr VNĐ'}
                        </span>
                      </div>
                      <div className="relative">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={newPrincipalMillionsStr}
                          onChange={(e) => {
                            const rawVal = e.target.value;
                            const sanitized = rawVal.replace(/[^0-9.,]/g, '').replace(',', '.');
                            setNewPrincipalMillionsStr(rawVal);
                            const num = parseFloat(sanitized);
                            if (isNaN(num) || num <= 0) {
                              setNewPrincipal(0);
                            } else {
                              setNewPrincipal(Math.round(num * 1_000_000));
                            }
                          }}
                          placeholder={`Ví dụ: ${(activeBook.principal / 1_000_000).toString()}`}
                          className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded-lg font-mono text-xs font-bold text-slate-900 focus:outline-none focus:ring-1 focus:ring-teal-500 focus:bg-white pr-16"
                        />
                        <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400">
                          Tr VNĐ
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5 border-t border-slate-100">
                        <span>Gốc cũ: <strong className="text-slate-700 font-mono">{formatMillionVND(activeBook.principal, settings.privacyMode)}</strong></span>
                        <span>Lãi cũ: <strong className="text-emerald-600 font-mono">{formatMillionVND(analysis.fullTermInterest, settings.privacyMode)}</strong></span>
                      </div>
                    </div>

                    {/* Term and rate grid */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="block text-[10px] font-bold text-slate-600 uppercase">
                          Kỳ hạn mới:
                        </label>
                        <CustomSelect
                          value={newTermMonths}
                          onChange={(val) => {
                            const num = Number(val);
                            setNewTermMonths(num);
                            setNewMaturityDate(calculateNewMaturityDate(newStartDate, num));
                          }}
                          options={[
                            { value: 1, label: '1 Tháng (1T)' },
                            { value: 2, label: '2 Tháng (2T)' },
                            { value: 3, label: '3 Tháng (3T)' },
                            { value: 6, label: '6 Tháng (6T)' },
                            { value: 9, label: '9 Tháng (9T)' },
                            { value: 12, label: '12 Tháng (12T)' },
                            { value: 13, label: '13 Tháng (13T)' },
                            { value: 18, label: '18 Tháng (18T)' },
                            { value: 24, label: '24 Tháng (24T)' },
                            { value: 36, label: '36 Tháng (36T)' },
                          ]}
                          size="sm"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="block text-[10px] font-bold text-slate-600 uppercase">
                          Lãi suất (%/năm):
                        </label>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={newInterestRateStr}
                          onChange={(e) => setNewInterestRateStr(e.target.value)}
                          placeholder="6.0"
                          className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg font-mono text-xs font-bold text-teal-700 focus:outline-none focus:ring-1 focus:ring-teal-500"
                        />
                      </div>
                    </div>

                    {/* Start Date and Computed Maturity Date */}
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div>
                        <span className="block font-bold text-slate-500 uppercase text-[10px]">Ngày bắt đầu:</span>
                        <input
                          type="date"
                          value={newStartDate}
                          onChange={(e) => {
                            const val = e.target.value;
                            setNewStartDate(val);
                            setNewMaturityDate(calculateNewMaturityDate(val, newTermMonths));
                          }}
                          className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-teal-500"
                        />
                      </div>
                      <div>
                        <span className="block font-bold text-slate-500 uppercase text-[10px]">Ngày đáo hạn mới:</span>
                        <input
                          type="date"
                          value={newMaturityDate}
                          onChange={(e) => setNewMaturityDate(e.target.value)}
                          className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-teal-500 font-mono text-slate-800"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex space-x-2 pt-1">
                    <button
                      disabled={isSubmittingAction}
                      onClick={() => {
                        if (isSubmittingAction) return;
                        setIsSubmittingAction(true);
                        const finalPrincipal = newPrincipal > 0 ? newPrincipal : activeBook.principal;
                        const parsedRate = parseFloat(newInterestRateStr.replace(',', '.'));
                        const finalRate = !isNaN(parsedRate) && parsedRate >= 0 ? parsedRate : (activeBook.interestRate || 6.0);
                        if (onRolloverBook) {
                          onRolloverBook(activeBook.id, {
                            newPrincipal: finalPrincipal,
                            newInterestRate: finalRate,
                            newTermMonths: newTermMonths,
                            newStartDate: newStartDate,
                            newMaturityDate: newMaturityDate,
                          });
                        }
                        setTimeout(() => setIsSubmittingAction(false), 800);
                      }}
                      className={`px-3.5 py-1.5 bg-teal-600 hover:bg-teal-700 text-white font-bold rounded-lg text-xs transition-colors ${
                        isSubmittingAction ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                      }`}
                    >
                      Xác nhận Tái tục 🔄
                    </button>
                    <button
                      onClick={() => setShowRolloverForm(false)}
                      className="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 font-semibold rounded-lg cursor-pointer text-xs"
                    >
                      Hủy bỏ
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end pt-1">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold cursor-pointer transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
};
