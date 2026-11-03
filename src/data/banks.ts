import { BankInfo, SavingsBook } from '../types';

export function syncBanksConfigToDrive(banks: BankInfo[]) {
  if (typeof window === 'undefined') return;
  try {
    const token = localStorage.getItem('google_drive_access_token_v4') || localStorage.getItem('google_access_token') || sessionStorage.getItem('google_access_token');
    if (token) {
      import('../utils/googleDriveService').then(({ saveMasterSyncStateOnDrive }) => {
        saveMasterSyncStateOnDrive(token, { status: 'active', banksConfig: banks }).catch(() => {});
      });
    }
  } catch {}
}

/**
 * Dispatch an event when banks are modified locally or synced remotely
 */
export function dispatchBanksUpdated(banks?: BankInfo[]) {
  if (typeof window !== 'undefined') {
    const list = banks || getAllBanks();
    window.dispatchEvent(new CustomEvent('banks-updated', { detail: list }));
  }
}

/**
 * Cập nhật cấu hình danh sách ngân hàng từ nguồn đám mây (Firestore / Google Drive)
 */
export function updateBanksFromRemote(remoteBanks: BankInfo[]): boolean {
  if (!Array.isArray(remoteBanks) || remoteBanks.length === 0) return false;
  try {
    const currentList = getAllBanks();
    const cleanedRemote = remoteBanks.map(cleanStandardBank);
    
    // So sánh nhanh chuỗi JSON để tránh kích hoạt lại không cần thiết
    const currentStr = JSON.stringify(currentList);
    const remoteStr = JSON.stringify(cleanedRemote);
    if (currentStr === remoteStr) {
      return false;
    }

    localStorage.setItem(BANKS_STORAGE_KEY, remoteStr);
    dispatchBanksUpdated(cleanedRemote);
    return true;
  } catch (err) {
    console.warn('Lỗi khi cập nhật cấu hình ngân hàng từ Firestore:', err);
    return false;
  }
}

export function getBankShortCode(bankIdOrName: string = '', bookCode: string = ''): string {
  if (bookCode && bookCode.includes('-')) {
    const prefix = bookCode.split('-')[0].trim().toUpperCase();
    if (prefix.length >= 2 && prefix.length <= 6) {
      return prefix;
    }
  }
  const clean = (bankIdOrName || '').trim().toUpperCase();
  if (clean === 'SEABANK') return 'SEA';
  if (clean === 'VIETCOMBANK') return 'VCB';
  if (clean === 'TECHCOMBANK') return 'TCB';
  if (clean === 'VIETINBANK') return 'CTG';
  if (clean === 'AGRIBANK') return 'VBA';
  if (clean === 'MBBANK') return 'MBB';
  if (clean === 'VPBANK') return 'VPB';
  if (clean === 'SACOMBANK') return 'STB';
  if (clean === 'TPBANK') return 'TPB';
  if (clean === 'HDBANK') return 'HDB';

  const matched = POPULAR_BANKS.find(
    (b) =>
      b.id.toLowerCase() === (bankIdOrName || '').toLowerCase() ||
      b.name.toUpperCase() === clean ||
      b.shortName.toUpperCase() === clean ||
      b.code.toUpperCase() === clean
  );
  if (matched) return matched.code;

  return clean || 'NH';
}

