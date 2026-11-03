import { AnnualInterestRecord, BalanceGrowthRecord, SavingsBook, SettlementAdjustment } from '../types';
import { deduplicateSettlementAdjustments } from '../utils/dataTranslator';

// Dữ liệu lịch sử mặc định (trống khi khởi tạo)
export const DEFAULT_HISTORICAL_ANNUALS: AnnualInterestRecord[] = [];
export const DEFAULT_HISTORICAL_BALANCES: BalanceGrowthRecord[] = [];

export const ANNUAL_INTEREST_HISTORY: AnnualInterestRecord[] = [];
export const BALANCE_GROWTH_HISTORY: BalanceGrowthRecord[] = [];

export function isUsingSampleData(_books?: SavingsBook[]): boolean {
  return false;
}

// In-memory cache for ultra-fast, zero-lag synchronous rendering
let inMemoryStaticAnnuals: AnnualInterestRecord[] | null = null;
let inMemoryStaticBalances: BalanceGrowthRecord[] | null = null;

/**
 * Lưu dữ liệu lịch sử tĩnh (data tĩnh - các năm trước năm hiện tại) vào in-memory cache & localStorage
 */
export function saveStaticHistoryToStorage(
  annuals: AnnualInterestRecord[] = [],
  balances: BalanceGrowthRecord[] = []
): void {
  try {
    const currentYear = new Date().getFullYear();
    const staticAnnuals = annuals.filter(a => a.year <= currentYear);
    const staticBalances = balances.filter(b => b.year < currentYear);

    const existing = loadStaticHistoryFromStorage();
    const annualsMap = new Map<number, AnnualInterestRecord>();
    existing.staticAnnuals.forEach(a => annualsMap.set(a.year, a));
    staticAnnuals.forEach(a => {
      if (a.interestEarnedMillion > 0 || !annualsMap.has(a.year)) {
        annualsMap.set(a.year, a);
      }
    });

    const balancesMap = new Map<number, BalanceGrowthRecord>();
    existing.staticBalances.forEach(b => balancesMap.set(b.year, b));
    staticBalances.forEach(b => {
      if (b.balanceMillion > 0 || !balancesMap.has(b.year)) {
        balancesMap.set(b.year, b);
      }
    });

    const finalAnnuals = Array.from(annualsMap.values()).sort((a, b) => a.year - b.year);
    const finalBalances = Array.from(balancesMap.values()).sort((a, b) => a.year - b.year);

    inMemoryStaticAnnuals = finalAnnuals;
    inMemoryStaticBalances = finalBalances;

    if (typeof localStorage !== 'undefined') {
      if (finalAnnuals.length > 0) {
        localStorage.setItem('savings_static_annual_history_v1', JSON.stringify(finalAnnuals));
      }
      if (finalBalances.length > 0) {
        localStorage.setItem('savings_static_balance_history_v1', JSON.stringify(finalBalances));
      }
    }
  } catch (err) {
    console.warn('Lỗi khi lưu dữ liệu tĩnh vào storage:', err);
  }
}

/**
 * Xóa sạch toàn bộ dữ liệu lịch sử tĩnh trong cả in-memory cache & localStorage
 */
export function clearStaticHistoryFromStorage(): void {
  inMemoryStaticAnnuals = null;
  inMemoryStaticBalances = null;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('savings_static_annual_history_v1');
      localStorage.removeItem('savings_static_balance_history_v1');
    }
  } catch (err) {
    console.warn('Lỗi khi xóa dữ liệu tĩnh khỏi storage:', err);
  }
}

/**
 * Đọc dữ liệu lịch sử tĩnh từ in-memory cache hoặc localStorage.
 */
export function loadStaticHistoryFromStorage(): {
  staticAnnuals: AnnualInterestRecord[];
  staticBalances: BalanceGrowthRecord[];
} {
  if (inMemoryStaticAnnuals !== null && inMemoryStaticBalances !== null) {
    return {
      staticAnnuals: inMemoryStaticAnnuals,
      staticBalances: inMemoryStaticBalances,
    };
  }

  let staticAnnuals: AnnualInterestRecord[] = [];
  let staticBalances: BalanceGrowthRecord[] = [];

  try {
    if (typeof localStorage !== 'undefined') {
      const sa = localStorage.getItem('savings_static_annual_history_v1');
      if (sa) staticAnnuals = JSON.parse(sa);
      const sb = localStorage.getItem('savings_static_balance_history_v1');
      if (sb) staticBalances = JSON.parse(sb);
    }
  } catch (err) {
    console.warn('Lỗi khi đọc dữ liệu tĩnh từ localStorage:', err);
  }

  inMemoryStaticAnnuals = staticAnnuals;
  inMemoryStaticBalances = staticBalances;

  return { staticAnnuals, staticBalances };
}

