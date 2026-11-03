/**
 * Formatters for Vietnamese currency, numbers, and dates
 */

// Module-level Singleton Caching for high-performance formatting
const VND_CURRENCY_FORMATTER = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
});

const VN_NUMBER_FORMATTER_0DEC = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 0,
});

const VN_NUMBER_FORMATTER_1DEC = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 1,
});

const VN_NUMBER_FORMATTER_2DEC = new Intl.NumberFormat('vi-VN', {
  maximumFractionDigits: 2,
});

/**
 * Định dạng phần trăm chuẩn Việt Nam (sử dụng dấu phẩy làm phân cách thập phân).
 * Ví dụ: 8.2 -> "8,20%", 6.55 -> "6,55%", 8 -> "8,00%" (hoặc gọn "8,2%" nếu tùy chỉnh)
 */
export function formatPercent(
  rate: number | string | null | undefined,
  decimals: number = 2
): string {
  if (rate === null || rate === undefined || rate === '') return '0%';
  const num = typeof rate === 'string' ? parseFloat(rate.replace(',', '.')) : rate;
  if (isNaN(num)) return '0%';
  const formatted = num.toFixed(decimals).replace('.', ',');
  return `${formatted}%`;
}

/**
 * Định dạng số thập phân chuẩn Việt Nam (dấu phẩy cách thập phân, dấu chấm cách hàng nghìn).
 * Ví dụ: 3.8 -> "3,8", 1234.5 -> "1.234,5"
 */
export function formatDecimal(
  val: number | string | null | undefined,
  decimals: number = 1
): string {
  if (val === null || val === undefined || val === '') return '0';
  const num = typeof val === 'string' ? parseFloat(val.replace(',', '.')) : val;
  if (isNaN(num)) return '0';
  return new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  }).format(num);
}

export function formatVND(amount: number, hideAmount: boolean = false): string {
  if (hideAmount) {
    return '•••••••• đ';
  }
  return VND_CURRENCY_FORMATTER.format(amount);
}

export function formatMillionVND(amount: number, hideAmount: boolean = false): string {
  if (hideAmount) {
    return '••••••';
  }
  const mil = amount / 1_000_000;
  return `${VN_NUMBER_FORMATTER_1DEC.format(mil)} Tr VNĐ`;
}

/**
 * Định dạng tiền tệ thích ứng thông minh (Tỷ / Triệu VNĐ)
 * - Số tiền >= 1 Tỷ (1.000.000.000 đ): Hiển thị dạng "X,XX Tỷ VNĐ" (ví dụ: 18,45 Tỷ VNĐ)
 * - Số tiền < 1 Tỷ: Hiển thị dạng "XXX,X Tr VNĐ" (ví dụ: 450 Tr VNĐ)
 */
export function formatAdaptiveVND(amount: number, hideAmount: boolean = false, maxDecimals: number = 2): string {
  if (hideAmount) {
    return '••••••';
  }
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  if (abs >= 1_000_000_000) {
    const ty = abs / 1_000_000_000;
    const fmt = maxDecimals === 1 ? VN_NUMBER_FORMATTER_1DEC : (maxDecimals === 0 ? VN_NUMBER_FORMATTER_0DEC : VN_NUMBER_FORMATTER_2DEC);
    return `${sign}${fmt.format(ty)} Tỷ VNĐ`;
  }
  if (abs >= 1_000_000) {
    const mil = abs / 1_000_000;
    return `${sign}${VN_NUMBER_FORMATTER_1DEC.format(mil)} Tr VNĐ`;
  }
  if (abs >= 1_000) {
    const k = abs / 1_000;
    return `${sign}${VN_NUMBER_FORMATTER_0DEC.format(k)} K VNĐ`;
  }
  return `${sign}${VN_NUMBER_FORMATTER_0DEC.format(abs)} đ`;
}

/**
 * Định dạng tiền tệ ngắn gọn thích ứng (Tỷ / Tr)
 * - >= 1 Tỷ: "18,45 Tỷ"
 * - >= 1 Triệu: "450 Tr"
 * - >= 1 Nghìn: "500 K"
 */
export function formatAdaptiveShortVND(amount: number, hideAmount: boolean = false, maxDecimals: number = 2): string {
  if (hideAmount) {
    return '••••••';
  }
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';

  if (abs >= 1_000_000_000) {
    const ty = abs / 1_000_000_000;
    const fmt = maxDecimals === 1 ? VN_NUMBER_FORMATTER_1DEC : (maxDecimals === 0 ? VN_NUMBER_FORMATTER_0DEC : VN_NUMBER_FORMATTER_2DEC);
    return `${sign}${fmt.format(ty)} Tỷ`;
  }
  if (abs >= 1_000_000) {
    const tr = abs / 1_000_000;
    return `${sign}${VN_NUMBER_FORMATTER_1DEC.format(tr)} Tr`;
  }
  if (abs >= 1_000) {
    const k = abs / 1_000;
    return `${sign}${VN_NUMBER_FORMATTER_0DEC.format(k)} K`;
  }
  return `${sign}${VN_NUMBER_FORMATTER_0DEC.format(abs)} đ`;
}

export function formatShortVND(amount: number, hideAmount: boolean = false): string {
  if (hideAmount) {
    return '••••••';
  }
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  
  if (abs >= 1_000_000) {
    const tr = abs / 1_000_000;
    return `${sign}${VN_NUMBER_FORMATTER_1DEC.format(tr)} Tr`;
  }
  if (abs >= 1_000) {
    const k = abs / 1_000;
    return `${sign}${VN_NUMBER_FORMATTER_0DEC.format(k)} K`;
  }
  return `${sign}${VN_NUMBER_FORMATTER_0DEC.format(abs)} đ`;
}

