/**
 * Multi-layer Data Translation Engine for Savings Portfolio
 * 
 * Pipeline:
 * [Dữ liệu gốc (Google Sheet / Excel / CSV)] 
 *                 ↕ (Inbound/Outbound Serializer)
 * [Dữ liệu trung gian (SavingsSheetDTO / RawDataRecord)]
 *                 ↕ (Schema Validator & Type Converter)
 * [Dữ liệu trên App (SavingsBook[] / HistoricalGrowth)]
 */

import { SavingsBook, AnnualInterestRecord, BalanceGrowthRecord, SettlementAdjustment, OwnerType, BookStatus } from '../types';
import { getDaysBetween, getAdjustedMaturityDate } from './calculator';
import { getOwnerLabel, getCustomOwnerNames } from './formatters';
import { isUsingSampleData, loadStaticHistoryFromStorage } from '../data/historicalGrowth';
import { getVietnamDateISO } from './date';

export interface RawSheetRow {
  bank: string;
  interestRateRaw: any;
  principalRaw: any;
  startDateRaw: any;
  maturityDateRaw: any;
  termMonthsRaw: any;
  benchmarkColRaw?: any;
  termInterestRaw?: any;
  annualInterestRaw?: any;
  maturityMonthYearRaw?: any;
}

export interface SheetTranslationResult {
  success: boolean;
  books: SavingsBook[];
  annualInterestRecords?: AnnualInterestRecord[];
  balanceGrowthRecords?: BalanceGrowthRecord[];
  totalPrincipalVND: number;
  totalTermInterestVND: number;
  totalAnnualInterestVND: number;
  averageInterestRate: number;
  errors: string[];
  warnings: string[];
}

const normalizeBusinessIdPart = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');

/**
 * Readable identity for matching the same savings book across local and Drive data.
 * Keep the principal in millions (e.g. 500 instead of 500000000).
 */
export function buildSavingsBookBusinessId(book: Pick<
  SavingsBook,
  'bankId' | 'principal' | 'startDate' | 'termMonths' | 'owner' | 'depositType'
>): string {
  const bank = normalizeBusinessIdPart(getBankTagForBook(book.bankId));
  const principalMillion = Number((book.principal / 1_000_000).toFixed(3)).toString();
  const startDate = normalizeDateToISO(book.startDate).replace(/-/g, '');
  const owner = normalizeBusinessIdPart(book.owner);
  const depositType = book.depositType === 'online' ? 'ONLINE' : 'COUNTER';

  return `book_${bank}_${principalMillion}m_${startDate}_${book.termMonths}m_${owner}_${depositType}`;
}

export function buildSettlementBusinessId(
  settlement: Pick<
    SettlementAdjustment,
    'bookCode' | 'bankId' | 'owner' | 'principal' | 'settlementDate' | 'settlementType'
  >
): string {
  const bank = normalizeBusinessIdPart(getBankTagForBook(settlement.bankId));
  const principalMillion = Number((settlement.principal / 1_000_000).toFixed(3)).toString();
  const date = normalizeDateToISO(settlement.settlementDate).replace(/-/g, '');
  const bookCode = normalizeBusinessIdPart(settlement.bookCode || '');
  const owner = normalizeBusinessIdPart(settlement.owner);
  const type = settlement.settlementType === 'early' ? 'EARLY' : 'MATURITY';

  return `settle_${bank}_${principalMillion}m_${date}_${bookCode}_${owner}_${type}`;
}

export function normalizeOwner(rawOwner: any, bankRawOrId?: string, bookCode?: string): OwnerType {
  const { husbandName, wifeName } = getCustomOwnerNames();
  if (rawOwner === undefined || rawOwner === null || rawOwner === '') {
    // Determine from bank or code
    const combined = `${bankRawOrId || ''} ${bookCode || ''}`.toLowerCase();
    if (/(?:2|\s2|_2|-2|\.2)$/.test(bankRawOrId || '') || combined.includes(' 2') || combined.includes('_2') || combined.includes('-2') || combined.includes('tk2') || combined.includes('vợ') || combined.includes('wife')) {
      return wifeName;
    }
    return husbandName;
  }

  const s = String(rawOwner).trim();
  // If corrupted by percent or numeric string (e.g. '6.55%', '6.80%', '6.55', '7.40', '1100', '22/8/2025')
  if (
    s.includes('%') ||
    /^\d+([.,]\d+)?%?$/.test(s) ||
    /^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(s) ||
    s.length <= 1
  ) {
    const combined = `${bankRawOrId || ''} ${bookCode || ''}`.toLowerCase();
    if (/(?:2|\s2|_2|-2|\.2)$/.test(bankRawOrId || '') || combined.includes(' 2') || combined.includes('_2') || combined.includes('-2') || combined.includes('tk2') || combined.includes('vợ') || combined.includes('wife')) {
      return wifeName;
    }
    return husbandName;
  }

  const lower = s.toLowerCase().normalize('NFC');
  const lowerHusband = husbandName.toLowerCase().normalize('NFC');
  const lowerWife = wifeName.toLowerCase().normalize('NFC');

  if (lower === 'vợ' || lower === 'vo' || lower === 'wife' || lower === lowerWife) return wifeName;
  if (lower === 'chồng' || lower === 'chong' || lower === 'husband' || lower === lowerHusband) return husbandName;

  return s;
}

