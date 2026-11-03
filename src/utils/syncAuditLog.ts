/**
 * Audit log stores data changes and sync inconsistencies, without copying full sheet snapshots.
 */



import type { AuditDevice, SavingsBook, SettlementAdjustment } from '../types';
import { Capacitor } from '@capacitor/core';
import { CURRENT_APP_VERSION } from '../version';

export interface SyncAuditLogEntry {
  id: string;
  timestamp: number; // Unix ms
  timeStr: string; // Định dạng ngày giờ VN (VD: 23/09/2026 18:15:30)
  type: 'SYNC_PUSH' | 'SYNC_PULL' | 'DATA_RESTORE' | 'DATA_DIVERGENCE' | 'CALCULATION' | 'SETTLEMENT_CHANGE' | 'ERROR' | 'SYNC_ERROR' | 'INFO';
  title: string;
  status: 'success' | 'warning' | 'error' | 'info';
  sheetName?: string;
  fileId?: string;
  auditSessionId?: string;
  userEmail?: string;
  userName?: string;
  currentRole?: string;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
  appVersion?: string;
  summary: string;
  details?: {
    activeBooksCount?: number;
    totalPrincipalMillion?: number;
    updatedRanges?: string[];
    annualInterestUpdated?: { year: number; interestMillion: number }[];
    annualInterestPreserved?: number[];
    balanceGrowthUpdated?: { year: number; balanceMillion: number; incomeMillion?: number };
    balanceGrowthPreserved?: number[];
    settlementsCount?: number;
    settlementDetails?: any[];
    source?: string;
    changes?: Array<{
      entity: 'book' | 'settlement' | 'cell';
      id: string;
      action: 'added' | 'updated' | 'removed';
      location?: string;
      fields?: Record<string, { from?: unknown; to?: unknown }>;
    }>;
    truncated?: boolean;
    [key: string]: any;
  };
  errorMessage?: string;
}

const STORAGE_KEY = 'savings_sync_audit_log_v1';
const ACTIVE_SESSION_KEY = 'savings_sync_audit_active_session_v1';
const DEVICE_ID_KEY = 'savings_sync_audit_device_id_v1';
const LAST_FILE_ID_KEY = 'savings_sync_audit_last_file_id_v1';
const MAX_LOG_ENTRIES = 30;

const BOOK_AUDIT_FIELDS: Array<keyof SavingsBook> = [
  'bankId',
  'owner',
  'depositType',
  'principal',
  'interestRate',
  'termMonths',
  'startDate',
  'maturityDate',
  'rolloverOption',
  'status',
  'expectedTermInterest',
  'annualInterestEquivalent',
  'note',
  'tag',
  'settlementDate',
  'isEarlySettled',
  'actualInterestVND',
];

const SETTLEMENT_AUDIT_FIELDS: Array<keyof SettlementAdjustment> = [
  'bookCode',
  'bankId',
  'owner',
  'principal',
  'settlementDate',
  'settlementYear',
  'settlementType',
  'actualInterestVND',
  'expectedTermInterest',
  'lostInterestVND',
  'reinvested',
  'note',
  'originalMaturityYear',
];

function getAuditIdentity(entity: 'book' | 'settlement', record: SavingsBook | SettlementAdjustment): string {
  if (entity === 'settlement') {
    const settlement = record as SettlementAdjustment;
    return String(settlement.id || `${settlement.bookCode}:${settlement.settlementDate}`);
  }
  const book = record as SavingsBook;
  return String(book.bookCode || book.id || '');
}

/**
 * Fingerprint cốt lõi về tài chính để nhận diện sổ ổn định qua các lần
 * nạp/chuẩn hóa mã quy ước.
 */
function getBookFinancialFingerprint(book: SavingsBook): string {
  const bank = String(book.bankId || '').trim().toLowerCase();
  const principal = Math.round(Number(book.principal) || 0);
  const start = String(book.startDate || '').trim();
  const maturity = String(book.maturityDate || '').trim();
  const rate = Number(book.interestRate) || 0;
  const owner = String(book.owner || '').trim().toLowerCase();
  return `${bank}|${principal}|${start}|${maturity}|${rate}|${owner}`;
}

function getSettlementFinancialFingerprint(settlement: SettlementAdjustment): string {
  const code = String(settlement.bookCode || '').trim().toLowerCase();
  const date = String(settlement.settlementDate || '').trim();
  const principal = Math.round(Number(settlement.principal) || 0);
  const interest = Math.round(Number(settlement.actualInterestVND) || 0);
  return `${code}|${date}|${principal}|${interest}`;
}

