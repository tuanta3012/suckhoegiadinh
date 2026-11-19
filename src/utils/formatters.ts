/**
 * Date and Vietnamese person-name normalization utilities.
 */

export function formatDateVN(dateStr?: string | null, padZeros: boolean = true): string {
  if (!dateStr || !dateStr.trim()) return '';
  const trimmed = dateStr.trim();

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(trimmed)) {
    const parts = trimmed.split('/');
    if (padZeros) {
      return `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
    }
    return trimmed;
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return padZeros
      ? `${day.padStart(2, '0')}/${month.padStart(2, '0')}/${year}`
      : `${parseInt(day, 10)}/${parseInt(month, 10)}/${year}`;
  }

  try {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) {
      const day = padZeros ? String(d.getDate()).padStart(2, '0') : String(d.getDate());
      const month = padZeros ? String(d.getMonth() + 1).padStart(2, '0') : String(d.getMonth() + 1);
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    }
  } catch {
    // ignore
  }

  return trimmed;
}

/**
 * Chuẩn hóa chuỗi tiếng Việt: loại bỏ dấu, khoảng trắng thừa và ký tự đặc biệt.
 */
export function normalizeVietnamese(str?: string | null): string {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSamePersonName(name1?: string | null, name2?: string | null): boolean {
  if (!name1 || !name2) return false;
  const n1 = normalizeVietnamese(name1);
  const n2 = normalizeVietnamese(name2);
  if (!n1 || !n2) return false;
  if (n1 === n2) return true;

  const cleanPrefixes = (s: string) =>
    s
      .replace(/^(ho va ten|ho ten|ten bn|ten benh nhan|benh nhan|bn|khach hang|nguoi benh|ong|ba|anh|chi|chau|em)\s+/i, '')
      .replace(/\s+(nam|nu|tuoi|\d+\s*t|\d+\s*tuoi)$/i, '')
      .trim();

  const c1 = cleanPrefixes(n1);
  const c2 = cleanPrefixes(n2);
  if (c1 === c2) return true;

  if (c1.length >= 4 && c2.length >= 4) {
    if (c1.includes(c2) || c2.includes(c1)) return true;
  }

  const t1 = c1.split(' ').filter(Boolean);
  const t2 = c2.split(' ').filter(Boolean);
  if (t1.length >= 2 && t2.length >= 2) {
    const first1 = t1[t1.length - 1];
    const last1 = t1[0];
    const first2 = t2[t2.length - 1];
    const last2 = t2[0];
    if (first1 === first2 && last1 === last2) return true;
  }

  return false;
}

/**
 * Tự động chuẩn hóa tên thành viên khi tiếp nhận tài liệu.
 */
export function normalizeVietnameseProperName(
  extractedName?: string | null,
  existingMembers: Array<{ id: string; name: string }> = []
): string {
  if (!extractedName || !extractedName.trim()) return '';
  const cleanName = extractedName
    .replace(/^(ho va ten|ho ten|ten bn|ten benh nhan|benh nhan|bn|khach hang|nguoi benh|ong|ba|anh|chi|chau|em)\s+/i, '')
    .trim();

  for (const m of existingMembers) {
    if (m.name && isSamePersonName(cleanName, m.name)) {
      return m.name;
    }
  }

  return cleanName
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
