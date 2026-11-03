import React, { useState, useMemo } from 'react';
import { SavingsBook, AppSettings, SettlementAdjustment } from '../types';
import { getDynamicAnnualInterestHistory, getDynamicBalanceGrowthHistory } from '../data/historicalGrowth';
import { getBankById } from '../data/banks';
import { getDaysBetween, calculateInterest } from '../utils/calculator';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
  LineChart,
  Line,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  TrendingUp,
  Coins,
  Calendar,
  Sparkles,
  ShieldCheck,
  Percent,
  Layers,
  Cloud,
  PieChart as PieIcon,
  BarChart3,
  Wallet,
  Clock,
  ArrowRight,
  Building2,
  UserCheck,
  Smartphone,
  SlidersHorizontal,
} from 'lucide-react';
import { getOwnerLabel, formatAdaptiveShortVND, formatPercent } from '../utils/formatters';

interface InterestCalculationViewProps {
  books: SavingsBook[];
  settings: AppSettings;
  currentDateStr: string;
  settlements?: SettlementAdjustment[];
  onOpenOptimizer?: () => void;
  onOpenSyncModal?: () => void;
}

type AllocationGroupBy = 'bank' | 'owner' | 'depositType' | 'term' | 'rate';

export const InterestCalculationView: React.FC<InterestCalculationViewProps> = ({
  books,
  settings,
  currentDateStr,
  settlements = [],
  onOpenOptimizer,
  onOpenSyncModal,
}) => {
  // Tab phân bổ danh mục (tích hợp từ Quick Chart)
  const [allocationGroupBy, setAllocationGroupBy] = useState<AllocationGroupBy>('bank');

  // Rollover simulation custom rate
  const [selectedSimRate, setSelectedSimRate] = useState<number>(7.5);

  // 1. Portfolio core totals
  const totalPrincipal = useMemo(() => books.reduce((sum, b) => sum + b.principal, 0), [books]);
  const totalActivePrincipalMil = useMemo(() => {
    const sum = books.filter((b) => b.status === 'active').reduce((acc, b) => acc + b.principal, 0);
    return Math.max(1, Math.round(sum / 1_000_000));
  }, [books]);

  const totalTermInterest = useMemo(
    () =>
      books.reduce((sum, b) => {
        const daysTotal = Math.max(1, getDaysBetween(b.startDate, b.maturityDate));
        const expected = b.expectedTermInterest ?? Math.round((b.principal * (b.interestRate / 100) * daysTotal) / 365);
        return sum + expected;
      }, 0),
    [books]
  );

  // Helper tính lãi suất bình quân gia quyền theo cả Gốc và Kỳ hạn
  const calculateWeightedAvgRate = (booksList: SavingsBook[]) => {
    const rateSum = booksList.reduce((sum, b) => {
      const term = b.termMonths || Math.max(1, Math.round(getDaysBetween(b.startDate, b.maturityDate) / 30));
      return sum + b.principal * b.interestRate * term;
    }, 0);
    const termSum = booksList.reduce((sum, b) => {
      const term = b.termMonths || Math.max(1, Math.round(getDaysBetween(b.startDate, b.maturityDate) / 30));
      return sum + b.principal * term;
    }, 0);
    return termSum > 0 ? rateSum / termSum : 0;
  };

  const weightedAvgRate = useMemo(() => calculateWeightedAvgRate(books), [books]);

  // Lãi bình quân tháng (quy về 12 tháng theo lãi suất bình quân)
  const monthlyAvgInterestVND = useMemo(() => {
    return Math.round((totalPrincipal * (weightedAvgRate / 100)) / 12);
  }, [totalPrincipal, weightedAvgRate]);

  // Tổng dòng tiền thu hồi (Gốc + Lãi)
  const totalCashflowVND = useMemo(() => {
    return totalPrincipal + totalTermInterest;
  }, [totalPrincipal, totalTermInterest]);

  // Dynamic history records synchronized in real-time
  const dynamicAnnualInterest = useMemo(
    () => getDynamicAnnualInterestHistory(books, settlements),
    [books, settlements]
  );
  const dynamicBalanceGrowth = useMemo(
    () => getDynamicBalanceGrowthHistory(books, settlements),
    [books, settlements]
  );

  // Group books by maturity year
  const booksByMaturityYear = useMemo(() => {
    const map = new Map<string, SavingsBook[]>();
    for (const b of books) {
      const year = b.maturityDate.slice(0, 4) || 'Khác';
      if (!map.has(year)) {
        map.set(year, []);
      }
      map.get(year)!.push(b);
    }
    return map;
  }, [books]);

  const maturityYears = useMemo(() => {
    return Array.from(booksByMaturityYear.keys()).sort();
  }, [booksByMaturityYear]);

  // Summary by maturity year
  const yearStats = useMemo(() => {
    return maturityYears.map((yr) => {
      const yearBooks = booksByMaturityYear.get(yr) || [];
      const principal = yearBooks.reduce((sum, b) => sum + b.principal, 0);
      const interest = yearBooks.reduce((sum, b) => {
        const daysTotal = Math.max(1, getDaysBetween(b.startDate, b.maturityDate));
        return sum + (b.expectedTermInterest ?? Math.round((b.principal * (b.interestRate / 100) * daysTotal) / 365));
      }, 0);
      const avgRate = calculateWeightedAvgRate(yearBooks);
      return {
        year: yr,
        bookCount: yearBooks.length,
        principal,
        principalMillion: Math.round(principal / 1_000_000),
        interest,
        interestMillion: Math.round(interest / 1_000_000),
        totalCashflow: principal + interest,
        totalCashflowMillion: Math.round((principal + interest) / 1_000_000),
        avgRate,
      };
    });
  }, [maturityYears, booksByMaturityYear]);

  // Monthly maturity timeline data
  const monthlyCashflowData = useMemo(() => {
    const map = new Map<string, { monthKey: string; monthLabel: string; principalMillion: number; interestMillion: number; totalMillion: number; bookCount: number }>();

    for (const book of books) {
      if (book.status !== 'active') continue;
      const ym = book.maturityDate.slice(0, 7); // Format: 'YYYY-MM'
      const [year, month] = ym.split('-');
      const monthLabel = `T${parseInt(month, 10)}/${year.slice(2)}`;

      const daysTotal = Math.max(1, getDaysBetween(book.startDate, book.maturityDate));
      const termInterest = book.expectedTermInterest ?? Math.round((book.principal * (book.interestRate / 100) * daysTotal) / 365);

      if (!map.has(ym)) {
        map.set(ym, {
          monthKey: ym,
          monthLabel,
          principalMillion: 0,
          interestMillion: 0,
          totalMillion: 0,
          bookCount: 0,
        });
      }

      const entry = map.get(ym)!;
      entry.principalMillion += Math.round(book.principal / 1_000_000);
      entry.interestMillion += Math.round(termInterest / 1_000_000);
      entry.totalMillion = entry.principalMillion + entry.interestMillion;
      entry.bookCount += 1;
    }

    return Array.from(map.values()).sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  }, [books]);

  // Peak cashflow month
  const peakCashflowMonth = useMemo(() => {
    if (monthlyCashflowData.length === 0) return null;
    return [...monthlyCashflowData].sort((a, b) => b.totalMillion - a.totalMillion)[0];
  }, [monthlyCashflowData]);

  // High contrast vibrant palette for breakdown categories to guarantee maximum visual separation
  const highContrastPalette = [
    '#2563eb', // Royal Blue
    '#db2777', // Vivid Magenta Pink
    '#059669', // Vivid Emerald Green
    '#d97706', // Vivid Amber Gold
    '#7c3aed', // Vivid Purple
    '#dc2626', // Vivid Red
    '#0891b2', // Vivid Cyan Teal
    '#ea580c', // Vivid Orange
    '#4f46e5', // Vivid Indigo
    '#16a34a', // Vivid Green
    '#e11d48', // Vivid Rose
    '#b45309', // Deep Bronze
  ];

  // Dynamic Allocation Stats (from Quick Chart) based on selected groupBy
  const allocationStats = useMemo(() => {
    const activeBooks = books.filter((b) => b.status === 'active');
    const totActivePrincipal = activeBooks.reduce((sum, b) => sum + b.principal, 0);

    const groupMap: Record<
      string,
      {
        id: string;
        name: string;
        shortName: string;
        principal: number;
        interest: number;
        bookCount: number;
        weightedRateSum: number;
        color: string;
        tag?: string;
      }
    > = {};

    activeBooks.forEach((book) => {
      const days = Math.max(1, getDaysBetween(book.startDate, book.maturityDate));
      const interest = calculateInterest(book.principal, book.interestRate, days);

      let key = '';
      let name = '';
      let shortName = '';
      let customColor = '';

      if (allocationGroupBy === 'bank') {
        const info = getBankById(book.bankId);
        key = book.bankId;
        name = info.name;
        shortName = info.shortName || info.code;
        customColor = info.primaryColor || '#2563eb';
      } else if (allocationGroupBy === 'owner') {
        key = book.owner ? book.owner.trim() : 'Chưa phân loại';
        name = getOwnerLabel(key);
        shortName = name;
        
        const lower = key.toLowerCase().normalize('NFC');
        const lowerHusband = (settings.husbandName || 'Chồng').toLowerCase().normalize('NFC');
        const lowerWife = (settings.wifeName || 'Vợ').toLowerCase().normalize('NFC');

        if (
          lower === 'chồng' ||
          lower === 'chong' ||
          lower === 'husband' ||
          lower === lowerHusband ||
          lower.includes('chồng') ||
          lower.includes('chong')
        ) {
          customColor = '#2563eb'; // Chồng: Xanh dương hoàng gia nổi bật (Royal Blue)
        } else if (
          lower === 'vợ' ||
          lower === 'vo' ||
          lower === 'wife' ||
          lower === lowerWife ||
          lower.includes('vợ') ||
          lower.includes('vo')
        ) {
          customColor = '#db2777'; // Vợ: Hồng cánh sen / Magenta tương phản rõ rệt
        } else if (lower.includes('chung') || lower.includes('cả 2') || lower.includes('cả hai') || lower === 'both') {
          customColor = '#059669'; // Cả hai / Chung: Xanh lá ngọc Emerald
        } else if (lower.includes('con')) {
          customColor = '#d97706'; // Con: Vàng cam hổ phách
        } else {
          customColor = '#7c3aed'; // Khác: Tím tử đinh hương
        }
      } else if (allocationGroupBy === 'depositType') {
        key = book.depositType || 'counter';
        name = key === 'online' ? 'Gửi Online' : 'Gửi Tại quầy';
        shortName = name;
        // Tương phản cao: Online (Xanh lá ngọc) vs Tại quầy (Xanh chàm đậm / Indigo)
        customColor = key === 'online' ? '#059669' : '#4338ca';
      } else if (allocationGroupBy === 'term') {
        const term = book.termMonths || 12;
        key = `${term}T`;
        name = `Kỳ hạn ${term} Tháng`;
        shortName = `${term} Tháng`;
        const termColors: Record<number, string> = {
          1: '#0284c7',  // Cyan 
          3: '#0891b2',  // Teal
          6: '#0284c7',  // Sky Blue
          9: '#4f46e5',  // Indigo
          12: '#2563eb', // Royal Blue
          13: '#059669', // Emerald
          18: '#7c3aed', // Vivid Purple
          24: '#e11d48', // Rose / Ruby
          36: '#ea580c', // Orange
        };
        customColor = termColors[term] || '#d97706';
      } else {
        // 'rate'
        const rate = book.interestRate;
        let bracket = '7.0% - 7.5%';
        customColor = '#0891b2'; // Cyan
        if (rate >= 9.0) {
          bracket = '≥ 9.0% (Đỉnh cao)';
          customColor = '#dc2626'; // Bright Red
        } else if (rate >= 8.5) {
          bracket = '8.5% - 9.0%';
          customColor = '#ea580c'; // Vivid Orange
        } else if (rate >= 8.0) {
          bracket = '8.0% - 8.5%';
          customColor = '#d97706'; // Amber Gold
        } else if (rate >= 7.5) {
          bracket = '7.5% - 8.0%';
          customColor = '#2563eb'; // Royal Blue
        }
        key = bracket;
        name = bracket;
        shortName = bracket;
      }

      if (!groupMap[key]) {
        groupMap[key] = {
          id: key,
          name,
          shortName,
          principal: 0,
          interest: 0,
          bookCount: 0,
          weightedRateSum: 0,
          color: customColor,
        };
      }

      groupMap[key].principal += book.principal;
      groupMap[key].interest += interest;
      groupMap[key].bookCount += 1;
      groupMap[key].weightedRateSum += book.interestRate * book.principal;
    });

    const list = Object.values(groupMap).map((item, idx) => {
      const percent = totActivePrincipal > 0 ? (item.principal / totActivePrincipal) * 100 : 0;
      const avgRate = item.principal > 0 ? item.weightedRateSum / item.principal : 0;
      
      // If bank mode and bank colors collide or aren't distinct, fallback to highContrastPalette
      let finalColor = item.color;
      if (allocationGroupBy === 'bank' && !item.color) {
        finalColor = highContrastPalette[idx % highContrastPalette.length];
      }

      return {
        ...item,
        percent,
        avgRate,
        principalMillion: Math.round(item.principal / 1_000_000),
        interestMillion: Math.round(item.interest / 1_000_000),
        color: finalColor,
      };
    });

    // Ensure distinct colors if all items ended up with duplicate colors
    const usedColors = new Set<string>();
    list.forEach((item, idx) => {
      if (usedColors.has(item.color)) {
        item.color = highContrastPalette[idx % highContrastPalette.length];
      }
      usedColors.add(item.color);
    });

    if (allocationGroupBy === 'term') {
      list.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    } else if (allocationGroupBy === 'rate') {
      // keep order
    } else {
      list.sort((a, b) => b.principal - a.principal);
    }

    return {
      list,
      totActivePrincipal,
      topItem: list[0] || null,
    };
  }, [books, allocationGroupBy, settings.husbandName, settings.wifeName]);

  // Early withdrawal vs collateral loan curve
  const lossCurveData = useMemo(() => {
    const maxMil = totalActivePrincipalMil;
    const targetSteps = [
      Math.round(maxMil * 0.1),
      Math.round(maxMil * 0.25),
      Math.round(maxMil * 0.5),
      Math.round(maxMil * 0.75),
      maxMil,
    ].filter((v) => v > 0);

    const sortedBooks = [...books].sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));

    return targetSteps.map((targetMil) => {
      const targetVND = targetMil * 1_000_000;
      let accumulated = 0;
      let earlyWithdrawLossVND = 0;
      let loanCostVND = 0;

      for (const book of sortedBooks) {
        if (accumulated >= targetVND) break;
        const daysTotal = Math.max(1, getDaysBetween(book.startDate, book.maturityDate));
        const daysToMaturity = Math.max(1, getDaysBetween(currentDateStr, book.maturityDate));
        const daysElapsed = Math.max(0, daysTotal - daysToMaturity);

        const expectedTermInterest =
          book.expectedTermInterest ??
          Math.round((book.principal * (book.interestRate / 100) * daysTotal) / 365);
        const demandInterest = Math.round((book.principal * (0.2 / 100) * daysElapsed) / 365);
        const lostInterest = expectedTermInterest - demandInterest;

        // Vay cầm cố: Lãi vay = Lãi sổ + 1.5%
        const loanRate = book.interestRate + 1.5;
        const bookLoanCost = Math.round((book.principal * (loanRate / 100) * daysToMaturity) / 365);

        accumulated += book.principal;
        earlyWithdrawLossVND += lostInterest;
        loanCostVND += bookLoanCost;
      }

      const savingsVND = Math.max(0, earlyWithdrawLossVND - loanCostVND);

      return {
        targetLabel: `${targetMil.toLocaleString('vi-VN')} Tr`,
        targetMil,
        earlyWithdrawLossMillion: Math.round(earlyWithdrawLossVND / 1_000_000),
        loanCostMillion: Math.round(loanCostVND / 1_000_000),
        savedMillion: Math.round(savingsVND / 1_000_000),
      };
    });
  }, [books, currentDateStr, totalActivePrincipalMil]);

  // Format money helper strictly in Million VNĐ (Tr)
  const formatMoney = (vnd: number) => {
    if (settings.privacyMode) return '••••••';
    const mil = Math.round(vnd / 1_000_000);
    return `${mil.toLocaleString('vi-VN')} Tr`;
  };

  const formatShortNumber = (val: number) => {
    if (settings.privacyMode) return '••••';
    return val.toLocaleString('vi-VN');
  };

  // If no books exist, show empty state
  if (books.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center shadow-xs space-y-4">
        <div className="w-14 h-14 rounded-2xl bg-amber-50 text-amber-600 flex items-center justify-center mx-auto border border-amber-200">
          <Coins className="w-7 h-7" />
        </div>
        <div className="space-y-1 max-w-sm mx-auto">
          <h3 className="text-base font-bold text-slate-900">
            Chưa Có Dữ Liệu Sổ Tiết Kiệm
          </h3>
          <p className="text-xs text-slate-500">
            Dữ liệu trên ứng dụng đã được làm sạch. Vui lòng kết nối Google Drive hoặc nhập sổ để xem phân tích dòng tiền và chiến lược tái tục.
          </p>
        </div>
        {onOpenSyncModal && (
          <button
            onClick={onOpenSyncModal}
            className="inline-flex items-center space-x-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs shadow-md active:scale-95 transition-all cursor-pointer"
          >
            <Cloud className="w-4 h-4" />
            <span>Kết Nối Google Drive</span>
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-12 max-w-5xl mx-auto">
      {/* 1. Executive Summary Banner: 5 Unified KPI Cards (All in Million VNĐ / Tr) */}
      <div className="bg-gradient-to-br from-slate-900 via-indigo-950 to-slate-900 text-white rounded-2xl p-3.5 sm:p-4 shadow-sm border border-indigo-800/40">
        <div className="flex items-center justify-between pb-2.5 border-b border-indigo-800/40">
          <div className="flex items-center space-x-2">
            <span className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              <TrendingUp className="w-4 h-4" />
            </span>
            <div>
              <h2 className="text-sm sm:text-base font-bold tracking-tight text-white leading-tight">
                Phân Tích Dòng Tiền &amp; Chiến Lược Tái Tục
              </h2>
            </div>
          </div>
          <span className="text-[11px] px-2 py-0.5 rounded-md bg-white/10 text-indigo-200 font-semibold shrink-0">
            {books.length} Sổ &bull; ĐV: Triệu VNĐ
          </span>
        </div>

        {/* 5 Core Metrics Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-3">
          {/* Metric 1: Tổng Gốc */}
          <div className="bg-white/5 rounded-xl p-2.5 border border-white/10 flex flex-col justify-center">
            <span className="text-[11px] text-amber-200 font-medium flex items-center justify-between">
              <span>Tổng Tiền Gốc</span>
              <Wallet className="w-3 h-3 text-amber-300/80" />
            </span>
            <span className="text-sm sm:text-base font-black text-amber-300 block mt-1 tracking-tight">
              {formatAdaptiveShortVND(totalPrincipal, settings.privacyMode)}
            </span>
          </div>

          {/* Metric 2: Tổng Lãi Kỳ */}
          <div className="bg-white/5 rounded-xl p-2.5 border border-white/10 flex flex-col justify-center">
            <span className="text-[11px] text-emerald-200 font-medium flex items-center justify-between">
              <span>Tổng Lãi Cả Kỳ</span>
              <Coins className="w-3 h-3 text-emerald-300/80" />
            </span>
            <span className="text-sm sm:text-base font-black text-emerald-300 block mt-1 tracking-tight">
              +{formatAdaptiveShortVND(totalTermInterest, settings.privacyMode)}
            </span>
          </div>

          {/* Metric 3: Quy Mô Thu Hồi (Gốc + Lãi) */}
          <div className="bg-white/5 rounded-xl p-2.5 border border-white/10 flex flex-col justify-center">
            <span className="text-[11px] text-sky-200 font-medium flex items-center justify-between">
              <span>Thu Hồi (Gốc+Lãi)</span>
              <ArrowRight className="w-3 h-3 text-sky-300/80" />
            </span>
            <span className="text-sm sm:text-base font-black text-sky-300 block mt-1 tracking-tight">
              {formatAdaptiveShortVND(totalCashflowVND, settings.privacyMode)}
            </span>
          </div>

          {/* Metric 4: Lãi Bình Quân / Tháng */}
          <div className="bg-white/5 rounded-xl p-2.5 border border-white/10 flex flex-col justify-center">
            <span className="text-[11px] text-teal-200 font-medium flex items-center justify-between">
              <span>Lãi BQ / Tháng</span>
              <Clock className="w-3 h-3 text-teal-300/80" />
            </span>
            <span className="text-sm sm:text-base font-black text-teal-300 block mt-1 tracking-tight">
              {formatAdaptiveShortVND(monthlyAvgInterestVND, settings.privacyMode)}
            </span>
          </div>

          {/* Metric 5: Lãi Suất Bình Quân Gia Quyền */}
          <div className="bg-white/5 rounded-xl p-2.5 border border-white/10 flex flex-col justify-center col-span-2 sm:col-span-1">
            <span className="text-[11px] text-yellow-200 font-medium flex items-center justify-between">
              <span>Lãi Suất BQ</span>
              <Percent className="w-3 h-3 text-yellow-300/80" />
            </span>
            <span className="text-sm sm:text-base font-black text-yellow-300 block mt-1 tracking-tight">
              {formatPercent(weightedAvgRate)}/năm
            </span>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 2. KHỐI DÒNG TIỀN THEO NĂM & TIẾN ĐỘ ĐÁO HẠN HÀNG THÁNG                   */}
      {/* ========================================================================= */}
      <div className="space-y-4">
        {/* Table: Tổng hợp dòng tiền theo năm */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-2xs overflow-hidden">
          <div className="px-3.5 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 flex items-center">
              <Calendar className="w-3.5 h-3.5 mr-1.5 text-indigo-600" />
              Tổng Hợp Dòng Tiền Thu Hồi Theo Năm Đáo Hạn
            </span>
            <span className="text-[10px] text-slate-500 font-medium">Đơn vị: Triệu VNĐ</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-100/70 text-slate-600 font-semibold text-[11px]">
                  <th className="py-2 px-3">Năm</th>
                  <th className="py-2 px-2 text-center">Số sổ</th>
                  <th className="py-2 px-2 text-right">Gốc thu hồi</th>
                  <th className="py-2 px-2 text-right">Lãi thực nhận</th>
                  <th className="py-2 px-2 text-right">Tổng dòng tiền</th>
                  <th className="py-2 px-3 text-right">Lãi suất BQ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {yearStats.map((item) => (
                  <tr key={item.year} className="hover:bg-indigo-50/30 transition-colors">
                    <td className="py-2.5 px-3 font-bold text-slate-900">
                      {item.year}
                    </td>
                    <td className="py-2.5 px-2 text-center text-slate-500">
                      {item.bookCount} sổ
                    </td>
                    <td className="py-2.5 px-2 text-right font-medium text-slate-800">
                      {formatShortNumber(item.principalMillion)} Tr
                    </td>
                    <td className="py-2.5 px-2 text-right font-bold text-emerald-600">
                      {formatShortNumber(item.interestMillion)} Tr
                    </td>
                    <td className="py-2.5 px-2 text-right font-bold text-indigo-600">
                      {formatShortNumber(item.totalCashflowMillion)} Tr
                    </td>
                    <td className="py-2.5 px-3 text-right font-semibold text-slate-800">
                      {formatPercent(item.avgRate)}
                    </td>
                  </tr>
                ))}
                {/* Total summary row */}
                <tr className="bg-slate-100/90 font-black text-slate-900 border-t border-slate-300">
                  <td className="py-2.5 px-3">Tổng Danh Mục</td>
                  <td className="py-2.5 px-2 text-center text-slate-600">{books.length} sổ</td>
                  <td className="py-2.5 px-2 text-right text-slate-900">
                    {formatShortNumber(Math.round(totalPrincipal / 1_000_000))} Tr
                  </td>
                  <td className="py-2.5 px-2 text-right text-emerald-700">
                    {formatShortNumber(Math.round(totalTermInterest / 1_000_000))} Tr
                  </td>
                  <td className="py-2.5 px-2 text-right text-indigo-700">
                    {formatShortNumber(Math.round(totalCashflowVND / 1_000_000))} Tr
                  </td>
                  <td className="py-2.5 px-3 text-right text-slate-900">
                    {formatPercent(weightedAvgRate)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Chart: Annual Cashflow (Gốc & Lãi theo năm) */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 flex items-center">
              <BarChart3 className="w-3.5 h-3.5 mr-1.5 text-indigo-600" />
              Biểu Đồ Quy Mô Dòng Tiền (Gốc &amp; Lãi) Theo Năm Đáo Hạn
            </span>
            <span className="text-[10px] text-slate-400">Đơn vị: Triệu VNĐ</span>
          </div>
          <div className="h-56 w-full pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={yearStats} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="year" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickFormatter={(v) => `${v.toLocaleString('vi-VN')} Tr`} />
                <Tooltip
                  formatter={(val: any, name: any) => [
                    `${Number(val).toLocaleString('vi-VN')} Tr`,
                    name === 'principalMillion' ? 'Tiền Gốc' : 'Tiền Lãi',
                  ]}
                  contentStyle={{ backgroundColor: '#0f172a', color: '#fff', borderRadius: '10px', fontSize: '11px' }}
                />
                <Legend formatter={(val) => (val === 'principalMillion' ? 'Tiền Gốc' : 'Tiền Lãi')} />
                <Bar dataKey="principalMillion" name="principalMillion" stackId="a" fill="#3b82f6" radius={[0, 0, 0, 0]} />
                <Bar dataKey="interestMillion" name="interestMillion" stackId="a" fill="#10b981" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart: Monthly Cashflow Timeline */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 flex items-center">
              <Calendar className="w-3.5 h-3.5 mr-1.5 text-teal-600" />
              Lịch Dòng Tiền Đáo Hạn Từng Tháng (12 – 24 Tháng Tới)
            </span>
            <span className="text-[10px] text-slate-400">Đơn vị: Triệu VNĐ</span>
          </div>

          <div className="h-60 w-full pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyCashflowData} margin={{ top: 10, right: 10, left: -10, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="monthLabel" tick={{ fontSize: 10, fill: '#475569' }} interval={0} angle={-30} textAnchor="end" height={40} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} tickFormatter={(v) => `${v.toLocaleString('vi-VN')} Tr`} />
                <Tooltip
                  formatter={(val: any, name: any) => [
                    `${Number(val).toLocaleString('vi-VN')} Tr`,
                    name === 'principalMillion' ? 'Tiền Gốc' : 'Tiền Lãi',
                  ]}
                  contentStyle={{ backgroundColor: '#0f172a', color: '#fff', borderRadius: '10px', fontSize: '11px' }}
                />
                <Bar dataKey="principalMillion" name="principalMillion" stackId="a" fill="#0d9488" />
                <Bar dataKey="interestMillion" name="interestMillion" stackId="a" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Peak Month & Highlights */}
          {peakCashflowMonth && (
            <div className="p-2.5 bg-teal-50/90 rounded-xl border border-teal-200/80 text-xs flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-teal-600 shrink-0" />
                <div>
                  <span className="font-bold text-teal-950">
                    Tháng dòng tiền về lớn nhất: {peakCashflowMonth.monthLabel}
                  </span>
                  <span className="text-[11px] text-teal-800 block">
                    Gốc: {peakCashflowMonth.principalMillion.toLocaleString('vi-VN')} Tr &bull; Lãi: {peakCashflowMonth.interestMillion.toLocaleString('vi-VN')} Tr
                  </span>
                </div>
              </div>
              <span className="text-xs sm:text-sm font-black text-teal-900 shrink-0">
                {peakCashflowMonth.totalMillion.toLocaleString('vi-VN')} Tr
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 3. KHỐI CƠ CẤU PHÂN BỔ DANH MỤC VỐN (TÍCH HỢP TỪ QUICK CHART)             */}
      {/* ========================================================================= */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-2xs space-y-4">
        {/* Header & Tabs Switcher */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-3">
          <div>
            <div className="flex items-center space-x-2">
              <PieIcon className="w-4 h-4 text-indigo-600" />
              <h3 className="font-bold text-slate-900 text-sm sm:text-base">
                Cơ Cấu Phân Bổ Danh Mục &amp; Dòng Vốn
              </h3>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Tỷ trọng vốn, số sổ và lãi suất bình quân theo từng phân loại
            </p>
          </div>

          {/* Switcher 4 Tabs */}
          <div className="flex items-center bg-slate-100 p-1 rounded-xl gap-1 overflow-x-auto scrollbar-none">
            <button
              type="button"
              onClick={() => setAllocationGroupBy('bank')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer shrink-0 ${
                allocationGroupBy === 'bank'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Building2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Ngân Hàng</span>
            </button>

            <button
              type="button"
              onClick={() => setAllocationGroupBy('owner')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer shrink-0 ${
                allocationGroupBy === 'owner'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5 text-blue-600" />
              <span>Chủ Sổ</span>
            </button>

            <button
              type="button"
              onClick={() => setAllocationGroupBy('depositType')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer shrink-0 ${
                allocationGroupBy === 'depositType'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5 text-purple-600" />
              <span>Hình Thức</span>
            </button>

            <button
              type="button"
              onClick={() => setAllocationGroupBy('term')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer shrink-0 ${
                allocationGroupBy === 'term'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Layers className="w-3.5 h-3.5 text-amber-600" />
              <span>Kỳ Hạn</span>
            </button>

            <button
              type="button"
              onClick={() => setAllocationGroupBy('rate')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer shrink-0 ${
                allocationGroupBy === 'rate'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Percent className="w-3.5 h-3.5 text-rose-600" />
              <span>Lãi Suất</span>
            </button>
          </div>
        </div>

        {/* Multi-segmented Color Distribution Bar */}
        <div className="space-y-1.5 bg-slate-50 p-3 rounded-2xl border border-slate-200/80">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-slate-700 flex items-center space-x-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5 text-indigo-600" />
              <span>
                Thanh Tỷ Trọng Danh Mục (
                {allocationGroupBy === 'bank'
                  ? 'Giữa các ngân hàng'
                  : allocationGroupBy === 'owner'
                  ? 'Giữa các chủ sổ'
                  : allocationGroupBy === 'depositType'
                  ? 'Online vs Tại quầy'
                  : allocationGroupBy === 'term'
                  ? 'Giữa các kỳ hạn'
                  : 'Giữa các dải lãi suất'}
                )
              </span>
            </span>
            <span className="text-[11px] text-slate-500 font-bold">100% Tiền Gửi</span>
          </div>

          <div className="h-4.5 w-full bg-slate-200 rounded-full overflow-hidden flex shadow-inner border border-slate-300">
            {allocationStats.list.map((item) => (
              <div
                key={item.id}
                style={{
                  width: `${Math.max(item.percent, 1.5)}%`,
                  backgroundColor: item.color,
                }}
                className="h-full border-r-2 border-white first:rounded-l-full last:rounded-r-full last:border-r-0 transition-all"
                title={`${item.shortName}: ${formatPercent(item.percent, 1)} (${item.principalMillion.toLocaleString('vi-VN')} Tr)`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between text-[10px] text-slate-500 pt-0.5">
            <span>
              Top cao nhất:{' '}
              <strong className="text-slate-800 font-bold">
                {allocationStats.topItem?.shortName} ({formatPercent(allocationStats.topItem?.percent, 1)})
              </strong>
            </span>
            <span>
              Tổng nhóm: <strong className="text-slate-800 font-bold">{allocationStats.list.length} nhóm</strong>
            </span>
          </div>
        </div>

        {/* Grid Charts & Detailed Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center">
          {/* Pie / Donut Chart with Center KPI Badge */}
          <div className="lg:col-span-5 relative h-56 w-full flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={allocationStats.list}
                  dataKey="principalMillion"
                  nameKey="shortName"
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={76}
                  paddingAngle={3}
                  label={false}
                >
                  {allocationStats.list.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} stroke="#ffffff" strokeWidth={2} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(val: any) => [`${Number(val).toLocaleString('vi-VN')} Tr`, 'Tiền gửi']}
                  contentStyle={{ backgroundColor: '#0f172a', color: '#fff', borderRadius: '10px', fontSize: '11px', border: 'none' }}
                />
              </PieChart>
            </ResponsiveContainer>

            {/* Centered Donut Summary Label */}
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-4">
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-tight">
                {allocationStats.topItem?.shortName || 'Tỷ trọng'}
              </span>
              <span className="text-base font-black text-slate-900 leading-tight">
                {allocationStats.topItem ? `${formatPercent(allocationStats.topItem.percent, 1)}` : '100%'}
              </span>
              <span className="text-[10px] font-bold text-indigo-600">
                {formatMoney(allocationStats.totActivePrincipal)}
              </span>
            </div>
          </div>

          {/* Breakdown Cards Grid */}
          <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {allocationStats.list.map((item) => (
              <div
                key={item.id}
                className="p-3 bg-white rounded-xl border border-slate-200 hover:border-indigo-300 transition-all shadow-2xs flex flex-col justify-between relative overflow-hidden group"
              >
                {/* Left Colored Accent Bar */}
                <div
                  className="absolute left-0 top-0 bottom-0 w-1 rounded-l"
                  style={{ backgroundColor: item.color }}
                />

                <div className="flex items-center justify-between pl-1">
                  <div className="flex items-center space-x-2 min-w-0">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0 shadow-2xs"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="font-bold text-slate-900 text-xs truncate">
                      {item.name}
                    </span>
                  </div>
                  <span
                    className="text-[10px] font-black px-2 py-0.5 rounded-md text-white shrink-0 shadow-2xs"
                    style={{ backgroundColor: item.color }}
                  >
                    {formatPercent(item.percent, 1)}
                  </span>
                </div>

                <div className="flex items-center justify-between text-xs pt-1.5 border-t border-slate-100 pl-1 mt-1">
                  <div>
                    <span className="text-[10px] text-slate-400 block uppercase font-medium">Gốc</span>
                    <span className="font-black text-slate-900 text-xs">
                      {formatShortNumber(item.principalMillion)} Tr
                    </span>
                  </div>
                  <div className="text-center">
                    <span className="text-[10px] text-slate-400 block uppercase font-medium">Lãi suất BQ</span>
                    <span className="font-bold text-emerald-700 text-xs">
                      {formatPercent(item.avgRate)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[10px] text-slate-400 block uppercase font-medium">Số lượng</span>
                    <span className="font-bold text-slate-700 text-xs">
                      {item.bookCount} sổ
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 4. KHỐI LỊCH SỬ LÃI & TĂNG TRƯỞNG QUY MÔ VỐN (2019 - 2026)                  */}
      {/* ========================================================================= */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Chart: Annual Interest History */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 flex items-center">
              <Coins className="w-3.5 h-3.5 mr-1.5 text-amber-600" />
              Lãi Thực Nhận Hàng Năm (2022 - 2026)
            </span>
            <span className="text-[10px] text-slate-400">Đơn vị: Triệu VNĐ</span>
          </div>
          <div className="h-48 w-full pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dynamicAnnualInterest} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toLocaleString('vi-VN')} Tr`} />
                <Tooltip
                  formatter={(val: any) => [settings.privacyMode ? '••••••' : `${Number(val).toLocaleString('vi-VN')} Tr`, 'Tiền Lãi']}
                  contentStyle={{ backgroundColor: '#0f172a', color: '#fff', borderRadius: '10px', fontSize: '11px' }}
                />
                <Bar dataKey="interestEarnedMillion" fill="#f59e0b" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart: Balance Growth History */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-slate-800 flex items-center">
              <TrendingUp className="w-3.5 h-3.5 mr-1.5 text-indigo-600" />
              Số Dư Tiền Gửi Cuối Năm (2019 - 2026)
            </span>
            <span className="text-[10px] text-slate-400">Đơn vị: Triệu VNĐ</span>
          </div>
          <div className="h-48 w-full pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dynamicBalanceGrowth} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="balanceGradUnified" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.7} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="year" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => (settings.privacyMode ? '••' : `${v.toLocaleString('vi-VN')} Tr`)} />
                <Tooltip
                  formatter={(val: any) => [settings.privacyMode ? '••••••' : `${Number(val).toLocaleString('vi-VN')} Tr`, 'Số Dư']}
                  contentStyle={{ backgroundColor: '#0f172a', color: '#fff', borderRadius: '10px', fontSize: '11px' }}
                />
                <Area type="monotone" dataKey="balanceMillion" stroke="#4f46e5" strokeWidth={2} fillOpacity={1} fill="url(#balanceGradUnified)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 5. KHỐI CHIẾN LƯỢC TÁI TỤC & CÔNG CỤ TỐI ƯU HÓA QUYẾT ĐỊNH               */}
      {/* ========================================================================= */}
      <div className="space-y-4">
        {/* 3 Core Rules */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
          <div className="bg-emerald-50/80 p-3 rounded-2xl border border-emerald-200/90 flex items-start space-x-2.5">
            <span className="w-6 h-6 rounded-full bg-emerald-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
              1
            </span>
            <div className="text-xs">
              <span className="font-bold text-emerald-950 block">Thang Kỳ Hạn Gối Đầu</span>
              <p className="text-emerald-800 text-[11px] leading-relaxed mt-0.5">
                Chia nhỏ thành các sổ đáo hạn rải đều mỗi quý để vừa có thanh khoản linh hoạt vừa hưởng lãi suất cao.
              </p>
            </div>
          </div>

          <div className="bg-amber-50/80 p-3 rounded-2xl border border-amber-200/90 flex items-start space-x-2.5">
            <span className="w-6 h-6 rounded-full bg-amber-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
              2
            </span>
            <div className="text-xs">
              <span className="font-bold text-amber-950 block">Gom Sổ Hưởng Lãi VIP</span>
              <p className="text-amber-800 text-[11px] leading-relaxed mt-0.5">
                Khi các sổ nhỏ đáo hạn cùng tháng, gom lại thành gói ≥ 1.000 Tr để đàm phán cộng thêm biên độ +0.3% – 0.5%/năm.
              </p>
            </div>
          </div>

          <div className="bg-indigo-50/80 p-3 rounded-2xl border border-indigo-200/90 flex items-start space-x-2.5">
            <span className="w-6 h-6 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
              3
            </span>
            <div className="text-xs">
              <span className="font-bold text-indigo-950 block">Tận Dụng Lãi Kép</span>
              <p className="text-indigo-800 text-[11px] leading-relaxed mt-0.5">
                Nhập toàn bộ tiền lãi vào gốc khi tái tục giúp tài sản tự động sinh lời theo cấp số nhân qua từng chu kỳ.
              </p>
            </div>
          </div>
        </div>

        {/* Interactive Compounding Simulator */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <span className="text-xs font-bold text-slate-800 flex items-center">
                <Sparkles className="w-3.5 h-3.5 mr-1.5 text-amber-500" />
                Mô Phỏng Thu Nhập Lãi Khi Tái Tục Toàn Bộ Danh Mục ({formatMoney(totalPrincipal)})
              </span>
              <p className="text-[11px] text-slate-500">Chọn mức lãi suất kỳ vọng để tính nhanh dòng tiền:</p>
            </div>

            {/* Rate selector buttons */}
            <div className="flex items-center space-x-1 overflow-x-auto no-scrollbar">
              {[6.0, 6.8, 7.5, 8.2, 9.0].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  onClick={() => setSelectedSimRate(rate)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                    selectedSimRate === rate
                      ? 'bg-amber-500 text-slate-950 shadow-xs'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {rate}%
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-xs">
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 block">Thu nhập năm:</span>
              <span className="font-bold text-emerald-700 text-sm block mt-0.5">
                {formatMoney(Math.round(totalPrincipal * (selectedSimRate / 100)))}
              </span>
            </div>
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 block">Thu nhập bình quân:</span>
              <span className="font-bold text-indigo-700 text-sm block mt-0.5">
                {formatMoney(Math.round((totalPrincipal * (selectedSimRate / 100)) / 12))}
              </span>
            </div>
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 block">Lãi kép sau 3 Năm:</span>
              <span className="font-bold text-amber-700 text-sm block mt-0.5">
                {formatMoney(Math.round(totalPrincipal * (Math.pow(1 + selectedSimRate / 100, 3) - 1)))}
              </span>
            </div>
            <div className="p-2.5 bg-slate-50 rounded-xl border border-slate-200">
              <span className="text-[10px] text-slate-500 block">Lãi kép sau 5 Năm:</span>
              <span className="font-bold text-teal-700 text-sm block mt-0.5">
                {formatMoney(Math.round(totalPrincipal * (Math.pow(1 + selectedSimRate / 100, 5) - 1)))}
              </span>
            </div>
          </div>
        </div>

        {/* Loss curve: Early withdrawal vs Collateral loan */}
        <div className="bg-white rounded-2xl border border-slate-200 p-3.5 sm:p-4 shadow-2xs space-y-2.5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
            <span className="text-xs font-bold text-slate-800 flex items-center">
              <ShieldCheck className="w-3.5 h-3.5 mr-1.5 text-rose-600" />
              So Sánh Thiệt Hại: Rút Sớm vs Vay Cầm Cố Khi Cần Vốn Mua Nhà
            </span>
            <div className="flex items-center space-x-2 text-[10px]">
              <span className="text-rose-600 font-bold">&bull; Mất do Rút sớm</span>
              <span className="text-indigo-600 font-bold">&bull; Phí Vay cầm cố</span>
              <span className="text-emerald-600 font-bold">&bull; Tiền giữ lại được</span>
            </div>
          </div>

          <div className="h-56 w-full pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={lossCurveData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="targetLabel" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `${v.toLocaleString('vi-VN')} Tr`} />
                <Tooltip
                  formatter={(val: any, name: any) => [
                    `${Number(val).toLocaleString('vi-VN')} Tr`,
                    name === 'earlyWithdrawLossMillion'
                      ? 'Mất nếu rút sớm'
                      : name === 'loanCostMillion'
                      ? 'Chi phí vay cầm cố'
                      : 'Lãi giữ lại được',
                  ]}
                  contentStyle={{ backgroundColor: '#0f172a', color: '#fff', borderRadius: '10px', fontSize: '11px' }}
                />
                <Line type="monotone" dataKey="earlyWithdrawLossMillion" stroke="#ef4444" strokeWidth={2.5} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="loanCostMillion" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} />
                <Line type="monotone" dataKey="savedMillion" stroke="#10b981" strokeWidth={2.5} strokeDasharray="4 4" dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-emerald-50 p-2.5 rounded-xl border border-emerald-200 text-[11px] text-emerald-950 flex items-center justify-between">
            <span>
              <strong>Khuyến nghị:</strong> Vay cầm cố ngắn hạn giúp bảo toàn trọn vẹn số tiền lãi đã tích lũy thay vì rút sớm chịu phạt lãi không kỳ hạn (0.2%).
            </span>
            {onOpenOptimizer && (
              <button
                type="button"
                onClick={onOpenOptimizer}
                className="ml-2 px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg shrink-0 cursor-pointer"
              >
                Tối Ưu Huy Động Vốn
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
