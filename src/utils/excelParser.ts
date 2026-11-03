import { SavingsBook, AnnualInterestRecord, BalanceGrowthRecord, SettlementAdjustment } from '../types';
import { getDaysBetween, calculateMaturityDate, getAdjustedMaturityDate } from './calculator';
import {
  translateBankFromSheet,
  translateInterestRateFromSheet,
  translateMoneyFromSheet,
  translateDateFromSheet,
  translateBooksToSheetMatrix,
  normalizeOwner,
  deduplicateSettlementAdjustments,
} from './dataTranslator';
import { CANONICAL_COLUMNS, STANDARDIZED_SHEET_HEADERS } from './dataSchema';
import { saveStaticHistoryToStorage } from '../data/historicalGrowth';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// Helper tải động module XLSX khi cần và cache lại để tối ưu dung lượng bundle ban đầu
let xlsxModule: typeof import('xlsx') | null = null;
export const getXLSX = async () => {
  if (!xlsxModule) {
    xlsxModule = await import('xlsx');
  }
  return xlsxModule;
};

export interface ParseExcelResult {
  success: boolean;
  books: SavingsBook[];
  errors: string[];
  warnings: string[];
  totalPrincipal: number;
  annualInterestHistory?: AnnualInterestRecord[];
  balanceGrowthHistory?: BalanceGrowthRecord[];
  settlements?: SettlementAdjustment[];
}

/**
 * Parses a 2D matrix of rows (from Google Sheets API values.get or Excel sheet_to_json)
 */