/**
 * Normalizes Bank and Owner from sheet string (e.g. 'SEA', 'SEA2', 'SHB', 'SHB2', 'VCB', 'VCB2')
 */
export function translateBankFromSheet(bankRaw: string): {
  bankId: string;
  owner: OwnerType;
  originalTag: string;
  status?: 'active' | 'settled';
  isEarlySettled?: boolean;
  settlementDate?: string;
  actualInterestVND?: number;
} {
  let clean = String(bankRaw || '').trim().toUpperCase();

  let status: 'active' | 'settled' = 'active';
  let isEarlySettled = false;
  let settlementDate: string | undefined;
  let actualInterestVND: number | undefined;

  if (clean.includes('-EARLY')) {
    status = 'settled';
    isEarlySettled = true;
    const parts = clean.split(':');
    if (parts.length >= 2) {
      settlementDate = parts[1];
    }
    if (parts.length >= 3) {
      actualInterestVND = parseInt(parts[2], 10) || 0;
    }
    // Strip everything after and including '-EARLY'
    clean = clean.split('-EARLY')[0];
  } else if (clean.includes('-SETTLED')) {
    status = 'settled';
    isEarlySettled = false;
    clean = clean.replace('-SETTLED', '');
  }

  // Detect if it is Wife's book indicated by trailing 2, ' 2', '_2', '-2', or 'TK 2'
  let isWife = false;
  if (/(?:2|\s2|_2|-2|\.2)$/.test(clean) || clean.includes(' 2') || clean.includes('_2') || clean.includes('-2') || clean.includes('TK2') || clean.includes('VỢ')) {
    isWife = true;
  }
  
  // Strip the '2' and delimiters to find the root bank abbreviation
  const root = clean.replace(/[\s_\-\.]*2\b|[\s_\-\.]*2$/g, '').replace(/\bVỢ\b|\bCHỒNG\b/g, '').trim();

  let bankId = '';
  let baseCode = '';

  if (root.includes('SHB')) {
    bankId = 'shb';
    baseCode = 'SHB';
  } else if (root.includes('SEA') || root.includes('SEABANK')) {
    bankId = 'seabank';
    baseCode = 'SEA';
  } else if (root.includes('VCB') || root.includes('VIETCOM')) {
    bankId = 'vietcombank';
    baseCode = 'VCB';
  } else if (root.includes('TCB') || root.includes('TECHCOM')) {
    bankId = 'techcombank';
    baseCode = 'TCB';
  } else if (root.includes('BIDV') || root.includes('BID')) {
    bankId = 'bidv';
    baseCode = 'BIDV';
  } else if (root.includes('VPB') || root.includes('VPBANK')) {
    bankId = 'vpbank';
    baseCode = 'VPB';
  } else if (root.includes('MB') || root.includes('MBBANK')) {
    bankId = 'mbbank';
    baseCode = 'MB';
  } else if (root.includes('ACB')) {
    bankId = 'acb';
    baseCode = 'ACB';
  } else if (root.includes('VIB')) {
    bankId = 'vib';
    baseCode = 'VIB';
  } else if (root.includes('TPB') || root.includes('TIENPHONG')) {
    bankId = 'tpbank';
    baseCode = 'TPB';
  } else if (root.includes('LPB') || root.includes('LPBANK') || root.includes('LIENVIET')) {
    bankId = 'lpbank';
    baseCode = 'LPB';
  } else if (root.includes('HDB') || root.includes('HDBANK')) {
    bankId = 'hdbank';
    baseCode = 'HDB';
  } else if (root.includes('MSB') || root.includes('MARITIME')) {
    bankId = 'msb';
    baseCode = 'MSB';
  } else if (root.includes('OCB')) {
    bankId = 'ocb';
    baseCode = 'OCB';
  } else if (root.includes('NAB') || root.includes('NAMABANK')) {
    bankId = 'namabank';
    baseCode = 'NAB';
  } else if (root.includes('NCB')) {
    bankId = 'ncb';
    baseCode = 'NCB';
  } else if (root.includes('BVB') || root.includes('BAOVIET')) {
    bankId = 'baovietbank';
    baseCode = 'BVB';
  } else if (root.includes('AGRI') || root.includes('AGRIBANK')) {
    bankId = 'agribank';
    baseCode = 'AGRI';
  } else if (root.includes('SCB')) {
    bankId = 'scb';
    baseCode = 'SCB';
  } else if (root.includes('PVB') || root.includes('PVCOMBANK')) {
    bankId = 'pvcombank';
    baseCode = 'PVB';
  } else if (root.includes('CTG') || root.includes('VIETIN')) {
    bankId = 'vietinbank';
    baseCode = 'CTG';
  } else if (root) {
    baseCode = root;
    bankId = root.toLowerCase();
  }

  if (!bankId) {
    bankId = 'seabank';
    baseCode = 'SEA';
  }

  const { husbandName, wifeName } = getCustomOwnerNames();
  const owner: OwnerType = isWife ? wifeName : husbandName;
  const originalTag = isWife ? `${baseCode}2` : baseCode;

  return {
    bankId,
    owner,
    originalTag,
    status,
    isEarlySettled,
    settlementDate,
    actualInterestVND,
  };
}