function compareAuditRecords<T extends SavingsBook | SettlementAdjustment>(
  entity: 'book' | 'settlement',
  previous: T[],
  next: T[],
  fields: Array<keyof T>
): NonNullable<SyncAuditLogEntry['details']>['changes'] {
  const changes: NonNullable<SyncAuditLogEntry['details']>['changes'] = [];
  const extractFields = (record: T, direction: 'from' | 'to') =>
    Object.fromEntries(
      fields
        .map((field) => [String(field), { [direction]: record[field] }])
        .filter(([, value]) => Object.values(value as Record<string, unknown>)
          .some((fieldValue) => fieldValue !== undefined && fieldValue !== null && fieldValue !== ''))
    ) as Record<string, { from?: unknown; to?: unknown }>;

  // Bản đồ tìm kiếm theo ID/mã hiển thị
  const oldById = new Map<string, { record: T; index: number }>();
  previous.forEach((record, index) => {
    const id = getAuditIdentity(entity, record);
    if (id) oldById.set(id, { record, index });
  });

  // Bản đồ tìm kiếm theo dấu vân tay tài chính cốt lõi (nếu ID thay đổi mã số hiển thị)
  const oldByFingerprint = new Map<string, { record: T; index: number; id: string }>();
  previous.forEach((record, index) => {
    const fp = entity === 'book'
      ? getBookFinancialFingerprint(record as SavingsBook)
      : getSettlementFinancialFingerprint(record as SettlementAdjustment);
    if (fp) oldByFingerprint.set(fp, { record, index, id: getAuditIdentity(entity, record) });
  });

  const matchedOldIds = new Set<string>();

  for (let newIndex = 0; newIndex < next.length; newIndex++) {
    const record = next[newIndex];
    const newId = getAuditIdentity(entity, record);
    if (!newId) continue;

    // 1. Thử khớp theo ID chính xác trước
    let oldMatch = oldById.get(newId);
    let matchedId = newId;

    // 2. Nếu không thấy theo ID, thử khớp theo dấu vân tay tài chính
    if (!oldMatch) {
      const fp = entity === 'book'
        ? getBookFinancialFingerprint(record as SavingsBook)
        : getSettlementFinancialFingerprint(record as SettlementAdjustment);
      const fpMatch = oldByFingerprint.get(fp);
      if (fpMatch && !matchedOldIds.has(fpMatch.id)) {
        oldMatch = fpMatch;
        matchedId = fpMatch.id;
      }
    }

    const rowNumber = newIndex + 2; // Dòng 1 là tiêu đề bảng tính
    const location = entity === 'book'
      ? `Bảng sổ tiết kiệm (Dòng ${rowNumber}, cột A-M)`
      : `Bảng tất toán (Dòng ${rowNumber}, cột U-AC)`;

    if (!oldMatch) {
      // Bản ghi mới hoàn toàn
      changes.push({
        entity,
        id: newId,
        action: 'added',
        location,
        fields: extractFields(record, 'to'),
      });
      continue;
    }

    matchedOldIds.add(matchedId);
    const oldRecord = oldMatch.record;

    const changedFields: Record<string, { from?: unknown; to?: unknown }> = {};
    for (const field of fields) {
      const from = oldRecord[field];
      const to = record[field];
      if (JSON.stringify(from) !== JSON.stringify(to)) {
        changedFields[String(field)] = { from, to };
      }
    }

    if (Object.keys(changedFields).length > 0) {
      // Chỉ ghi nhận là updated khi thực sự có trường dữ liệu thay đổi
      changes.push({
        entity,
        id: newId,
        action: 'updated',
        location,
        fields: changedFields,
      });
    }
  }

  // Những bản ghi cũ không còn xuất hiện trong danh sách mới
  previous.forEach((record, oldIndex) => {
    const oldId = getAuditIdentity(entity, record);
    if (oldId && !matchedOldIds.has(oldId)) {
      const rowNumber = oldIndex + 2;
      const location = entity === 'book'
        ? `Bảng sổ tiết kiệm (Dòng ${rowNumber}, cột A-M)`
        : `Bảng tất toán (Dòng ${rowNumber}, cột U-AC)`;

      changes.push({
        entity,
        id: oldId,
        action: 'removed',
        location,
        fields: extractFields(record, 'from'),
      });
    }
  });

  return changes;
}