export function parseMatrixData(matrix: any[][]): ParseExcelResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!matrix || matrix.length === 0) {
    return { success: false, books: [], errors: ['Dữ liệu bảng tính trống.'], warnings, totalPrincipal: 0 };
  }

  // Find header row index
  let headerRowIdx = -1;
  for (let r = 0; r < Math.min(15, matrix.length); r++) {
    const rowStr = (matrix[r] || []).map((c) => String(c).toLowerCase()).join(' ');
    if (
      (rowStr.includes('ngân hàng') || rowStr.includes('bank') || rowStr.includes('nh')) &&
      (rowStr.includes('tiền') || rowStr.includes('gốc') || rowStr.includes('amount') || rowStr.includes('lãi') || rowStr.includes('đáo hạn'))
    ) {
      headerRowIdx = r;
      break;
    }
  }

  const rawRows: Record<string, any>[] = [];
  if (headerRowIdx >= 0) {
    const headers = matrix[headerRowIdx].map((h, i) => String(h || `col_${i}`).trim());
    for (let r = headerRowIdx + 1; r < matrix.length; r++) {
      const rowData: Record<string, any> = {};
      let hasContent = false;
      (matrix[r] || []).forEach((val, cIdx) => {
        if (val !== undefined && val !== '') {
          hasContent = true;
          const headerName = headers[cIdx] || `col_${cIdx}`;
          rowData[headerName] = val;
          rowData[`__col_${cIdx}`] = val; // Store positional column index for reliable fallback
        }
      });
      if (hasContent) rawRows.push(rowData);
    }
  } else {
    // Treat row 0 as header if no explicit keyword matched
    const headers = (matrix[0] || []).map((h, i) => String(h || `col_${i}`).trim());
    for (let r = 1; r < matrix.length; r++) {
      const rowData: Record<string, any> = {};
      let hasContent = false;
      (matrix[r] || []).forEach((val, cIdx) => {
        if (val !== undefined && val !== '') {
          hasContent = true;
          const headerName = headers[cIdx] || `col_${cIdx}`;
          rowData[headerName] = val;
          rowData[`__col_${cIdx}`] = val; // Store positional column index for reliable fallback
        }
      });
      if (hasContent) rawRows.push(rowData);
    }
  }

  if (rawRows.length === 0) {
    return { success: false, books: [], errors: ['Không tìm thấy hàng dữ liệu nào trong bảng tính.'], warnings, totalPrincipal: 0 };
  }

  const books: SavingsBook[] = [];
  let parsedIndex = 1;

  for (const row of rawRows) {
    const findVal = (patterns: string[], excludePatterns: string[] = []): any => {
      for (const key of Object.keys(row)) {
        if (key.startsWith('__col_')) continue; // Skip positional keys during header matching
        const cleanKey = key.trim().toLowerCase().normalize('NFC');
        // Skip if key contains any excluded substring
        if (excludePatterns.some((ex) => cleanKey.includes(ex.toLowerCase().normalize('NFC')))) {
          continue;
        }
        for (const p of patterns) {
          const cleanP = p.trim().toLowerCase().normalize('NFC');
          if (cleanP === 'nh') {
            // Whole-word match for "nh" to avoid matching "chi nhánh", "nhận", "doanh", "thành", etc.
            const words = cleanKey.split(/[\s,.\-_/()]+/);
            if (words.includes('nh')) {
              return row[key];
            }
          } else if (cleanKey.includes(cleanP)) {
            return row[key];
          }
        }
      }
      return undefined;
    };

    // 1. Bank and Code (Column A / index 0 fallback)
    const bankVal = findVal(['ngân hàng', 'bank', 'nh', 'tổ chức'], ['chi nhánh', 'nhận', 'nhóm', 'doanh', 'thành', 'bệnh', 'số tài khoản', 'số tk']);
    const bankRaw = String(bankVal !== undefined ? bankVal : (row['__col_0'] || '')).trim();
    const rawCode = findVal(['mã sổ', 'mã', 'ký hiệu', 'số sổ', 'code', 'hợp đồng', 'stt']);
    const bankLower = bankRaw.toLowerCase().normalize('NFC');

    // Skip summary or non-book rows
    if (
      !bankRaw ||
      bankLower.includes('total') ||
      bankLower.includes('tổng') ||
      bankLower.includes('lãi hàng năm') ||
      bankLower.includes('số dư cuối') ||
      bankLower.includes('thu nhập') ||
      /^\d{4}$/.test(bankRaw)
    ) {
      continue;
    }

    const { 
      bankId, 
      originalTag,
      status: parsedStatus,
      isEarlySettled,
      settlementDate,
      actualInterestVND
    } = translateBankFromSheet(bankRaw);

    // Kiểm tra cấu trúc layout (19 cột chuẩn vs 17 cột cũ) nếu không có tiêu đề rõ ràng
    const col1Val = row['__col_1'];
    const col2Val = row['__col_2'];

    const col1Str = String(col1Val !== undefined && col1Val !== null ? col1Val : '').trim();
    const isCol1Rate = col1Str.includes('%') || (/^\d+([.,]\d+)?$/.test(col1Str) && parseFloat(col1Str.replace(',', '.')) <= 25 && parseFloat(col1Str.replace(',', '.')) > 0.5);
    const isLegacy17ColLayout = isCol1Rate && !findVal(['chủ sổ', 'owner', 'người gửi']);

    // 2. Principal
    const rawPrincipal = findVal(['tiền gửi', 'tiền gởi', 'số tiền', 'gốc', 'principal', 'amount']) ?? 
      (isLegacy17ColLayout ? row['__col_2'] : row['__col_4']);
    const principal = translateMoneyFromSheet(rawPrincipal);

    if (!principal || principal <= 0) {
      continue;
    }

    // 3. Interest rate
    const rawRate = findVal(['lãi suất', 'rate', '%', 'lãi'], ['lãi theo', 'lãi 1', 'tiền lãi']) ?? 
      (isLegacy17ColLayout ? row['__col_1'] : row['__col_3']);
    const interestRate = translateInterestRateFromSheet(rawRate);

    // 4. Dates & Term
    const startDateRaw = findVal(['ngày gửi', 'ngày mở', 'gửi', 'start'], ['tiền']) ?? 
      (isLegacy17ColLayout ? row['__col_3'] : row['__col_5']);
    const maturityDateRaw = findVal(['đáo hạn', 'đến hạn', 'hạn', 'maturity', 'end'], ['tháng đáo', 'kỳ hạn', 'kỳ']) ?? 
      (isLegacy17ColLayout ? row['__col_4'] : row['__col_6']);
    const termRaw = findVal(['kỳ', 'kỳ hạn', 'tháng', 'term'], ['tháng đáo', 'ngày']) ?? 
      (isLegacy17ColLayout ? row['__col_5'] : row['__col_7']);

    const startDate = translateDateFromSheet(startDateRaw) || '2025-09-15';
    let maturityDate = translateDateFromSheet(maturityDateRaw);
    let termMonths = typeof termRaw === 'number' ? termRaw : (termRaw ? parseInt(String(termRaw), 10) : 0);

    // Nếu không có cột Kỳ hạn nhưng có Ngày gửi và Ngày đáo hạn -> Tự động suy ra số tháng kỳ hạn
    if ((!termMonths || termMonths <= 0) && maturityDate && maturityDate > startDate) {
      const days = getDaysBetween(startDate, maturityDate);
      termMonths = Math.max(1, Math.round(days / 30.4375));
    }
    if (!termMonths || termMonths <= 0) {
      termMonths = 12;
    }

    // Tự động tính Ngày đáo hạn nếu file không có cột Ngày đáo hạn nhưng có Kỳ hạn
    if (!maturityDate || maturityDate <= startDate || maturityDate.startsWith('201') || maturityDate.startsWith('200')) {
      maturityDate = calculateMaturityDate(startDate, termMonths);
    }

    // 5. Code
    const bookCode = rawCode ? String(rawCode).trim() : `SO-${originalTag || bankId.toUpperCase()}-${String(parsedIndex).padStart(2, '0')}`;

    // 6. Owner (Chủ sổ)
    let candidateOwner: any = undefined;
    if (!isLegacy17ColLayout) {
      const rawOwnerVal = findVal(['chủ sổ', 'người gửi', 'đứng tên', 'owner', 'chủ sở hữu', 'chủ']);
      candidateOwner = rawOwnerVal !== undefined && rawOwnerVal !== null && String(rawOwnerVal).trim() !== ''
        ? rawOwnerVal
        : col1Val;
    }
    const owner = normalizeOwner(candidateOwner, bankRaw, rawCode || originalTag);

    // 6.1 Deposit Type (Online vs Tại quầy)
    let depositType: 'online' | 'counter' = 'counter';
    if (!isLegacy17ColLayout) {
      const rawDepositVal = findVal(['hình thức', 'loại sổ', 'kênh gửi', 'kênh', 'deposit type', 'type']);
      const depositCandidate = rawDepositVal !== undefined ? rawDepositVal : col2Val;
      const rawDepositTypeStr = String(depositCandidate !== undefined && depositCandidate !== null ? depositCandidate : '').trim().toLowerCase().normalize('NFC');
      
      // If the candidate contains numeric values, dates, or percent signs, it's NOT a deposit type column
      if (!rawDepositTypeStr.includes('%') && !/^\d+([.,]\d+)?$/.test(rawDepositTypeStr)) {
        const combinedTypeStr = `${rawDepositTypeStr} ${bankRaw} ${rawCode || ''}`.toLowerCase().normalize('NFC');
        if (
          combinedTypeStr.includes('online') ||
          combinedTypeStr.includes('trực tuyến') ||
          combinedTypeStr.includes('app') ||
          combinedTypeStr.includes('web')
        ) {
          depositType = 'online';
        } else if (
          combinedTypeStr.includes('quầy') ||
          combinedTypeStr.includes('counter') ||
          combinedTypeStr.includes('offline') ||
          combinedTypeStr.includes('tại quầy') ||
          combinedTypeStr.includes('sổ giấy') ||
          combinedTypeStr.includes('trực tiếp')
        ) {
          depositType = 'counter';
        }
      }
    }

    // 6.2 Chuẩn hóa ngày đáo hạn thực tế (nếu rơi vào thứ 7 / chủ nhật thì tự động lấy ngày làm việc tiếp theo)
    const adjustedMaturity = getAdjustedMaturityDate(maturityDate, depositType, bankId);
    if (adjustedMaturity) {
      maturityDate = adjustedMaturity;
    }

    // 7. Expected term interest & annual equivalent (tính theo số ngày thực tế gửi đến ngày đáo hạn thực tế)
    const daysTotal = Math.max(1, getDaysBetween(startDate, maturityDate));
    const calculatedTermInterest = Math.round((principal * (interestRate / 100) * daysTotal) / 365);
    const calculatedAnnualInterest = Math.round(principal * (interestRate / 100));

    const rawTermInterest = findVal(['lãi theo sổ', 'tiền lãi theo sổ', 'lãi kỳ hạn', 'tiền lãi']) ?? 
      (isLegacy17ColLayout ? row['__col_7'] : row['__col_9']);
    let expectedTermInterest = translateMoneyFromSheet(rawTermInterest);
    if (!expectedTermInterest || expectedTermInterest <= 0 || expectedTermInterest > principal * 2) {
      expectedTermInterest = calculatedTermInterest;
    }

    const rawAnnualInterest = findVal(['lãi 1 năm', 'tiền lãi 1 năm', 'lãi năm']) ?? 
      (isLegacy17ColLayout ? row['__col_8'] : row['__col_10']);
    let annualInterestEquivalent = translateMoneyFromSheet(rawAnnualInterest);
    if (!annualInterestEquivalent || annualInterestEquivalent <= 0 || annualInterestEquivalent > principal * 2) {
      annualInterestEquivalent = calculatedAnnualInterest;
    }
    const maturityMonthYear = maturityDate.slice(5, 7) + '/' + maturityDate.slice(2, 4);
    const cleanCode = (bookCode || '').replace(/[^a-zA-Z0-9-_]/g, '');
    const stableId = `book-${bankId.toLowerCase()}-${cleanCode || parsedIndex}`;

    books.push({
      id: stableId,
      bookCode,
      bankId,
      owner,
      depositType,
      principal,
      interestRate,
      termMonths,
      startDate,
      maturityDate,
      rolloverOption: 'principal_and_interest',
      status: parsedStatus || 'active',
      isEarlySettled,
      settlementDate,
      actualInterestVND,
      expectedTermInterest,
      annualInterestEquivalent,
      maturityMonthYear,
      note: `Đồng bộ Google Drive (${bookCode})`,
    });

    parsedIndex++;
  }

  if (books.length === 0) {
    return {
      success: false,
      books: [],
      errors: ['Không trích xuất được dòng dữ liệu sổ tiết kiệm hợp lệ nào. Vui lòng kiểm tra lại cấu trúc hàng và cột trong Google Sheet/Excel.'],
      warnings,
      totalPrincipal: 0,
    };
  }

  const totalPrincipal = books.reduce((s, b) => s + b.principal, 0);

  // Trích xuất dữ liệu lịch sử tĩnh từ các cột N-S (Lãi hàng năm, Số cuối năm & Thu nhập)
  const historicalTables = extractHistoricalTablesFromMatrix(matrix, headerRowIdx >= 0 ? headerRowIdx : 0);
  if (historicalTables.annuals.length > 0 || historicalTables.balances.length > 0) {
    saveStaticHistoryToStorage(historicalTables.annuals, historicalTables.balances);
  }

  return {
    success: true,
    books,
    errors,
    warnings,
    totalPrincipal,
    annualInterestHistory: historicalTables.annuals,
    balanceGrowthHistory: historicalTables.balances,
    settlements: historicalTables.settlements,
  };
}