/**
 * Translates App Bank & Owner back to exact Sheet Bank Name:
 * Clean Bank Code without attaching '2' (e.g. 'SEA', 'SHB', 'VCB', 'TCB', 'BIDV')
 * Owner and DepositType are maintained in their own dedicated columns.
 * Includes status & early settlement metadata for 2-way sync integrity.
 */
export function translateBankToSheet(book: SavingsBook): string {
  const bankCodeMap: Record<string, string> = {
    seabank: 'SEA',
    shb: 'SHB',
    vietcombank: 'VCB',
    techcombank: 'TCB',
    bidv: 'BIDV',
    vpbank: 'VPB',
    mbbank: 'MB',
    acb: 'ACB',
    vib: 'VIB',
    tpbank: 'TPB',
    lpbank: 'LPB',
    hdbank: 'HDB',
    msb: 'MSB',
    ocb: 'OCB',
    namabank: 'NAB',
    ncb: 'NCB',
    baovietbank: 'BVB',
    agribank: 'AGRI',
    scb: 'SCB',
    pvcombank: 'PVB',
    vietinbank: 'CTG',
  };
  const baseCode = bankCodeMap[book.bankId.toLowerCase()] || book.bankId.toUpperCase();
  let sheetCode = baseCode;

  if (book.status === 'settled') {
    if (book.isEarlySettled) {
      sheetCode += `-EARLY:${book.settlementDate || ''}:${book.actualInterestVND || 0}`;
    } else {
      sheetCode += '-SETTLED';
    }
  }
  return sheetCode;
}

/**
 * Returns formatted clean bank tag for display (e.g. SEA, SHB, VCB)
 */
export function getBankTagForBook(bankId: string, _owner?: string, defaultCode?: string): string {
  const bankCodeMap: Record<string, string> = {
    seabank: 'SEA',
    shb: 'SHB',
    vietcombank: 'VCB',
    techcombank: 'TCB',
    bidv: 'BIDV',
    vpbank: 'VPB',
    mbbank: 'MB',
    acb: 'ACB',
    vib: 'VIB',
    tpbank: 'TPB',
    lpbank: 'LPB',
    hdbank: 'HDB',
    msb: 'MSB',
    ocb: 'OCB',
    namabank: 'NAB',
    ncb: 'NCB',
    baovietbank: 'BVB',
    agribank: 'AGRI',
    scb: 'SCB',
    pvcombank: 'PVB',
    vietinbank: 'CTG',
  };
  const baseCode = bankCodeMap[bankId.toLowerCase()] || defaultCode || bankId.toUpperCase();
  return baseCode;
}

/**
 * Normalizes percentage string or number into standard percent number (e.g. '6.55%' -> 6.55)
 */