export const POPULAR_BANKS: BankInfo[] = [
  {
    id: 'seabank',
    name: 'SeABank',
    shortName: 'SeABank',
    code: 'SEA',
    primaryColor: '#be123c',
    textColor: '#ffffff',
    bgLight: '#ffe4e6',
    borderColor: '#fecdd3',
    defaultLoanMargin: 1.5,
    maxLTV: 1.0, // Khách VIP vay 100% giá trị sổ
  },
  {
    id: 'shb',
    name: 'SHB',
    shortName: 'SHB',
    code: 'SHB',
    primaryColor: '#d97706',
    textColor: '#ffffff',
    bgLight: '#fef3c7',
    borderColor: '#fde68a',
    defaultLoanMargin: 1.5,
    maxLTV: 1.0, // Khách VIP vay 100% giá trị sổ
  },
  {
    id: 'vietcombank',
    name: 'Vietcombank',
    shortName: 'Vietcombank',
    code: 'VCB',
    primaryColor: '#15803d',
    textColor: '#ffffff',
    bgLight: '#dcfce7',
    borderColor: '#86efac',
    defaultLoanMargin: 1.5,
    maxLTV: 1.0,
  },
  {
    id: 'bidv',
    name: 'BIDV',
    shortName: 'BIDV',
    code: 'BIDV',
    primaryColor: '#0e7490',
    textColor: '#ffffff',
    bgLight: '#cffafe',
    borderColor: '#a5f3fc',
    defaultLoanMargin: 1.5,
    maxLTV: 1.0,
  },
  {
    id: 'techcombank',
    name: 'Techcombank',
    shortName: 'Techcombank',
    code: 'TCB',
    primaryColor: '#e11d48',
    textColor: '#ffffff',
    bgLight: '#ffe4e6',
    borderColor: '#fecdd3',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'mbbank',
    name: 'MBBank',
    shortName: 'MBBank',
    code: 'MBB',
    primaryColor: '#1d4ed8',
    textColor: '#ffffff',
    bgLight: '#dbeafe',
    borderColor: '#bfdbfe',
    defaultLoanMargin: 1.5,
    maxLTV: 0.95,
  },
  {
    id: 'vpbank',
    name: 'VPBank',
    shortName: 'VPBank',
    code: 'VPB',
    primaryColor: '#16a34a',
    textColor: '#ffffff',
    bgLight: '#dcfce7',
    borderColor: '#86efac',
    defaultLoanMargin: 2.0,
    maxLTV: 0.95,
  },
  {
    id: 'acb',
    name: 'ACB',
    shortName: 'ACB',
    code: 'ACB',
    primaryColor: '#0284c7',
    textColor: '#ffffff',
    bgLight: '#e0f2fe',
    borderColor: '#bae6fd',
    defaultLoanMargin: 1.6,
    maxLTV: 0.95,
  },
  {
    id: 'agribank',
    name: 'Agribank',
    shortName: 'Agribank',
    code: 'AGRI',
    primaryColor: '#881337',
    textColor: '#ffffff',
    bgLight: '#ffe4e6',
    borderColor: '#fecdd3',
    defaultLoanMargin: 1.5,
    maxLTV: 1.0,
  },
  {
    id: 'vietinbank',
    name: 'VietinBank',
    shortName: 'VietinBank',
    code: 'CTG',
    primaryColor: '#0369a1',
    textColor: '#ffffff',
    bgLight: '#e0f2fe',
    borderColor: '#bae6fd',
    defaultLoanMargin: 1.5,
    maxLTV: 1.0,
  },
  {
    id: 'hdbank',
    name: 'HDBank',
    shortName: 'HDBank',
    code: 'HDB',
    primaryColor: '#c2410c',
    textColor: '#ffffff',
    bgLight: '#ffedd5',
    borderColor: '#fed7aa',
    defaultLoanMargin: 2.0,
    maxLTV: 0.90,
  },
  {
    id: 'vib',
    name: 'VIB',
    shortName: 'VIB',
    code: 'VIB',
    primaryColor: '#0ea5e9',
    textColor: '#ffffff',
    bgLight: '#e0f2fe',
    borderColor: '#bae6fd',
    defaultLoanMargin: 1.9,
    maxLTV: 0.95,
  },
  {
    id: 'tpbank',
    name: 'TPBank',
    shortName: 'TPBank',
    code: 'TPB',
    primaryColor: '#7e22ce',
    textColor: '#ffffff',
    bgLight: '#f3e8ff',
    borderColor: '#e9d5ff',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'lpbank',
    name: 'LPBank',
    shortName: 'LPBank',
    code: 'LPB',
    primaryColor: '#b45309',
    textColor: '#ffffff',
    bgLight: '#fef3c7',
    borderColor: '#fde68a',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'sacombank',
    name: 'Sacombank',
    shortName: 'Sacombank',
    code: 'STB',
    primaryColor: '#034ea2',
    textColor: '#ffffff',
    bgLight: '#eff6ff',
    borderColor: '#bfdbfe',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'msb',
    name: 'MSB',
    shortName: 'MSB',
    code: 'MSB',
    primaryColor: '#ea580c',
    textColor: '#ffffff',
    bgLight: '#fff7ed',
    borderColor: '#ffedd5',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'ocb',
    name: 'OCB',
    shortName: 'OCB',
    code: 'OCB',
    primaryColor: '#15803d',
    textColor: '#ffffff',
    bgLight: '#f0fdf4',
    borderColor: '#bbf7d0',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'namabank',
    name: 'Nam A Bank',
    shortName: 'Nam A Bank',
    code: 'NAB',
    primaryColor: '#ca8a04',
    textColor: '#ffffff',
    bgLight: '#fefce8',
    borderColor: '#fef08a',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'bacabank',
    name: 'Bac A Bank',
    shortName: 'Bac A Bank',
    code: 'BAB',
    primaryColor: '#0891b2',
    textColor: '#ffffff',
    bgLight: '#ecfeff',
    borderColor: '#a5f3fc',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'ncb',
    name: 'NCB',
    shortName: 'NCB',
    code: 'NCB',
    primaryColor: '#0284c7',
    textColor: '#ffffff',
    bgLight: '#f0f9ff',
    borderColor: '#bae6fd',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'pvcombank',
    name: 'PVcomBank',
    shortName: 'PVcomBank',
    code: 'PVB',
    primaryColor: '#d97706',
    textColor: '#ffffff',
    bgLight: '#fffbeb',
    borderColor: '#fde68a',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
  {
    id: 'baovietbank',
    name: 'BaoViet Bank',
    shortName: 'BaoViet Bank',
    code: 'BVB',
    primaryColor: '#7c3aed',
    textColor: '#ffffff',
    bgLight: '#f5f3ff',
    borderColor: '#ddd6fe',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  },
];

export const BANKS_STORAGE_KEY = 'savings_banks_registry_v7';

// Từ điển chuẩn hóa tên tiếng Anh rút gọn & mã viết tắt cho toàn bộ ngân hàng
const STANDARD_BANK_NAMES: Record<string, { name: string; shortName: string; code: string }> = {
  seabank: { name: 'SeABank', shortName: 'SeABank', code: 'SEA' },
  shb: { name: 'SHB', shortName: 'SHB', code: 'SHB' },
  vietcombank: { name: 'Vietcombank', shortName: 'Vietcombank', code: 'VCB' },
  bidv: { name: 'BIDV', shortName: 'BIDV', code: 'BIDV' },
  techcombank: { name: 'Techcombank', shortName: 'Techcombank', code: 'TCB' },
  mbbank: { name: 'MBBank', shortName: 'MBBank', code: 'MBB' },
  vpbank: { name: 'VPBank', shortName: 'VPBank', code: 'VPB' },
  acb: { name: 'ACB', shortName: 'ACB', code: 'ACB' },
  agribank: { name: 'Agribank', shortName: 'Agribank', code: 'AGRI' },
  vietinbank: { name: 'VietinBank', shortName: 'VietinBank', code: 'CTG' },
  hdbank: { name: 'HDBank', shortName: 'HDBank', code: 'HDB' },
  vib: { name: 'VIB', shortName: 'VIB', code: 'VIB' },
  tpbank: { name: 'TPBank', shortName: 'TPBank', code: 'TPB' },
  lpbank: { name: 'LPBank', shortName: 'LPBank', code: 'LPB' },
  sacombank: { name: 'Sacombank', shortName: 'Sacombank', code: 'STB' },
  msb: { name: 'MSB', shortName: 'MSB', code: 'MSB' },
  ocb: { name: 'OCB', shortName: 'OCB', code: 'OCB' },
  namabank: { name: 'Nam A Bank', shortName: 'Nam A Bank', code: 'NAB' },
  bacabank: { name: 'Bac A Bank', shortName: 'Bac A Bank', code: 'BAB' },
  ncb: { name: 'NCB', shortName: 'NCB', code: 'NCB' },
  pvcombank: { name: 'PVcomBank', shortName: 'PVcomBank', code: 'PVB' },
  baovietbank: { name: 'BaoViet Bank', shortName: 'BaoViet Bank', code: 'BVB' },
  scb: { name: 'SCB', shortName: 'SCB', code: 'SCB' },
};

/**
 * Tự động làm sạch & nhất quán tên ngân hàng:
 * Chỉ giữ lại mã viết tắt (VCB, SHB...) và tên tiếng Anh rút gọn (Vietcombank, SeABank...)
 */
export function cleanStandardBank(bank: BankInfo): BankInfo {
  const idKey = (bank.id || '').toLowerCase();
  if (STANDARD_BANK_NAMES[idKey]) {
    const std = STANDARD_BANK_NAMES[idKey];
    return {
      ...bank,
      name: std.name,
      shortName: std.shortName,
      code: std.code,
    };
  }

  // Đối với ngân hàng tùy biến, nếu tên còn chứa 'Ngân hàng Đông Nam Á (SeABank)' -> rút gọn về 'SeABank'
  let cleanName = (bank.name || bank.shortName || '').trim();
  const matchParentheses = cleanName.match(/\(([^)]+)\)/);
  if (matchParentheses && matchParentheses[1]) {
    cleanName = matchParentheses[1].trim();
  } else {
    cleanName = cleanName
      .replace(/^Ngân\s+hàng\s+(?:TMCP\s+)?/i, '')
      .replace(/^NH\s+(?:TMCP\s+)?/i, '')
      .trim();
  }

  const cleanShort = (bank.shortName || cleanName).trim()
    .replace(/^Ngân\s+hàng\s+(?:TMCP\s+)?/i, '')
    .trim();

  const finalName = cleanName || cleanShort || bank.id.toUpperCase();
  const finalShort = cleanShort || finalName;
  const finalCode = (bank.code || finalShort.slice(0, 4)).toUpperCase().replace(/[^A-Z0-9]/g, '');

  return {
    ...bank,
    name: finalName,
    shortName: finalShort,
    code: finalCode,
  };
}