/**
 * Trích xuất dữ liệu tĩnh LÃI HÀNG NĂM, SỐ CUỐI NĂM và NHẬT KÝ BIẾN ĐỘNG từ các cột bên phải trong bảng tính Excel/Google Sheet
 * Hỗ trợ linh hoạt Layout chuẩn (N-S, U-AC) hoặc nhận diện tiêu đề cột
 */
export function extractHistoricalTablesFromMatrix(
  matrix: any[][],
  headerRowIdx = 0
): { annuals: AnnualInterestRecord[]; balances: BalanceGrowthRecord[]; settlements: SettlementAdjustment[] } {
  const annuals: AnnualInterestRecord[] = [];
  const balances: BalanceGrowthRecord[] = [];
  const settlements: SettlementAdjustment[] = [];

  if (!matrix || matrix.length <= headerRowIdx + 1) {
    return { annuals, balances, settlements };
  }

  const headerRow = matrix[headerRowIdx] || [];
  let colAnnualYear = -1;
  let colAnnualAmount = -1;
  let colBalanceYear = -1;
  let colBalanceAmount = -1;
  let colBalanceIncome = -1;

  headerRow.forEach((hVal, colIdx) => {
    const hStr = String(hVal || '').toLowerCase().normalize('NFC').trim();
    if (hStr.includes('lãi hàng năm') || hStr.includes('lãi năm')) {
      if (colAnnualYear === -1) colAnnualYear = colIdx;
    } else if (hStr.includes('số cuối năm') || hStr.includes('dư cuối năm')) {
      if (colBalanceYear === -1) colBalanceYear = colIdx;
    }
  });

  // Fallback theo vị trí cột nếu tiêu đề không khớp
  if (colAnnualYear === -1) {
    if (headerRow.length >= 15) {
      colAnnualYear = 13; // Cột N (Layout 19 cột)
    } else if (headerRow.length >= 13) {
      colAnnualYear = 11; // Cột L (Layout 17 cột cũ)
    }
  }
  if (colAnnualYear !== -1 && colAnnualAmount === -1) {
    colAnnualAmount = colAnnualYear + 1; // Cột O
  }

  if (colBalanceYear === -1) {
    if (headerRow.length >= 18) {
      colBalanceYear = 16; // Cột Q (Layout 19 cột)
    } else if (headerRow.length >= 16) {
      colBalanceYear = 14; // Cột O (Layout 17 cột cũ)
    }
  }
  if (colBalanceYear !== -1) {
    if (colBalanceAmount === -1) colBalanceAmount = colBalanceYear + 1; // Cột R
    if (colBalanceIncome === -1) colBalanceIncome = colBalanceYear + 2; // Cột S
  }

  const startRow = Math.max(1, headerRowIdx + 1);
  for (let r = startRow; r < matrix.length; r++) {
    const row = matrix[r] || [];

    // Parse Lãi Hàng Năm
    if (colAnnualYear !== -1 && colAnnualAmount !== -1 && row[colAnnualYear] !== undefined && row[colAnnualYear] !== '') {
      const yrClean = String(row[colAnnualYear]).replace(/\D/g, '');
      const yrRaw = parseInt(yrClean, 10);
      const amtRaw = translateMoneyFromSheet(row[colAnnualAmount]);

      if (yrRaw >= 2000 && yrRaw <= 2099 && amtRaw > 0) {
        const million = amtRaw > 50000 ? Math.round(amtRaw / 1_000_000) : Math.round(amtRaw);
        const vnd = million * 1_000_000;
        annuals.push({
          year: yrRaw,
          interestEarnedMillion: million,
          interestEarnedVND: vnd,
        });
      }
    }

    // Parse Số Cuối Năm & Thu Nhập Năm
    if (colBalanceYear !== -1 && colBalanceAmount !== -1 && row[colBalanceYear] !== undefined && row[colBalanceYear] !== '') {
      const yrClean = String(row[colBalanceYear]).replace(/\D/g, '');
      const yrRaw = parseInt(yrClean, 10);
      const balRaw = translateMoneyFromSheet(row[colBalanceAmount]);
      const incRaw = colBalanceIncome !== -1 ? translateMoneyFromSheet(row[colBalanceIncome]) : 0;

      if (yrRaw >= 2000 && yrRaw <= 2099 && balRaw > 0) {
        const balMillion = balRaw > 50000 ? Math.round(balRaw / 1_000_000) : Math.round(balRaw);
        const balVnd = balMillion * 1_000_000;

        let incMillion: number | undefined = undefined;
        let incVnd: number | undefined = undefined;

        if (incRaw > 0) {
          incMillion = incRaw > 50000 ? Math.round(incRaw / 1_000_000) : Math.round(incRaw);
          incVnd = incMillion * 1_000_000;
        }

        balances.push({
          year: yrRaw,
          balanceMillion: balMillion,
          balanceVND: balVnd,
          annualIncomeMillion: incMillion,
          annualIncomeVND: incVnd,
        });
      }
    }

    // Parse Nhật ký biến động (Cột U..AC - indices 20..28)
    // Tự động nhận diện cấu trúc 9 cột (ID ở U, Ngày ở V) hoặc 8 cột (Ngày ở U)
    const col20Header = String(headerRow[20] || '').toLowerCase().normalize('NFC').trim();
    const col21Header = String(headerRow[21] || '').toLowerCase().normalize('NFC').trim();

    // 1. Kiểm tra tiêu đề ở cột 20 (U) và cột 21 (V)
    const isExplicit9ColHeader = col20Header.includes('id') || col21Header.includes('ngày') || col21Header.includes('date');
    const isExplicit8ColHeader = (col20Header.includes('ngày') || col20Header.includes('date')) && !col20Header.includes('id');

    // 2. Kiểm tra dữ liệu thực tế tại hàng này
    const val20 = row[20];
    const val21 = row[21];

    const val20Str = String(val20 !== undefined && val20 !== null ? val20 : '').trim();

    // Kiểm tra xem val20 hoặc val21 có phải ngày hợp lệ không
    const dateFrom20 = translateDateFromSheet(val20);
    const dateFrom21 = translateDateFromSheet(val21);

    let is9ColLayout = false;
    if (isExplicit9ColHeader) {
      is9ColLayout = true;
    } else if (isExplicit8ColHeader) {
      is9ColLayout = false;
    } else {
      // Nhận diện theo mẫu dữ liệu nếu không có tiêu đề rõ
      if (val20Str.startsWith('ADJ_') || val20Str.toLowerCase().startsWith('id_') || (dateFrom21 && !dateFrom20)) {
        is9ColLayout = true;
      } else if (dateFrom20 && !dateFrom21) {
        is9ColLayout = false;
      } else if (dateFrom21) {
        is9ColLayout = true;
      }
    }

    let actIdRaw = '';
    let actDateRaw: any = '';
    let actTypeRaw: any = '';
    let actCodeRaw: any = '';
    let actBankRaw: any = '';
    let actOwnerRaw: any = '';
    let actPrincipalRaw: any = '';
    let actInterestRaw: any = '';
    let actNoteRaw: any = '';

    if (is9ColLayout) {
      // Cấu trúc 9 cột: ID (U/20), Ngày (V/21), Loại (W/22), Mã sổ (X/23), NH (Y/24), Chủ (Z/25), Gốc (AA/26), Lãi (AB/27), Ghi chú (AC/28)
      actIdRaw = row[20];
      actDateRaw = row[21];
      actTypeRaw = row[22];
      actCodeRaw = row[23];
      actBankRaw = row[24];
      actOwnerRaw = row[25];
      actPrincipalRaw = row[26];
      actInterestRaw = row[27];
      actNoteRaw = row[28];
    } else {
      // Cấu trúc 8 cột: Ngày (U/20), Loại (V/21), Mã sổ (W/22), NH (X/23), Chủ (Y/24), Gốc (Z/25), Lãi (AA/26), Ghi chú (AB/27)
      actDateRaw = row[20];
      actTypeRaw = row[21];
      actCodeRaw = row[22];
      actBankRaw = row[23];
      actOwnerRaw = row[24];
      actPrincipalRaw = row[25];
      actInterestRaw = row[26];
      actNoteRaw = row[27];
      actIdRaw = `ADJ_${r}_${actCodeRaw || 'SO'}`;
    }

    // Nếu actIdRaw rỗng hoặc không có tiền tố ADJ_, tạo ID ổn định
    if (!actIdRaw || String(actIdRaw).trim() === '') {
      actIdRaw = `ADJ_${r}_${actCodeRaw || 'SO'}`;
    }

    const cleanDateStr = String(actDateRaw || '').trim();
    const cleanDateLower = cleanDateStr.toLowerCase();
    if (
      cleanDateLower.includes('ngày') ||
      cleanDateLower.includes('date') ||
      cleanDateLower.includes('tổng') ||
      cleanDateLower.includes('total') ||
      cleanDateLower.includes('stt') ||
      cleanDateLower.includes('nhật ký')
    ) {
      continue;
    }

    const principalVal = translateMoneyFromSheet(actPrincipalRaw);
    const interestVal = translateMoneyFromSheet(actInterestRaw);
    const hasMeaningfulData = (principalVal > 0 || interestVal > 0) && !!(String(actCodeRaw || '').trim() || String(actBankRaw || '').trim());

    if (cleanDateStr !== '' && hasMeaningfulData) {
      const dateIso = translateDateFromSheet(cleanDateStr);
      if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) continue;
      const yr = parseInt(dateIso.slice(0, 4), 10);
      if (isNaN(yr) || yr < 2000 || yr > 2100) continue;
      const typeStr = String(actTypeRaw || '').toLowerCase();
      const settlementType = typeStr.includes('trước') ? 'early' : 'maturity';
      const ownerVal = normalizeOwner(actOwnerRaw, String(actBankRaw || ''), String(actCodeRaw || ''));

      let origMaturityYr = yr;
      const codeStr = String(actCodeRaw || '').trim();
      const codeMatch = codeStr.match(/-(\d{2})\d{2}-/);
      if (codeMatch) {
        const parsedYY = parseInt('20' + codeMatch[1], 10);
        if (parsedYY >= 2020 && parsedYY <= 2040) {
          origMaturityYr = parsedYY;
        }
      } else {
        const noteMatch = String(actNoteRaw || '').match(/20(2[6-9]|3[0-9])/);
        if (noteMatch) {
          const parsedYr = parseInt(noteMatch[0], 10);
          if (parsedYr >= yr) {
            origMaturityYr = parsedYr;
          }
        }
      }

      // Trích xuất Lãi đúng hạn ban đầu nếu có trong note
      let expectedTermInterest: number | undefined;
      const noteStr = String(actNoteRaw || '');
      const expMatch = noteStr.match(/(?:Lãi đúng hạn|Lãi ban đầu|Lãi bị mất|thiệt hại)[^\d]*(\d+(?:[.,]\d+)?)\s*(?:Tr|triệu)/i);
      if (expMatch) {
        const milVal = parseFloat(expMatch[1].replace(',', '.'));
        if (!isNaN(milVal) && milVal > 0) {
          expectedTermInterest = Math.round(milVal * 1_000_000);
        }
      }

      settlements.push({
        id: String(actIdRaw || `ADJ_${r}_${codeStr || 'SO'}`),
        bookCode: codeStr || 'SO_SAVED',
        bankId: translateBankFromSheet(String(actBankRaw || '')).bankId || 'scb',
        owner: ownerVal,
        principal: principalVal,
        settlementDate: dateIso,
        settlementYear: yr,
        originalMaturityYear: origMaturityYr,
        settlementType,
        actualInterestVND: interestVal,
        expectedTermInterest,
        note: noteStr,
        timestamp: new Date(dateIso).getTime() || Date.now(),
      });
    }
  }

  const uniqueAnnuals = Array.from(new Map(annuals.map(a => [a.year, a])).values()).sort((a, b) => a.year - b.year);
  const uniqueBalances = Array.from(new Map(balances.map(b => [b.year, b])).values()).sort((a, b) => a.year - b.year);
  const uniqueSettlements = deduplicateSettlementAdjustments(
    Array.from(new Map(settlements.map(s => [s.id, s])).values())
  );

  return { annuals: uniqueAnnuals, balances: uniqueBalances, settlements: uniqueSettlements };
}

