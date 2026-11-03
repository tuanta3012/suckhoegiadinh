import React, { useState, useEffect, useMemo, useRef } from 'react';
import { SavingsBook, AppSettings, SettlementAdjustment, canEditData } from '../types';
import { getBankById } from '../data/banks';
import { getDynamicAnnualInterestHistory, getDynamicBalanceGrowthHistory } from '../data/historicalGrowth';
import {
  formatVND,
  formatShortVND,
  formatAdaptiveVND,
  formatAdaptiveShortVND,
  formatDateVN,
  formatPercent,
  getOwnerLabel,
  getOwnerBadgeStyle,
} from '../utils/formatters';
import { getDaysBetween, getAdjustedMaturityDate, calculateMaturityDate } from '../utils/calculator';
import { getBankTagForBook } from '../utils/dataTranslator';
import { parseExcelFile } from '../utils/excelParser';
import { CustomSelect } from './CustomSelect';
import { 
  FileSpreadsheet, 
  TrendingUp, 
  Coins, 
  ArrowUpDown, 
  CheckCircle2, 
  Clock, 
  SlidersHorizontal,
  BarChart3,
  Cloud,
  RefreshCw,
  Upload,
  Plus,
  X,
  Landmark,
  Sparkles,
  AlertTriangle,
  Eye,
} from 'lucide-react';

const CashflowChart = React.lazy(() =>
  import('./CashflowChart').then((module) => ({ default: module.CashflowChart }))
);

interface ExcelSheetViewProps {
  books: SavingsBook[];
  settings: AppSettings;
  currentDateStr: string;
  banksVersion?: number;
  settlements?: SettlementAdjustment[];
  onOpenDetail: (book: SavingsBook) => void;
  onUpdateBook?: (book: SavingsBook) => void;
  onSettleBook?: (bookId: string, extra?: { isEarlySettled: boolean; settlementDate: string; actualInterestVND: number }) => void;
  onRolloverBook?: (
    oldBookId: string,
    rolloverConfig: {
      newPrincipal: number;
      newInterestRate: number;
      newTermMonths: number;
      newStartDate: string;
      newMaturityDate: string;
    }
  ) => void;
  onDeleteBook?: (bookId: string) => void;
  onOpenOptimizer: () => void;
  onOpenSyncModal?: () => void;
  onOpenInterestCalc?: () => void;
  onSyncDrive?: () => Promise<void>;
  isSyncingDrive?: boolean;
  onImportBooks?: (books: SavingsBook[], mode: 'replace' | 'merge') => void;
  onOpenAddModal?: () => void;
}