export function translateInterestRateFromSheet(val: any): number {
  if (typeof val === 'number') {
    if (val <= 0) return 6.0;
    if (val < 0.3) return Number((val * 100).toFixed(2)); // e.g. 0.0655 -> 6.55
    if (val >= 100) return Number((val / 100).toFixed(2)); // e.g. 655 -> 6.55
    if (val > 25) return 6.0; // Corrupted year numbers -> fallback safe rate
    return Number(val.toFixed(2));
  }
  if (!val) return 6.0;
  let str = String(val).trim().replace(/[^\d.,\-]/g, '');
  if (str.includes(',') && !str.includes('.')) {
    str = str.replace(',', '.');
  }
  let num = parseFloat(str);
  if (isNaN(num) || num <= 0) return 6.0;
  if (num < 0.3) num = num * 100;
  if (num >= 100) num = num / 100;
  if (num > 25) num = 6.0;
  return Number(num.toFixed(2));
}

/**
 * Translates interest rate to sheet format using comma decimal and percent sign for Vietnamese Google Sheet locale (e.g. 8.5 -> '8,50%')
 */
export function translateInterestRateToSheet(rate: number): string {
  if (typeof rate !== 'number' || isNaN(rate)) return '0%';
  const cleanNum = Number(rate.toFixed(2));
  return `${cleanNum.toString().replace('.', ',')}%`;
}

/**
 * Parses numeric currency (Triệu VNĐ or VNĐ) into standard VNĐ integer
 */