/**
 * Parses an Excel Workbook object (from raw ArrayBuffer, string, or workbook object)
 */
export async function parseWorkbook(workbookOrBuffer: any): Promise<ParseExcelResult> {
  const XLSX = await getXLSX();
  let workbook: any = workbookOrBuffer;

  if (workbookOrBuffer instanceof ArrayBuffer || workbookOrBuffer instanceof Uint8Array) {
    workbook = XLSX.read(workbookOrBuffer, { type: 'array', cellDates: true });
  } else if (typeof workbookOrBuffer === 'string') {
    workbook = XLSX.read(workbookOrBuffer, { type: 'string', cellDates: true });
  }

  const warnings: string[] = [];
  let bestResult: ParseExcelResult | null = null;

  if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
    return { success: false, books: [], errors: ['Không tìm thấy trang tính (sheet) nào trong file.'], warnings, totalPrincipal: 0 };
  }

  // Iterate across all sheets and pick the sheet with the most valid savings books
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Convert to 2D array of rows
    const matrix: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
    if (!matrix || matrix.length === 0) continue;

    const res = parseMatrixData(matrix);
    if (res.success && res.books.length > (bestResult?.books?.length || 0)) {
      bestResult = res;
    }
  }

  if (!bestResult || bestResult.books.length === 0) {
    return {
      success: false,
      books: [],
      errors: ['Không trích xuất được dòng dữ liệu sổ tiết kiệm hợp lệ nào. Vui lòng kiểm tra lại cấu trúc hàng và cột trong Google Sheet/Excel.'],
      warnings,
      totalPrincipal: 0,
    };
  }

  return bestResult;
}