export function buildSavingsDataAuditDiff(
  previousBooks: SavingsBook[],
  nextBooks: SavingsBook[],
  previousSettlements: SettlementAdjustment[],
  nextSettlements: SettlementAdjustment[]
): { changes: NonNullable<SyncAuditLogEntry['details']>['changes']; truncated: boolean } {
  const changes = [
    ...compareAuditRecords('book', previousBooks, nextBooks, BOOK_AUDIT_FIELDS),
    ...compareAuditRecords('settlement', previousSettlements, nextSettlements, SETTLEMENT_AUDIT_FIELDS),
  ];
  return {
    changes,
    truncated: false,
  };
}

function compactAuditValue(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 1000) : undefined;
  }
  if (Array.isArray(value)) {
    const compacted = value.map(compactAuditValue).filter((item) => item !== undefined);
    return compacted.length ? compacted : undefined;
  }
  if (value && typeof value === 'object') {
    const compacted = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/^columns_[A-Z]+_/.test(key))
        .map(([key, item]) => [key, compactAuditValue(item)])
        .filter(([, item]) => item !== undefined)
    );
    return Object.keys(compacted).length ? compacted : undefined;
  }
  return value === null || value === undefined ? undefined : value;
}

function compactAuditEntry(entry: SyncAuditLogEntry): SyncAuditLogEntry {
  return Object.fromEntries(
    Object.entries(entry)
      .map(([key, value]) => {
        if (key === 'details' && value && typeof value === 'object') {
          const details = Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
              .map(([detailKey, detailValue]) => [
                detailKey,
                detailKey === 'changes' ? detailValue : compactAuditValue(detailValue),
              ])
              .filter(([, detailValue]) => detailValue !== undefined)
          );
          return [key, Object.keys(details).length ? details : undefined];
        }
        const compacted =
          key === 'errorMessage' && typeof value === 'string'
            ? value.slice(0, 1000)
            : compactAuditValue(value);
        return [key, compacted];
      })
      .filter(([, value]) => value !== undefined)
  ) as SyncAuditLogEntry;
}

export function compactAuditLogsForSheet(entries: SyncAuditLogEntry[]): SyncAuditLogEntry[] {
  return entries
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_LOG_ENTRIES)
    .map(compactAuditEntry);
}

export function getSyncAuditDevice(): Pick<AuditDevice, 'deviceId' | 'deviceName' | 'platform'> {
  let deviceId = '';
  try {
    if (typeof localStorage !== 'undefined') {
      deviceId = localStorage.getItem(DEVICE_ID_KEY) || '';
      if (!deviceId) {
        deviceId =
          typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        localStorage.setItem(DEVICE_ID_KEY, deviceId);
      }
    }
  } catch (err) {
    console.warn('Không thể lưu mã nhận diện thiết bị cho audit log:', err);
    deviceId = `device_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  const platform = Capacitor.isNativePlatform()
    ? Capacitor.getPlatform() === 'android' ? 'Android' : Capacitor.getPlatform()
    : 'Web';
  return {
    deviceId,
    deviceName: `${platform} · ${deviceId.slice(-4).toUpperCase()}`,
    platform,
  };
}

export function rememberSyncAuditFileId(fileId: string): void {
  try {
    if (fileId && typeof localStorage !== 'undefined') {
      localStorage.setItem(LAST_FILE_ID_KEY, fileId);
    }
  } catch (err) {
    console.warn('Không thể lưu file gần nhất để đọc audit log Cloud:', err);
  }
}

export function getLastSyncAuditFileId(): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(LAST_FILE_ID_KEY);
  } catch (err) {
    console.warn('Không thể đọc file gần nhất để đọc audit log Cloud:', err);
    return null;
  }
}

export function mergeAuditLogEntries(...sources: Array<SyncAuditLogEntry[] | undefined>): SyncAuditLogEntry[] {
  const merged = new Map<string, SyncAuditLogEntry>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (entry?.id) merged.set(entry.id, entry);
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_LOG_ENTRIES);
}

export function mergeAuditDevices(
  ...sources: Array<AuditDevice[] | undefined>
): AuditDevice[] {
  const merged = new Map<string, AuditDevice>();
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const device of source) {
      if (!device?.deviceId) continue;
      const key = `${device.deviceId}:${device.userEmail?.trim().toLowerCase() || ''}`;
      const previous = merged.get(key);
      merged.set(key, {
        ...previous,
        ...device,
        firstSeenAt: previous?.firstSeenAt || device.firstSeenAt,
        lastSeenAt:
          !previous || device.lastSeenAt > previous.lastSeenAt
            ? device.lastSeenAt
            : previous.lastSeenAt,
      });
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function auditDevicesFromLogs(entries: SyncAuditLogEntry[]): AuditDevice[] {
  const grouped = new Map<string, AuditDevice>();
  for (const entry of entries) {
    if (!entry.deviceId || !entry.deviceName || !entry.platform) continue;
    const timestamp = new Date(entry.timestamp).toISOString();
    const key = `${entry.deviceId}:${entry.userEmail?.trim().toLowerCase() || ''}`;
    const previous = grouped.get(key);
    grouped.set(key, {
      deviceId: entry.deviceId,
      deviceName: entry.deviceName,
      platform: entry.platform,
      userEmail: entry.userEmail,
      firstSeenAt: !previous || timestamp < previous.firstSeenAt ? timestamp : previous.firstSeenAt,
      lastSeenAt: !previous || timestamp > previous.lastSeenAt ? timestamp : previous.lastSeenAt,
    });
  }
  return mergeAuditDevices(Array.from(grouped.values()));
}

interface SyncAuditSession {
  id: string;
  fileId: string;
  startedAt: string;
}

let cloudWriteQueue: Promise<void> = Promise.resolve();

export function getActiveSyncAuditSession(): SyncAuditSession | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as SyncAuditSession;
    return session.id && session.fileId ? session : null;
  } catch (err) {
    console.warn('Lỗi đọc phiên audit log hiện tại:', err);
    return null;
  }
}

export function beginSyncAuditSession(fileId: string, id?: string, startedAt?: string): SyncAuditSession {
  const session: SyncAuditSession = {
    id: id || `audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    fileId,
    startedAt: startedAt || new Date().toISOString(),
  };
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(session));
    rememberSyncAuditFileId(fileId);
  } catch (err) {
    console.warn('Không thể lưu phiên audit log hiện tại:', err);
  }
  return session;
}