export function translateMoneyFromSheet(val: any): number {
  if (typeof val === 'number') {
    if (isNaN(val) || val <= 0) return 0;
    // If under 500,000, it's expressed in Triệu VNĐ (e.g. 1100 -> 1,100,000,000)
    if (val < 500_000) {
      return Math.round(val * 1_000_000);
    }
    return Math.round(val);
  }
  if (!val) return 0;
  let str = String(val).trim().replace(/[^\d.,\-]/g, '');
  if (!str) return 0;
  
  if (str.includes(',') && !str.includes('.')) {
    const parts = str.split(',');
    if (parts.length === 2 && parts[1].length <= 2) {
      str = str.replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (str.includes('.') && str.includes(',')) {
    if (str.lastIndexOf(',') > str.lastIndexOf('.')) {
      str = str.replace(/\./g, '').replace(',', '.');
    } else {
      str = str.replace(/,/g, '');
    }
  } else if (str.includes('.') && !str.includes(',')) {
    const parts = str.split('.');
    // If multiple dots (e.g. "1.000.000") or single dot followed by 3 digits (e.g. "1.080" or "3.450" in VN thousands format)
    if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
      str = parts.join('');
    }
  }

  const num = parseFloat(str);
  if (isNaN(num) || num <= 0) return 0;
  if (num < 500_000) {
    return Math.round(num * 1_000_000);
  }
  return Math.round(num);
}

/**
 * Formats VNĐ integer into Triệu VNĐ for exact sheet display (e.g. 1,100,000,000 -> 1100, 78,200,000 -> 78.2)
 */
export function translateMoneyToSheet(vnd: number, allowFraction = false): number {
  const mil = vnd / 1_000_000;
  if (allowFraction) {
    return Number(mil.toFixed(2));
  }
  return Math.round(mil);
}

/**
 * Normalizes varied date string formats (D/M/YYYY, DD/MM/YYYY, Excel Serial numbers or strings, ISO) into YYYY-MM-DD
 */
export function translateDateFromSheet(val: any): string | null {
  if (!val) return null;

  // 1. Handle JavaScript Date objects (e.g. from XLSX cellDates)
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. Handle Excel / Google Sheets Serial Numbers (both numeric 45941 or string "45941")
  const numVal = typeof val === 'number' ? val : (typeof val === 'string' && /^\d{5}(\.\d+)?$/.test(val.trim()) ? parseFloat(val.trim()) : NaN);
  if (!isNaN(numVal) && numVal >= 30000 && numVal <= 70000) {
    const jsDate = new Date((numVal - 25569) * 86400 * 1000);
    if (!isNaN(jsDate.getTime())) {
      const y = jsDate.getUTCFullYear();
      const m = String(jsDate.getUTCMonth() + 1).padStart(2, '0');
      const d = String(jsDate.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  const str = String(val).trim();
  if (!str) return null;

  // 3. Match D/M/YYYY or DD/MM/YYYY or D.M.YYYY (Vietnamese Day/Month/Year)
  const dmy = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    let p1 = parseInt(dmy[1], 10);
    let p2 = parseInt(dmy[2], 10);
    const year = dmy[3];

    // Default: p1 is day, p2 is month
    let day = p1;
    let month = p2;

    // Auto-fix if p2 > 12 (meaning p2 was meant to be day, e.g. MM/DD/YYYY)
    if (p2 > 12 && p1 <= 12) {
      day = p2;
      month = p1;
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const mStr = String(month).padStart(2, '0');
      const dStr = String(day).padStart(2, '0');
      return `${year}-${mStr}-${dStr}`;
    }
  }

  // 4. Match YYYY-MM-DD
  const ymd = str.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (ymd) {
    const year = ymd[1];
    const month = ymd[2].padStart(2, '0');
    const day = ymd[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // 5. Fallback for standard date string representations (e.g., "Wed Aug 22 2025...")
  const parsedTime = Date.parse(str);
  if (!isNaN(parsedTime)) {
    const dObj = new Date(parsedTime);
    const y = dObj.getFullYear();
    const m = String(dObj.getMonth() + 1).padStart(2, '0');
    const d = String(dObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return null;
}
/**
 * Formats YYYY-MM-DD or Excel Serial Number into strict Sheet date format (dd/mm/yyyy or d/m/yyyy or yyyy-mm-dd)
 */
export function translateDateToSheet(
  dateVal: any,
  format: 'd/m/yyyy' | 'dd/mm/yyyy' | 'yyyy-mm-dd' = 'yyyy-mm-dd'
): string {
  if (!dateVal) return '';
  let str = String(dateVal).trim();
  
  // If dateVal is not in YYYY-MM-DD format (e.g. numeric serial "45941"), attempt conversion
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const iso = translateDateFromSheet(dateVal);
    if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      str = iso;
    } else {
      return str;
    }
  }

  if (format === 'yyyy-mm-dd') {
    return str;
  }

  const [y, m, d] = str.split('-');
  const dayPadded = String(d).padStart(2, '0');
  const monthPadded = String(m).padStart(2, '0');

  if (format === 'd/m/yyyy') {
    return `${parseInt(d, 10)}/${parseInt(m, 10)}/${y}`;
  }
  return `${dayPadded}/${monthPadded}/${y}`;
}

import { STANDARDIZED_SHEET_HEADERS } from './dataSchema';

/**
 * Exact 19 Column Headers of the App & Sheet (Books with Owner and DepositType + Side-by-Side Summary Tables)
 */
export const ORIGINAL_SHEET_HEADERS = STANDARDIZED_SHEET_HEADERS;
export const CANONICAL_SHEET_HEADERS = STANDARDIZED_SHEET_HEADERS;

/**
 * Translates App SavingsBook[] to 2D Array Matrix containing ONLY data rows (Row 2 onwards)
 * matching the schema of the Google Sheet / Excel with Owner & DepositType columns
 */
export function translateBooksToDataRows(books: SavingsBook[]): (string | number)[][] {
  // Chỉ đồng bộ những sổ đang hoạt động (active) lên Google Sheet, loại bỏ các sổ đã tất toán (settled)
  const activeBooks = books.filter((b) => b.status === 'active');
  const normalizedBooks = activeBooks.map((b) => {
    const effectiveMaturity = getAdjustedMaturityDate(b.maturityDate, b.depositType, b.bankId) || b.maturityDate;
    return {
      ...b,
      maturityDate: effectiveMaturity,
    };
  });
  const sortedBooks = [...normalizedBooks].sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));
  return sortedBooks.map((b) => {
    const bankStr = translateBankToSheet(b);
    const ownerStr = getOwnerLabel(b.owner);
    const depositTypeStr = b.depositType === 'counter' ? 'Tại quầy' : 'Online';
    const rateStr = translateInterestRateToSheet(b.interestRate);
    const principalMil = translateMoneyToSheet(b.principal, false);
    const startStr = translateDateToSheet(b.startDate, 'yyyy-mm-dd');
    const maturityStr = translateDateToSheet(b.maturityDate, 'yyyy-mm-dd');
    const term = b.termMonths;
    const benchmarkDateStr = getVietnamDateISO();
    const daysRemaining = getDaysBetween(benchmarkDateStr, b.maturityDate);
    const monthsRemaining = Math.max(0, Math.round(daysRemaining / 30.417));

    // Term interest in million
    const daysTotal = Math.max(1, getDaysBetween(b.startDate, b.maturityDate));
    const termInterestVND = Math.round((b.principal * (b.interestRate / 100) * daysTotal) / 365);
    const termInterestMil = translateMoneyToSheet(termInterestVND, true);

    // Annual interest in million
    const annualInterestVND = Math.round(b.principal * (b.interestRate / 100));
    const annualInterestMil = translateMoneyToSheet(annualInterestVND, true);

    const matIso = translateDateFromSheet(b.maturityDate) || b.maturityDate;
    const monthYear = matIso && matIso.length >= 7 ? `${matIso.slice(5, 7)}/${matIso.slice(2, 4)}` : '';

    return [
      bankStr,
      ownerStr,
      depositTypeStr,
      rateStr,
      principalMil,
      startStr,
      maturityStr,
      term,
      monthsRemaining,
      termInterestMil,
      annualInterestMil,
      monthYear,
    ];
  });
}

/**
 * Converts App SavingsBook[] to exact 2D Array Matrix matching Google Sheet / Excel side-by-side structure
 */
export function translateBooksToSheetMatrix(
  books: SavingsBook[],
  annualHistory?: AnnualInterestRecord[],
  balanceHistory?: BalanceGrowthRecord[],
  settlements?: SettlementAdjustment[]
): (string | number)[][] {
  const matrix: (string | number)[][] = [];

  // Chỉ lấy những sổ đang hoạt động (active), loại bỏ các sổ đã tất toán (settled) ra khỏi danh sách
  const activeBooks = books.filter((b) => b.status === 'active');
  const normalizedBooks = activeBooks.map((b) => {
    const effectiveMaturity = getAdjustedMaturityDate(b.maturityDate, b.depositType, b.bankId) || b.maturityDate;
    return {
      ...b,
      maturityDate: effectiveMaturity,
    };
  });
  const sortedBooks = [...normalizedBooks].sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));

  // Row 0: Headers
  matrix.push([...ORIGINAL_SHEET_HEADERS]);

  const effectiveSettlements: SettlementAdjustment[] = deduplicateSettlementAdjustments(settlements || []);

  const currentYear = new Date().getFullYear();
  let annuals: AnnualInterestRecord[] = [];
  let balances: BalanceGrowthRecord[] = [];

  const stored = loadStaticHistoryFromStorage();

  if (annualHistory && annualHistory.length > 0) {
    // Chỉ giữ lại các năm lịch sử <= năm hiện tại. 
    // Nếu năm đó đã có bản ghi tĩnh gốc (BASE), ta giữ nguyên giá trị chốt ban đầu của bản ghi tĩnh đó,
    // tránh ghi đè giá trị đã qua điều chỉnh tất toán (vốn dĩ tính động ở runtime).
    annuals = annualHistory.filter((a) => a.year <= currentYear).map((a) => {
      const baseStatic = stored.staticAnnuals.find((s) => s.year === a.year);
      return {
        ...a,
        interestEarnedMillion: baseStatic ? baseStatic.interestEarnedMillion : a.interestEarnedMillion,
        interestEarnedVND: baseStatic ? baseStatic.interestEarnedVND : a.interestEarnedVND,
      };
    });
  } else {
    // Đọc dữ liệu lịch sử tĩnh chuẩn từ file
    annuals = stored.staticAnnuals.filter((a) => a.year <= currentYear);
  }

  if (balanceHistory && balanceHistory.length > 0) {
    // Số dư cuối năm đã chốt chỉ bao gồm các năm trước năm hiện tại
    balances = balanceHistory.filter((b) => b.year < currentYear);
  } else {
    balances = stored.staticBalances.filter((b) => b.year < currentYear);
  }

  let totalPrincipalMil = 0;
  let totalTermInterestMil = 0;
  let totalAnnualInterestMil = 0;
  const dataRows = sortedBooks.map((b) => {
    const bankStr = translateBankToSheet(b);
    const ownerStr = getOwnerLabel(b.owner);
    const depositTypeStr = b.depositType === 'counter' ? 'Tại quầy' : 'Online';
    const rateVal = translateInterestRateToSheet(b.interestRate);
    const principalMil = translateMoneyToSheet(b.principal, false);
    const startStr = translateDateToSheet(b.startDate, 'yyyy-mm-dd');
    const maturityStr = translateDateToSheet(b.maturityDate, 'yyyy-mm-dd');
    const term = b.termMonths;
    const benchmarkDateStr = getVietnamDateISO();
    const daysRemaining = getDaysBetween(benchmarkDateStr, b.maturityDate);
    const monthsRemaining = Math.max(0, Math.round(daysRemaining / 30.417));

    const daysTotal = Math.max(1, getDaysBetween(b.startDate, b.maturityDate));
    const termInterestVND = Math.round((b.principal * (b.interestRate / 100) * daysTotal) / 365);
    const termInterestMil = translateMoneyToSheet(termInterestVND, true);

    const annualInterestVND = Math.round(b.principal * (b.interestRate / 100));
    const annualInterestMil = translateMoneyToSheet(annualInterestVND, true);

    const matIso = translateDateFromSheet(b.maturityDate) || b.maturityDate;
    const monthYear = matIso && matIso.length >= 7 ? `${matIso.slice(5, 7)}/${matIso.slice(2, 4)}` : '';

    totalPrincipalMil += principalMil;
    totalTermInterestMil += termInterestMil;
    totalAnnualInterestMil += annualInterestMil;

    return [
      bankStr,
      ownerStr,
      depositTypeStr,
      rateVal,
      principalMil,
      startStr,
      maturityStr,
      term,
      monthsRemaining,
      termInterestMil,
      annualInterestMil,
      monthYear,
    ];
  });

  const maxDataRows = Math.max(
    dataRows.length,
    annuals.length,
    balances.length,
    effectiveSettlements.length,
    isUsingSampleData(books) ? 18 : 1
  );

  for (let r = 0; r < maxDataRows; r++) {
    const bookRow = r < dataRows.length ? dataRows[r] : ['', '', '', '', '', '', '', '', '', '', '', ''];
    const annualRow = r < annuals.length
      ? [annuals[r].year, annuals[r].interestEarnedMillion]
      : ['', ''];
    const balanceRow = r < balances.length
      ? [balances[r].year, balances[r].balanceMillion, balances[r].annualIncomeMillion ?? '']
      : ['', '', ''];

    const act = r < effectiveSettlements.length ? effectiveSettlements[r] : null;
    const typeLabel = act
      ? act.settlementType === 'early'
        ? 'Tất toán trước hạn'
        : 'Tất toán đúng hạn'
      : '';
    const activityRow = act
      ? [
          act.id || `ADJ_${act.timestamp || Date.now()}`,
          translateDateToSheet(act.settlementDate, 'yyyy-mm-dd'),
          typeLabel,
          act.bookCode || '',
          getBankTagForBook(act.bankId, act.owner),
          getOwnerLabel(act.owner),
          translateMoneyToSheet(act.principal || 0, true),
          translateMoneyToSheet(act.actualInterestVND || 0, true),
          act.note || '',
        ]
      : ['', '', '', '', '', '', '', '', ''];

    matrix.push([
      ...bookRow,
      '', // Separator M
      ...annualRow,
      '', // Separator P
      ...balanceRow,
      '', // Separator T
      ...activityRow, // Columns U..AC
    ]);
  }

  return matrix;
}

/**
 * Tự động chuẩn hóa, sắp xếp và tái đánh chỉ mục/thứ tự toàn bộ danh mục sổ tiết kiệm:
 * 1. Loại bỏ hoàn toàn các sổ đã tất toán khỏi danh sách sổ (sổ đã tất toán không tồn tại trong danh sách nữa).
 * 2. Sắp xếp toàn bộ sổ active theo ngày đáo hạn tăng dần (sổ sắp đến hạn nhất lên trước).
 * 3. Chuẩn hóa mã sổ (bookCode) sạch sẽ theo quy ước: {TAG}-{YYMM}-{MILLIONS}.
 */
export function sortAndReindexBooks(bookList: SavingsBook[]): SavingsBook[] {
  // Loại bỏ hoàn toàn sổ đã tất toán khỏi danh sách sổ
  const activeBooks = bookList.filter((b) => b.status !== 'settled');

  // Sắp xếp các sổ active theo ngày đáo hạn tăng dần
  activeBooks.sort((a, b) => {
    const dateDiff = a.maturityDate.localeCompare(b.maturityDate);
    if (dateDiff !== 0) return dateDiff;
    return a.startDate.localeCompare(b.startDate);
  });

  // Chuẩn hóa mã sổ sạch sẽ
  return activeBooks.map((book) => {
    const tag = getBankTagForBook(book.bankId, book.owner);
    let code = (book.bookCode || '').trim();
    // Bỏ hậu tố (Tái tục) nếu có để tạo mã ngắn gọn, chuẩn mực
    code = code.replace(/\s*\(Tái tục\)+/gi, '').trim();

    if (!code || code.startsWith('SO-') || book.bookCode.includes('(Tái tục)')) {
      const yy = book.maturityDate.slice(2, 4);
      const mm = book.maturityDate.slice(5, 7);
      const mil = Math.round(book.principal / 1_000_000);
      code = `${tag}-${yy}${mm}-${mil}`;
    }

    return {
      ...book,
      owner: normalizeOwner(book.owner, book.bankId, book.bookCode),
      bookCode: code,
      status: 'active' as BookStatus,
    };
  });
}

/**
 * Chuẩn hóa chuỗi ngày tháng về dạng chuẩn YYYY-MM-DD để so khớp nghiệp vụ
 */
export function normalizeDateToISO(rawDate?: string): string {
  if (!rawDate) return '';
  const s = String(rawDate).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }
  const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }
  return s;
}