/**
 * Parses an Excel (.xlsx or .xls) file uploaded by the user
 */
export async function parseSavingsExcel(file: File): Promise<ParseExcelResult> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    return await parseWorkbook(arrayBuffer);
  } catch (err: any) {
    return {
      success: false,
      books: [],
      errors: [`Lỗi khi đọc file Excel: ${err?.message || 'Định dạng file không hỗ trợ'}`],
      warnings: [],
      totalPrincipal: 0,
    };
  }
}

export const parseExcelFile = parseSavingsExcel;

/**
 * Parses a CSV string retrieved from Google Sheets or export endpoint
 */
export async function parseSavingsCSV(csvString: string): Promise<ParseExcelResult> {
  try {
    return await parseWorkbook(csvString);
  } catch (err: any) {
    return {
      success: false,
      books: [],
      errors: [`Lỗi xử lý dữ liệu CSV từ Google Sheets: ${err?.message || 'Dữ liệu không đúng định dạng'}`],
      warnings: [],
      totalPrincipal: 0,
    };
  }
}

export async function buildSavingsWorkbook(
  books: SavingsBook[],
  annualHistory?: AnnualInterestRecord[],
  balanceHistory?: BalanceGrowthRecord[],
  settlements?: SettlementAdjustment[],
  metadata?: Record<string, any>
): Promise<any> {
  const XLSX = await getXLSX();
  const matrix = translateBooksToSheetMatrix(books, annualHistory, balanceHistory, settlements);
  const worksheet = XLSX.utils.aoa_to_sheet(matrix);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'SoTietKiem');

  // Set column widths matching sheet with Owner and DepositType columns
  worksheet['!cols'] = [
    { wch: 14 }, // A: Ngân hàng
    { wch: 14 }, // B: Chủ sổ
    { wch: 12 }, // C: Hình thức
    { wch: 12 }, // D: Lãi suất
    { wch: 14 }, // E: Tiền gửi
    { wch: 14 }, // F: Gửi
    { wch: 14 }, // G: Đáo hạn
    { wch: 8 },  // H: Kỳ
    { wch: 14 }, // I: Ngày hôm nay
    { wch: 18 }, // J: Tiền lãi theo sổ
    { wch: 18 }, // K: Tiền lãi 1 năm
    { wch: 14 }, // L: Tháng đáo hạn
    { wch: 4 },  // M: Separator
    { wch: 14 }, // N: Lãi hàng năm
    { wch: 12 }, // O: Số tiền (Lãi)
    { wch: 4 },  // P: Separator
    { wch: 14 }, // Q: Số cuối năm
    { wch: 12 }, // R: Số tiền (Gốc)
    { wch: 16 }, // S: Thu nhập năm
    { wch: 4 },  // T: Separator
    { wch: 14 }, // U: Nhật ký biến động
    { wch: 14 }, // V: Ngày GD
    { wch: 14 }, // W: Loại
    { wch: 14 }, // X: Ngân hàng
    { wch: 14 }, // Y: Mã sổ
    { wch: 14 }, // Z: Tiền gốc
    { wch: 14 }, // AA: Tiền lãi thực nhận
    { wch: 14 }, // AB: Chủ sổ
    { wch: 24 }, // AC: Ghi chú
  ];

  // Định dạng số có dấu chấm phân cách hàng nghìn cho tất cả các cột tiền tệ
  for (let r = 1; r < matrix.length; r++) {
    // E (4): Tiền gửi (Triệu VNĐ)
    const cellE = worksheet[XLSX.utils.encode_cell({ r, c: 4 })];
    if (cellE && typeof cellE.v === 'number') cellE.z = '#,##0';

    // J (9): Tiền lãi theo sổ
    const cellJ = worksheet[XLSX.utils.encode_cell({ r, c: 9 })];
    if (cellJ && typeof cellJ.v === 'number') cellJ.z = '#,##0.0#';

    // K (10): Tiền lãi 1 năm
    const cellK = worksheet[XLSX.utils.encode_cell({ r, c: 10 })];
    if (cellK && typeof cellK.v === 'number') cellK.z = '#,##0.0#';

    // O (14): Lãi năm (Lãi hàng năm)
    const cellO = worksheet[XLSX.utils.encode_cell({ r, c: 14 })];
    if (cellO && typeof cellO.v === 'number') cellO.z = '#,##0';

    // R (17): Gốc cuối năm (Số cuối năm)
    const cellR = worksheet[XLSX.utils.encode_cell({ r, c: 17 })];
    if (cellR && typeof cellR.v === 'number') cellR.z = '#,##0';

    // S (18): Thu nhập năm
    const cellS = worksheet[XLSX.utils.encode_cell({ r, c: 18 })];
    if (cellS && typeof cellS.v === 'number') cellS.z = '#,##0';

    // AA (26): Tiền gốc biến động
    const cellAA = worksheet[XLSX.utils.encode_cell({ r, c: 26 })];
    if (cellAA && typeof cellAA.v === 'number') cellAA.z = '#,##0';

    // AB (27): Lãi thực nhận biến động
    const cellAB = worksheet[XLSX.utils.encode_cell({ r, c: 27 })];
    if (cellAB && typeof cellAB.v === 'number') cellAB.z = '#,##0.0#';
  }

  // Thêm sheet cấu hình ẩn __CONFIG__ để bảo toàn toàn bộ thiết lập và quyền hạn
  const configPayload = Object.fromEntries(Object.entries({
    schemaVersion: 2,
    updatedAt: new Date().toISOString(),
    ...(metadata || {}),
  }).filter(([, value]) => value !== undefined && value !== null && value !== ''));

  const configMatrix: (string | number)[][] = [
    ['__METADATA_JSON__', JSON.stringify(configPayload)],
    ['Vault Name', metadata?.vaultName || 'Sổ Tiết Kiệm'],
    ['Schema Version', 2],
    ['Last Updated', new Date().toLocaleString('vi-VN')],
    ...(metadata?.adminEmail ? [['Admin Email', metadata.adminEmail] as [string, string]] : []),
  ];

  const wsConfig = XLSX.utils.aoa_to_sheet(configMatrix);
  XLSX.utils.book_append_sheet(workbook, wsConfig, '__CONFIG__');

  return workbook;
}