/**
 * Lấy toàn bộ danh sách ngân hàng hiện hành (Đã bao gồm thêm/sửa/xóa tùy chỉnh và tự động làm sạch tên)
 */
export function getAllBanks(): BankInfo[] {
  try {
    // Kiểm tra kho v5 trước, nếu chưa có thì kiểm tra v4 cũ để migrate dữ liệu người dùng
    let raw = localStorage.getItem(BANKS_STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem('savings_banks_registry_v4');
    }

    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const cleanedList = parsed.map(cleanStandardBank);
        // Lưu lại phiên bản đã làm sạch vào storage
        try {
          localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(cleanedList));
        } catch {}
        return cleanedList;
      }
    }
  } catch {
    // ignore
  }

  const defaultCleaned = POPULAR_BANKS.map(cleanStandardBank);
  try {
    localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(defaultCleaned));
  } catch {}
  return defaultCleaned;
}

/**
 * Thêm hoặc Cập nhật (Sửa) thông tin ngân hàng
 */
export function saveBank(bank: Partial<BankInfo> & { name: string; shortName?: string; code?: string }): BankInfo {
  const currentList = getAllBanks();
  const rawId = (bank.id || bank.shortName || bank.name || `bank-${Date.now()}`)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const existingIndex = currentList.findIndex((b) => b.id.toLowerCase() === (bank.id || rawId).toLowerCase());

  const palette = [
    { primary: '#0284c7', bg: '#f0f9ff', border: '#bae6fd' },
    { primary: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
    { primary: '#d97706', bg: '#fffbeb', border: '#fde68a' },
    { primary: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
    { primary: '#e11d48', bg: '#fff1f2', border: '#fecdd3' },
    { primary: '#0891b2', bg: '#ecfeff', border: '#a5f3fc' },
    { primary: '#4f46e5', bg: '#eef2ff', border: '#c7d2fe' },
    { primary: '#ca6805', bg: '#fff7ed', border: '#fed7aa' },
  ];

  if (existingIndex >= 0) {
    // Sửa thông tin ngân hàng hiện tại
    const existing = currentList[existingIndex];
    const updatedBank: BankInfo = {
      ...existing,
      ...bank,
      name: bank.name.trim(),
      shortName: bank.shortName?.trim() || bank.name.trim(),
      code: bank.code?.trim().toUpperCase() || existing.code,
      defaultLoanMargin: bank.defaultLoanMargin !== undefined ? Number(bank.defaultLoanMargin) : existing.defaultLoanMargin,
      maxLTV: bank.maxLTV !== undefined ? Number(bank.maxLTV) : existing.maxLTV,
      primaryColor: bank.primaryColor || existing.primaryColor,
      bgLight: bank.bgLight || existing.bgLight,
      borderColor: bank.borderColor || existing.borderColor,
      worksOnSaturday: bank.worksOnSaturday !== undefined ? !!bank.worksOnSaturday : existing.worksOnSaturday,
    };
    currentList[existingIndex] = updatedBank;
    try {
      localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(currentList));
    } catch {}
    dispatchBanksUpdated(currentList);
    syncBanksConfigToDrive(currentList);
    return updatedBank;
  } else {
    // Thêm ngân hàng mới
    const id = rawId.startsWith('bank-') || rawId.startsWith('custom-') ? rawId : `custom-${rawId}`;
    const shortName = bank.shortName?.trim() || bank.name.trim();
    const code = bank.code?.trim().toUpperCase() || shortName.slice(0, 4).toUpperCase();
    const chosenColor = palette[Math.abs(id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % palette.length];

    const newBank: BankInfo = {
      id,
      name: bank.name.trim(),
      shortName,
      code,
      primaryColor: bank.primaryColor || chosenColor.primary,
      textColor: '#ffffff',
      bgLight: bank.bgLight || chosenColor.bg,
      borderColor: bank.borderColor || chosenColor.border,
      defaultLoanMargin: bank.defaultLoanMargin !== undefined ? Number(bank.defaultLoanMargin) : 1.8,
      maxLTV: bank.maxLTV !== undefined ? Number(bank.maxLTV) : 0.95,
      worksOnSaturday: bank.worksOnSaturday !== undefined ? !!bank.worksOnSaturday : false,
    };

    const updatedList = [newBank, ...currentList];
    try {
      localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(updatedList));
    } catch {}
    dispatchBanksUpdated(updatedList);
    syncBanksConfigToDrive(updatedList);
    return newBank;
  }
}

/**
 * Xóa (Bớt) ngân hàng khỏi danh sách
 */
export function deleteBank(bankId: string): boolean {
  const currentList = getAllBanks();
  const updatedList = currentList.filter((b) => b.id.toLowerCase() !== bankId.toLowerCase());
  try {
    localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(updatedList));
  } catch {}
  dispatchBanksUpdated(updatedList);
  syncBanksConfigToDrive(updatedList);
  return true;
}