export function endSyncAuditSession(fileId?: string): void {
  try {
    const session = getActiveSyncAuditSession();
    if (!session || (fileId && session.fileId !== fileId)) return;
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch (err) {
    console.warn('Không thể đóng phiên audit log hiện tại:', err);
  }
}

export function getSyncAuditLogsForSession(sessionId: string): SyncAuditLogEntry[] {
  if (!sessionId) return [];
  return getSyncAuditLogs().filter((entry) => entry.auditSessionId === sessionId);
}

export function combineSyncAuditLogsForSession(
  sessionId: string,
  ...sources: Array<SyncAuditLogEntry[] | undefined>
): SyncAuditLogEntry[] {
  return mergeAuditLogEntries(
    ...sources,
    getSyncAuditLogs().filter((entry) => entry.auditSessionId === sessionId)
  );
}

export function mergeSyncAuditLogs(entries: SyncAuditLogEntry[]): void {
  if (entries.length === 0) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mergeAuditLogEntries(getSyncAuditLogs(), entries)));
  } catch (err) {
    console.warn('Lỗi hợp nhất audit log của phiên Drive:', err);
  }
}

export function flushSyncAuditLogWrites(): Promise<void> {
  return cloudWriteQueue;
}

/**
 * Đọc toàn bộ danh sách nhật ký kiểm toán từ localStorage
 */
export function getSyncAuditLogs(): SyncAuditLogEntry[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const capped = mergeAuditLogEntries(list);
    if (capped.length !== list.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(capped));
    }
    return capped;
  } catch (err) {
    console.warn('Lỗi đọc audit log từ storage:', err);
    return [];
  }
}

/**
 * Thêm một mục nhật ký kiểm toán mới
 */