/**
 * Lọc trùng lặp danh sách nhật ký tất toán (Settlement Adjustments).
 * Đảm bảo mỗi sự kiện tất toán/tái tục cho 1 sổ chỉ lưu duy nhất 1 thẻ nhật ký.
 * Loại bỏ triệt để các thẻ bị trùng lặp do nhấp đúp, lệch định dạng ngày hoặc cơ chế đồng bộ.
 */
export function deduplicateSettlementAdjustments(
  adjustments: SettlementAdjustment[]
): SettlementAdjustment[] {
  if (!Array.isArray(adjustments) || adjustments.length === 0) return [];
  const seenKeys = new Set<string>();
  const uniqueList: SettlementAdjustment[] = [];

  for (const adj of adjustments) {
    if (!adj) continue;

    // LOẠI BỎ TRIỆT ĐỂ BẢN GHI RÁC TỰ ĐỘNG TẠO TỪ CÁC PHIÊN BẢN CŨ HOẶC CHUYỂN DỊCH TỰ ĐỘNG
    if (
      adj.id?.startsWith('migrated_') ||
      adj.id?.startsWith('ADJ_RESTORED_') ||
      adj.note?.includes('Chuyển dịch tự động')
    ) {
      continue;
    }

    // Chuẩn hóa mã sổ sạch sẽ
    const rawCode = (adj.bookCode || '').trim();
    const cleanCode = rawCode.replace(/\s*\(Tái tục\)+/gi, '').replace(/\s+/g, '').toUpperCase();
    const isoDate = normalizeDateToISO(adj.settlementDate);
    const principal = Number(adj.principal) || 0;
    const bankId = (adj.bankId || '').trim().toLowerCase();
    const settlementType = adj.settlementType || 'early';

    // Khóa định danh nghiệp vụ duy nhất:
    // MỖI SỰ KIỆN TẤT TOÁN DỰA TRÊN: Mã Sổ (hoặc Ngân hàng) + Ngày Tất Toán + Số Tiền Gốc + Loại Tất Toán
    const businessId = buildSettlementBusinessId({
      bookCode: cleanCode || adj.bookCode,
      bankId,
      owner: adj.owner,
      principal,
      settlementDate: isoDate || adj.settlementDate,
      settlementType,
    });

    if (!seenKeys.has(businessId)) {
      seenKeys.add(businessId);
      uniqueList.push({
        ...adj,
        businessId,
        bookCode: cleanCode || adj.bookCode,
        settlementDate: isoDate || adj.settlementDate,
        principal,
      });
    } else {
      // Ưu tiên giữ ID ADJ_ tương thích file nếu hai bản ghi cùng business ID.
      if (adj.id && adj.id.startsWith('ADJ_')) {
        const existingIdx = uniqueList.findIndex((item) => {
          const itemCode = (item.bookCode || '').replace(/\s*\(Tái tục\)+/gi, '').replace(/\s+/g, '').toUpperCase();
          const itemDate = normalizeDateToISO(item.settlementDate);
          return buildSettlementBusinessId({
            bookCode: itemCode || item.bookCode,
            bankId: item.bankId,
            owner: item.owner,
            principal: Number(item.principal) || 0,
            settlementDate: itemDate,
            settlementType: item.settlementType || 'early',
          }) === businessId;
        });
        if (existingIdx !== -1) {
          uniqueList[existingIdx] = {
            ...adj,
            businessId,
            bookCode: cleanCode || adj.bookCode,
            settlementDate: isoDate || adj.settlementDate,
            principal,
          };
        }
      }
    }
  }

  return uniqueList;
}