export const ExcelSheetView: React.FC<ExcelSheetViewProps> = ({
  books,
  settings,
  currentDateStr,
  banksVersion = 0,
  settlements = [],
  onOpenDetail,
  onSettleBook,
  onRolloverBook,
  onOpenOptimizer,
  onOpenSyncModal,
  onImportBooks,
  onOpenAddModal,
}) => {
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'remaining' | 'maturity' | 'principal' | 'rate' | 'original'>('remaining');
  const [isReadingFile, setIsReadingFile] = useState<boolean>(false);
  const [selectedSummaryBook, setSelectedSummaryBook] = useState<any | null>(null);

  // States cho Interactive Quick Action Modal
  const [showSettleConfirm, setShowSettleConfirm] = useState<boolean>(false);
  const [showRolloverConfig, setShowRolloverConfig] = useState<boolean>(false);
  const [newRolloverPrincipal, setNewRolloverPrincipal] = useState<number>(0);
  const [newRolloverPrincipalStr, setNewRolloverPrincipalStr] = useState<string>('');
  const [newRolloverTerm, setNewRolloverTerm] = useState<number>(12);
  const [newRolloverRateStr, setNewRolloverRateStr] = useState<string>('5.5');
  const [newRolloverStartDate, setNewRolloverStartDate] = useState<string>(currentDateStr);

  useEffect(() => {
    if (selectedSummaryBook) {
      setShowSettleConfirm(false);
      setShowRolloverConfig(false);

      const daysTotal = Math.max(1, getDaysBetween(selectedSummaryBook.startDate, selectedSummaryBook.maturityDate));
      const expectedTermInterest = selectedSummaryBook.calculatedTermInterest ?? selectedSummaryBook.expectedTermInterest ?? Math.round((selectedSummaryBook.principal * (selectedSummaryBook.interestRate / 100) * daysTotal) / 365);
      const defaultNewPrincipal = selectedSummaryBook.principal + expectedTermInterest;

      setNewRolloverPrincipal(defaultNewPrincipal);
      setNewRolloverPrincipalStr((defaultNewPrincipal / 1_000_000).toString());
      setNewRolloverTerm(selectedSummaryBook.termMonths || 12);
      setNewRolloverRateStr((selectedSummaryBook.interestRate || 5.5).toString());
      setNewRolloverStartDate(currentDateStr);
    }
  }, [selectedSummaryBook, currentDateStr]);

  const [isProcessingAction, setIsProcessingAction] = useState(false);

  const handleConfirmSettle = (type: 'before_term' | 'on_term') => {
    if (isProcessingAction) return;
    if (selectedSummaryBook && onSettleBook) {
      setIsProcessingAction(true);
      const daysTotal = Math.max(1, getDaysBetween(selectedSummaryBook.startDate, selectedSummaryBook.maturityDate));
      const expectedTermInterest = selectedSummaryBook.calculatedTermInterest ?? selectedSummaryBook.expectedTermInterest ?? Math.round((selectedSummaryBook.principal * (selectedSummaryBook.interestRate / 100) * daysTotal) / 365);
      
      const isEarly = type === 'before_term';
      const daysActual = Math.max(1, getDaysBetween(selectedSummaryBook.startDate, currentDateStr));
      const actualInterestVND = isEarly
        ? Math.round((selectedSummaryBook.principal * 0.001 * daysActual) / 365)
        : expectedTermInterest;

      onSettleBook(selectedSummaryBook.id, {
        isEarlySettled: isEarly,
        settlementDate: currentDateStr,
        actualInterestVND,
      });
      setSelectedSummaryBook(null);
      setTimeout(() => setIsProcessingAction(false), 500);
    }
  };

  const handleConfirmRollover = () => {
    if (isProcessingAction) return;
    if (selectedSummaryBook && onRolloverBook) {
      setIsProcessingAction(true);
      const finalPrincipal = newRolloverPrincipal > 0 ? newRolloverPrincipal : selectedSummaryBook.principal;
      const parsedRate = parseFloat(newRolloverRateStr.replace(',', '.'));
      const finalRate = !isNaN(parsedRate) && parsedRate >= 0 ? parsedRate : (selectedSummaryBook.interestRate || 5.5);

      const rawMaturity = calculateMaturityDate(newRolloverStartDate, newRolloverTerm);
      const newMaturityDate = getAdjustedMaturityDate(
        rawMaturity,
        selectedSummaryBook.depositType === 'online' ? 'online' : 'counter',
        selectedSummaryBook.bankId
      );

      onRolloverBook(selectedSummaryBook.id, {
        newPrincipal: finalPrincipal,
        newInterestRate: finalRate,
        newTermMonths: newRolloverTerm,
        newStartDate: newRolloverStartDate,
        newMaturityDate,
      });
      setSelectedSummaryBook(null);
      setTimeout(() => setIsProcessingAction(false), 500);
    }
  };


  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedSummaryBook) {
        setSelectedSummaryBook(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSummaryBook]);

  const handleManualFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsReadingFile(true);
    try {
      const res = await parseExcelFile(file);
      if (res.success && res.books.length > 0) {
        onImportBooks?.(res.books, 'replace');
      } else {
        alert('File không hợp lệ hoặc không tìm thấy danh mục sổ tiết kiệm chuẩn.');
      }
    } catch (err: any) {
      alert('Lỗi khi đọc file Excel: ' + (err?.message || ''));
    } finally {
      setIsReadingFile(false);
      if (e.target) e.target.value = '';
    }
  };

  // Danh sách các tag chủ sổ có trong dữ liệu
  const uniqueOwnerTags = useMemo(() => {
    const list: string[] = [];
    books.forEach((b) => {
      if (b.owner) {
        const lbl = getOwnerLabel(b.owner);
        if (!list.includes(lbl)) {
          list.push(lbl);
        }
      }
    });
    return list;
  }, [books]);

  // Định dạng chuẩn triệu đồng (Tr) theo đúng file Excel liên kết
  const formatMoney = (valVND: number) => {
    if (settings.privacyMode) return '••••••';
    const mil = valVND / 1_000_000;
    return mil.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
  };

  // Tính toán số ngày và số tháng còn lại theo thời gian thực (tính từ ngày hiện tại)
  const booksWithMetrics = useMemo(() => {
    return books.map((book, idx) => {
      const adjustedMaturityDate = getAdjustedMaturityDate(book.maturityDate, book.depositType, book.bankId);
      const effectiveMaturityDate = adjustedMaturityDate || book.maturityDate;
      const daysToMaturity = getDaysBetween(currentDateStr, effectiveMaturityDate);
      const monthsRemaining = Math.max(0, Math.round(daysToMaturity / 30.417));
      
      // Tiền lãi theo sổ (tính theo số ngày thực tế gửi đến ngày đáo hạn thực tế)
      const daysTotal = Math.max(1, getDaysBetween(book.startDate, effectiveMaturityDate));
      const termInterest = book.expectedTermInterest ?? Math.round((book.principal * (book.interestRate / 100) * daysTotal) / 365);
      
      // Tiền lãi 1 năm quy đổi
      const annualInterest = book.annualInterestEquivalent ?? Math.round(book.principal * (book.interestRate / 100));

      return {
        ...book,
        maturityDate: effectiveMaturityDate,
        originalIndex: idx + 1,
        adjustedMaturityDate: effectiveMaturityDate,
        isWeekendPostponed: false,
        daysToMaturity,
        monthsRemaining,
        calculatedTermInterest: termInterest,
        calculatedAnnualInterest: annualInterest,
      };
    });
  }, [books, currentDateStr, banksVersion]);

  // Lọc theo Phân loại và sắp xếp
  const displayedBooks = useMemo(() => {
    return booksWithMetrics
      .filter((b) => {
        if (filterCategory === 'all') return true;
        if (filterCategory === 'online') return b.depositType === 'online';
        if (filterCategory === 'counter') return b.depositType === 'counter';
        return getOwnerLabel(b.owner) === filterCategory;
      })
      .sort((a, b) => {
        if (sortBy === 'maturity') return a.maturityDate.localeCompare(b.maturityDate);
        if (sortBy === 'principal') return b.principal - a.principal;
        if (sortBy === 'rate') return b.interestRate - a.interestRate;
        if (sortBy === 'remaining') return a.daysToMaturity - b.daysToMaturity;
        return 0;
      });
  }, [booksWithMetrics, filterCategory, sortBy]);

  const cashflowChartData = useMemo(() => {
    return booksWithMetrics
      .reduce<Array<{
        monthKey: string;
        label: string;
        principalMillion: number;
        interestMillion: number;
      }>>((acc, item) => {
        const monthKey = item.maturityDate.slice(0, 7);
        const [year, month] = monthKey.split('-');
        const label = `T${parseInt(month, 10)}/${year.slice(2)}`;
        const existing = acc.find((entry) => entry.monthKey === monthKey);
        if (existing) {
          existing.principalMillion += Math.round(item.principal / 1_000_000);
          existing.interestMillion += Math.round(item.calculatedTermInterest / 1_000_000);
        } else {
          acc.push({
            monthKey,
            label,
            principalMillion: Math.round(item.principal / 1_000_000),
            interestMillion: Math.round(item.calculatedTermInterest / 1_000_000),
          });
        }
        return acc;
      }, [])
      .sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  }, [booksWithMetrics]);

  // Tổng hợp thống kê dựa trên danh sách đang hiển thị
  const summary = useMemo(() => {
    const totalPrincipal = displayedBooks.reduce((sum, b) => sum + b.principal, 0);
    const totalTermInterest = displayedBooks.reduce((sum, b) => sum + b.calculatedTermInterest, 0);
    const totalAnnualInterest = displayedBooks.reduce((sum, b) => sum + b.calculatedAnnualInterest, 0);
    
    const weightedRateSum = displayedBooks.reduce((sum, b) => {
      const term = b.termMonths || Math.max(1, Math.round(getDaysBetween(b.startDate, b.maturityDate) / 30));
      return sum + (b.principal * b.interestRate * term);
    }, 0);
    const weightedTermSum = displayedBooks.reduce((sum, b) => {
      const term = b.termMonths || Math.max(1, Math.round(getDaysBetween(b.startDate, b.maturityDate) / 30));
      return sum + (b.principal * term);
    }, 0);
    const weightedAvgRate = weightedTermSum > 0 ? weightedRateSum / weightedTermSum : (totalPrincipal > 0 ? (totalAnnualInterest / totalPrincipal) * 100 : 0);
    const monthlyAverageInterest = totalAnnualInterest / 12;

    const seAAmount = displayedBooks
      .filter((b) => b.bankId === 'seabank' || b.bankId === 'sea2')
      .reduce((s, b) => s + b.principal, 0);
    const shbAmount = displayedBooks
      .filter((b) => b.bankId === 'shb')
      .reduce((s, b) => s + b.principal, 0);

    return {
      totalPrincipal,
      totalTermInterest,
      totalAnnualInterest,
      weightedAvgRate,
      monthlyAverageInterest,
      seAAmount,
      shbAmount,
      seAPercent: totalPrincipal > 0 ? (seAAmount / totalPrincipal) * 100 : 0,
      shbPercent: totalPrincipal > 0 ? (shbAmount / totalPrincipal) * 100 : 0,
    };
  }, [displayedBooks]);

  // Sổ đến hạn gần nhất & Lãi suất cao nhất (Dynamic)
  const nextMaturingBook = useMemo(() => {
    if (booksWithMetrics.length === 0) return null;
    const futureOnly = booksWithMetrics.filter((b) => b.daysToMaturity >= 0);
    if (futureOnly.length === 0) return booksWithMetrics[0];
    return [...futureOnly].sort((a, b) => a.daysToMaturity - b.daysToMaturity)[0];
  }, [booksWithMetrics]);

  const highestRateBook = useMemo(() => {
    if (booksWithMetrics.length === 0) return null;
    return [...booksWithMetrics].sort((a, b) => b.interestRate - a.interestRate)[0];
  }, [booksWithMetrics]);

  // Dynamic history records synchronized in real-time with current active books & settlements
  const dynamicAnnualInterest = useMemo(
    () => getDynamicAnnualInterestHistory(books, settlements),
    [books, settlements]
  );
  const dynamicBalanceGrowth = useMemo(
    () => getDynamicBalanceGrowthHistory(books, settlements),
    [books, settlements]
  );

  // Auto scroll history tables to bottom (latest 5 rows)
  const table1ScrollRef = useRef<HTMLDivElement>(null);
  const table2ScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (table1ScrollRef.current) {
      table1ScrollRef.current.scrollTop = table1ScrollRef.current.scrollHeight;
    }
    if (table2ScrollRef.current) {
      table2ScrollRef.current.scrollTop = table2ScrollRef.current.scrollHeight;
    }
  }, [dynamicAnnualInterest, dynamicBalanceGrowth]);

  // Dynamic Bank Breakdown
  const bankBreakdown = useMemo(() => {
    const map = new Map<string, { count: number; amount: number; name: string; color: string }>();
    booksWithMetrics.forEach((b) => {
      const bank = getBankById(b.bankId);
      const code = bank.code;
      const existing = map.get(code) || { count: 0, amount: 0, name: bank.shortName, color: bank.primaryColor };
      existing.count += 1;
      existing.amount += b.principal;
      map.set(code, existing);
    });
    return Array.from(map.entries()).map(([code, data]) => ({
      code,
      ...data,
      percent: summary.totalPrincipal > 0 ? (data.amount / summary.totalPrincipal) * 100 : 0,
    }));
  }, [booksWithMetrics, summary.totalPrincipal]);

  return (
    <div className="space-y-4">
      {/* Financial Overview & Cashflow Chart Card */}
      {books.length > 0 && (
      <div className="bg-gradient-to-r from-emerald-950 via-slate-900 to-emerald-950 text-white rounded-2xl p-4 sm:p-5 shadow-sm border border-emerald-800/40 space-y-4">
        {/* 4 Quick Stat KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3.5">
          <div className="bg-white/10 rounded-xl p-2.5 sm:p-3.5 border border-white/10 flex flex-col justify-between">
            <span className="text-[11px] sm:text-xs text-emerald-200 font-medium block leading-tight">
              Tổng tiền gửi (Gốc)
            </span>
            <span className="text-base sm:text-xl font-bold text-white block mt-1 font-mono tracking-tight">
              {books.length > 0 ? formatAdaptiveVND(summary.totalPrincipal, settings.privacyMode) : '0 Tr VNĐ'}
            </span>
            <span className="text-[10px] sm:text-[11px] text-emerald-300 mt-0.5">{books.length} sổ tiết kiệm</span>
          </div>

          <div className="bg-white/10 rounded-xl p-2.5 sm:p-3.5 border border-white/10 flex flex-col justify-between">
            <span className="text-[11px] sm:text-xs text-emerald-200 font-medium block leading-tight">
              Tổng tiền lãi theo sổ
            </span>
            <span className="text-base sm:text-xl font-bold text-amber-300 block mt-1 font-mono tracking-tight">
              {books.length > 0 ? `+${formatAdaptiveVND(summary.totalTermInterest, settings.privacyMode)}` : '0 Tr VNĐ'}
            </span>
            <span className="text-[10px] sm:text-[11px] text-emerald-300 mt-0.5">Nhận khi đến hạn</span>
          </div>

          <div className="bg-white/10 rounded-xl p-2.5 sm:p-3.5 border border-white/10 flex flex-col justify-between">
            <span className="text-[11px] sm:text-xs text-emerald-200 font-medium block leading-tight">
              Tiền lãi quy đổi 1 năm
            </span>
            <span className="text-base sm:text-xl font-bold text-emerald-300 block mt-1 font-mono tracking-tight">
              {books.length > 0 ? `${formatAdaptiveVND(summary.totalAnnualInterest, settings.privacyMode)}/năm` : '0 Tr VNĐ/năm'}
            </span>
            <span className="text-[10px] sm:text-[11px] text-emerald-300 mt-0.5">
              ~{books.length > 0 ? formatAdaptiveShortVND(summary.monthlyAverageInterest, settings.privacyMode) : '0'}/tháng
            </span>
          </div>

          <div className="bg-white/10 rounded-xl p-2.5 sm:p-3.5 border border-white/10 flex flex-col justify-between">
            <span className="text-[11px] sm:text-xs text-emerald-200 font-medium block leading-tight">
              Lãi suất bình quân
            </span>
            <span className="text-base sm:text-xl font-bold text-yellow-300 block mt-1 font-mono tracking-tight">
              {formatPercent(summary.weightedAvgRate)} / năm
            </span>
            <span className="text-[10px] sm:text-[11px] text-emerald-300 mt-0.5 truncate">
              {highestRateBook ? `Đỉnh: ${formatPercent(highestRateBook.interestRate)} (${getBankById(highestRateBook.bankId).code})` : 'Chưa có sổ'}
            </span>
          </div>
        </div>

        {/* Embedded Cashflow Bar Chart - Always Shown by Default */}
        {books.length > 0 && (
          <div className="pt-3 sm:pt-4 border-t border-emerald-700/40 space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 text-xs">
              <span className="font-bold text-white flex items-center">
                <BarChart3 className="w-4 h-4 mr-1.5 text-amber-300 shrink-0" />
                Dòng tiền đáo hạn theo tháng (Gốc &amp; Lãi nhận về)
              </span>
              <div className="flex items-center space-x-3 text-emerald-200 text-[11px]">
                <span className="flex items-center">
                  <span className="w-2.5 h-2.5 bg-emerald-400 rounded mr-1"></span> Gốc đáo hạn
                </span>
                <span className="flex items-center">
                  <span className="w-2.5 h-2.5 bg-amber-400 rounded mr-1"></span> Lãi thực nhận
                </span>
              </div>
            </div>

            <div className="h-48 sm:h-56 w-full bg-slate-900/60 rounded-xl p-2 sm:p-3 border border-white/10">
              <React.Suspense fallback={<div className="h-full animate-pulse rounded-lg bg-slate-800" />}>
                <CashflowChart data={cashflowChartData} />
              </React.Suspense>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Control Bar: Filter, Sort & Action */}
      {books.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-3 sm:p-4 shadow-xs space-y-3">
          {/* Row 1: Phân loại tags (All, Chủ sổ, Online, Tại quầy) - Horizontally scrollable on mobile */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar w-full">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center mr-1 shrink-0">
              <SlidersHorizontal className="w-3.5 h-3.5 mr-1 text-slate-400" />
              Phân loại:
            </span>

            <button
              type="button"
              onClick={() => setFilterCategory('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterCategory === 'all'
                  ? 'bg-slate-900 text-white shadow-2xs'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              Tất cả ({books.length})
            </button>

            {uniqueOwnerTags.map((tag) => {
              const count = books.filter((b) => getOwnerLabel(b.owner) === tag).length;
              const isSelected = filterCategory === tag;
              const badge = getOwnerBadgeStyle(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setFilterCategory(tag)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer border ${
                    isSelected
                      ? 'bg-slate-900 text-white border-slate-900 shadow-2xs'
                      : `${badge.badgeClass} hover:opacity-90`
                  }`}
                >
                  {tag} ({count})
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => setFilterCategory('online')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterCategory === 'online'
                  ? 'bg-teal-700 text-white shadow-2xs'
                  : 'bg-teal-50 text-teal-800 hover:bg-teal-100 border border-teal-200/60'
              }`}
            >
              Online ({books.filter(b => b.depositType === 'online').length})
            </button>
            <button
              type="button"
              onClick={() => setFilterCategory('counter')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filterCategory === 'counter'
                  ? 'bg-amber-700 text-white shadow-2xs'
                  : 'bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200/60'
              }`}
            >
              Tại quầy ({books.filter(b => b.depositType === 'counter').length})
            </button>
          </div>

          {/* Row 2: Sorting & Action Button */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-2.5 border-t border-slate-100">
            {/* Sort selector - unified styling & guaranteed no overflow */}
            <div className="flex items-center space-x-2 w-full sm:w-auto min-w-0">
              <span className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center shrink-0">
                <ArrowUpDown className="w-3.5 h-3.5 mr-1 text-slate-400" />
                Sắp xếp:
              </span>
              <div className="flex-1 sm:w-64 min-w-0">
                <CustomSelect
                  value={sortBy}
                  onChange={(val) => setSortBy(val as any)}
                  options={[
                    { value: 'remaining', label: 'Tháng còn lại (Sắp đến hạn)' },
                    { value: 'maturity', label: 'Ngày đáo hạn (Tăng dần)' },
                    { value: 'original', label: 'Thứ tự chuẩn File Excel' },
                    { value: 'principal', label: 'Số tiền gửi (Lớn nhất)' },
                    { value: 'rate', label: 'Lãi suất (% cao nhất)' },
                  ]}
                  size="sm"
                />
              </div>
            </div>

            <button
              onClick={onOpenOptimizer}
              className="w-full sm:w-auto justify-center px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-slate-950 font-bold text-xs shadow-xs transition-colors flex items-center space-x-1.5 shrink-0 cursor-pointer"
            >
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Mô phỏng Vay Mua Nhà</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Table Container matching Excel Layout */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        {displayedBooks.length === 0 ? (
          <div className="py-8 px-4 flex flex-col items-center justify-center text-center">
            <div className="flex flex-col items-center justify-center space-y-3 max-w-md w-full bg-slate-50/90 p-4 sm:p-5 rounded-2xl border border-slate-200">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-xs">
                <FileSpreadsheet className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <p className="font-extrabold text-slate-900 text-base">Chưa có sổ tiết kiệm</p>
                <p className="text-xs text-slate-600 leading-relaxed">
                  {settings.googleSheetUrl ? (
                    'Đồng bộ Google Drive để tải sổ về.'
                  ) : (
                    'Kết nối Google Drive, tải file Excel hoặc thêm sổ mới.'
                  )}
                </p>
              </div>

              {/* Hidden manual file input for Excel file */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                onChange={handleManualFileInput}
                className="hidden"
              />

              <div className="flex flex-col sm:flex-row flex-wrap items-center justify-center gap-2 pt-1.5 w-full">

                {onOpenSyncModal && (
                  <button
                    onClick={onOpenSyncModal}
                    className="flex items-center justify-center space-x-2 w-full sm:w-auto px-4 py-2.5 rounded-xl bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-bold text-xs border border-emerald-300 shadow-2xs transition-colors cursor-pointer"
                  >
                    <Cloud className="w-3.5 h-3.5 text-emerald-600" />
                    <span>{settings.googleSheetUrl ? 'Đồng bộ Drive' : 'Kết nối Drive'}</span>
                  </button>
                )}

                <button
                  disabled={isReadingFile}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex items-center justify-center space-x-2 w-full sm:w-auto px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition-all active:scale-98 disabled:opacity-60 disabled:cursor-wait cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{isReadingFile ? 'Đang đọc file...' : 'Tải file Excel'}</span>
                </button>

                {onOpenAddModal && (
                  <button
                    onClick={onOpenAddModal}
                    className="flex items-center justify-center space-x-2 w-full sm:w-auto px-3.5 py-2.5 rounded-xl bg-teal-700 hover:bg-teal-800 active:bg-teal-900 text-white font-bold text-xs transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-teal-100" />
                    <span>Thêm sổ</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              {/* Table Header - Compact ~70% height */}
              <thead>
                <tr className="bg-slate-200/90 text-slate-900 border-b-2 border-slate-300 font-extrabold uppercase tracking-wide text-[11.5px]">
                  <th className="py-1 px-2 text-center w-10">STT</th>
                  <th className="py-1 px-2 text-center">Ngân hàng</th>
                  <th className="py-1 px-2 text-center">Lãi suất</th>
                  <th className="py-1 px-2.5 text-right">
                    Tiền gửi (Tr VNĐ)
                  </th>
                  <th className="py-1 px-2 text-center">Ngày gửi</th>
                  <th className="py-1 px-2 text-center">Đáo hạn</th>
                  <th className="py-1 px-1 text-center w-14">Kỳ hạn</th>
                  <th className="py-1 px-2 text-center bg-amber-100/70 text-amber-950 border-x border-amber-300/60">
                    <span className="block font-black leading-tight">Thời gian còn</span>
                  </th>
                  <th className="py-1 px-1 text-right w-[95px]">
                    Lãi theo sổ (Tr)
                  </th>
                  <th className="py-1 px-1 text-right w-[90px]">
                    Lãi 1 năm (Tr)
                  </th>
                  <th className="py-1 px-2 text-center">Tháng đáo hạn</th>
                </tr>
              </thead>

              {/* Table Body */}
              <tbody className="divide-y divide-slate-200 text-slate-900">
                {displayedBooks.map((item, index) => {
                  const bank = getBankById(item.bankId);
                  const isUrgent = item.daysToMaturity <= 45;

                  return (
                    <tr
                      key={item.id}
                      onClick={() => {
                        if (window.innerWidth < 768) {
                          setSelectedSummaryBook(item);
                        } else {
                          onOpenDetail(item);
                        }
                      }}
                      className={`cursor-pointer hover:bg-emerald-50/80 active:bg-emerald-100/60 transition-colors ${
                        isUrgent ? 'bg-amber-50/45' : index % 2 === 1 ? 'bg-slate-50/60' : 'bg-white'
                      }`}
                      title="Bấm để xem thông tin sổ"
                    >
                      {/* STT */}
                      <td className="py-1 px-2 text-center text-slate-800 font-extrabold text-[12px] sm:text-[13px]">
                        {index + 1}
                      </td>

                      {/* Ngân hàng (chỉ để lại chữ viết tắt, tăng cỡ chữ 10%) */}
                      <td className="py-1 px-2 text-center">
                        <span
                          className="px-2.5 py-0.5 rounded font-black text-[11.5px] sm:text-[13px] inline-block tracking-wide shadow-xs"
                          style={{ backgroundColor: bank.bgLight, color: bank.primaryColor }}
                        >
                          {getBankTagForBook(item.bankId, item.owner, bank.code)}
                        </span>
                      </td>

                      {/* Lãi suất */}
                      <td className="py-1 px-1.5 text-center">
                        <span
                          className={`font-black px-2 py-0.5 rounded text-[11.5px] sm:text-[13px] inline-block border ${
                            item.interestRate >= 9.0
                              ? 'bg-rose-100 text-rose-950 border-rose-300'
                              : item.interestRate >= 8.5
                              ? 'bg-amber-100 text-amber-950 border-amber-300'
                              : 'bg-slate-100 text-slate-900 border-slate-200'
                          }`}
                        >
                          {formatPercent(item.interestRate)}
                        </span>
                      </td>

                      {/* Tiền gửi (Gốc) */}
                      <td className="py-1 px-2.5 text-right font-black text-slate-950 text-xs sm:text-[14.5px] font-mono">
                        {formatMoney(item.principal)}
                      </td>

                      {/* Ngày gửi */}
                      <td className="py-1 px-1.5 text-center text-slate-900 font-bold font-mono text-[11px] sm:text-[12px]">
                        {formatDateVN(item.startDate)}
                      </td>

                      {/* Ngày đáo hạn */}
                      <td className="py-1 px-1.5 text-center font-mono text-[11px] sm:text-[12px]">
                        <span className={`font-black ${isUrgent ? 'text-rose-700 underline decoration-rose-300 decoration-2' : 'text-slate-950'}`}>
                          {formatDateVN(item.maturityDate)}
                        </span>
                      </td>

                      {/* Kỳ hạn */}
                      <td className="py-1 px-1 text-center">
                        <span className="px-1.5 py-0.5 bg-slate-200 text-slate-950 rounded text-[11px] sm:text-[12px] font-black">
                          {item.termMonths}T
                        </span>
                      </td>

                      {/* Thời gian còn lại */}
                      <td className="py-1 px-1.5 text-center bg-amber-100/20 border-x border-amber-300/20">
                        {item.daysToMaturity < 0 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-sm text-[11px] sm:text-[12px] font-black bg-rose-700 text-white">
                            Quá {Math.abs(item.daysToMaturity)}N
                          </span>
                        ) : item.daysToMaturity === 0 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-sm text-[11px] sm:text-[12px] font-black bg-rose-600 text-white animate-pulse">
                            Hôm nay
                          </span>
                        ) : item.daysToMaturity <= 30 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-sm text-[11px] sm:text-[12px] font-black bg-rose-500 text-white animate-pulse">
                            {item.daysToMaturity} ngày
                          </span>
                        ) : item.daysToMaturity <= 90 ? (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-sm text-[11px] sm:text-[12px] font-black bg-amber-500 text-slate-950">
                            {item.daysToMaturity} ngày
                          </span>
                        ) : (
                          <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-sm text-[11px] sm:text-[12px] font-black bg-slate-200 text-slate-800">
                            {item.monthsRemaining} tháng
                          </span>
                        )}
                      </td>

                      {/* Tiền lãi theo sổ */}
                      <td className="py-1 px-1 text-right font-bold text-emerald-850 text-xs sm:text-[13.5px] font-mono">
                        {formatMoney(item.calculatedTermInterest)}
                      </td>

                      {/* Tiền lãi 1 năm */}
                      <td className="py-1 px-1 text-right font-bold text-slate-900 text-xs sm:text-[13.5px] font-mono">
                        {formatMoney(item.calculatedAnnualInterest)}
                      </td>

                      {/* Tháng đáo hạn */}
                      <td className="py-1 px-1.5 text-center font-mono font-extrabold text-slate-950 text-xs sm:text-[13px]">
                        {item.maturityMonthYear || item.maturityDate.slice(5, 7) + '/' + item.maturityDate.slice(2, 4)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              {/* Table Footer - TOTAL ROW */}
              <tfoot>
                <tr className="bg-slate-950 text-white font-black border-t-2 border-slate-900 text-xs sm:text-sm">
                  <td colSpan={3} className="py-1.5 px-3 text-left uppercase tracking-wider text-amber-400 font-black text-[12px] sm:text-[13px]">
                    TỔNG CỘNG (TOTAL)
                  </td>
                  {/* Tổng tiền gửi */}
                  <td className="py-1.5 px-3 text-right text-emerald-400 font-mono font-black text-xs sm:text-[14.5px]">
                    {formatMoney(summary.totalPrincipal)}
                  </td>
                  <td colSpan={4} className="py-1.5 px-2 text-center text-slate-200 font-extrabold text-[11px] sm:text-[12px]">
                    Lãi suất BQ: <span className="text-yellow-300 font-black">{formatPercent(summary.weightedAvgRate)}/năm</span>
                  </td>
                  {/* Tổng tiền lãi theo sổ */}
                  <td className="py-1.5 px-1 text-right text-amber-400 font-mono font-black text-xs sm:text-[13.5px]">
                    +{formatMoney(summary.totalTermInterest)}
                  </td>
                  {/* Tổng tiền lãi 1 năm */}
                  <td className="py-1.5 px-1 text-right text-emerald-400 font-mono font-black text-xs sm:text-[13.5px]">
                    {formatMoney(summary.totalAnnualInterest)}
                  </td>
                  <td className="py-1.5 px-2 text-center text-slate-100 font-black text-xs sm:text-[13px]">
                    {displayedBooks.length} Sổ
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* HAI BẢNG TỔNG KẾT THEO HIỆN TRẠNG SỔ TIẾT KIỆM */}
      {books.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-2xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* BẢNG 1: LÃI HÀNG NĂM */}
            <div className="border border-slate-200 rounded-xl overflow-hidden flex flex-col">
              <div className="bg-slate-100 px-3.5 py-2 border-b border-slate-200 flex items-center justify-between shrink-0">
                <span className="font-bold text-xs text-slate-800">LÃI HÀNG NĂM</span>
                <span className="text-[10px] text-slate-500 font-mono">Đơn vị: Triệu VNĐ</span>
              </div>
              <div
                ref={table1ScrollRef}
                className="max-h-[190px] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
              >
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200 sticky top-0 z-10 shadow-2xs">
                    <tr>
                      <th className="py-2 px-2.5 sm:px-3 whitespace-nowrap bg-slate-50">Lãi hàng năm</th>
                      <th className="py-2 px-2.5 sm:px-3 text-right whitespace-nowrap bg-slate-50">Số tiền</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {dynamicAnnualInterest.map((row) => {
                      const isProvisional = row.year >= 2027;

                      return (
                        <tr key={row.year} className={`hover:bg-slate-50 ${row.year >= 2026 ? 'bg-amber-50/60 font-semibold' : ''}`}>
                          <td className="py-2 px-2.5 sm:px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                            {isProvisional ? (
                              <div className="flex items-center space-x-1.5 whitespace-nowrap">
                                <span>{row.year}</span>
                                <span className="text-[9px] sm:text-[10px] text-emerald-900 bg-emerald-100 px-1.5 py-0.5 rounded font-normal whitespace-nowrap shrink-0 inline-block">
                                  Tạm tính
                                </span>
                              </div>
                            ) : (
                              row.year
                            )}
                          </td>
                          <td className={`py-2 px-2.5 sm:px-3 text-right font-mono font-bold whitespace-nowrap ${row.year >= 2026 ? 'text-amber-800' : 'text-emerald-700'}`}>
                            {settings.privacyMode ? '••••••' : row.interestEarnedMillion.toLocaleString('vi-VN')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* BẢNG 2: SỐ DƯ CUỐI NĂM & THU NHẬP NĂM */}
            <div className="border border-slate-200 rounded-xl overflow-hidden flex flex-col">
              <div className="bg-slate-100 px-3.5 py-2 border-b border-slate-200 flex items-center justify-between shrink-0">
                <span className="font-bold text-xs text-slate-800">
                  THU NHẬP NĂM
                </span>
                <span className="text-[10px] text-slate-500 font-mono">Đơn vị: Triệu VNĐ</span>
              </div>
              <div
                ref={table2ScrollRef}
                className="max-h-[190px] overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
              >
                <table className="w-full text-xs text-left border-collapse">
                  <thead className="bg-slate-50 text-slate-600 font-bold border-b border-slate-200 sticky top-0 z-10 shadow-2xs">
                    <tr>
                      <th className="py-2 px-2 sm:px-3 whitespace-nowrap w-[44%] sm:w-auto bg-slate-50">Số dư cuối</th>
                      <th className="py-2 px-2 sm:px-3 text-right whitespace-nowrap w-[28%] sm:w-auto bg-slate-50">Số tiền</th>
                      <th className="py-2 px-2 sm:px-3 text-right text-indigo-700 whitespace-nowrap w-[28%] sm:w-auto bg-slate-50">Thu nhập</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-slate-700">
                    {dynamicBalanceGrowth.map((row) => {
                      const isCurrentYear = row.year === 2026;

                      return (
                        <tr key={row.year} className={`hover:bg-slate-50 ${isCurrentYear ? 'bg-indigo-50/60 font-semibold' : ''}`}>
                          <td className="py-2 px-2 sm:px-3 font-mono font-bold text-slate-900 whitespace-nowrap">
                            {isCurrentYear ? (
                              <div className="flex items-center space-x-1 sm:space-x-1.5 whitespace-nowrap">
                                <span>2026</span>
                                <span className="text-[9px] sm:text-[10px] text-emerald-900 bg-emerald-100 px-1 sm:px-1.5 py-0.5 rounded font-normal whitespace-nowrap shrink-0 inline-block">
                                  Tạm tính
                                </span>
                              </div>
                            ) : (
                              row.year
                            )}
                          </td>
                          <td className="py-2 px-2 sm:px-3 text-right font-mono font-bold text-slate-900 whitespace-nowrap">
                            {settings.privacyMode ? '••••••' : row.balanceMillion.toLocaleString('vi-VN')}
                          </td>
                          <td className="py-2 px-2 sm:px-3 text-right font-mono font-bold text-indigo-700 whitespace-nowrap">
                            {settings.privacyMode ? (row.annualIncomeMillion ? '••••••' : '') : (row.annualIncomeMillion ? row.annualIncomeMillion.toLocaleString('vi-VN') : '')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Concise Portfolio Key Insights Bar (Dynamic 100%) */}
      {books.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-2xs">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs divide-y md:divide-y-0 md:divide-x divide-slate-100">
            {/* Item 1: Phân bổ Ngân hàng */}
            <div className="space-y-1.5 md:pr-4">
              <span className="font-bold text-slate-700 flex items-center">
                <Coins className="w-3.5 h-3.5 text-emerald-600 mr-1.5" />
                Tỷ trọng Ngân hàng
              </span>
              <div className="flex flex-wrap items-center justify-between text-slate-600 gap-1">
                {bankBreakdown.map((bk) => (
                  <span key={bk.code}>
                    {bk.code} ({bk.count} sổ): <strong style={{ color: bk.color }}>{formatShortVND(bk.amount, settings.privacyMode)}</strong> ({formatPercent(bk.percent, 1)})
                  </span>
                ))}
              </div>
              <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden flex">
                {bankBreakdown.map((bk) => (
                  <div
                    key={bk.code}
                    className="h-full"
                    style={{ width: `${bk.percent}%`, backgroundColor: bk.color }}
                    title={`${bk.code}: ${formatPercent(bk.percent, 1)}`}
                  />
                ))}
              </div>
            </div>

            {/* Item 2: Sắp đến hạn gần nhất */}
            <div className="space-y-1 md:px-4 pt-3 md:pt-0">
              <span className="font-bold text-slate-700 flex items-center">
                <Clock className="w-3.5 h-3.5 text-amber-600 mr-1.5" />
                Sổ đến hạn gần nhất
              </span>
              {nextMaturingBook ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-800 font-semibold">{getBankById(nextMaturingBook.bankId).shortName} ({formatShortVND(nextMaturingBook.principal, settings.privacyMode)})</span>
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-900 rounded font-bold text-[10px]">
                      Đáo hạn: {formatDateVN(nextMaturingBook.maturityDate)} ({nextMaturingBook.daysToMaturity} ngày)
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500">
                    Lãi nhận: <strong>{formatShortVND(nextMaturingBook.calculatedTermInterest || 0, settings.privacyMode)}</strong>. Cần tiền sớm nên vay cầm cố thay vì rút trước hạn.
                  </p>
                </>
              ) : (
                <p className="text-slate-400">Không có sổ nào sắp đến hạn.</p>
              )}
            </div>

            {/* Item 3: Dòng tiền lãi sinh lời */}
            <div className="space-y-1 md:pl-4 pt-3 md:pt-0">
              <span className="font-bold text-slate-700 flex items-center">
                <TrendingUp className="w-3.5 h-3.5 text-indigo-600 mr-1.5" />
                Hiệu suất sinh lời
              </span>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Lãi thụ động / tháng:</span>
                <strong className="text-emerald-700 font-bold">~{formatShortVND(summary.monthlyAverageInterest, settings.privacyMode)}/tháng</strong>
              </div>
              <p className="text-[11px] text-slate-500">
                Lãi suất cao nhất: <strong className="text-rose-700">{highestRateBook ? `${formatPercent(highestRateBook.interestRate)}/năm` : '0%'}</strong> {highestRateBook ? `(${getBankById(highestRateBook.bankId).code} - ${formatShortVND(highestRateBook.principal, settings.privacyMode)})` : ''}.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Box Thông Tin & Thao Tác Nhanh Sổ Tiết Kiệm (Modal Tương Tác Trực Tiếp) */}
      {selectedSummaryBook && (
        <div
          className="fixed inset-0 bg-slate-900/65 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-4 animate-in fade-in duration-150 overflow-y-auto"
          onClick={() => setSelectedSummaryBook(null)}
        >
          <div
            className="bg-white rounded-3xl shadow-2xl border border-slate-200 max-w-md w-full overflow-hidden flex flex-col my-auto animate-in zoom-in-95 duration-150 relative max-h-[92vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const bank = getBankById(selectedSummaryBook.bankId);
              const daysToMaturity = selectedSummaryBook.daysToMaturity ?? getDaysBetween(currentDateStr, selectedSummaryBook.maturityDate);
              const daysTotal = Math.max(1, getDaysBetween(selectedSummaryBook.startDate, selectedSummaryBook.maturityDate));
              const termInterest = selectedSummaryBook.calculatedTermInterest ?? selectedSummaryBook.expectedTermInterest ?? Math.round((selectedSummaryBook.principal * (selectedSummaryBook.interestRate / 100) * daysTotal) / 365);

              return (
                <>
                  {/* Header Ngân hàng */}
                  <div
                    className="px-4 py-3 border-b flex items-center justify-between shrink-0"
                    style={{ backgroundColor: bank.bgLight, borderColor: bank.borderColor }}
                  >
                    <div className="flex items-center space-x-2.5 pr-4">
                      <div
                        className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm shadow-2xs shrink-0"
                        style={{ backgroundColor: bank.primaryColor, color: bank.textColor }}
                      >
                        <Landmark className="w-4 h-4" />
                      </div>
                      <div className="flex items-center space-x-2 overflow-hidden">
                        <span className="font-black text-slate-900 text-sm sm:text-base tracking-tight truncate">
                          {bank.shortName}
                        </span>
                        <span className="text-xs font-mono font-black px-2 py-0.5 rounded bg-white/90 text-slate-800 border border-slate-200/80 shrink-0 shadow-2xs">
                          {getBankTagForBook(selectedSummaryBook.bankId, selectedSummaryBook.owner, bank.code)}
                        </span>
                      </div>
                    </div>

                    <button
                      id="btn-close-summary-modal"
                      onClick={() => setSelectedSummaryBook(null)}
                      className="p-1.5 text-slate-500 hover:text-slate-900 bg-white/80 hover:bg-white rounded-full shadow-2xs border border-slate-200 transition-all cursor-pointer"
                      title="Đóng"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Body thông tin & thao tác */}
                  <div className="p-3 sm:p-4 space-y-3 overflow-y-auto text-xs sm:text-sm">
                    {/* Khối 1: Tiền gốc & Lãi nhận được (Giữ thiết kế chuẩn Ảnh 1) */}
                    <div className="bg-slate-900 text-white p-3 sm:p-3.5 rounded-2xl shadow-sm space-y-1.5">
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs font-bold text-slate-300 uppercase tracking-wide">1. TIỀN GỐC GỬI:</span>
                        <span className="text-base sm:text-lg font-black font-mono text-white tracking-tight">
                          {formatVND(selectedSummaryBook.principal, settings.privacyMode)}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between border-t border-white/10 pt-1.5">
                        <span className="text-xs font-bold text-emerald-400 uppercase tracking-wide">TIỀN LÃI NHẬN ĐƯỢC:</span>
                        <span className="text-sm sm:text-base font-black font-mono text-emerald-300">
                          +{formatVND(termInterest, settings.privacyMode)}
                        </span>
                      </div>
                    </div>

                    {/* Khối 2: Lãi suất & Đáo hạn (Giữ thiết kế chuẩn Ảnh 1) */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-amber-50/90 p-2.5 rounded-2xl border border-amber-200/80 col-span-2 flex items-center justify-between">
                        <span className="text-xs font-bold text-amber-900 uppercase tracking-wider">2. LÃI SUẤT ({selectedSummaryBook.termMonths}T):</span>
                        <span className="text-base sm:text-lg font-black font-mono text-amber-700">
                          {formatPercent(selectedSummaryBook.interestRate)}/năm
                        </span>
                      </div>

                      <div className="bg-slate-50 p-2.5 rounded-2xl border border-slate-200/80 space-y-1">
                        <span className="text-xs text-slate-500 font-extrabold block uppercase">3. ĐÁO HẠN</span>
                        <span className="font-black text-slate-900 font-mono text-sm block tracking-tight">
                          {formatDateVN(selectedSummaryBook.maturityDate)}
                        </span>
                        <span className={`block text-xs sm:text-sm font-bold ${daysToMaturity <= 30 ? 'text-rose-600 font-black' : 'text-slate-700'}`}>
                          {daysToMaturity < 0 ? (
                            <>Quá <span className="font-black text-sm">{Math.abs(daysToMaturity)}</span> ngày</>
                          ) : daysToMaturity === 0 ? (
                            <span className="font-black">Đáo hạn Hôm nay</span>
                          ) : (
                            <>Còn <span className="font-black text-sm">{daysToMaturity}</span> ngày</>
                          )}
                        </span>
                      </div>

                      <div className="bg-slate-50 p-2.5 rounded-2xl border border-slate-200/80 space-y-1">
                        <span className="text-xs text-slate-500 font-extrabold block uppercase">4. CHỦ SỞ HỮU</span>
                        <div>
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-black border ${getOwnerBadgeStyle(selectedSummaryBook.owner).badgeClass}`}>
                            {getOwnerLabel(selectedSummaryBook.owner)}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-600 font-bold block pt-0.5">
                          {selectedSummaryBook.depositType === 'online' ? '📱 Online' : '🏦 Tại quầy'}
                        </span>
                      </div>
                    </div>

                    {/* Khối 4: TẤT TOÁN & TÁI TỤC SỔ (Đúng 100% Ảnh 2) */}
                    <div className="bg-slate-50/90 border border-slate-200/90 rounded-2xl p-3 space-y-2.5">
                      <div className="flex items-center space-x-1.5">
                        <Sparkles className="w-4 h-4 text-emerald-600" />
                        <h4 className="font-extrabold text-slate-800 text-xs sm:text-sm">
                          Tất Toán &amp; Tái Tục Sổ
                        </h4>
                      </div>

                      {/* Nút thao tác trực tiếp */}
                      {!showSettleConfirm && !showRolloverConfig && (
                        !canEditData(settings.currentRole) ? (
                          <div className="p-3 bg-amber-500/10 border border-amber-500/30 text-amber-800 rounded-xl text-xs font-semibold flex items-center space-x-2">
                            <Eye className="w-4 h-4 text-amber-600 shrink-0" />
                            <span>Tài khoản ở vai trò <strong>Chỉ xem (Viewer)</strong> — Bạn không có quyền tất toán, tái tục hay tác động dữ liệu.</span>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {daysToMaturity > 0 ? (
                              /* Sổ CHƯA ĐẾN HẠN: Chỉ hiện nút Tất toán trước hạn (Rút sớm) */
                              <button
                                onClick={() => setShowSettleConfirm(true)}
                                className="w-full py-2.5 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-98 text-white font-extrabold text-xs sm:text-sm shadow-xs flex items-center justify-center space-x-2 transition-all cursor-pointer"
                              >
                                <AlertTriangle className="w-4 h-4" />
                                <span>⚠️ Tất toán trước hạn (Rút sớm)</span>
                              </button>
                            ) : (
                              /* Sổ ĐÃ ĐẾN HẠN / QUÁ HẠN: Hiện nút Tất toán đúng/quá hạn và Nút Tái tục sổ */
                              <div className="space-y-2">
                                <button
                                  onClick={() => setShowSettleConfirm(true)}
                                  className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-98 text-white font-extrabold text-xs sm:text-sm shadow-xs flex items-center justify-center space-x-2 transition-all cursor-pointer"
                                >
                                  <CheckCircle2 className="w-4 h-4" />
                                  <span>
                                    {daysToMaturity === 0 ? '✅ Tất toán đúng hạn' : '✅ Tất toán quá hạn'}
                                  </span>
                                </button>

                                <button
                                  onClick={() => setShowRolloverConfig(true)}
                                  className="w-full py-2.5 px-3 rounded-xl bg-teal-600 hover:bg-teal-700 active:scale-98 text-white font-extrabold text-xs sm:text-sm shadow-xs flex items-center justify-center space-x-2 transition-all cursor-pointer"
                                >
                                  <RefreshCw className="w-4 h-4" />
                                  <span>Tái tục (Mở sổ mới) 🔄</span>
                                </button>
                              </div>
                            )}
                          </div>
                        )
                      )}

                      {/* Khung xác nhận Tất toán (Khi bấm nút Tất toán) */}
                      {showSettleConfirm && (
                        <div className="bg-white p-3 rounded-xl border border-rose-200 space-y-2 animate-in fade-in duration-150">
                          <p className="text-xs font-bold text-slate-800">
                            {daysToMaturity > 0 ? (
                              <span className="text-rose-600">
                                Xác nhận tất toán trước hạn? (Lãi nhận theo không kỳ hạn 0.1%/năm ~ {formatVND(Math.round((selectedSummaryBook.principal * 0.001 * Math.max(1, getDaysBetween(selectedSummaryBook.startDate, currentDateStr))) / 365), settings.privacyMode)})
                              </span>
                            ) : (
                              <span className="text-emerald-700">
                                Xác nhận tất toán đúng hạn? (Rút trọn vẹn Gốc {formatVND(selectedSummaryBook.principal, settings.privacyMode)} + Lãi {formatVND(termInterest, settings.privacyMode)})
                              </span>
                            )}
                          </p>
                          <div className="flex items-center space-x-2 pt-1">
                            <button
                              onClick={() => handleConfirmSettle(daysToMaturity > 0 ? 'before_term' : 'on_term')}
                              className="flex-1 py-1.5 bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs rounded-lg shadow-2xs cursor-pointer"
                            >
                              Xác nhận Tất Toán
                            </button>
                            <button
                              onClick={() => setShowSettleConfirm(false)}
                              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-lg cursor-pointer"
                            >
                              Hủy
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Khung cấu hình Tái tục (Khi bấm nút Tái tục) */}
                      {showRolloverConfig && (
                        <div className="bg-white p-3 rounded-2xl border border-teal-200 space-y-2.5 animate-in fade-in duration-150">
                          <div className="flex items-center justify-between border-b border-teal-100 pb-1.5">
                            <h5 className="font-extrabold text-teal-950 text-xs flex items-center space-x-1.5">
                              <RefreshCw className="w-3.5 h-3.5 text-teal-600" />
                              <span>Cấu Hình Tái Tục (Mở chu kỳ mới)</span>
                            </h5>
                          </div>
                          <p className="text-[11px] text-teal-900 leading-snug">
                            Sổ cũ được lưu vào <strong>Nhật ký biến động</strong>. Bạn có thể tự do điều chỉnh lại toàn bộ thông tin cho sổ mới:
                          </p>

                          {/* Nhập Tiền Gốc Mới */}
                          <div className="p-2 bg-teal-50/70 rounded-xl border border-teal-100 space-y-1">
                            <div className="flex justify-between items-center text-[10px] font-bold">
                              <label className="text-slate-700 uppercase">GỐC SỔ MỚI (Triệu VNĐ):</label>
                              <span className="text-teal-700 font-mono font-extrabold">
                                {newRolloverPrincipal > 0 ? formatVND(newRolloverPrincipal, settings.privacyMode) : '0 VNĐ'}
                              </span>
                            </div>
                            <div className="relative">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={newRolloverPrincipalStr}
                                onChange={(e) => {
                                  const rawVal = e.target.value;
                                  const sanitized = rawVal.replace(/[^0-9.,]/g, '').replace(',', '.');
                                  setNewRolloverPrincipalStr(rawVal);
                                  const num = parseFloat(sanitized);
                                  if (isNaN(num) || num <= 0) {
                                    setNewRolloverPrincipal(0);
                                  } else {
                                    setNewRolloverPrincipal(Math.round(num * 1_000_000));
                                  }
                                }}
                                placeholder="Nhập số tiền..."
                                className="w-full px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-900 focus:ring-1 focus:ring-teal-500 focus:outline-none pr-14"
                              />
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-bold text-slate-400">
                                Tr VNĐ
                              </span>
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5 border-t border-teal-100/60">
                              <span>Gốc cũ: <strong className="text-slate-700 font-mono">{formatVND(selectedSummaryBook.principal, settings.privacyMode)}</strong></span>
                              <span>Lãi cũ: <strong className="text-emerald-600 font-mono">{formatVND(termInterest, settings.privacyMode)}</strong></span>
                            </div>
                          </div>

                          {/* Kỳ hạn & Lãi suất */}
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="text-[10px] font-bold text-slate-600 uppercase block mb-0.5">
                                Kỳ hạn mới:
                              </label>
                              <CustomSelect
                                value={newRolloverTerm}
                                onChange={(val) => setNewRolloverTerm(Number(val))}
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
                                className="w-full text-xs font-bold"
                              />
                            </div>

                            <div>
                              <label className="text-[10px] font-bold text-slate-600 uppercase block mb-0.5">
                                Lãi suất (%/năm):
                              </label>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={newRolloverRateStr}
                                onChange={(e) => setNewRolloverRateStr(e.target.value)}
                                placeholder="5.5"
                                className="w-full px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                              />
                            </div>
                          </div>

                          {/* Ngày bắt đầu kỳ mới */}
                          <div>
                            <label className="text-[10px] font-bold text-slate-600 uppercase block mb-0.5">
                              Ngày bắt đầu kỳ mới:
                            </label>
                            <input
                              type="date"
                              value={newRolloverStartDate}
                              onChange={(e) => setNewRolloverStartDate(e.target.value)}
                              className="w-full px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs font-bold text-slate-800 focus:ring-1 focus:ring-teal-500 focus:outline-none"
                            />
                          </div>

                          <div className="flex items-center space-x-2 pt-1">
                            <button
                              onClick={handleConfirmRollover}
                              className="flex-1 py-1.5 bg-teal-600 hover:bg-teal-700 active:scale-98 text-white font-bold text-xs rounded-xl shadow-2xs cursor-pointer transition-all"
                            >
                              Xác Nhận Tái Tục
                            </button>
                            <button
                              onClick={() => setShowRolloverConfig(false)}
                              className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl cursor-pointer transition-colors"
                            >
                              Hủy
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Footer Modal */}
                  <div className="px-4 py-2.5 bg-slate-50 border-t border-slate-200 flex items-center justify-end shrink-0">
                    <button
                      onClick={() => setSelectedSummaryBook(null)}
                      className="px-4 py-1.5 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-bold text-xs cursor-pointer transition-colors"
                    >
                      Đóng
                    </button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
};