export function formatDateVN(dateStr: string, padZeros: boolean = false): string {
  if (!dateStr) return '';
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    if (!year || !month || !day) return dateStr;
    if (padZeros) {
      return `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
    }
    return `${day}/${month}/${year}`;
  } catch {
    return dateStr;
  }
}

export function formatRelativeDays(days: number): string {
  if (days < 0) {
    return `Đã quá hạn ${Math.abs(days)} ngày`;
  }
  if (days === 0) {
    return 'Đáo hạn hôm nay!';
  }
  if (days === 1) {
    return 'Đáo hạn ngày mai';
  }
  if (days < 30) {
    return `Còn ${days} ngày nữa`;
  }
  const months = Math.floor(days / 30);
  const remDays = days % 30;
  if (remDays === 0) {
    return `Còn ${months} tháng`;
  }
  return `Còn ~${months} tháng ${remDays} ngày (${days} ngày)`;
}

export function getCustomOwnerNames(): { husbandName: string; wifeName: string } {
  try {
    const saved = localStorage.getItem('savings_settings_v3');
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        husbandName: parsed.husbandName || 'Chồng',
        wifeName: parsed.wifeName || 'Vợ',
      };
    }
  } catch {
    // ignore
  }
  return { husbandName: 'Chồng', wifeName: 'Vợ' };
}

export const DEFAULT_OWNER_TAGS = ['Chồng', 'Vợ', 'Bố', 'Mẹ', 'Con'];

export function getOwnerLabel(owner?: string, fallback = ''): string {
  const { husbandName, wifeName } = getCustomOwnerNames();
  const resolvedFallback = fallback || husbandName;
  if (!owner) return resolvedFallback;
  const lower = owner.trim().toLowerCase().normalize('NFC');
  const lowerHusband = husbandName.toLowerCase().normalize('NFC');
  const lowerWife = wifeName.toLowerCase().normalize('NFC');

  if (lower === 'husband' || lower === 'chong' || lower === 'chồng' || lower === lowerHusband) {
    return husbandName;
  }
  if (lower === 'wife' || lower === 'vo' || lower === 'vợ' || lower === lowerWife) {
    return wifeName;
  }
  if (lower === 'both' || lower === 'cả 2' || lower === 'cả hai') {
    return 'Cả hai';
  }
  if (lower === 'children' || lower === 'con cái') {
    return 'Con';
  }
  return owner.trim();
}

/**
 * Returns stylish Tailwind classes for owner badge based on tag name
 */
export function getOwnerBadgeStyle(owner?: string): { bg: string; text: string; border: string; badgeClass: string } {
  const label = getOwnerLabel(owner);
  const lower = label.toLowerCase();
  const { husbandName, wifeName } = getCustomOwnerNames();
  const lowerHusband = husbandName.toLowerCase().normalize('NFC');
  const lowerWife = wifeName.toLowerCase().normalize('NFC');

  if (lower.includes('chồng') || lower.includes('husband') || lower === lowerHusband) {
    return {
      bg: 'bg-indigo-50',
      text: 'text-indigo-700',
      border: 'border-indigo-200',
      badgeClass: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    };
  }
  if (lower.includes('vợ') || lower.includes('wife') || lower === lowerWife) {
    return {
      bg: 'bg-rose-50',
      text: 'text-rose-700',
      border: 'border-rose-200',
      badgeClass: 'bg-rose-50 text-rose-700 border-rose-200',
    };
  }
  if (lower.includes('bố') || lower.includes('cha')) {
    return {
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      border: 'border-amber-200',
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
    };
  }
  if (lower.includes('mẹ')) {
    return {
      bg: 'bg-purple-50',
      text: 'text-purple-700',
      border: 'border-purple-200',
      badgeClass: 'bg-purple-50 text-purple-700 border-purple-200',
    };
  }
  if (lower.includes('con')) {
    return {
      bg: 'bg-emerald-50',
      text: 'text-emerald-700',
      border: 'border-emerald-200',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    };
  }
  // Deterministic palette for custom owner tags
  const palettes = [
    { bg: 'bg-violet-50', text: 'text-violet-700', border: 'border-violet-200' },
    { bg: 'bg-teal-50', text: 'text-teal-700', border: 'border-teal-200' },
    { bg: 'bg-fuchsia-50', text: 'text-fuchsia-700', border: 'border-fuchsia-200' },
    { bg: 'bg-cyan-50', text: 'text-cyan-700', border: 'border-cyan-200' },
    { bg: 'bg-orange-50', text: 'text-orange-800', border: 'border-orange-200' },
    { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' },
    { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200' },
    { bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-300' },
  ];

  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = label.charCodeAt(i) + ((hash << 5) - hash);
  }
  const selected = palettes[Math.abs(hash) % palettes.length];
  return {
    ...selected,
    badgeClass: `${selected.bg} ${selected.text} ${selected.border}`,
  };
}

/**
 * Format a number or numeric string to Vietnamese dot-separated thousands format.
 * E.g., 200000000 -> "200.000.000"
 */
export function formatNumberWithDots(val: number | string | null | undefined): string {
  if (val === null || val === undefined || val === '') return '';
  const digits = val.toString().replace(/\D/g, '');
  if (!digits) return '';
  const num = parseInt(digits, 10);
  return isNaN(num) ? '' : VN_NUMBER_FORMATTER_0DEC.format(num);
}

/**
 * Parse a dot-separated or formatted string into a plain number.
 * E.g., "200.000.000" -> 200000000
 */
export function parseNumberFromDots(str: string | null | undefined): number {
  if (!str) return 0;
  const digits = str.toString().replace(/\D/g, '');
  if (!digits) return 0;
  const num = parseInt(digits, 10);
  return isNaN(num) ? 0 : num;
}