function getOriginalMaturityYear(s: SettlementAdjustment, fallbackYear: number): number {
  if (s.originalMaturityYear) {
    const yr = parseInt(String(s.originalMaturityYear), 10);
    if (!isNaN(yr)) return yr;
  }
  if (s.settlementDate) {
    const year = parseInt(s.settlementDate.slice(0, 4), 10);
    if (!isNaN(year)) return year;
  }
  return s.settlementYear || fallbackYear;
}

/**
 * Tính toán & Kết hợp Bảng LÃI HÀNG NĂM:
 * - Các năm cũ < Năm hiện tại (ví dụ < 2026): 100% Data Tĩnh từ file/chốt sổ.
 * - Sổ đáo hạn năm nào mà tất toán trước hạn thì trừ lãi (phần lãi bị mất) vào năm đó, bất kể số lãi năm đó đã chốt hay chưa.
 * - Sổ đáo hạn năm nào mà tất toán đúng hạn/quá hạn thì lãi năm đó không thay đổi.
 */
export function getDynamicAnnualInterestHistory(
  books: SavingsBook[] = [],
  settlements: SettlementAdjustment[] = [],
  customStaticAnnuals?: AnnualInterestRecord[]
): AnnualInterestRecord[] {
  const currentYear = new Date().getFullYear(); // e.g. 2026
  const nextYear = currentYear + 1; // e.g. 2027
  const safeSettlements = deduplicateSettlementAdjustments(settlements || []);

  // 1. Lấy dữ liệu tĩnh lịch sử từ file hoặc storage
  let rawStaticAnnuals: AnnualInterestRecord[] = [];
  if (customStaticAnnuals && customStaticAnnuals.length > 0) {
    rawStaticAnnuals = customStaticAnnuals;
  } else {
    const stored = loadStaticHistoryFromStorage();
    rawStaticAnnuals = stored.staticAnnuals;
  }

  // Các năm nhỏ hơn currentYear: 100% data tĩnh
  const pastStaticAnnuals = rawStaticAnnuals.filter(a => a.year < currentYear);

  // Chúng ta sẽ tính toán động cho năm hiện tại và các năm tương lai
  const yearsToCompute = new Set<number>();
  yearsToCompute.add(currentYear);
  yearsToCompute.add(nextYear);

  // Thêm các năm từ danh sách sổ active
  const activeBooks = (books || []).filter(b => b.status !== 'settled');
  activeBooks.forEach(b => {
    if (b.maturityDate) {
      const yr = parseInt(b.maturityDate.slice(0, 4), 10);
      if (!isNaN(yr) && yr >= currentYear) {
        yearsToCompute.add(yr);
      }
    }
  });

  // Thêm các năm từ danh sách lịch sử tất toán (năm đáo hạn gốc & năm tất toán thực tế)
  safeSettlements.forEach(s => {
    const originalMaturityYear = getOriginalMaturityYear(s, currentYear);
    if (originalMaturityYear >= currentYear) {
      yearsToCompute.add(originalMaturityYear);
    }
    if (s.settlementYear && s.settlementYear >= currentYear) {
      yearsToCompute.add(s.settlementYear);
    }
  });

  // Thêm các năm có sẵn trong rawStaticAnnuals mà >= currentYear
  rawStaticAnnuals.forEach(a => {
    if (a.year >= currentYear) {
      yearsToCompute.add(a.year);
    }
  });

  // Nếu không có dữ liệu tĩnh và không có sổ/tất toán nào -> Trả về rỗng (0 dữ liệu sample)
  if (rawStaticAnnuals.length === 0 && (books || []).length === 0 && safeSettlements.length === 0) {
    return [];
  }

  const dynamicRecords: AnnualInterestRecord[] = [];

  yearsToCompute.forEach(yr => {
    // Tìm xem năm này có bản chốt tĩnh từ file/Sheets không
    const staticRec = rawStaticAnnuals.find(a => a.year === yr);

    let interestVND = 0;

    if (staticRec) {
      let netAdjustmentVND = 0;

      safeSettlements.forEach(s => {
        const originalMaturityYear = getOriginalMaturityYear(s, currentYear);

        if (s.settlementYear === yr) {
          if (originalMaturityYear === yr) {
            if (s.settlementType === 'early') {
              const expected = s.expectedTermInterest || 0;
              const actual = s.actualInterestVND || 0;
              const lost = expected - actual;
              if (lost > 0) {
                netAdjustmentVND -= lost;
              }
            }
          } else {
            netAdjustmentVND += (s.actualInterestVND || 0);
          }
        } else {
          if (originalMaturityYear === yr) {
            const expected = s.expectedTermInterest || 0;
            netAdjustmentVND -= expected;
          }
        }
      });

      activeBooks.forEach(b => {
        const maturityYear = b.maturityDate ? parseInt(b.maturityDate.slice(0, 4), 10) : currentYear;
        if (maturityYear === yr) {
          const startYear = b.startDate ? parseInt(b.startDate.slice(0, 4), 10) : 0;
          if (startYear === yr) {
            const startMs = new Date(b.startDate).getTime();
            const matMs = new Date(b.maturityDate).getTime();
            const daysTotal = Math.max(1, Math.round((matMs - startMs) / (1000 * 3600 * 24)));
            const termInt = b.expectedTermInterest ?? Math.round((b.principal * (b.interestRate / 100) * daysTotal) / 365);
            netAdjustmentVND += termInt;
          }
        }
      });

      interestVND = Math.max(0, staticRec.interestEarnedVND + netAdjustmentVND);
    } else {
      let dynamicSumVND = 0;

      activeBooks.forEach(b => {
        const maturityYear = b.maturityDate ? parseInt(b.maturityDate.slice(0, 4), 10) : currentYear;
        if (maturityYear === yr) {
          const startMs = new Date(b.startDate).getTime();
          const matMs = new Date(b.maturityDate).getTime();
          const daysTotal = Math.max(1, Math.round((matMs - startMs) / (1000 * 3600 * 24)));
          const termInt = b.expectedTermInterest ?? Math.round((b.principal * (b.interestRate / 100) * daysTotal) / 365);
          dynamicSumVND += termInt;
        }
      });

      (settlements || []).forEach(s => {
        if (s.settlementYear === yr) {
          dynamicSumVND += (s.actualInterestVND || 0);
        }
      });

      interestVND = dynamicSumVND;
    }

    if (interestVND > 0 || staticRec) {
      dynamicRecords.push({
        year: yr,
        interestEarnedMillion: Math.round(interestVND / 1_000_000),
        interestEarnedVND: interestVND,
      });
    }
  });

  const allRecords = [
    ...pastStaticAnnuals,
    ...dynamicRecords,
  ];

  const uniqueMap = new Map<number, AnnualInterestRecord>();
  allRecords.forEach(r => uniqueMap.set(r.year, r));
  return Array.from(uniqueMap.values()).sort((a, b) => a.year - b.year);
}