export function recordSyncAuditLog(
  entry: Omit<SyncAuditLogEntry, 'id' | 'timestamp' | 'timeStr'>
): SyncAuditLogEntry {
  const now = new Date();
  const timeStr = now.toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const session = getActiveSyncAuditSession();
  const device = getSyncAuditDevice();
  const fullEntry = compactAuditEntry({
    ...entry,
    deviceId: entry.deviceId || device.deviceId,
    deviceName: entry.deviceName || device.deviceName,
    platform: entry.platform || device.platform,
    appVersion: entry.appVersion || CURRENT_APP_VERSION,
    ...(session
      ? {
          fileId: session.fileId,
          auditSessionId: session.id,
        }
      : {}),
    id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    timeStr,
  });

  let updatedLogs: SyncAuditLogEntry[] = [fullEntry];
  try {
    const existing = getSyncAuditLogs();
    updatedLogs = [fullEntry, ...existing].slice(0, MAX_LOG_ENTRIES);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedLogs));
    }
  } catch (err) {
    console.warn('Lỗi lưu audit log:', err);
  }

  if (session && typeof window !== 'undefined') {
    try {
      cloudWriteQueue = cloudWriteQueue
        .then(async () => {
          const activeSession = getActiveSyncAuditSession();
          if (activeSession?.id !== session.id || activeSession.fileId !== session.fileId) return;
          const {
            getGoogleAccessToken,
            getMasterSyncStateFromDrive,
            saveMasterSyncStateToGoogleSheet,
          } = await import('./googleDriveService');
          const token =
            localStorage.getItem('google_drive_access_token_v4') ||
            localStorage.getItem('google_access_token') ||
            sessionStorage.getItem('google_access_token') ||
            getGoogleAccessToken();
          if (!token) return;
          const master = await getMasterSyncStateFromDrive(token, session.fileId);
          if (
            !master ||
            master.status !== 'active' ||
            master.activeFileId !== session.fileId ||
            master.auditSessionId !== session.id
          ) {
            console.info('[SYNC AUDIT] Bỏ qua ghi log vì phiên liên kết trên Drive đã kết thúc hoặc thay đổi.');
            return;
          }
          const fileLogs = getSyncAuditLogs().filter((log) => log.fileId === session.fileId);
          const mergedLogs = mergeAuditLogEntries(
            master.auditLogs,
            fileLogs
          );
          const auditDevices = mergeAuditDevices(
            master.auditDevices,
            auditDevicesFromLogs([fullEntry])
          );
          const saved = await saveMasterSyncStateToGoogleSheet(token, session.fileId, {
            ...master,
            auditSessionId: session.id,
            auditSessionStartedAt: session.startedAt,
            auditSessionEndedAt: undefined,
            auditLogs: mergedLogs,
            auditDevices,
          });
          if (!saved) throw new Error('Google Sheet không xác nhận lưu được audit log.');
        })
        .catch((err) => console.warn('Không thể đồng bộ audit log của phiên Drive hiện tại:', err));
    } catch (err) {
      console.warn('Không thể chuẩn bị đồng bộ audit log của phiên Drive hiện tại:', err);
    }
  }

  // Xuất ra console dev để dễ theo dõi
  const prefix = `[SYNC AUDIT] [${fullEntry.type}] [${fullEntry.status.toUpperCase()}]`;
  if (fullEntry.status === 'error') {
    console.error(prefix, fullEntry.title, fullEntry.summary, fullEntry.details);
  } else if (fullEntry.status === 'warning') {
    console.warn(prefix, fullEntry.title, fullEntry.summary, fullEntry.details);
  } else {
    console.info(prefix, fullEntry.title, fullEntry.summary, fullEntry.details);
  }

  return fullEntry;
}

/**
 * Xóa sạch toàn bộ nhật ký kiểm toán
 */
export function clearSyncAuditLogs(): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (err) {
    console.warn('Lỗi xóa audit log:', err);
  }
}

/**
 * Xuất toàn bộ nhật ký ra định dạng văn bản (Plain Text) để sao chép hoặc tải về
 */
export function formatAuditLogsAsText(customLogs?: SyncAuditLogEntry[]): string {
  const logs = customLogs !== undefined ? customLogs : getSyncAuditLogs();
  if (logs.length === 0) {
    return 'Chưa có nhật ký kiểm toán đồng bộ nào được ghi nhận.';
  }

  let text = `NHẬT KÝ KIỂM TOÁN ĐỒNG BỘ VÀ GIÁM SÁT HỆ THỐNG (TỔNG CỘNG: ${logs.length} BẢN GHI)\r\n`;
  text += `Thời gian xuất báo cáo: ${new Date().toLocaleString('vi-VN')}\r\n`;
  text += `================================================================================\r\n\r\n`;

  logs.forEach((log, idx) => {
    text += `[#${idx + 1}] ${log.timeStr} | [${log.type}] | TRẠNG THÁI: ${log.status.toUpperCase()}\r\n`;
    text += `TIÊU ĐỀ: ${log.title}\r\n`;
    text += `TÓM TẮT: ${log.summary}\r\n`;
    if (log.userEmail) text += `NGƯỜI DÙNG: ${log.userEmail}${log.currentRole ? ` (${log.currentRole})` : ''}\r\n`;
    if (log.platform) text += `THIẾT BỊ: ${log.deviceName || log.platform}${log.deviceId ? ` (${log.deviceId})` : ''}\r\n`;
    if (log.sheetName) text += `TÊN FILE / BẢNG TÍNH: ${log.sheetName}\r\n`;
    if (log.errorMessage) text += `LỖI: ${log.errorMessage}\r\n`;
    if (log.details) {
      text += `CHI TIẾT THAY ĐỔI:\r\n${JSON.stringify(log.details, null, 2)}\r\n`;
    }
    text += `--------------------------------------------------------------------------------\r\n\r\n`;
  });

  return text;
}
