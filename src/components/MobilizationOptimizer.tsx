import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from 'recharts';
import {
  Calculator,
  Calendar,
  DollarSign,
  TrendingDown,
  Sparkles,
  Landmark,
  User,
  BarChart3,
  Percent,
  ChevronDown,
  ChevronUp,
  Cloud,
  CheckCircle2,
  Repeat,
  CalendarRange,
  CalendarDays,
  ListFilter,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { SavingsBook, AppSettings } from '../types';
import { getBankById, getAllBanks, saveBank } from '../data/banks';
import {
  formatDateVN,
  formatPercent,
  getOwnerLabel,
  getOwnerBadgeStyle,
  formatNumberWithDots,
} from '../utils/formatters';
import { getBankTagForBook } from '../utils/dataTranslator';
import {
  findOptimalDayInMonth,
  findOptimalDaysInRange,
  MonthOptimizationResult,
  DayOptimizationResult,
  getDaysBetween,
} from '../utils/calculator';
import { CustomSelect } from './CustomSelect';

interface MobilizationOptimizerProps {
  books: SavingsBook[];
  currentDateStr: string;
  settings: AppSettings;
  onOpenBookDetail: (book: SavingsBook) => void;
  onOpenSyncModal?: () => void;
}

type MobilizationMode = 'SINGLE_MONTH' | 'MONTH_RANGE';

interface MobilizationOptimizerCache {
  mode?: MobilizationMode;
  targetAmountMillion?: number;
  targetAmountMillionStr?: string;
  selectedYear?: number;
  selectedMonth?: number;
  selectedDayOverride?: number | null;
  rangeStartYear?: number;
  rangeStartMonth?: number;
  rangeEndYear?: number;
  rangeEndMonth?: number;
  expandedRangeMonthKey?: string | null;
  isBankConfigExpanded?: boolean;
}

const OPTIMIZER_CACHE_KEY = 'savings_mobilization_optimizer_cache_v1';

const getInitialOptimizerCache = (): MobilizationOptimizerCache => {
  try {
    const saved = localStorage.getItem(OPTIMIZER_CACHE_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch {
    // ignore
  }
  return {};
};

export const MobilizationOptimizer: React.FC<MobilizationOptimizerProps> = ({
  books,
  currentDateStr,
  settings,
  onOpenSyncModal,
}) => {
  // Lấy năm và tháng hiện tại từ currentDateStr (VD: 2026-09-21 -> year: 2026, month: 9)
  const [currYear, currMonth] = useMemo(() => {
    const parts = currentDateStr.split('-').map(Number);
    return [parts[0] || 2026, parts[1] || 9];
  }, [currentDateStr]);

  const cachedState = useMemo(() => getInitialOptimizerCache(), []);

  // Mode: Chọn 1 tháng cụ thể HOẶC Chọn khoảng nhiều tháng
  const [mode, setMode] = useState<MobilizationMode>(() => cachedState.mode || 'SINGLE_MONTH');

  // Số tiền muốn huy động (Đơn vị: Triệu VNĐ)
  // Mặc định: 3.000 Tr (= 3 Tỷ VNĐ) hoặc lấy từ bộ nhớ lưu tạm
  const initialAmount =
    typeof cachedState.targetAmountMillion === 'number' && cachedState.targetAmountMillion >= 0
      ? cachedState.targetAmountMillion
      : 3000;

  const [targetAmountMillion, setTargetAmountMillion] = useState<number>(initialAmount);
  const [targetAmountMillionStr, setTargetAmountMillionStr] = useState<string>(
    () => cachedState.targetAmountMillionStr || formatNumberWithDots(initialAmount)
  );
  const [debouncedTargetAmountVND, setDebouncedTargetAmountVND] = useState<number>(initialAmount * 1_000_000);
  const [isCalculating, setIsCalculating] = useState<boolean>(false);

  // Debounce 250ms cho việc tính toán tối ưu hoá nguồn vốn
  useEffect(() => {
    setIsCalculating(true);
    const timer = setTimeout(() => {
      setDebouncedTargetAmountVND(targetAmountMillion * 1_000_000);
      setIsCalculating(false);
    }, 250);

    return () => clearTimeout(timer);
  }, [targetAmountMillion]);

  // Chế độ 1 tháng cụ thể:
  const [selectedYear, setSelectedYear] = useState<number>(() => cachedState.selectedYear || currYear);
  const [selectedMonth, setSelectedMonth] = useState<number>(
    () => cachedState.selectedMonth || (currMonth === 12 ? 1 : currMonth + 1)
  );
  const [selectedDayOverride, setSelectedDayOverride] = useState<number | null>(
    () => (cachedState.selectedDayOverride !== undefined ? cachedState.selectedDayOverride : null)
  );

  // Chế độ khoảng nhiều tháng (Từ tháng A đến tháng B):
  const [rangeStartYear, setRangeStartYear] = useState<number>(() => cachedState.rangeStartYear || currYear);
  const [rangeStartMonth, setRangeStartMonth] = useState<number>(() => cachedState.rangeStartMonth || currMonth);
  const [rangeEndYear, setRangeEndYear] = useState<number>(
    () => cachedState.rangeEndYear || (currMonth + 6 > 12 ? currYear + 1 : currYear)
  );
  const [rangeEndMonth, setRangeEndMonth] = useState<number>(
    () => cachedState.rangeEndMonth || (((currMonth + 6 - 1) % 12) + 1)
  );
  const [expandedRangeMonthKey, setExpandedRangeMonthKey] = useState<string | null>(
    () => cachedState.expandedRangeMonthKey || null
  );

  // Cấu hình thu gọn/mở rộng block Vay thế chấp theo ngân hàng
  const [isBankConfigExpanded, setIsBankConfigExpanded] = useState<boolean>(
    () => !!cachedState.isBankConfigExpanded
  );

  // Tự động lưu phương án đang thực hiện vào bộ nhớ máy để không bị mất khi chuyển tab
  useEffect(() => {
    try {
      const stateToSave: MobilizationOptimizerCache = {
        mode,
        targetAmountMillion,
        targetAmountMillionStr,
        selectedYear,
        selectedMonth,
        selectedDayOverride,
        rangeStartYear,
        rangeStartMonth,
        rangeEndYear,
        rangeEndMonth,
        expandedRangeMonthKey,
        isBankConfigExpanded,
      };
      localStorage.setItem(OPTIMIZER_CACHE_KEY, JSON.stringify(stateToSave));
    } catch {
      // ignore
    }
  }, [
    mode,
    targetAmountMillion,
    targetAmountMillionStr,
    selectedYear,
    selectedMonth,
    selectedDayOverride,
    rangeStartYear,
    rangeStartMonth,
    rangeEndYear,
    rangeEndMonth,
    expandedRangeMonthKey,
    isBankConfigExpanded,
  ]);

  // Đặt lại phương án về mặc định ban đầu
  const handleResetPlan = () => {
    setMode('SINGLE_MONTH');
    setTargetAmountMillion(3000);
    setTargetAmountMillionStr('3.000');
    setSelectedYear(currYear);
    setSelectedMonth(currMonth === 12 ? 1 : currMonth + 1);
    setSelectedDayOverride(null);
    setRangeStartYear(currYear);
    setRangeStartMonth(currMonth);
    setRangeEndYear(currMonth + 6 > 12 ? currYear + 1 : currYear);
    setRangeEndMonth(((currMonth + 6 - 1) % 12) + 1);
    setExpandedRangeMonthKey(null);
    setBankMargins(getMasterBankMargins());
    setBankLTVs(getMasterBankLTVs());
    setMarginInputStrings({});
    setLtvInputStrings({});
    try {
      localStorage.removeItem(OPTIMIZER_CACHE_KEY);
    } catch {
      // ignore
    }
  };

  // Lấy cấu hình mặc định trực tiếp từ Master Bank Configs (đã đồng bộ Firestore & LocalStorage)
  const getMasterBankMargins = useCallback((): Record<string, number> => {
    const all = getAllBanks();
    const res: Record<string, number> = {};
    for (const b of all) {
      res[b.id.toLowerCase()] = b.defaultLoanMargin !== undefined ? b.defaultLoanMargin : 1.8;
    }
    return res;
  }, []);

  const getMasterBankLTVs = useCallback((): Record<string, number> => {
    const all = getAllBanks();
    const res: Record<string, number> = {};
    for (const b of all) {
      res[b.id.toLowerCase()] = b.maxLTV !== undefined ? Math.round(b.maxLTV * 100) : 95;
    }
    return res;
  }, []);

  // Cấu hình ngân hàng khởi tạo từ Master Bank Configs
  const [bankMargins, setBankMargins] = useState<Record<string, number>>(() => {
    const master = getMasterBankMargins();
    return { ...master, ...(settings.bankLoanMargins || {}) };
  });
  const [marginInputStrings, setMarginInputStrings] = useState<Record<string, string>>({});

  const [bankLTVs, setBankLTVs] = useState<Record<string, number>>(() => {
    const master = getMasterBankLTVs();
    return { ...master, ...(settings.bankLTVs || {}) };
  });
  const [ltvInputStrings, setLtvInputStrings] = useState<Record<string, string>>({});

  const [bankSettlementTypes, setBankSettlementTypes] = useState<Record<string, 'UPFRONT' | 'MATURITY'>>(
    settings.bankSettlementTypes || {
      seabank: 'UPFRONT',
      shb: 'UPFRONT',
      sea2: 'UPFRONT',
      vietcombank: 'UPFRONT',
      techcombank: 'MATURITY',
      bidv: 'UPFRONT',
      vpbank: 'MATURITY',
      mbbank: 'UPFRONT',
      acb: 'MATURITY',
      agribank: 'UPFRONT',
      hdbank: 'MATURITY',
      vib: 'MATURITY',
      tpbank: 'UPFRONT',
    }
  );

  // Lắng nghe sự kiện cập nhật ngân hàng (từ menu Quản Lý Ngân Hàng hoặc đồng bộ Firestore từ thiết bị khác)
  useEffect(() => {
    const handleBanksUpdated = () => {
      const latestMargins = getMasterBankMargins();
      const latestLTVs = getMasterBankLTVs();
      setBankMargins(latestMargins);
      setBankLTVs(latestLTVs);
      setMarginInputStrings({});
      setLtvInputStrings({});
    };

    window.addEventListener('banks-updated', handleBanksUpdated);
    return () => window.removeEventListener('banks-updated', handleBanksUpdated);
  }, [getMasterBankMargins, getMasterBankLTVs]);

  const demandRate = settings.defaultDemandRate || 0.2;
  const autoRollover = true;

  // Lọc active books
  const activeBooks = useMemo(() => books.filter((b) => b.status === 'active'), [books]);
  const totalPrincipal = useMemo(() => activeBooks.reduce((sum, b) => sum + b.principal, 0), [activeBooks]);
  const totalPrincipalMillion = Math.round(totalPrincipal / 1_000_000);

  // Xử lý đổi số tiền mục tiêu (Triệu VNĐ)
  const handleAmountMillionChange = (valMillion: number) => {
    const clamped = Math.max(0, valMillion);
    setTargetAmountMillion(clamped);
    setTargetAmountMillionStr(formatNumberWithDots(clamped));
  };

  const handleAmountInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      setTargetAmountMillionStr('');
      setTargetAmountMillion(0);
      return;
    }
    const num = parseInt(digits, 10);
    setTargetAmountMillion(num);
    setTargetAmountMillionStr(formatNumberWithDots(num));
  };

  // Preset quick amounts (Hỗ trợ linh hoạt Triệu và Tỷ VNĐ)
  const presetAmountsMillion = useMemo(() => {
    const list = [
      { label: '300 Tr', value: 300 },
      { label: '500 Tr', value: 500 },
      { label: '1 Tỷ', value: 1000 },
      { label: '2 Tỷ', value: 2000 },
      { label: '3 Tỷ', value: 3000 },
      { label: '5 Tỷ', value: 5000 },
      { label: '8 Tỷ', value: 8000 },
      { label: '10 Tỷ', value: 10000 },
      { label: '15 Tỷ', value: 15000 },
      { label: '20 Tỷ', value: 20000 },
    ].filter((p) => p.value < totalPrincipalMillion);

    if (totalPrincipalMillion > 0) {
      const allLabel =
        totalPrincipalMillion >= 1000
          ? `Tất cả (${(totalPrincipalMillion / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} Tỷ)`
          : `Tất cả (${totalPrincipalMillion.toLocaleString('vi-VN')} Tr)`;
      list.push({ label: allLabel, value: totalPrincipalMillion });
    }
    return list;
  }, [totalPrincipalMillion]);

  // Handler cho ngân hàng: Đồng bộ tức thì cả Optimizer và Master Configs
  const handleBankMarginChange = (bankId: string, margin: number, persistToBankConfig = true) => {
    setBankMargins((prev) => ({ ...prev, [bankId]: margin }));
    if (persistToBankConfig) {
      const bank = getBankById(bankId);
      saveBank({ id: bankId, name: bank.name, defaultLoanMargin: margin });
    }
  };

  const handleMarginInputChange = (bankId: string, rawVal: string) => {
    setMarginInputStrings((prev) => ({ ...prev, [bankId]: rawVal }));
    const parsed = parseFloat(rawVal.replace(',', '.'));
    if (!isNaN(parsed) && parsed >= 0) {
      handleBankMarginChange(bankId, parsed, true);
    }
  };

  const handleBankLtvChange = (bankId: string, ltv: number, persistToBankConfig = true) => {
    setBankLTVs((prev) => ({ ...prev, [bankId]: ltv }));
    if (persistToBankConfig) {
      const bank = getBankById(bankId);
      saveBank({ id: bankId, name: bank.name, maxLTV: ltv / 100 });
    }
  };

  const handleLtvInputChange = (bankId: string, rawVal: string) => {
    setLtvInputStrings((prev) => ({ ...prev, [bankId]: rawVal }));
    const parsed = parseFloat(rawVal.replace(',', '.'));
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      handleBankLtvChange(bankId, parsed, true);
    }
  };

  const handleBankSettlementChange = (bankId: string, type: 'UPFRONT' | 'MATURITY') => {
    setBankSettlementTypes((prev) => ({ ...prev, [bankId]: type }));
  };

  // Danh sách các ngân hàng trong danh mục sổ
  const activeBanksList = useMemo(() => {
    const map = new Map<string, {
      bankId: string;
      bankName: string;
      bankTag: string;
      color: string;
      bgLight: string;
      booksCount: number;
      totalPrincipal: number;
      avgRate: number;
    }>();

    for (const book of activeBooks) {
      const bId = book.bankId;
      const bank = getBankById(bId);
      if (!map.has(bId)) {
        map.set(bId, {
          bankId: bId,
          bankName: bank.shortName || bank.name,
          bankTag: bank.code,
          color: bank.primaryColor || '#059669',
          bgLight: bank.bgLight || '#ecfdf5',
          booksCount: 0,
          totalPrincipal: 0,
          avgRate: 0,
        });
      }
      const item = map.get(bId)!;
      item.booksCount += 1;
      item.totalPrincipal += book.principal;
      item.avgRate += book.interestRate * book.principal;
    }

    return Array.from(map.values()).map((item) => ({
      ...item,
      avgRate: item.totalPrincipal > 0 ? item.avgRate / item.totalPrincipal : 0,
    }));
  }, [activeBooks]);

  // 1. TÍNH TOÁN CHO CHẾ ĐỘ 1 THÁNG CỤ THỂ
  const singleMonthResult: MonthOptimizationResult = useMemo(() => {
    return findOptimalDayInMonth(
      activeBooks,
      debouncedTargetAmountVND,
      selectedYear,
      selectedMonth,
      bankMargins,
      bankLTVs,
      bankSettlementTypes,
      demandRate,
      autoRollover
    );
  }, [
    activeBooks,
    debouncedTargetAmountVND,
    selectedYear,
    selectedMonth,
    bankMargins,
    bankLTVs,
    bankSettlementTypes,
    demandRate,
    autoRollover,
  ]);

  // Ngày được hiển thị (hoặc ngày tối ưu nhất hoặc ngày người dùng chọn trên biểu đồ)
  const activeDayResult: DayOptimizationResult = useMemo(() => {
    if (selectedDayOverride !== null) {
      const found = singleMonthResult.allDays.find((d) => d.dayNumber === selectedDayOverride);
      if (found) return found;
    }
    return singleMonthResult.bestDay;
  }, [singleMonthResult, selectedDayOverride]);

  // 2. TÍNH TOÁN CHO CHẾ ĐỘ KHOẢNG NHIỀU THÁNG
  const rangeResults: MonthOptimizationResult[] = useMemo(() => {
    if (mode !== 'MONTH_RANGE') return [];
    return findOptimalDaysInRange(
      activeBooks,
      debouncedTargetAmountVND,
      rangeStartYear,
      rangeStartMonth,
      rangeEndYear,
      rangeEndMonth,
      bankMargins,
      bankLTVs,
      bankSettlementTypes,
      demandRate,
      autoRollover
    );
  }, [
    mode,
    activeBooks,
    debouncedTargetAmountVND,
    rangeStartYear,
    rangeStartMonth,
    rangeEndYear,
    rangeEndMonth,
    bankMargins,
    bankLTVs,
    bankSettlementTypes,
    demandRate,
    autoRollover,
  ]);

  // Danh sách 36 tháng tính từ thời điểm hiện tại (không quá 36 tháng)
  const monthOptions36 = useMemo(() => {
    const list: {
      value: string;
      label: string;
      shortLabel: string;
      hyphenLabel: string;
      subLabel?: string;
      year: number;
      month: number;
    }[] = [];

    for (let i = 0; i < 36; i++) {
      const totalMonth = currMonth - 1 + i;
      const y = currYear + Math.floor(totalMonth / 12);
      const m = (totalMonth % 12) + 1;
      const mStr = m.toString().padStart(2, '0');
      const val = `${y}-${mStr}`;

      let sub = '';
      if (i === 0) sub = 'Hiện tại';
      else if (i === 1) sub = 'Tháng tới';
      else if (i % 12 === 0) sub = `+${i / 12} năm`;
      else sub = `+${i} tháng`;

      list.push({
        value: val,
        label: `Tháng ${mStr}/${y}`,
        shortLabel: `${mStr}/${y}`,
        hyphenLabel: `${mStr}-${y}`,
        subLabel: sub,
        year: y,
        month: m,
      });
    }
    return list;
  }, [currYear, currMonth]);

  // Quick Month Presets for Single Month
  const upcomingMonthsList = useMemo(() => {
    const list: { label: string; year: number; month: number }[] = [];
    let y = currYear;
    let m = currMonth;
    for (let i = 0; i < 12; i++) {
      list.push({
        label: `${m.toString().padStart(2, '0')}/${y}`,
        year: y,
        month: m,
      });
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return list;
  }, [currYear, currMonth]);

  // Set quick ranges
  const handleSetQuickRange = (monthsCount: number) => {
    setRangeStartYear(currYear);
    setRangeStartMonth(currMonth);
    let ey = currYear;
    let em = currMonth + monthsCount - 1;
    while (em > 12) {
      em -= 12;
      ey++;
    }
    setRangeEndYear(ey);
    setRangeEndMonth(em);
  };

  if (books.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 sm:p-12 text-center shadow-xs space-y-5">
        <div className="w-16 h-16 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200">
          <Calculator className="w-8 h-8" />
        </div>
        <div className="space-y-2 max-w-md mx-auto">
          <h3 className="text-lg font-bold text-slate-900">
            Chưa Có Sổ Tiết Kiệm Để Tối Ưu Huy Động Vốn
          </h3>
          <p className="text-xs sm:text-sm text-slate-500 leading-relaxed">
            Dữ liệu trên ứng dụng đã được dọn sạch hoàn toàn sau khi hủy liên kết. Hãy mở cửa sổ Google Drive để kết nối lại dữ liệu của bạn.
          </p>
        </div>
        {onOpenSyncModal && (
          <button
            onClick={onOpenSyncModal}
            className="inline-flex items-center space-x-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md transition-all active:scale-95 cursor-pointer"
          >
            <Cloud className="w-4 h-4" />
            <span>Mở Cửa Sổ Đồng Bộ Google Drive</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      {/* 1. CẤU HÌNH VAY THẾ CHẤP THEO NGÂN HÀNG (MOBILE-FIRST COMPACT & COLLAPSIBLE) */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden transition-all">
        <button
          type="button"
          onClick={() => setIsBankConfigExpanded(!isBankConfigExpanded)}
          className="w-full p-4 sm:p-5 flex items-center justify-between text-left hover:bg-slate-50/80 transition-colors cursor-pointer"
        >
          <div className="flex items-center space-x-3">
            <span className="p-2.5 rounded-xl bg-amber-500 text-slate-950 font-black shrink-0 shadow-2xs">
              <Percent className="w-5 h-5" />
            </span>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="font-bold text-slate-900 text-sm sm:text-base">
                  Cấu hình vay thế chấp theo ngân hàng
                </h3>
                <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
                  {activeBanksList.length} Ngân hàng
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-1 text-slate-400 pl-2">
            <span className="text-xs font-semibold hidden sm:inline text-slate-500">
              {isBankConfigExpanded ? 'Thu gọn' : 'Tùy chỉnh'}
            </span>
            {isBankConfigExpanded ? (
              <ChevronUp className="w-5 h-5 text-slate-600" />
            ) : (
              <ChevronDown className="w-5 h-5 text-slate-600" />
            )}
          </div>
        </button>

        {isBankConfigExpanded && (
          <div className="p-4 sm:p-5 pt-0 border-t border-slate-100 space-y-4 animate-in fade-in">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5 pt-4">
              {activeBanksList.map((bankItem) => {
                const currentMargin = bankMargins[bankItem.bankId] ?? 1.5;
                const currentMarginStr = marginInputStrings[bankItem.bankId] !== undefined
                  ? marginInputStrings[bankItem.bankId]
                  : currentMargin.toString();

                const currentLtv = bankLTVs[bankItem.bankId] ?? 95;
                const currentLtvStr = ltvInputStrings[bankItem.bankId] !== undefined
                  ? ltvInputStrings[bankItem.bankId]
                  : currentLtv.toString();

                const currentSettlement = bankSettlementTypes[bankItem.bankId] ?? 'UPFRONT';

                return (
                  <div
                    key={bankItem.bankId}
                    className="p-3.5 bg-slate-50/90 border border-slate-200 rounded-2xl space-y-3 hover:border-amber-400/90 transition-all shadow-2xs flex flex-col justify-between"
                  >
                    {/* Header ngân hàng & quy mô sổ */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span
                          className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wider shadow-2xs"
                          style={{ backgroundColor: bankItem.bgLight, color: bankItem.color }}
                        >
                          {bankItem.bankTag}
                        </span>
                        <span className="font-bold text-slate-900 text-xs sm:text-sm truncate">
                          {bankItem.bankName}
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-600 font-bold">
                        {Math.round(bankItem.totalPrincipal / 1_000_000).toLocaleString('vi-VN')} Tr
                      </span>
                    </div>

                    {/* 3 Mục cấu hình gọn nhẹ */}
                    <div className="space-y-2 text-xs">
                      {/* Lãi vay cộng thêm */}
                      <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-600 font-semibold">1. Lãi vay cộng thêm:</span>
                          <span className="font-bold text-amber-800">+{currentMargin}%/năm</span>
                        </div>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <div className="flex items-center bg-amber-50/60 border border-amber-300 rounded-lg px-2 py-1 shrink-0">
                            <span className="text-amber-700 text-xs font-bold mr-0.5">+</span>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={currentMarginStr}
                              onChange={(e) => handleMarginInputChange(bankItem.bankId, e.target.value)}
                              className="w-10 text-center text-xs font-black text-amber-950 focus:outline-none bg-transparent"
                            />
                            <span className="text-slate-500 text-[10px] font-bold">%</span>
                          </div>
                          <div className="flex items-center gap-1 overflow-x-auto flex-1 scrollbar-none">
                            {[1.5, 2.0, 2.5, 3.0].map((m) => (
                              <button
                                key={m}
                                type="button"
                                onClick={() => {
                                  setMarginInputStrings((p) => ({ ...p, [bankItem.bankId]: m.toString() }));
                                  handleBankMarginChange(bankItem.bankId, m);
                                }}
                                className={`px-1.5 py-1 rounded text-[10px] font-bold cursor-pointer shrink-0 transition-all ${
                                  Math.abs(currentMargin - m) < 0.001
                                    ? 'bg-amber-600 text-white shadow-2xs'
                                    : 'bg-slate-100 hover:bg-amber-100 text-slate-700'
                                }`}
                              >
                                +{m}%
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Tỷ lệ vay (LTV) */}
                      <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 space-y-1">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-slate-600 font-semibold">2. Tỷ lệ vay cầm cố (LTV):</span>
                          <span className="font-bold text-emerald-800">{currentLtv}% Gốc</span>
                        </div>
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <div className="flex items-center bg-emerald-50/60 border border-emerald-300 rounded-lg px-2 py-1 shrink-0">
                            <input
                              type="text"
                              inputMode="numeric"
                              value={currentLtvStr}
                              onChange={(e) => handleLtvInputChange(bankItem.bankId, e.target.value)}
                              className="w-10 text-center text-xs font-black text-emerald-950 focus:outline-none bg-transparent"
                            />
                            <span className="text-slate-500 text-[10px] font-bold">%</span>
                          </div>
                          <div className="flex items-center gap-1 overflow-x-auto flex-1 scrollbar-none">
                            {[100, 95, 90, 85].map((ltvVal) => (
                              <button
                                key={ltvVal}
                                type="button"
                                onClick={() => {
                                  setLtvInputStrings((p) => ({ ...p, [bankItem.bankId]: ltvVal.toString() }));
                                  handleBankLtvChange(bankItem.bankId, ltvVal);
                                }}
                                className={`px-1.5 py-1 rounded text-[10px] font-bold cursor-pointer shrink-0 transition-all ${
                                  currentLtv === ltvVal
                                    ? 'bg-emerald-600 text-white shadow-2xs'
                                    : 'bg-slate-100 hover:bg-emerald-100 text-slate-700'
                                }`}
                              >
                                {ltvVal}%{ltvVal === 100 ? ' VIP' : ''}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Quyết toán */}
                      <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 space-y-1">
                        <span className="text-slate-600 font-semibold text-[11px] block">
                          3. Thời điểm quyết toán:
                        </span>
                        <div className="grid grid-cols-2 gap-1 pt-0.5">
                          <button
                            type="button"
                            onClick={() => handleBankSettlementChange(bankItem.bankId, 'UPFRONT')}
                            className={`px-2 py-1.5 rounded-lg text-center text-[10px] font-bold transition-all cursor-pointer border ${
                              currentSettlement === 'UPFRONT'
                                ? 'bg-amber-50 border-amber-400 text-amber-950 shadow-2xs'
                                : 'bg-slate-50 border-slate-200 text-slate-600'
                            }`}
                          >
                            Bù trừ khi vay
                          </button>
                          <button
                            type="button"
                            onClick={() => handleBankSettlementChange(bankItem.bankId, 'MATURITY')}
                            className={`px-2 py-1.5 rounded-lg text-center text-[10px] font-bold transition-all cursor-pointer border ${
                              currentSettlement === 'MATURITY'
                                ? 'bg-indigo-50 border-indigo-400 text-indigo-950 shadow-2xs'
                                : 'bg-slate-50 border-slate-200 text-slate-600'
                            }`}
                          >
                            Khi sổ đáo hạn
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 2. BỘ ĐIỀU KHIỂN NHU CẦU HUY ĐỘNG VỐN (MOBILE-FIRST) */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-6 shadow-xs space-y-5">
        {/* Switch Mode: 1 Tháng Cụ Thể VS Khoảng Nhiều Tháng */}
        <div className="flex items-center p-1 bg-slate-100/90 rounded-2xl border border-slate-200">
          <button
            type="button"
            onClick={() => {
              setMode('SINGLE_MONTH');
              setSelectedDayOverride(null);
            }}
            className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center space-x-2 transition-all cursor-pointer ${
              mode === 'SINGLE_MONTH'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CalendarDays className="w-4 h-4" />
            <span>Chọn 1 Tháng Cụ Thể</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('MONTH_RANGE')}
            className={`flex-1 py-2.5 px-3 rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center space-x-2 transition-all cursor-pointer ${
              mode === 'MONTH_RANGE'
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <CalendarRange className="w-4 h-4" />
            <span>Chọn Khoảng Nhiều Tháng</span>
          </button>
        </div>

        {/* Số tiền muốn huy động (Đơn vị: Triệu VNĐ) */}
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <label className="text-xs uppercase tracking-wider font-bold text-slate-700 flex items-center">
              <DollarSign className="w-4 h-4 text-emerald-600 mr-1" />
              Số tiền muốn huy động
              {targetAmountMillion >= 1000 && (
                <span className="ml-2 px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800 text-[11px] font-black border border-emerald-300 lowercase">
                  ≈ {(targetAmountMillion / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ
                </span>
              )}
            </label>
            <div className="flex items-center space-x-1.5 bg-emerald-50/80 border border-emerald-300 rounded-xl px-3 py-1.5 shadow-2xs">
              {isCalculating && mode === 'MONTH_RANGE' && (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600 shrink-0" />
              )}
              <input
                type="text"
                inputMode="numeric"
                placeholder="0"
                value={targetAmountMillionStr}
                onChange={handleAmountInputChange}
                className="w-28 sm:w-36 text-right font-black text-emerald-800 text-base sm:text-lg focus:outline-none bg-transparent tracking-tight"
              />
              <span className="text-xs text-emerald-900 font-black">Tr VNĐ</span>
            </div>
          </div>

          <input
            type="range"
            min="100"
            max={Math.max(1000, totalPrincipalMillion)}
            step="100"
            value={targetAmountMillion}
            onChange={(e) => handleAmountMillionChange(Number(e.target.value))}
            className="w-full accent-emerald-600 h-2 bg-slate-100 rounded-lg cursor-pointer"
          />

          {/* Quick presets for amounts & Reset */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {presetAmountsMillion.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => handleAmountMillionChange(p.value)}
                className={`px-2.5 py-1.5 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 ${
                  targetAmountMillion === p.value
                    ? 'bg-emerald-600 text-white shadow-2xs ring-2 ring-emerald-300'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-slate-200/60'
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              onClick={handleResetPlan}
              title="Đặt lại các tiêu chí về mặc định ban đầu"
              className="px-2.5 py-1.5 rounded-xl text-xs font-bold text-slate-500 hover:text-rose-600 hover:bg-rose-50 border border-dashed border-slate-300 transition-all cursor-pointer flex items-center gap-1 shrink-0 ml-auto"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Đặt lại</span>
            </button>
          </div>
        </div>

        {/* Thời gian: Tùy theo Mode */}
        {mode === 'SINGLE_MONTH' ? (
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase tracking-wider font-bold text-slate-700 flex items-center">
                <Calendar className="w-4 h-4 text-amber-600 mr-1" />
                Chọn Tháng Cần Tư Vấn Ngày Huy Động Tối Ưu
              </label>
              <span className="text-xs sm:text-sm font-black text-emerald-800 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-200">
                {selectedMonth.toString().padStart(2, '0')}/{selectedYear}
              </span>
            </div>

            {/* Quick Month Chips */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {upcomingMonthsList.map((m) => {
                const isSelected = selectedYear === m.year && selectedMonth === m.month;
                return (
                  <button
                    key={`${m.year}-${m.month}`}
                    type="button"
                    onClick={() => {
                      setSelectedYear(m.year);
                      setSelectedMonth(m.month);
                      setSelectedDayOverride(null);
                    }}
                    className={`px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer shrink-0 ${
                      isSelected
                        ? 'bg-amber-500 text-slate-950 shadow-2xs ring-2 ring-amber-300 font-black'
                        : 'bg-slate-100 hover:bg-amber-100 text-slate-700 border border-slate-200/80'
                    }`}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>

            <div className="pt-1">
              <label className="text-[11px] text-slate-500 font-semibold block mb-1">
                Hoặc chọn tháng/năm bất kỳ (trong 36 tháng tới):
              </label>
              <CustomSelect
                value={`${selectedYear}-${selectedMonth.toString().padStart(2, '0')}`}
                onChange={(val) => {
                  const opt = monthOptions36.find((o) => o.value === val);
                  if (opt) {
                    setSelectedYear(opt.year);
                    setSelectedMonth(opt.month);
                    setSelectedDayOverride(null);
                  }
                }}
                options={monthOptions36.map((o) => ({
                  value: o.value,
                  label: o.shortLabel,
                  subLabel: o.subLabel,
                }))}
                size="md"
                buttonClassName="font-bold text-slate-800 bg-white"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase tracking-wider font-bold text-slate-700 flex items-center">
                <CalendarRange className="w-4 h-4 text-indigo-600 mr-1" />
                Khoảng Thời Gian Cần Phân Tích (Từ Tháng Đến Tháng)
              </label>
            </div>

            {/* Quick Range Presets */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              {[
                { label: '3 tháng tới', months: 3 },
                { label: '6 tháng tới', months: 6 },
                { label: '9 tháng tới', months: 9 },
                { label: '12 tháng tới', months: 12 },
                { label: '18 tháng tới', months: 18 },
                { label: '24 tháng tới', months: 24 },
                { label: '36 tháng tới', months: 36 },
              ].map((r) => (
                <button
                  key={r.months}
                  type="button"
                  onClick={() => handleSetQuickRange(r.months)}
                  className="px-2.5 py-1.5 rounded-xl text-xs font-bold bg-slate-100 hover:bg-indigo-100 text-slate-700 border border-slate-200/80 cursor-pointer shrink-0 transition-all"
                >
                  {r.label}
                </button>
              ))}
            </div>

            {/* Range Selectors - Gộp Tháng + Năm (Phạm vi tối đa 36 tháng) */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="space-y-1.5 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                <span className="text-[11px] font-bold text-slate-600 block">Từ tháng:</span>
                <CustomSelect
                  value={`${rangeStartYear}-${rangeStartMonth.toString().padStart(2, '0')}`}
                  onChange={(val) => {
                    const opt = monthOptions36.find((o) => o.value === val);
                    if (opt) {
                      setRangeStartYear(opt.year);
                      setRangeStartMonth(opt.month);
                      const startIdx = monthOptions36.findIndex((o) => o.value === val);
                      const endIdx = monthOptions36.findIndex(
                        (o) => o.value === `${rangeEndYear}-${rangeEndMonth.toString().padStart(2, '0')}`
                      );
                      if (startIdx > endIdx && endIdx !== -1) {
                        setRangeEndYear(opt.year);
                        setRangeEndMonth(opt.month);
                      }
                    }
                  }}
                  options={monthOptions36.map((o) => ({
                    value: o.value,
                    label: o.shortLabel,
                    subLabel: o.subLabel,
                  }))}
                  size="md"
                  buttonClassName="px-2.5 py-2 text-xs sm:text-sm font-bold text-slate-800 bg-white"
                />
              </div>

              <div className="space-y-1.5 bg-slate-50 p-2.5 rounded-xl border border-slate-200">
                <span className="text-[11px] font-bold text-slate-600 block">Đến tháng:</span>
                <CustomSelect
                  value={`${rangeEndYear}-${rangeEndMonth.toString().padStart(2, '0')}`}
                  onChange={(val) => {
                    const opt = monthOptions36.find((o) => o.value === val);
                    if (opt) {
                      setRangeEndYear(opt.year);
                      setRangeEndMonth(opt.month);
                      const endIdx = monthOptions36.findIndex((o) => o.value === val);
                      const startIdx = monthOptions36.findIndex(
                        (o) => o.value === `${rangeStartYear}-${rangeStartMonth.toString().padStart(2, '0')}`
                      );
                      if (endIdx < startIdx && startIdx !== -1) {
                        setRangeStartYear(opt.year);
                        setRangeStartMonth(opt.month);
                      }
                    }
                  }}
                  options={monthOptions36.map((o) => ({
                    value: o.value,
                    label: o.shortLabel,
                    subLabel: o.subLabel,
                  }))}
                  size="md"
                  buttonClassName="px-2.5 py-2 text-xs sm:text-sm font-bold text-slate-800 bg-white"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 3. KẾT QUẢ KHI CHỌN 1 THÁNG CỤ THỂ */}
      {mode === 'SINGLE_MONTH' && (
        <div className="space-y-4">
          {/* THẺ PHƯƠNG ÁN TỐI ƯU NHẤT TRONG THÁNG (GIẢM 40% ĐỘ CAO, TINH GỌN NỘI DUNG) */}
          <div className="bg-gradient-to-b from-emerald-500/15 via-white to-emerald-500/5 rounded-2xl border-2 border-emerald-500 p-3.5 sm:p-4 shadow-sm relative overflow-hidden space-y-2.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center space-x-2.5">
                <span className="p-2 rounded-xl bg-emerald-600 text-white font-black shrink-0 shadow-2xs">
                  <Sparkles className="w-5 h-5" />
                </span>
                <div>
                  <div className="flex items-center space-x-1.5 flex-wrap">
                    <span className="px-2 py-0.5 rounded-full bg-emerald-600 text-white text-[9px] font-black uppercase tracking-wider">
                      Phương Án Tối Ưu Nhất
                    </span>
                    {selectedDayOverride !== null && (
                      <button
                        type="button"
                        onClick={() => setSelectedDayOverride(null)}
                        className="text-[10px] text-emerald-800 underline font-bold cursor-pointer"
                      >
                        (Về ngày tốt nhất: {singleMonthResult.bestDay.dateStr})
                      </button>
                    )}
                  </div>
                  <h3 className="font-black text-slate-900 text-sm sm:text-base pt-0.5">
                    Ngày Giải Ngân Tối Ưu: {formatDateVN(activeDayResult.dateStr)} ({activeDayResult.dayOfWeekLabel})
                  </h3>
                </div>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-2 bg-white/95 px-3 py-1.5 rounded-xl border border-emerald-200 shrink-0">
                <div>
                  <span className="text-[9px] uppercase font-bold text-slate-500 block">
                    Tổng Chi Phí Huy Động
                  </span>
                  <div className="flex items-baseline space-x-1.5">
                    <span className="text-sm sm:text-base font-black text-emerald-700">
                      {Math.round(activeDayResult.optimalTotalCost / 1_000_000).toLocaleString('vi-VN')} Tr VNĐ
                    </span>
                    <span className="text-[10px] font-bold text-slate-500">
                      (~{formatPercent((activeDayResult.optimalTotalCost / (activeDayResult.optimalTotalCash || 1)) * 100)})
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Rationale Text (Gọn 1-2 dòng) */}
            <div className="p-2 sm:p-2.5 bg-white/90 rounded-xl border border-emerald-200/80 text-[11px] sm:text-xs text-slate-700 leading-snug font-medium">
              💡 {activeDayResult.rationale}
            </div>

            {/* 3 Cấu Phần Chi Phí (Dạng 3 cột gọn gàng) */}
            <div className="grid grid-cols-3 gap-2 pt-0.5">
              {/* Cấu phần 1 */}
              <div className="p-2 sm:p-2.5 bg-emerald-50/90 border border-emerald-200 rounded-xl space-y-0.5">
                <span className="text-[9px] uppercase font-bold text-emerald-800 block truncate">
                  1. Đáo hạn (0đ)
                </span>
                <div className="text-xs sm:text-sm font-black text-emerald-900 truncate">
                  {Math.round(activeDayResult.freeMaturedCash / 1_000_000).toLocaleString('vi-VN')} Tr
                </div>
                <span className="text-[10px] text-emerald-700 block font-medium truncate">
                  {activeDayResult.maturedBooksCount} sổ đúng mốc
                </span>
              </div>

              {/* Cấu phần 2 */}
              <div className="p-2 sm:p-2.5 bg-indigo-50/90 border border-indigo-200 rounded-xl space-y-0.5">
                <span className="text-[9px] uppercase font-bold text-indigo-800 block truncate">
                  2. Lãi vay thế chấp
                </span>
                <div className="text-xs sm:text-sm font-black text-indigo-900 truncate">
                  +{Math.round(activeDayResult.optimalLoanInterestCost / 1_000_000).toLocaleString('vi-VN')} Tr
                </div>
                <span className="text-[10px] text-indigo-700 block font-medium truncate">
                  {activeDayResult.pledgeCount} sổ vay cầm cố
                </span>
              </div>

              {/* Cấu phần 3 */}
              <div className="p-2 sm:p-2.5 bg-amber-50/90 border border-amber-200 rounded-xl space-y-0.5">
                <span className="text-[9px] uppercase font-bold text-amber-800 block truncate">
                  3. Mất lãi rút sớm
                </span>
                <div className="text-xs sm:text-sm font-black text-amber-900 truncate">
                  +{Math.round(activeDayResult.optimalEarlyLossCost / 1_000_000).toLocaleString('vi-VN')} Tr
                </div>
                <span className="text-[10px] text-amber-700 block font-medium truncate">
                  {activeDayResult.earlyBreakCount} sổ rút sớm
                </span>
              </div>
            </div>

            {/* Tiết kiệm được */}
            {activeDayResult.savingsVsAllBreak > 0 && (
              <div className="flex items-center justify-between text-[11px] bg-emerald-100/90 px-3 py-1.5 rounded-lg text-emerald-950 font-bold">
                <span className="truncate mr-2">So với rút trước hạn toàn bộ:</span>
                <span className="text-emerald-800 text-xs shrink-0">
                  Tiết kiệm +{Math.round(activeDayResult.savingsVsAllBreak / 1_000_000).toLocaleString('vi-VN')} Tr
                </span>
              </div>
            )}
          </div>

          {/* BIỂU ĐỒ DIỄN BIẾN CHI PHÍ CÁC NGÀY TRONG THÁNG */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
              <div>
                <h3 className="font-bold text-slate-900 text-sm sm:text-base flex items-center">
                  <BarChart3 className="w-4 h-4 text-emerald-600 mr-1.5" />
                  Diễn biến chi phí huy động các ngày trong {singleMonthResult.monthLabel}
                </h3>
                <p className="text-xs text-slate-500">
                  Chạm vào từng cột để xem phương án huy động tại ngày đó. Đơn vị: Triệu VNĐ (Tr).
                </p>
              </div>

              <div className="flex items-center space-x-2 text-[11px] text-slate-600">
                <span className="inline-flex items-center">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1" />
                  Ngày Tối Ưu Nhất
                </span>
              </div>
            </div>

            <div className="h-56 w-full pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={singleMonthResult.allDays.map((d) => ({
                    day: d.dayNumber,
                    dateStr: d.dateStr,
                    costMillion: Math.round(d.optimalTotalCost / 1_000_000),
                    isBest: d.dayNumber === singleMonthResult.bestDay.dayNumber,
                    isSelected: d.dayNumber === activeDayResult.dayNumber,
                    freeCash: Math.round(d.freeMaturedCash / 1_000_000),
                  }))}
                  margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                  onClick={(e: any) => {
                    if (e && e.activePayload && e.activePayload[0]) {
                      const dayVal = e.activePayload[0].payload.day;
                      setSelectedDayOverride(dayVal);
                    }
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                  <XAxis
                    dataKey="day"
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    tickFormatter={(v) => `N${v}`}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    tickFormatter={(v) => `${v} Tr`}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div className="bg-slate-900 text-white p-2.5 rounded-xl text-xs shadow-lg space-y-1">
                            <div className="font-bold text-amber-400">
                              Ngày {data.day}/{selectedMonth}/{selectedYear}
                            </div>
                            <div>
                              Chi phí huy động:{' '}
                              <strong className="text-emerald-400">{data.costMillion.toLocaleString('vi-VN')} Tr</strong>
                            </div>
                            {data.freeCash > 0 && (
                              <div className="text-slate-300">
                                Tiền đáo hạn tự do: <strong>{data.freeCash.toLocaleString('vi-VN')} Tr</strong>
                              </div>
                            )}
                            <div className="text-[10px] text-slate-400 pt-0.5">
                              (Chạm để chọn ngày này)
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                  <Bar dataKey="costMillion" radius={[4, 4, 0, 0]} cursor="pointer">
                    {singleMonthResult.allDays.map((d, index) => {
                      const isBest = d.dayNumber === singleMonthResult.bestDay.dayNumber;
                      const isSelected = d.dayNumber === activeDayResult.dayNumber;
                      return (
                        <Cell
                          key={`cell-${index}`}
                          fill={isBest ? '#10b981' : isSelected ? '#6366f1' : '#cbd5e1'}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* BẢNG KÊ DANH SÁCH SỔ PHẢI TÁC ĐỘNG (GIẢM 30% CHIỀU CAO MỖI BOX) */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs space-y-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
              <div>
                <h3 className="font-bold text-slate-900 text-sm sm:text-base flex items-center">
                  <ListFilter className="w-4 h-4 text-emerald-600 mr-2" />
                  Bảng kê danh sách sổ chịu ảnh hưởng ({activeDayResult.selectedItems.length} sổ)
                </h3>
              </div>

              <div className="flex items-center space-x-1.5 text-[10px]">
                <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold">
                  Đáo Hạn (0đ)
                </span>
                <span className="px-2 py-0.5 rounded bg-indigo-100 text-indigo-900 font-bold">
                  Vay Cầm Cố
                </span>
                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-bold">
                  Rút Sớm
                </span>
              </div>
            </div>

            {/* Danh sách các sổ được chọn theo giao diện quy chuẩn thống nhất */}
            <div className="space-y-3">
              {activeDayResult.selectedItems.map(({ analysis, optimalAction, cost }, idx) => {
                const { book, projectedBook, daysRemaining, isMatured, appliedLtv } = analysis;
                const bId = projectedBook?.bankId || book.bankId;
                const bank = getBankById(bId);

                // Tìm STT thực tế của sổ trong Bảng kê
                const originalBookIndex = books.findIndex((b) => b.id === book.id);
                const bookSTT = originalBookIndex >= 0 ? originalBookIndex + 1 : idx + 1;

                const principalVal = projectedBook?.principal || book.principal;
                const totalMaturityExpected = principalVal + (analysis.fullTermInterest || 0);
                const maturityDateStr = projectedBook?.maturityDate || book.maturityDate;
                const startDateStr = projectedBook?.startDate || book.startDate;

                const totalDays = Math.max(1, getDaysBetween(startDateStr, maturityDateStr));
                const passedDays = Math.max(0, getDaysBetween(startDateStr, activeDayResult.dateStr));
                const percentProgress = Math.min(100, Math.max(0, Math.round((passedDays / totalDays) * 100)));

                return (
                  <div
                    key={book.id}
                    className="bg-white rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-all duration-200 overflow-hidden"
                  >
                    {/* Top Bank Strip & Tags (Quy chuẩn hệ thống) */}
                    <div
                      className="px-3.5 py-2.5 flex items-center justify-between border-b flex-wrap gap-2"
                      style={{ backgroundColor: bank.bgLight, borderColor: bank.borderColor }}
                    >
                      <div className="flex items-center space-x-2">
                        {/* STT Bảng kê */}
                        <span className="px-2 py-0.5 rounded-md bg-slate-900 text-white text-[11px] font-black tracking-tight shadow-2xs shrink-0">
                          STT #{bookSTT}
                        </span>

                        {/* Icon ngân hàng chuẩn */}
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs shadow-xs shrink-0"
                          style={{ backgroundColor: bank.primaryColor, color: bank.textColor }}
                        >
                          <Landmark className="w-3.5 h-3.5" />
                        </div>

                        {/* Tên ngân hàng & Mã Tag */}
                        <div className="flex items-center space-x-1.5 flex-wrap">
                          <span className="font-bold text-slate-900 text-xs sm:text-sm tracking-tight">
                            {bank.shortName}
                          </span>
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-white/80 text-slate-700 border border-slate-200/60">
                            {getBankTagForBook(bId, book.owner, bank.code)}
                          </span>
                          {analysis.cycleIndex && analysis.cycleIndex > 0 ? (
                            <span className="text-[10px] text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded font-bold border border-amber-200 flex items-center">
                              <Repeat className="w-3 h-3 mr-0.5 text-amber-600" />
                              Tái tục kỳ {analysis.cycleIndex}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      {/* Phía phải: Chủ sở hữu, Hình thức gửi & Action badge tối ưu */}
                      <div className="flex items-center space-x-1.5 flex-wrap">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border shadow-2xs ${
                            getOwnerBadgeStyle(book.owner).badgeClass
                          }`}
                        >
                          <User className="w-3 h-3 mr-1 opacity-70" />
                          {getOwnerLabel(book.owner)}
                        </span>
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold border ${
                            book.depositType === 'counter'
                              ? 'bg-amber-50 text-amber-900 border-amber-200/80'
                              : 'bg-teal-50 text-teal-800 border-teal-200/80'
                          }`}
                        >
                          {book.depositType === 'counter' ? 'Tại quầy' : 'Online'}
                        </span>
                        <div>
                          {optimalAction === 'MATURED' ? (
                            <span className="px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[11px] font-black flex items-center shadow-2xs">
                              <CheckCircle2 className="w-3 h-3 mr-1" />
                              Đáo Hạn (0đ)
                            </span>
                          ) : optimalAction === 'PLEDGE' ? (
                            <span className="px-2 py-0.5 rounded-md bg-indigo-600 text-white text-[11px] font-black flex items-center shadow-2xs">
                              <Percent className="w-3 h-3 mr-1" />
                              Vay Cầm Cố ({Math.round(appliedLtv * 100)}%)
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-md bg-amber-500 text-slate-950 text-[11px] font-black flex items-center shadow-2xs">
                              <TrendingDown className="w-3 h-3 mr-1" />
                              Rút Sớm
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Dải tiến độ kỳ hạn chuẩn */}
                    <div className="w-full h-1 bg-slate-100 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-500 ${
                          isMatured
                            ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                            : daysRemaining <= 45
                            ? 'bg-gradient-to-r from-amber-500 to-orange-500'
                            : 'bg-gradient-to-r from-indigo-500 to-blue-500'
                        }`}
                        style={{ width: `${percentProgress}%` }}
                      />
                    </div>

                    {/* Thân thẻ 4 chỉ tiêu trên 1 hàng chuẩn kích thước text lớn dễ nhìn */}
                    <div className="p-3 sm:p-4 bg-white">
                      <div className="grid grid-cols-4 gap-1.5 sm:gap-4 items-start">
                        {/* 1. SỐ TIỀN GỐC */}
                        <div className="min-w-0">
                          <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                            Số tiền gốc
                          </span>
                          <span className="text-sm sm:text-base md:text-lg font-bold text-slate-900 tracking-tight font-mono block truncate">
                            {(principalVal / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} Tr
                          </span>
                        </div>

                        {/* 2. TỔNG THU (GỐC+LÃI) */}
                        <div className="min-w-0">
                          <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                            Tổng thu (Gốc+Lãi)
                          </span>
                          <span className="text-sm sm:text-base md:text-lg font-bold text-emerald-600 tracking-tight font-mono block truncate">
                            +{(totalMaturityExpected / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} Tr
                          </span>
                        </div>

                        {/* 3. CHI PHÍ */}
                        <div className="min-w-0">
                          <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                            Chi phí
                          </span>
                          {cost === 0 ? (
                            <span className="text-sm sm:text-base md:text-lg font-bold text-emerald-600 tracking-tight font-mono block truncate">
                              0 đ
                            </span>
                          ) : (
                            <span className="text-sm sm:text-base md:text-lg font-bold text-rose-600 tracking-tight font-mono block truncate">
                              -{(cost / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} Tr
                            </span>
                          )}
                        </div>

                        {/* 4. NGÀY ĐÁO HẠN HOẶC NGÀY GỬI (NẾU RÚT SỚM) */}
                        <div className="min-w-0 text-right">
                          <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                            {optimalAction === 'EARLY_BREAK' ? 'Ngày gửi' : 'Ngày đáo hạn'}
                          </span>
                          <span className="text-sm sm:text-base md:text-lg font-bold text-slate-900 tracking-tight font-mono block truncate">
                            {formatDateVN(optimalAction === 'EARLY_BREAK' ? startDateStr : maturityDateStr, false)}
                          </span>
                          <div className="flex justify-end mt-0.5">
                            {optimalAction === 'EARLY_BREAK' ? (
                              <span className="text-[9.5px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded font-mono inline-block bg-amber-100 text-amber-900">
                                Đã gửi {passedDays}N
                              </span>
                            ) : (
                              <span
                                className={`text-[9.5px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded font-mono inline-block ${
                                  isMatured
                                    ? 'bg-rose-100 text-rose-800'
                                    : daysRemaining <= 45
                                    ? 'bg-amber-100 text-amber-900'
                                    : 'bg-indigo-50 text-indigo-800'
                                }`}
                              >
                                {isMatured ? 'Đáo hạn' : `Còn ${daysRemaining}N`}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 4. KẾT QUẢ KHI CHỌN KHOẢNG NHIỀU THÁNG (MULTI-MONTH RANGE ROUTE) */}
      {mode === 'MONTH_RANGE' && (
        <div className="space-y-5">
          {/* Header tóm tắt kỳ phân tích */}
          <div className="bg-gradient-to-r from-indigo-900 to-slate-900 text-white p-5 sm:p-6 rounded-2xl shadow-md space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-300">
                    Lộ Trình Tối Ưu Hóa Dòng Tiền Đa Chu Kỳ
                  </span>
                  {isCalculating && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-300 text-[10px] font-semibold border border-amber-400/30">
                      <Loader2 className="w-2.5 h-2.5 animate-spin text-amber-400" />
                      <span>Đang tính toán...</span>
                    </span>
                  )}
                </div>
                <h3 className="text-lg sm:text-xl font-black">
                  Tư Vấn Từng Tháng: {rangeStartMonth.toString().padStart(2, '0')}/{rangeStartYear} &rarr; {rangeEndMonth.toString().padStart(2, '0')}/{rangeEndYear}
                </h3>
              </div>

              <div className="bg-white/10 px-3.5 py-2 rounded-xl border border-white/20">
                <span className="text-[10px] text-slate-300 block">Số tiền mục tiêu:</span>
                <span className="text-base font-black text-amber-400">
                  {targetAmountMillion.toLocaleString('vi-VN')} Tr VNĐ
                </span>
              </div>
            </div>

            <p className="text-xs text-indigo-100 leading-relaxed">
              Dưới đây là <strong>ngày tối ưu nhất cho từng tháng</strong>. Hệ thống tự động quét dòng tiền các sổ (kể cả tái tục gối đầu) để chọn ra ngày có chi phí huy động vốn thấp nhất của từng tháng tương ứng.
            </p>
          </div>

          {/* Biểu đồ So Sánh Chi Phí Huy Động Giữa Các Tháng */}
          {rangeResults.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-xs space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-slate-900 text-sm sm:text-base flex items-center">
                    <BarChart3 className="w-4 h-4 text-indigo-600 mr-1.5" />
                    So sánh chi phí huy động tối ưu giữa các tháng
                  </h3>
                  <p className="text-xs text-slate-500">
                    Tháng có cột càng thấp = Chi phí huy động càng rẻ. Đơn vị: Triệu VNĐ (Tr).
                  </p>
                </div>
              </div>

              <div className="h-52 w-full pt-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={rangeResults.map((m) => ({
                      monthLabel: `${m.month.toString().padStart(2, '0')}/${m.year}`,
                      costMillion: Math.round(m.bestDay.optimalTotalCost / 1_000_000),
                      freeCashMillion: Math.round(m.bestDay.freeMaturedCash / 1_000_000),
                      optimalDateStr: m.bestDay.dateStr,
                      fullMonthRes: m,
                    }))}
                    margin={{ top: 10, right: 10, left: -15, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="monthLabel" tick={{ fontSize: 10, fill: '#64748b' }} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickFormatter={(v) => `${v} Tr`} />
                    <Tooltip
                      content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                          const d = payload[0].payload;
                          return (
                            <div className="bg-slate-900 text-white p-2.5 rounded-xl text-xs shadow-lg space-y-1">
                              <div className="font-bold text-amber-400">{d.monthLabel}</div>
                              <div>
                                Ngày tối ưu: <strong>{formatDateVN(d.optimalDateStr)}</strong>
                              </div>
                              <div>
                                Chi phí thấp nhất:{' '}
                                <strong className="text-emerald-400">{d.costMillion.toLocaleString('vi-VN')} Tr</strong>
                              </div>
                              {d.freeCashMillion > 0 && (
                                <div className="text-slate-300">
                                  Tiền đáo hạn tự do: <strong>{d.freeCashMillion.toLocaleString('vi-VN')} Tr</strong>
                                </div>
                              )}
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar dataKey="costMillion" radius={[4, 4, 0, 0]} fill="#6366f1">
                      {rangeResults.map((r, i) => (
                        <Cell
                          key={`range-cell-${i}`}
                          fill={r.bestDay.optimalTotalCost === 0 ? '#10b981' : '#6366f1'}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Danh Sách Chi Tiết Từng Tháng Kèm Bảng Kê */}
          <div className="space-y-4">
            <h3 className="font-bold text-slate-900 text-sm sm:text-base flex items-center">
              <CalendarRange className="w-4 h-4 text-indigo-600 mr-2" />
              Chi tiết ngày tối ưu & bảng kê sổ cho từng tháng ({rangeResults.length} tháng)
            </h3>

            {rangeResults.map((monthRes) => {
              const { monthLabel, bestDay } = monthRes;
              const formattedMonthMMYYYY = `${monthRes.month.toString().padStart(2, '0')}/${monthRes.year}`;
              const isExpanded = expandedRangeMonthKey === monthLabel;
              const costMillion = Math.round(bestDay.optimalTotalCost / 1_000_000);

              return (
                <div
                  key={monthLabel}
                  className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs hover:border-indigo-400 transition-all"
                >
                  {/* Monthly Summary Bar */}
                  <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="px-2.5 py-0.5 rounded-lg bg-indigo-100 text-indigo-900 text-xs font-black">
                          {formattedMonthMMYYYY}
                        </span>
                        <span className="font-bold text-slate-900 text-sm sm:text-base">
                          Ngày Tối Ưu: <strong className="text-emerald-700">{formatDateVN(bestDay.dateStr)}</strong> ({bestDay.dayOfWeekLabel})
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 leading-relaxed max-w-2xl">
                        {bestDay.rationale}
                      </p>
                    </div>

                    <div className="flex items-center justify-between sm:justify-end space-x-3 pt-2 sm:pt-0 border-t sm:border-t-0 border-slate-200/80">
                      <div className="text-left sm:text-right">
                        <span className="text-[10px] text-slate-500 font-bold block">Chi Phí Huy Động:</span>
                        <span className={`text-base font-black ${costMillion === 0 ? 'text-emerald-600' : 'text-slate-900'}`}>
                          {costMillion === 0 ? '0 đ' : `${costMillion.toLocaleString('vi-VN')} Tr`}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => setExpandedRangeMonthKey(isExpanded ? null : monthLabel)}
                        className={`px-3 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center space-x-1.5 ${
                          isExpanded
                            ? 'bg-indigo-600 text-white shadow-2xs'
                            : 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <span>{isExpanded ? 'Đóng Bảng Kê' : 'Xem Bảng Kê Sổ'}</span>
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {/* Expanded Books Manifest for this Month */}
                  {isExpanded && (
                    <div className="p-4 sm:p-5 border-t border-slate-200 bg-white space-y-3 animate-in fade-in">
                      <div className="flex items-center justify-between text-xs pb-1">
                        <span className="font-bold text-slate-800">
                          Bảng kê {bestDay.selectedItems.length} sổ phải tác động tại ngày {formatDateVN(bestDay.dateStr)}:
                        </span>
                        <span className="text-slate-500">
                          {bestDay.pledgeCount} Vay cầm cố &bull; {bestDay.earlyBreakCount} Rút sớm &bull; {bestDay.maturedBooksCount} Đáo hạn
                        </span>
                      </div>

                      <div className="space-y-3">
                        {bestDay.selectedItems.map(({ analysis, optimalAction, cost }, sIdx) => {
                          const { book, projectedBook, daysRemaining, isMatured, appliedLtv } = analysis;
                          const bId = projectedBook?.bankId || book.bankId;
                          const bank = getBankById(bId);

                          const originalBookIndex = books.findIndex((b) => b.id === book.id);
                          const bookSTT = originalBookIndex >= 0 ? originalBookIndex + 1 : sIdx + 1;

                          const principalVal = projectedBook?.principal || book.principal;
                          const totalMaturityExpected = principalVal + (analysis.fullTermInterest || 0);
                          const maturityDateStr = projectedBook?.maturityDate || book.maturityDate;
                          const startDateStr = projectedBook?.startDate || book.startDate;

                          const totalDays = Math.max(1, getDaysBetween(startDateStr, maturityDateStr));
                          const passedDays = Math.max(0, getDaysBetween(startDateStr, bestDay.dateStr));
                          const percentProgress = Math.min(100, Math.max(0, Math.round((passedDays / totalDays) * 100)));

                          return (
                            <div
                              key={book.id}
                              className="bg-white rounded-2xl border border-slate-200/80 shadow-xs hover:shadow-md transition-all duration-200 overflow-hidden"
                            >
                              {/* Top Bank Strip & Tags (Quy chuẩn hệ thống) */}
                              <div
                                className="px-3.5 py-2.5 flex items-center justify-between border-b flex-wrap gap-2"
                                style={{ backgroundColor: bank.bgLight, borderColor: bank.borderColor }}
                              >
                                <div className="flex items-center space-x-2">
                                  {/* STT Bảng kê */}
                                  <span className="px-2 py-0.5 rounded-md bg-slate-900 text-white text-[11px] font-black tracking-tight shadow-2xs shrink-0">
                                    STT #{bookSTT}
                                  </span>

                                  {/* Icon ngân hàng chuẩn */}
                                  <div
                                    className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-xs shadow-xs shrink-0"
                                    style={{ backgroundColor: bank.primaryColor, color: bank.textColor }}
                                  >
                                    <Landmark className="w-3.5 h-3.5" />
                                  </div>

                                  {/* Tên ngân hàng & Mã Tag */}
                                  <div className="flex items-center space-x-1.5 flex-wrap">
                                    <span className="font-bold text-slate-900 text-xs sm:text-sm tracking-tight">
                                      {bank.shortName}
                                    </span>
                                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-white/80 text-slate-700 border border-slate-200/60">
                                      {getBankTagForBook(bId, book.owner, bank.code)}
                                    </span>
                                    {analysis.cycleIndex && analysis.cycleIndex > 0 ? (
                                      <span className="text-[10px] text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded font-bold border border-amber-200 flex items-center">
                                        <Repeat className="w-3 h-3 mr-0.5 text-amber-600" />
                                        Tái tục kỳ {analysis.cycleIndex}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>

                                {/* Phía phải: Chủ sở hữu, Hình thức gửi & Action badge tối ưu */}
                                <div className="flex items-center space-x-1.5 flex-wrap">
                                  <span
                                    className={`inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-bold border shadow-2xs ${
                                      getOwnerBadgeStyle(book.owner).badgeClass
                                    }`}
                                  >
                                    <User className="w-3 h-3 mr-1 opacity-70" />
                                    {getOwnerLabel(book.owner)}
                                  </span>
                                  <span
                                    className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-bold border ${
                                      book.depositType === 'counter'
                                        ? 'bg-amber-50 text-amber-900 border-amber-200/80'
                                        : 'bg-teal-50 text-teal-800 border-teal-200/80'
                                    }`}
                                  >
                                    {book.depositType === 'counter' ? 'Tại quầy' : 'Online'}
                                  </span>
                                  <div>
                                    {optimalAction === 'MATURED' ? (
                                      <span className="px-2 py-0.5 rounded-md bg-emerald-600 text-white text-[11px] font-black flex items-center shadow-2xs">
                                        <CheckCircle2 className="w-3 h-3 mr-1" />
                                        Đáo Hạn (0đ)
                                      </span>
                                    ) : optimalAction === 'PLEDGE' ? (
                                      <span className="px-2 py-0.5 rounded-md bg-indigo-600 text-white text-[11px] font-black flex items-center shadow-2xs">
                                        <Percent className="w-3 h-3 mr-1" />
                                        Vay Cầm Cố ({Math.round(appliedLtv * 100)}%)
                                      </span>
                                    ) : (
                                      <span className="px-2 py-0.5 rounded-md bg-amber-500 text-slate-950 text-[11px] font-black flex items-center shadow-2xs">
                                        <TrendingDown className="w-3 h-3 mr-1" />
                                        Rút Sớm
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>

                              {/* Dải tiến độ kỳ hạn chuẩn */}
                              <div className="w-full h-1 bg-slate-100 overflow-hidden">
                                <div
                                  className={`h-full transition-all duration-500 ${
                                    isMatured
                                      ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
                                      : daysRemaining <= 45
                                      ? 'bg-gradient-to-r from-amber-500 to-orange-500'
                                      : 'bg-gradient-to-r from-indigo-500 to-blue-500'
                                  }`}
                                  style={{ width: `${percentProgress}%` }}
                                />
                              </div>

                              {/* Thân thẻ 4 chỉ tiêu trên 1 hàng chuẩn kích thước text lớn dễ nhìn */}
                              <div className="p-3 sm:p-4 bg-white">
                                <div className="grid grid-cols-4 gap-1.5 sm:gap-4 items-start">
                                  {/* 1. SỐ TIỀN GỐC */}
                                  <div className="min-w-0">
                                    <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                                      Số tiền gốc
                                    </span>
                                    <span className="text-sm sm:text-base md:text-lg font-bold text-slate-900 tracking-tight font-mono block truncate">
                                      {(principalVal / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} Tr
                                    </span>
                                  </div>

                                  {/* 2. TỔNG THU (GỐC+LÃI) */}
                                  <div className="min-w-0">
                                    <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                                      Tổng thu (Gốc+Lãi)
                                    </span>
                                    <span className="text-sm sm:text-base md:text-lg font-bold text-emerald-600 tracking-tight font-mono block truncate">
                                      +{(totalMaturityExpected / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} Tr
                                    </span>
                                  </div>

                                  {/* 3. CHI PHÍ */}
                                  <div className="min-w-0">
                                    <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                                      Chi phí
                                    </span>
                                    {cost === 0 ? (
                                      <span className="text-sm sm:text-base md:text-lg font-bold text-emerald-600 tracking-tight font-mono block truncate">
                                        0 đ
                                      </span>
                                    ) : (
                                      <span className="text-sm sm:text-base md:text-lg font-bold text-rose-600 tracking-tight font-mono block truncate">
                                        -{(cost / 1_000_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} Tr
                                      </span>
                                    )}
                                  </div>

                                  {/* 4. NGÀY ĐÁO HẠN HOẶC NGÀY GỬI (NẾU RÚT SỚM) */}
                                  <div className="min-w-0 text-right">
                                    <span className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-400 font-bold block truncate">
                                      {optimalAction === 'EARLY_BREAK' ? 'Ngày gửi' : 'Ngày đáo hạn'}
                                    </span>
                                    <span className="text-sm sm:text-base md:text-lg font-bold text-slate-900 tracking-tight font-mono block truncate">
                                      {formatDateVN(optimalAction === 'EARLY_BREAK' ? startDateStr : maturityDateStr, false)}
                                    </span>
                                    <div className="flex justify-end mt-0.5">
                                      {optimalAction === 'EARLY_BREAK' ? (
                                        <span className="text-[9.5px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded font-mono inline-block bg-amber-100 text-amber-900">
                                          Đã gửi {passedDays}N
                                        </span>
                                      ) : (
                                        <span
                                          className={`text-[9.5px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded font-mono inline-block ${
                                            isMatured
                                              ? 'bg-rose-100 text-rose-800'
                                              : daysRemaining <= 45
                                              ? 'bg-amber-100 text-amber-900'
                                              : 'bg-indigo-50 text-indigo-800'
                                          }`}
                                        >
                                          {isMatured ? 'Đáo hạn' : `Còn ${daysRemaining}N`}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