/**
 * Tính toán & Kết hợp Bảng THU NHẬP NĂM:
 */
export function getDynamicBalanceGrowthHistory(
  books: SavingsBook[] = [],
  _settlements: SettlementAdjustment[] = [],
  customStaticBalances?: BalanceGrowthRecord[]
): BalanceGrowthRecord[] {
  const currentYear = new Date().getFullYear();

  let staticBalances: BalanceGrowthRecord[] = [];
  if (customStaticBalances && customStaticBalances.length > 0) {
    staticBalances = customStaticBalances.filter(b => b.year < currentYear);
  } else {
    const stored = loadStaticHistoryFromStorage();
    staticBalances = stored.staticBalances.filter(b => b.year < currentYear);
  }

  staticBalances.sort((a, b) => a.year - b.year);

  const activeBooks = (books || []).filter(b => b.status !== 'settled');

  // Nếu không có dữ liệu tĩnh và không có sổ active -> Trả về rỗng (0 dữ liệu sample)
  if (staticBalances.length === 0 && activeBooks.length === 0) {
    return [];
  }

  const currentYearBalanceVND = activeBooks.reduce((sum, b) => sum + b.principal, 0);
  const currentYearBalanceMil = Math.round(currentYearBalanceVND / 1_000_000);

  let lastStaticBalanceMil: number | undefined = undefined;
  if (staticBalances.length > 0) {
    lastStaticBalanceMil = staticBalances[staticBalances.length - 1].balanceMillion;
  }

  let currentYearIncomeMil: number | undefined = undefined;
  let currentYearIncomeVND: number | undefined = undefined;

  if (lastStaticBalanceMil !== undefined) {
    currentYearIncomeMil = currentYearBalanceMil - lastStaticBalanceMil;
    currentYearIncomeVND = currentYearIncomeMil * 1_000_000;
  }

  const dynamicCurrentYearRecord: BalanceGrowthRecord = {
    year: currentYear,
    balanceMillion: currentYearBalanceMil,
    balanceVND: currentYearBalanceVND,
    annualIncomeMillion: currentYearIncomeMil,
    annualIncomeVND: currentYearIncomeVND,
  };

  const allRecords = [
    ...staticBalances,
    dynamicCurrentYearRecord,
  ];

  const uniqueMap = new Map<number, BalanceGrowthRecord>();
  allRecords.forEach(r => uniqueMap.set(r.year, r));

  const sorted = Array.from(uniqueMap.values()).sort((a, b) => a.year - b.year);

  let prevBal: number | undefined = undefined;
  return sorted.map(r => {
    let incMil = r.annualIncomeMillion;
    let incVnd = r.annualIncomeVND;

    if (prevBal !== undefined && (incMil === undefined || incMil === null)) {
      incMil = r.balanceMillion - prevBal;
      incVnd = incMil * 1_000_000;
    }

    prevBal = r.balanceMillion;

    return {
      ...r,
      annualIncomeMillion: incMil,
      annualIncomeVND: incVnd,
    };
  });
}