export async function getSavingsExcelArrayBuffer(
  books: SavingsBook[],
  annualHistory?: AnnualInterestRecord[],
  balanceHistory?: BalanceGrowthRecord[],
  settlements?: SettlementAdjustment[]
): Promise<Uint8Array> {
  const XLSX = await getXLSX();
  const workbook = await buildSavingsWorkbook(books, annualHistory, balanceHistory, settlements);
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

/**
 * Exports current savings books to an Excel (.xlsx) file
 */
export async function exportSavingsBooksToExcel(
  books: SavingsBook[],
  fileName = 'So_Tiet_Kiem_Gia_Dinh_37Ty.xlsx',
  annualHistory?: AnnualInterestRecord[],
  balanceHistory?: BalanceGrowthRecord[],
  settlements?: SettlementAdjustment[]
): Promise<void> {
  const XLSX = await getXLSX();
  const workbook = await buildSavingsWorkbook(books, annualHistory, balanceHistory, settlements);

  if (Capacitor.isNativePlatform()) {
    try {
      const b64Data = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
      const writeResult = await Filesystem.writeFile({
        path: fileName,
        data: b64Data,
        directory: Directory.Cache,
      });
      await Share.share({
        title: 'Xuất file Excel',
        url: writeResult.uri,
      });
    } catch (err) {
      console.error('Lỗi khi xuất file Excel trên mobile:', err);
      alert('Không thể xuất file: ' + (err instanceof Error ? err.message : String(err)));
    }
  } else {
    XLSX.writeFile(workbook, fileName);
  }
}

/**
 * Xuất file Mẫu Bảng Dữ Liệu Chuẩn Hóa (.xlsx) kèm bảng Hướng dẫn định nghĩa trường thông tin
 */
export async function exportStandardTemplateExcel(fileName = 'Mau_Bang_Du_Lieu_So_Tiet_Kiem_Chuan.xlsx'): Promise<void> {
  const XLSX = await getXLSX();
  const sampleMatrix: (string | number)[][] = [
    // Row 0: 19 Canonical Headers
    STANDARDIZED_SHEET_HEADERS,
    // Sample Row 1
    ['SHB', 'Chồng', 'Tại quầy', '6,80%', 1100, '22/8/2025', '22/8/2026', 12, 11, 74.8, 74.8, '08/26', '', 2021, 1400, '', 2021, 23000, 2500],
    // Sample Row 2
    ['SEA', 'Chồng', 'Tại quầy', '6,55%', 1000, '15/9/2025', '15/9/2026', 12, 12, 65.5, 65.5, '09/26', '', 2022, 1650, '', 2022, 26500, 2700],
    // Sample Row 3
    ['VCB', 'Vợ', 'Online', '5,60%', 2000, '10/10/2025', '10/10/2026', 12, 13, 112, 112, '10/26', '', 2023, 1900, '', 2023, 29000, 3100],
    // Sample Row 4
    ['TCB', 'Vợ', 'Tại quầy', '6,20%', 1500, '05/11/2025', '05/11/2026', 12, 14, 93, 93, '11/26', '', 2024, 2100, '', 2024, 32000, 3400],
    // Sample Row 5
    ['MB', 'Chồng', 'Online', '6,10%', 800, '18/12/2025', '18/12/2026', 12, 15, 48.8, 48.8, '12/26', '', 2025, 2350, '', 2025, 34500, 3600],
  ];

  const wsData = XLSX.utils.aoa_to_sheet(sampleMatrix);
  wsData['!cols'] = CANONICAL_COLUMNS.map((col) => ({ wch: col.width }));

  // Sheet 2: Data Dictionary & Field Instructions
  const guideMatrix: (string | number)[][] = [
    ['CỘT', 'TÊN TRƯỜNG THÔNG TIN', 'BẮT BUỘC', 'KIỂU DỮ LIỆU', 'VÍ DỤ', 'MÔ TẢ CHI TIẾT & QUY TẮC CHUẨN HÓA'],
    ...CANONICAL_COLUMNS.map((col) => [
      col.excelCol,
      col.header || `(Phân cách ${col.excelCol})`,
      col.required ? 'Bắt buộc' : 'Tùy chọn',
      col.dataType,
      String(col.example),
      col.description,
    ]),
  ];

  const wsGuide = XLSX.utils.aoa_to_sheet(guideMatrix);
  wsGuide['!cols'] = [
    { wch: 8 },  // Cột
    { wch: 24 }, // Tên trường
    { wch: 12 }, // Bắt buộc
    { wch: 16 }, // Kiểu dữ liệu
    { wch: 16 }, // Ví dụ
    { wch: 60 }, // Mô tả
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, wsData, 'SoTietKiem_Chuan');
  XLSX.utils.book_append_sheet(workbook, wsGuide, 'HuongDan_DinhNghiaTruong');

  if (Capacitor.isNativePlatform()) {
    try {
      const b64Data = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
      const writeResult = await Filesystem.writeFile({
        path: fileName,
        data: b64Data,
        directory: Directory.Cache,
      });
      await Share.share({
        title: 'Xuất file Excel',
        url: writeResult.uri,
      });
    } catch (err) {
      console.error('Lỗi khi xuất mẫu Excel trên mobile:', err);
      alert('Không thể xuất mẫu: ' + (err instanceof Error ? err.message : String(err)));
    }
  } else {
    XLSX.writeFile(workbook, fileName);
  }
}