/**
 * Khôi phục danh sách ngân hàng về mặc định
 */
export function resetBanksToDefault(): BankInfo[] {
  const defaultCleaned = POPULAR_BANKS.map(cleanStandardBank);
  try {
    localStorage.setItem(BANKS_STORAGE_KEY, JSON.stringify(defaultCleaned));
  } catch {}
  dispatchBanksUpdated(defaultCleaned);
  syncBanksConfigToDrive(defaultCleaned);
  return [...defaultCleaned];
}

// Giữ lại alias cho tính tương thích
export const saveCustomBank = saveBank;

export function getBankById(bankId: string): BankInfo {
  const all = getAllBanks();
  const found = all.find((b) => b.id.toLowerCase() === bankId.toLowerCase());
  if (found) return cleanStandardBank(found);

  const fallback: BankInfo = {
    id: bankId,
    name: bankId,
    shortName: bankId.toUpperCase(),
    code: bankId.toUpperCase().slice(0, 4),
    primaryColor: '#334155',
    textColor: '#ffffff',
    bgLight: '#f1f5f9',
    borderColor: '#cbd5e1',
    defaultLoanMargin: 1.8,
    maxLTV: 0.95,
  };
  return cleanStandardBank(fallback);
}

export interface BankWithUsage extends BankInfo {
  bookCount: number;
  totalPrincipal: number;
}

/**
 * Sắp xếp danh sách ngân hàng theo các ngân hàng hay gửi nhất
 * (Dựa trên số lượng sổ và tổng tiền gửi hiện có trong danh mục)
 */
export function getSortedBanksByUsage(books: SavingsBook[] = []): {
  frequentBanks: BankWithUsage[];
  otherBanks: BankWithUsage[];
  allSorted: BankWithUsage[];
} {
  const all = getAllBanks();

  // Đếm số lượng sổ và tổng tiền theo từng ngân hàng
  const statsMap = new Map<string, { count: number; principal: number }>();
  for (const book of books) {
    if (book.status !== 'active') continue;
    const current = statsMap.get(book.bankId.toLowerCase()) || { count: 0, principal: 0 };
    current.count += 1;
    current.principal += book.principal;
    statsMap.set(book.bankId.toLowerCase(), current);
  }

  const enriched: BankWithUsage[] = all.map((b) => {
    const stats = statsMap.get(b.id.toLowerCase()) || { count: 0, principal: 0 };
    return {
      ...b,
      bookCount: stats.count,
      totalPrincipal: stats.principal,
    };
  });

  // Chia làm 2 nhóm: Nhóm có sổ đang gửi (ưu tiên số lượng sổ DESC, tiền gửi DESC)
  const frequentBanks = enriched
    .filter((b) => b.bookCount > 0)
    .sort((a, b) => {
      if (b.bookCount !== a.bookCount) return b.bookCount - a.bookCount;
      return b.totalPrincipal - a.totalPrincipal;
    });

  // Nhóm chưa có sổ đang gửi (sắp xếp theo bảng chữ cái)
  const otherBanks = enriched
    .filter((b) => b.bookCount === 0)
    .sort((a, b) => a.shortName.localeCompare(b.shortName));

  return {
    frequentBanks,
    otherBanks,
    allSorted: [...frequentBanks, ...otherBanks],
  };
}
