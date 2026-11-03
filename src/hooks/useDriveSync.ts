import { useState, useEffect, useRef, useCallback, Dispatch, SetStateAction } from 'react';
import { Preferences } from '@capacitor/preferences';
import { SavingsBook, AppSettings, AuthUser, SettlementAdjustment, BookStatus, canPushToDrive } from '../types';
import {
  sortAndReindexBooks,
  deduplicateSettlementAdjustments,
} from '../utils/dataTranslator';
import {
  getGoogleAccessToken,
  setGoogleAccessToken,
  ensureGoogleAccessToken,
  signInWithGoogle,
  trySilentRefresh,
  isGoogleTokenValid,
  downloadRealGoogleDriveFile,
  updateRealGoogleDriveFile,
  getRealGoogleDriveFileMetadata,
  captureMasterDataCellChanges,
  autoDiscoverLatestCentralHub,
  assertWorkspaceMembership,
  getMasterSyncStateFromDrive,
  touchMasterSyncStateOnDrive,
  applyMasterStateToSettings,
  isExplicitlyUnlinked,
  setExplicitlyUnlinked,
  isDefaultTestName,
} from '../utils/googleDriveService';
import { buildSavingsDataAuditDiff, recordSyncAuditLog } from '../utils/syncAuditLog';
import { resolveUserRole } from '../utils/roleHelper';

import { clearStaticHistoryFromStorage } from '../data/historicalGrowth';
import {
  clearLocalSyncQueue,
  hasLocalSyncMutations,
  readLocalSyncQueue,
} from '../utils/localSyncQueue';
import { mergeQueuedBooks } from '../utils/syncMutationMerge';
import { removeWorkspaceFileAssignment } from '../utils/workspaceShareRelay';


interface UseDriveSyncProps {
  currentUser: AuthUser | null;
  setCurrentUser?: Dispatch<SetStateAction<AuthUser | null>>;
  settings: AppSettings;
  setSettings: Dispatch<SetStateAction<AppSettings>>;
  books: SavingsBook[];
  setBooks: Dispatch<SetStateAction<SavingsBook[]>>;
  settlementAdjustments: SettlementAdjustment[];
  setSettlementAdjustments?: Dispatch<SetStateAction<SettlementAdjustment[]>>;
  setShowFileDeletedRecovery: (show: boolean) => void;
}

function readLocalSyncStorageSnapshot(): {
  books: SavingsBook[];
  settlements: SettlementAdjustment[];
  issues: string[];
} {
  const issues: string[] = [];
  if (typeof localStorage === 'undefined') {
    return { books: [], settlements: [], issues: ['local_storage_unavailable'] };
  }
  const readArray = <T,>(key: string): T[] => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is T => Boolean(item) && typeof item === 'object');
      }
      issues.push(`${key}:not_array`);
    } catch {
      issues.push(`${key}:invalid_json`);
    }
    return [];
  };
  return {
    books: readArray<SavingsBook>('savings_books_v3'),
    settlements: readArray<SettlementAdjustment>('savings_settlements_v3'),
    issues,
  };
}

export function useDriveSync({
  currentUser,
  setCurrentUser,
  settings,
  setSettings,
  books,
  setBooks,
  settlementAdjustments,
  setSettlementAdjustments,
  setShowFileDeletedRecovery,
}: UseDriveSyncProps) {
  const [isSyncingDrive, setIsSyncingDrive] = useState<boolean>(false);
  const [syncDriveStatus, setSyncDriveStatus] = useState<string | null>(null);
  const [detectedDesyncHub, setDetectedDesyncHub] = useState<{ id: string; name: string; webViewLink?: string; linkedTimestamp?: string } | null>(null);
  const [isDriveTokenExpired, setIsDriveTokenExpired] = useState<boolean>(false);

  // Đảm bảo ở chế độ offline (hoặc người dùng ngoại tuyến), tuyệt đối không mở cảnh báo hết hạn token Drive
  useEffect(() => {
    if (
      (currentUser?.isOffline || !currentUser) &&
      (!settings.googleSheetUrl || (typeof navigator !== 'undefined' && !navigator.onLine))
    ) {
      setIsDriveTokenExpired(false);
      setSyncDriveStatus(null);
    }
  }, [currentUser, settings.googleSheetUrl]);

  // Refs và cơ chế quản lý đồng bộ 2 chiều phản xạ (Reactive 2-Way Sync)
  const isTabVisibleRef = useRef<boolean>(
    typeof document !== 'undefined' ? document.visibilityState === 'visible' : true
  );
  const lastCheckedModifiedTimeTimestampRef = useRef<number>(Date.now());
  const isRemoteUpdateRef = useRef<boolean>(false);
  const isInitialSyncDoneRef = useRef<boolean>(false);
  const lastCheckedModifiedTimeRef = useRef<string | null>(null);
  const isCheckingRemoteRef = useRef<boolean>(false);
  const [initialBooksString] = useState(() => JSON.stringify(books));
  const [initialAdjsString] = useState(() => JSON.stringify(settlementAdjustments));
  const previousBooksStringRef = useRef<string>(initialBooksString);
  const previousAdjsStringRef = useRef<string>(initialAdjsString);
  const booksRef = useRef<SavingsBook[]>(books);
  booksRef.current = books;

  // Helper đồng bộ danh sách nhật ký tất toán từ file liên kết trên Google Drive (Nguồn sự thật duy nhất)
  const applyMasterSettlements = useCallback(
    (remoteSettlements: SettlementAdjustment[] | undefined) => {
      if (!setSettlementAdjustments) return;
      const cleanNext = deduplicateSettlementAdjustments(remoteSettlements || []);
      const nextStr = JSON.stringify(cleanNext);
      previousAdjsStringRef.current = nextStr;
      setSettlementAdjustments(cleanNext);
      try {
        localStorage.setItem('savings_settlements_v3', nextStr);
      } catch {}
    },
    [setSettlementAdjustments]
  );

  // Triệt tiêu vòng lặp phản xạ khi đổi file hoặc push/pull liên tục
  const settlementAdjustmentsRef = useRef<SettlementAdjustment[]>(settlementAdjustments);
  settlementAdjustmentsRef.current = settlementAdjustments;
  const remoteSyncCooldownUntilRef = useRef<number>(0);

  const isSwitchingFileRef = useRef<boolean>(false);
  const isSyncingRef = useRef<boolean>(false);
  const isPushingRef = useRef<boolean>(false);
  const isAutoConnectingRef = useRef<boolean>(false);
  const lastLocalPushTimeRef = useRef<number>(0);
  const fileSwitchCooldownUntilRef = useRef<number>(0);

  // Hàng đợi đẩy dữ liệu tránh race condition khi cập nhật nhanh liên tục
  const needsPushRef = useRef<boolean>(false);
  const pendingBooksRef = useRef<SavingsBook[] | null>(null);
  const pendingAdjsRef = useRef<SettlementAdjustment[] | null>(null);
  const isRestoreMergePushRef = useRef(false);
  const pendingQueueRetryRef = useRef<number | null>(null);

  // Quản lý độ trễ index tìm kiếm của Google Drive API (để tránh vòng lặp phản hồi ngược)
  const lastUrlChangeTimeRef = useRef<number>(Date.now());
  const prevUrlRef = useRef<string | undefined>(settings.googleSheetUrl);
  const lastSyncedUrlRef = useRef<string | null>(settings.googleSheetUrl || null);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (settings.googleSheetUrl !== prevUrlRef.current) {
      lastUrlChangeTimeRef.current = Date.now();
      prevUrlRef.current = settings.googleSheetUrl;
    }
  }, [settings.googleSheetUrl]);

  // Lắng nghe các lỗi runtime toàn cục để tự động ghi log vào Firestore trung tâm
  useEffect(() => {
    const handleGlobalError = (event: ErrorEvent) => {
      if (event.error) {
        recordSyncAuditLog({
          type: 'SYNC_ERROR',
          title: 'Lỗi Runtime chưa xử lý',
          status: 'error',
          userEmail: currentUser?.email,
          currentRole: settingsRef.current?.currentRole,
          summary: event.message || 'Uncaught runtime error',
          errorMessage: event.error ? String(event.error?.stack || event.error) : event.message,
          details: {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          },
        });
      }
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      recordSyncAuditLog({
        type: 'SYNC_ERROR',
        title: 'Lỗi Promise Rejection chưa bắt',
        status: 'error',
        userEmail: currentUser?.email,
        currentRole: settingsRef.current?.currentRole,
        summary: event.reason ? String(event.reason?.message || event.reason) : 'Unhandled promise rejection',
        errorMessage: event.reason ? String(event.reason?.stack || event.reason) : 'Unhandled promise rejection',
      });
    };

    window.addEventListener('error', handleGlobalError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleGlobalError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, [currentUser?.email]);

  // Khởi tạo quy trình chuyển đổi liên kết file: Khóa toàn bộ các trigger push/pull tự động
  const startFileSwitch = useCallback(() => {
    isSwitchingFileRef.current = true;
    isInitialSyncDoneRef.current = false;
    isCheckingRemoteRef.current = true;
    fileSwitchCooldownUntilRef.current = Date.now() + 10000;
    setIsSyncingDrive(true);
    setSyncDriveStatus('Đang chuyển đổi liên kết file Google Drive...');
  }, []);

  const cancelFileSwitch = useCallback(() => {
    isSwitchingFileRef.current = false;
    isCheckingRemoteRef.current = false;
    isInitialSyncDoneRef.current = true;
    setIsSyncingDrive(false);
    setSyncDriveStatus(null);
  }, []);

  const finishFileSwitch = useCallback(
    (
      newBooks: SavingsBook[],
      newAdjs?: SettlementAdjustment[],
      newUrl?: string,
      newFileName?: string,
      stampTime?: string,
      fileModTime?: string,
      readOnly = false
    ) => {
      // 1. Chuẩn hóa danh sách sổ để bảo đảm tính nhất quán (deterministic)
      const activeRemote = newBooks.filter((b) => b.status !== 'settled');
      const normalizedBooks = sortAndReindexBooks(activeRemote);
      const adjsToKeep = deduplicateSettlementAdjustments(newAdjs ?? settlementAdjustments);

      // 2. Cập nhật các snapshot và ref trước khi cập nhật state
      previousBooksStringRef.current = JSON.stringify(normalizedBooks);
      previousAdjsStringRef.current = JSON.stringify(adjsToKeep);
      isRemoteUpdateRef.current = true;

      const effectiveUrl = newUrl ?? settings.googleSheetUrl;
      if (effectiveUrl) {
        lastSyncedUrlRef.current = effectiveUrl;
        prevUrlRef.current = effectiveUrl;
      }
      lastUrlChangeTimeRef.current = Date.now();
      lastLocalPushTimeRef.current = Date.now();
      lastCheckedModifiedTimeRef.current = fileModTime || null;

      // 3. Cập nhật state nội bộ và bộ nhớ lưu trữ
      try {
        if (normalizedBooks.length > 0) {
          localStorage.removeItem('savings_books_cleared');
        } else {
          localStorage.setItem('savings_books_cleared', 'true');
        }
        localStorage.setItem('savings_books_v3', JSON.stringify(normalizedBooks));
        localStorage.setItem('savings_settlements_v3', JSON.stringify(adjsToKeep));
      } catch {}
      setBooks(normalizedBooks);
      if (setSettlementAdjustments) {
        setSettlementAdjustments(adjsToKeep);
      }

      const nowStr = new Date().toLocaleString('vi-VN');
      setSettings((prev) => ({
        ...prev,
        googleSheetUrl: effectiveUrl || '',
        googleSheetName: newFileName || prev.googleSheetName || '',
        lastSyncTime: nowStr,
        autoSync: true,
        lastLocalLinkTimestamp: stampTime || new Date().toISOString(),
      }));

      // Tự động lấp đầy các cột tính toán đã tính xong lên Google Drive ngay khi vừa liên kết file mới
      const token = getGoogleAccessToken();
      const match = effectiveUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/) || effectiveUrl?.match(/id=([a-zA-Z0-9-_]+)/);
      const fileId = match ? match[1] : null;
      if (
        !readOnly &&
        canPushToDrive(settings.currentRole) &&
        token &&
        fileId &&
        lastCheckedModifiedTimeRef.current &&
        normalizedBooks.length > 0
      ) {
        updateRealGoogleDriveFile(token, fileId, normalizedBooks, adjsToKeep, {
          userEmail: currentUser?.email,
          currentRole: settings.currentRole,
          sheetName: settings.googleSheetName,
        }, lastCheckedModifiedTimeRef.current || undefined)
          .then(() => {
            console.info('[Central Hub Sync] Đã tự động lấp đầy các cột tính toán lên Google Drive ngay sau khi liên kết.');
          })
          .catch((err) => {
            console.warn('Lỗi tự động điền cột tính toán sau khi liên kết:', err);
          });
      }

      // 4. Giữ lock trong 1200ms để mọi render của React và I/O mạng lắng xuống hoàn toàn
      fileSwitchCooldownUntilRef.current = Date.now() + 6000;
      setTimeout(() => {
        isInitialSyncDoneRef.current = true;
        isSwitchingFileRef.current = false;
        isCheckingRemoteRef.current = false;
        setIsSyncingDrive(false);
        setSyncDriveStatus(`✅ Đã kết nối và nạp thành công ${normalizedBooks.length} sổ từ file mới`);
        setTimeout(() => setSyncDriveStatus(null), 3500);
      }, 1200);
    },
    [currentUser, settings.currentRole, settings.googleSheetName, settings.googleSheetUrl, settlementAdjustments, setBooks, setSettings]
  );

  // Đánh dấu cập nhật dữ liệu đến từ thao tác Drive (nạp file/đổi file) để ngăn phản xạ đẩy ngược lên Drive
  const markAsRemoteUpdate = useCallback(
    (newBooks?: SavingsBook[], newAdjs?: SettlementAdjustment[], newUrl?: string, newModifiedTime?: string) => {
      isRemoteUpdateRef.current = true;
      if (newBooks) {
        previousBooksStringRef.current = JSON.stringify(newBooks);
      }
      if (newAdjs) {
        previousAdjsStringRef.current = JSON.stringify(newAdjs);
      }
      if (newUrl) {
        lastSyncedUrlRef.current = newUrl;
        prevUrlRef.current = newUrl;
        lastUrlChangeTimeRef.current = Date.now();
      }
      if (newModifiedTime) {
        lastCheckedModifiedTimeRef.current = newModifiedTime;
      }
    },
    []
  );

  // Intelligent Drive Synchronization
  const syncBooksFromDrive = useCallback(
    async (
      forceTokenPrompt = false,
      explicitToken?: string,
      _pushAfterSync = false,
      explicitFileUrl?: string,
      explicitUserEmail?: string
    ) => {
      if (currentUser?.isOffline && !settings.googleSheetUrl && !explicitFileUrl) return;
      if (isSwitchingFileRef.current || isPushingRef.current || isSyncingRef.current) {
        return;
      }

      const syncUserEmail = explicitUserEmail?.trim() || currentUser?.email || '';
      let token = explicitToken || getGoogleAccessToken();
      const isValid = isGoogleTokenValid();

      if (!token || !isValid) {
        // Thử silent refresh ngầm trước khi làm gián đoạn người dùng
        const silentToken = await trySilentRefresh();
        if (silentToken) {
          token = silentToken;
        } else if (forceTokenPrompt) {
          try {
            token = await ensureGoogleAccessToken();
          } catch {
            setSyncDriveStatus('Chưa hoàn tất đăng nhập Google để đồng bộ.');
            return;
          }
        } else {
          // Chỉ kích hoạt khi silent refresh thực sự thất bại
          if (token && !isValid) {
            setGoogleAccessToken(null);
            setIsDriveTokenExpired(true);
            setSyncDriveStatus('⚠️ Cần xác thực lại tài khoản Google Drive.');
          }
          return;
        }
      }
      setIsDriveTokenExpired(false);

      const currentUrl = explicitFileUrl || settings.googleSheetUrl;
      if (!currentUrl) {
        isInitialSyncDoneRef.current = true;
        return;
      }

      // Phân tích file ID hiện tại
      let currentFileId: string | null = null;
      const match = currentUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) || currentUrl.match(/id=([a-zA-Z0-9-_]+)/);
      currentFileId = match
        ? match[1]
        : currentUrl.length > 20 && !currentUrl.includes('/')
        ? currentUrl
        : null;

      if (!currentFileId) {
        isInitialSyncDoneRef.current = true;
        return;
      }

      const fileId = currentFileId;

      isSyncingRef.current = true;
      setIsSyncingDrive(true);
      setSyncDriveStatus('Đang đồng bộ Google Drive...');
      try {
        // Kiểm tra nhanh xem thiết bị khác có hủy liên kết file này trước đó không & nạp danh sách thành viên
        try {
          const masterState = token ? await getMasterSyncStateFromDrive(token, fileId) : null;
          if (masterState) {
            applyMasterStateToSettings(masterState, syncUserEmail, setSettings, settingsRef.current, token);
            if (masterState.status === 'unlinked' || masterState.lastAction === 'unlink') {
              const unlinkMs = masterState.updatedAt
                ? new Date(masterState.updatedAt).getTime()
                : masterState.linkedTimestamp
                ? new Date(masterState.linkedTimestamp).getTime()
                : 0;
              const localMs = settings.lastLocalLinkTimestamp ? new Date(settings.lastLocalLinkTimestamp).getTime() : 0;
              if (unlinkMs >= localMs || unlinkMs === 0) {
                console.info('[Central Hub Sync] Phát hiện thiết bị khác đã hủy liên kết file trung tâm khi đang đồng bộ.');
                setBooks([]);
                if (setSettlementAdjustments) setSettlementAdjustments([]);
                try {
                  localStorage.setItem('savings_books_v3', JSON.stringify([]));
                  localStorage.setItem('savings_books_cleared', 'true');
                  localStorage.removeItem('savings_settlements_v3');
                  clearStaticHistoryFromStorage();
                } catch {}
                setExplicitlyUnlinked(true);
                setSettings((prev) => ({
                  ...prev,
                  googleSheetUrl: '',
                  googleSheetName: '',
                  currentRole: 'ADMIN',
                  workspaceOwnerEmail: undefined,
                  isPersonalWorkspace: true,
                  members: [],
                  lastSyncTime: undefined,
                  lastLocalLinkTimestamp: masterState.updatedAt || masterState.linkedTimestamp,
                }));
                setSyncDriveStatus('⚡ Thiết bị khác đã hủy liên kết. Đã dọn sạch dữ liệu để đồng bộ an toàn.');
                isSyncingRef.current = false;
                setIsSyncingDrive(false);
                return;
              }
            }
          }
        } catch (masterErr) {
          console.warn('Lỗi kiểm tra master state trong syncBooksFromDrive:', masterErr);
        }

        if (canPushToDrive(settingsRef.current?.currentRole)) {
          try {
            await captureMasterDataCellChanges(token, fileId, 'drive_pull', {
              userEmail: syncUserEmail,
              currentRole: settingsRef.current?.currentRole,
              sheetName: settingsRef.current?.googleSheetName,
            });
          } catch (auditError: any) {
            console.error('[SYNC AUDIT] Không thể đối chiếu sheet master trước khi nạp dữ liệu.', auditError);
            recordSyncAuditLog({
              type: 'SYNC_ERROR',
              title: 'Không đối chiếu được sheet master trước khi tải',
              status: 'error',
              fileId,
              userEmail: syncUserEmail,
              currentRole: settingsRef.current?.currentRole,
              sheetName: settingsRef.current?.googleSheetName,
              summary: `Không thể kiểm tra thay đổi ô A:AC trước khi tải: ${auditError?.message || auditError}`,
              errorMessage: auditError?.message,
              details: { stage: 'pre_pull_audit', auditGapPossible: true },
            });
          }
        }

        let res;
        try {
          res = await downloadRealGoogleDriveFile(token, fileId, undefined, syncUserEmail);
        } catch (tokenErr: any) {
          // If token expired (401) or credentials invalid
          if (
            tokenErr?.message?.includes('hết hạn') ||
            tokenErr?.message?.includes('401') ||
            tokenErr?.message?.includes('invalid authentication credentials') ||
            tokenErr?.message?.includes('credentials')
          ) {
            console.warn('[Central Hub Sync] Token hết hạn trong download. Thử gia hạn ngầm...');
            const freshToken = await trySilentRefresh();
            if (freshToken) {
              token = freshToken;
              setIsDriveTokenExpired(false);
              res = await downloadRealGoogleDriveFile(freshToken, fileId, undefined, syncUserEmail);
            } else if (forceTokenPrompt) {
              try {
                token = await ensureGoogleAccessToken();
                setIsDriveTokenExpired(false);
                res = await downloadRealGoogleDriveFile(token, fileId, undefined, syncUserEmail);
              } catch {
                return;
              }
            } else {
              setGoogleAccessToken(null);
              setIsDriveTokenExpired(true);
              setSyncDriveStatus('⚠️ Cần xác thực lại tài khoản Google Drive.');
              return;
            }
          } else {
            throw tokenErr;
          }
        }
        if (res.success) {
          setIsDriveTokenExpired(false);
          isRemoteUpdateRef.current = true;
          remoteSyncCooldownUntilRef.current = Date.now() + 5000;

          const userEmail = syncUserEmail || 'unknown';
          if (userEmail && userEmail !== 'unknown') {
            removeWorkspaceFileAssignment(userEmail).catch(() => {});
          }
          const role = resolveUserRole(userEmail, settingsRef.current?.currentRole, settingsRef.current?.members, settingsRef.current?.workspaceOwnerEmail);
          const pulledBooks = res.books || [];
          const pulledSettlements = res.settlements || [];
          localStorage.setItem(
            'savings_drive_sync_baseline_v1',
            JSON.stringify({ fileId, books: pulledBooks, settlements: pulledSettlements })
          );
          const localQueue = readLocalSyncQueue();
          const hasQueuedMutations = hasLocalSyncMutations(localQueue);
          const restorePending =
            localStorage.getItem('savings_master_restore_required') === 'true' ||
            hasQueuedMutations;
          const localStorageSnapshot = readLocalSyncStorageSnapshot();
          const cacheDiff = buildSavingsDataAuditDiff(
            booksRef.current,
            pulledBooks,
            settlementAdjustmentsRef.current,
            pulledSettlements
          );
          if (cacheDiff.changes?.length) {
            recordSyncAuditLog({
              type: 'DATA_RESTORE',
              title: 'Drive và dữ liệu cục bộ bị lệch',
              status: 'warning',
              fileId,
              userEmail,
              currentRole: role,
              sheetName: settingsRef.current?.googleSheetName,
              summary: `Đã thay dữ liệu cục bộ bằng bản Drive; phát hiện ${cacheDiff.changes.length}${cacheDiff.truncated ? '+' : ''} thay đổi khác biệt.`,
              details: {
                source: 'local_cache_vs_drive',
                localBooksCount: booksRef.current.length,
                driveBooksCount: pulledBooks.length,
                localSettlementsCount: settlementAdjustmentsRef.current.length,
                driveSettlementsCount: pulledSettlements.length,
                localStorageBooksCount: localStorageSnapshot.books.length,
                localStorageSettlementsCount: localStorageSnapshot.settlements.length,
                ...(localStorageSnapshot.issues.length
                  ? { localStorageIssues: localStorageSnapshot.issues }
                  : {}),
                changes: cacheDiff.changes,
                ...(cacheDiff.truncated ? { truncated: true } : {}),
              },
            });
          }
          const storageToStateDiff = buildSavingsDataAuditDiff(
            localStorageSnapshot.books,
            booksRef.current,
            localStorageSnapshot.settlements,
            settlementAdjustmentsRef.current
          );
          if (localStorageSnapshot.issues.length || storageToStateDiff.changes?.length) {
            recordSyncAuditLog({
              type: 'DATA_DIVERGENCE',
              title: 'LocalStorage và dữ liệu ứng dụng bị lệch',
              status: 'warning',
              fileId,
              userEmail,
              currentRole: role,
              sheetName: settingsRef.current?.googleSheetName,
              summary: localStorageSnapshot.issues.length
                ? 'Không đọc được đầy đủ cache LocalStorage trước khi nạp dữ liệu Drive.'
                : `Cache LocalStorage khác trạng thái ứng dụng ở ${storageToStateDiff.changes.length}${storageToStateDiff.truncated ? '+' : ''} mục.`,
              details: {
                source: 'local_storage_vs_app_state',
                ...(localStorageSnapshot.issues.length
                  ? { localStorageIssues: localStorageSnapshot.issues }
                  : {}),
                ...(storageToStateDiff.changes?.length
                  ? { changes: storageToStateDiff.changes }
                  : {}),
                ...(storageToStateDiff.truncated ? { truncated: true } : {}),
              },
            });
          }
          const mergeResult = restorePending
            ? mergeQueuedBooks(pulledBooks, localQueue)
            : { books: pulledBooks, conflict: undefined };
          const restoredBooks = mergeResult.books;
          if (mergeResult.conflict) {
            isInitialSyncDoneRef.current = true;
            setSyncDriveStatus(`⚠️ ${mergeResult.conflict}`);
            return;
          }
          const restoredSettlements = restorePending
            ? deduplicateSettlementAdjustments([
                ...pulledSettlements,
                ...localQueue.settlements,
              ])
            : pulledSettlements;
          applyMasterSettlements(restoredSettlements);

          const hasLocalRestoreChanges =
            hasQueuedMutations &&
            (JSON.stringify(restoredBooks) !== JSON.stringify(pulledBooks) ||
              JSON.stringify(restoredSettlements) !== JSON.stringify(pulledSettlements));
          if (restorePending && hasLocalRestoreChanges && currentUser && !currentUser.isOffline && canPushToDrive(settingsRef.current.currentRole)) {
            isRestoreMergePushRef.current = true;
            needsPushRef.current = true;
            pendingBooksRef.current = restoredBooks;
            pendingAdjsRef.current = restoredSettlements;
          } else if (restorePending && !hasQueuedMutations) {
            try {
              localStorage.removeItem('savings_master_restore_required');
            } catch (error) {
              console.error('Không thể xóa cờ phục hồi local sau khi đọc Drive:', error);
            }
          } else if (restorePending && hasQueuedMutations && !hasLocalRestoreChanges) {
            clearLocalSyncQueue(localQueue);
          }

          isInitialSyncDoneRef.current = true;

          if (restoredBooks.length > 0) {
            const activeRemote = restoredBooks.map((b) => ({ ...b, status: 'active' as BookStatus }));
            const mergedBooks = sortAndReindexBooks(activeRemote);

            setBooks((prevBooks) => {
              const nextStr = JSON.stringify(mergedBooks);
              const prevStr = JSON.stringify(prevBooks);
              if (prevStr === nextStr) {
                return prevBooks;
              }
              previousBooksStringRef.current = nextStr;
              try {
                localStorage.removeItem('savings_books_cleared');
                localStorage.setItem('savings_books_v3', nextStr);
              } catch {
                // ignore
              }
              return mergedBooks;
            });

            const nowStr = new Date().toLocaleString('vi-VN');
            let fetchedName = settings.googleSheetName;
            try {
              const meta = await getRealGoogleDriveFileMetadata(token, fileId);
              if (meta?.modifiedTime) {
                lastCheckedModifiedTimeRef.current = meta.modifiedTime;
              }
              if (meta?.name && !fetchedName) {
                fetchedName = meta.name;
              }
            } catch {
              // ignore
            }

            setSettings((prev) => {
              const shouldUpdateName = fetchedName && fetchedName !== prev.googleSheetName;
              if (!shouldUpdateName && prev.lastSyncTime === nowStr) {
                return prev;
              }
              return {
                ...prev,
                lastSyncTime: nowStr,
                ...(shouldUpdateName ? { googleSheetName: fetchedName } : {}),
              };
            });

            lastSyncedUrlRef.current = currentUrl;
            setSyncDriveStatus(`Đã đồng bộ ${restoredBooks.length} sổ từ Google Drive`);
            setTimeout(() => setSyncDriveStatus(null), 3500);
          } else {
            // File trên Google Drive trống hoặc chưa có sổ
            setBooks([]);
            try {
              localStorage.setItem('savings_books_v3', JSON.stringify([]));
              localStorage.setItem('savings_books_cleared', 'true');
            } catch {}
            setSyncDriveStatus('File Google Drive chưa có sổ tiết kiệm nào.');
            setTimeout(() => setSyncDriveStatus(null), 3500);
          }
          return true;
        } else if (!res.success && res.errors && res.errors.length > 0) {
          isInitialSyncDoneRef.current = true;
          recordSyncAuditLog({
            type: 'SYNC_ERROR',
            title: 'Không thể phân tích dữ liệu Google Drive',
            status: 'error',
            fileId,
            userEmail: syncUserEmail,
            currentRole: settingsRef.current?.currentRole,
            sheetName: settingsRef.current?.googleSheetName,
            summary: res.errors[0],
            errorMessage: res.errors.slice(0, 3).join(' | '),
            details: {
              stage: 'parse_pull',
              source: 'drive_to_local',
              localBooksCount: booksRef.current.length,
              localSettlementsCount: settlementAdjustmentsRef.current.length,
            },
          });
          setSyncDriveStatus(res.errors[0]);
        } else {
          isInitialSyncDoneRef.current = true;
          recordSyncAuditLog({
            type: 'SYNC_ERROR',
            title: 'Google Drive không trả dữ liệu hợp lệ',
            status: 'error',
            fileId,
            userEmail: syncUserEmail,
            currentRole: settingsRef.current?.currentRole,
            sheetName: settingsRef.current?.googleSheetName,
            summary: 'Không tải được dữ liệu hợp lệ và không có thông tin lỗi chi tiết.',
            details: {
              stage: 'parse_pull',
              source: 'drive_to_local',
              localBooksCount: booksRef.current.length,
              localSettlementsCount: settlementAdjustmentsRef.current.length,
            },
          });
          lastSyncedUrlRef.current = currentUrl;
        }
      } catch (err: any) {
        isInitialSyncDoneRef.current = true;
        recordSyncAuditLog({
          type: 'SYNC_ERROR',
          title: 'Lỗi tải dữ liệu từ Google Drive',
          status: 'error',
          userEmail: syncUserEmail,
          currentRole: settingsRef.current?.currentRole,
          sheetName: settingsRef.current?.googleSheetName,
          summary: `Lỗi đọc file Google Drive: ${err?.message || err}`,
          errorMessage: err?.stack || err?.message,
          details: {
            stage: 'pull',
            source: 'drive_to_local',
            fileId,
            localBooksCount: booksRef.current.length,
            localSettlementsCount: settlementAdjustmentsRef.current.length,
            currentUrl,
          },
        });
        if (
          err?.message?.includes('hết hạn') ||
          err?.message?.includes('invalid authentication credentials')
        ) {
          console.warn('Drive sync warning:', err?.message);
          setSyncDriveStatus('Phiên đăng nhập Google hết hạn. Vui lòng bấm đăng nhập lại.');
        } else if (
          err?.message?.includes('FILE_NOT_FOUND') ||
          err?.message?.includes('xóa') ||
          err?.message?.includes('404')
        ) {
          console.warn('Google Drive file deleted or not found for this client:', err?.message);
          setSyncDriveStatus('⚠️ Không thể đọc file liên kết trên tài khoản này (hoặc chưa được chia sẻ quyền).');
        } else {
          console.error('Drive sync error:', err);
          setSyncDriveStatus(`Lỗi đồng bộ: ${err.message}`);
        }
      } finally {
        isSyncingRef.current = false;
        setIsSyncingDrive(false);
        setTimeout(() => setSyncDriveStatus(null), 3500);

        // Kích hoạt đẩy dữ liệu xếp hàng đợi nếu có thay đổi cục bộ trong khi sync
        if (needsPushRef.current && pendingBooksRef.current) {
          const nextB = pendingBooksRef.current;
          const nextA = pendingAdjsRef.current || settlementAdjustments;
          needsPushRef.current = false;
          pendingBooksRef.current = null;
          pendingAdjsRef.current = null;
          setTimeout(() => {
            pushBooksToDrive(nextB, nextA);
          }, 400);
        }
      }
    },
    [currentUser, settings.googleSheetUrl, settings.googleSheetName, settlementAdjustments, setSettings, setBooks, setShowFileDeletedRecovery]
  );

  // Automatic push updated books to Google Drive (2-way sync)
  const pushBooksToDrive = useCallback(
    async (updatedBooks: SavingsBook[], currentAdjustments?: SettlementAdjustment[]) => {
      // TUYỆT ĐỐI KHÔNG GHI ĐÈ KHI CHƯA HOÀN TẤT TẢI DỮ LIỆU TỪ DRIVE VỀ HOẶC ĐANG TRONG THỜI GIAN COOLDOWN
      if (!isInitialSyncDoneRef.current) return;
      if (isSwitchingFileRef.current || isSyncingRef.current || isPushingRef.current) return;
      if (Date.now() < fileSwitchCooldownUntilRef.current) return;
      if (currentUser?.isOffline) return;
      if (!settings.googleSheetUrl) return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      const pendingMutationQueue = readLocalSyncQueue();
      if (
        (localStorage.getItem('savings_master_restore_required') === 'true' ||
          !hasLocalSyncMutations(pendingMutationQueue)) &&
        !isRestoreMergePushRef.current
      ) return;
      if (!canPushToDrive(settings.currentRole)) {
        console.info('[Smart Sync] Thành viên với vai trò VIEWER (Chỉ xem) không thực hiện đẩy dữ liệu lên Google Drive.');
        return;
      }

      const match =
        settings.googleSheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) ||
        settings.googleSheetUrl.match(/id=([a-zA-Z0-9-_]+)/);
      const fileId = match
        ? match[1]
        : settings.googleSheetUrl.length > 20 && !settings.googleSheetUrl.includes('/')
        ? settings.googleSheetUrl
        : null;
      if (!fileId) return;

      let token = getGoogleAccessToken();
      const isValid = isGoogleTokenValid();

      if (!token || !isValid) {
        const silentToken = await trySilentRefresh();
        if (silentToken) {
          token = silentToken;
        } else {
          console.warn('[Auto-Push] Token Google Drive không tồn tại hoặc đã hết hạn.');
          if (token && !isValid) {
            setGoogleAccessToken(null);
          }
          setIsDriveTokenExpired(true);
          setSyncDriveStatus('⚠️ Cần xác thực lại tài khoản Google Drive.');
          return;
        }
      }

      const queuedMutations = readLocalSyncQueue();
      let booksToWrite = updatedBooks;
      let settlementsToWrite =
        currentAdjustments ?? settlementAdjustmentsRef.current ?? settlementAdjustments ?? [];
      if (hasLocalSyncMutations(queuedMutations)) {
        const baselineText = localStorage.getItem('savings_drive_sync_baseline_v1');
        if (!baselineText) {
          throw new Error('Chưa có bản dữ liệu Drive làm mốc. Đã giữ thay đổi local và dừng ghi.');
        }
        const baseline = JSON.parse(baselineText) as {
          fileId?: string;
          books?: SavingsBook[];
          settlements?: SettlementAdjustment[];
        };
        if (
          baseline.fileId !== fileId ||
          !Array.isArray(baseline.books) ||
          !Array.isArray(baseline.settlements)
        ) {
          throw new Error('Bản mốc Drive không khớp file đang liên kết. Đã giữ thay đổi local và dừng ghi.');
        }

        const mergeResult = mergeQueuedBooks(baseline.books, queuedMutations);
        if (mergeResult.conflict) throw new Error(mergeResult.conflict);
        booksToWrite = sortAndReindexBooks(mergeResult.books);
        settlementsToWrite = deduplicateSettlementAdjustments([
          ...baseline.settlements,
          ...queuedMutations.settlements,
        ]);
      }

      isPushingRef.current = true;
      try {
        setIsSyncingDrive(true);

        // KIỂM TRA TRẠNG THÁI TRÊN DRIVE TRƯỚC KHI GHI (TRÁNH GHI ĐÈ KHI THIẾT BỊ KHÁC ĐÃ UNLINK)
        try {
          const currentMaster = token ? await getMasterSyncStateFromDrive(token, fileId) : null;
          if (!currentMaster) {
            throw new Error('Không thể xác minh trạng thái File liên kết trên Drive. Đã dừng đồng bộ để tránh ghi sai file.');
          }
          if (currentMaster && (currentMaster.status === 'unlinked' || currentMaster.lastAction === 'unlink')) {
            console.warn('[Central Hub Sync] Phát hiện tệp cấu hình đã được hủy liên kết từ thiết bị khác. Hủy đẩy dữ liệu và tự động ngắt liên kết.');
            
            setExplicitlyUnlinked(true);
            setBooks([]);
            if (setSettlementAdjustments) setSettlementAdjustments([]);
            try {
              localStorage.setItem('savings_books_v3', JSON.stringify([]));
              localStorage.setItem('savings_settlements_v3', JSON.stringify([]));
              localStorage.setItem('savings_books_cleared', 'true');
              clearStaticHistoryFromStorage();
            } catch {}

            setSettings((prev) => ({
              ...prev,
              googleSheetUrl: '',
              googleSheetName: '',
              currentRole: 'ADMIN',
              workspaceOwnerEmail: undefined,
              isPersonalWorkspace: true,
              members: [],
              lastSyncTime: undefined,
              lastLocalLinkTimestamp: currentMaster.updatedAt || currentMaster.linkedTimestamp,
            }));

            setSyncDriveStatus('⚡ Thiết bị khác đã hủy liên kết. Đã ngắt kết nối để bảo mật dữ liệu.');
            setIsSyncingDrive(false);
            isPushingRef.current = false;
            return; // Dừng ngay lập tức, không cho phép ghi đè lên file!
          }
          if (currentMaster.status !== 'active' || currentMaster.activeFileId !== fileId) {
            throw new Error('Không xác minh được file này là File liên kết đang hoạt động. Đã dừng đồng bộ.');
          }
          const verifiedMaster = await assertWorkspaceMembership(
            token,
            fileId,
            currentUser?.email || ''
          );
          if (
            !verifiedMaster ||
            resolveUserRole(
              currentUser?.email,
              undefined,
              verifiedMaster.members,
              verifiedMaster.adminEmail
            ) === 'VIEWER'
          ) {
            throw new Error('Không xác minh được quyền thành viên có thể ghi trong Nhóm thành viên. Đã dừng đồng bộ.');
          }
        } catch (masterCheckErr) {
          console.error('[Auto-Push] Không thể xác minh master state; đã dừng push.', masterCheckErr);
          throw masterCheckErr;
        }

        const adjs = settlementsToWrite;
        const localStorageSnapshot = readLocalSyncStorageSnapshot();
        const storageDiff = buildSavingsDataAuditDiff(
          localStorageSnapshot.books,
          booksToWrite,
          localStorageSnapshot.settlements,
          adjs
        );
        if (localStorageSnapshot.issues.length || storageDiff.changes?.length) {
          recordSyncAuditLog({
            type: 'DATA_DIVERGENCE',
            title: 'LocalStorage khác dữ liệu sắp đồng bộ',
            status: 'warning',
            fileId,
            userEmail: currentUser?.email,
            currentRole: settingsRef.current?.currentRole,
            sheetName: settingsRef.current?.googleSheetName,
            summary: localStorageSnapshot.issues.length
              ? 'Không đọc được đầy đủ cache LocalStorage trước khi ghi Drive.'
              : `Dữ liệu sắp ghi khác cache LocalStorage ở ${storageDiff.changes.length}${storageDiff.truncated ? '+' : ''} mục.`,
            details: {
              source: 'local_storage_vs_push_payload',
              localStorageBooksCount: localStorageSnapshot.books.length,
              pushBooksCount: booksToWrite.length,
              localStorageSettlementsCount: localStorageSnapshot.settlements.length,
              pushSettlementsCount: adjs.length,
              ...(localStorageSnapshot.issues.length
                ? { localStorageIssues: localStorageSnapshot.issues }
                : {}),
              ...(storageDiff.changes?.length ? { changes: storageDiff.changes } : {}),
              ...(storageDiff.truncated ? { truncated: true } : {}),
            },
          });
        }

        const expectedModifiedTime = lastCheckedModifiedTimeRef.current;
        if (!expectedModifiedTime) {
          throw new Error(
            'Chưa có mốc phiên bản Drive để kiểm tra ghi đồng thời. Đã dừng push; hãy tải/đồng bộ file trước.'
          );
        }
        const success = await updateRealGoogleDriveFile(token, fileId, booksToWrite, adjs, {
          userEmail: currentUser?.email,
          currentRole: settingsRef.current?.currentRole,
          sheetName: settingsRef.current?.googleSheetName,
        }, expectedModifiedTime);
        if (success) {
          localStorage.setItem(
            'savings_drive_sync_baseline_v1',
            JSON.stringify({ fileId, books: booksToWrite, settlements: adjs })
          );
          clearLocalSyncQueue(queuedMutations);
          localStorage.removeItem('savings_master_restore_required');
          lastLocalPushTimeRef.current = Date.now();
          const nowStr = new Date().toLocaleString('vi-VN');
          setSettings((prev) => ({ ...prev, lastSyncTime: nowStr }));
          await touchMasterSyncStateOnDrive(
            token,
            fileId,
            currentUser?.email,
            settings.lastLocalLinkTimestamp,
            settings.googleSheetName,
            settings.googleSheetUrl
          );
          try {
            const updatedMeta = await getRealGoogleDriveFileMetadata(token, fileId);
            if (updatedMeta?.modifiedTime) {
              lastCheckedModifiedTimeRef.current = updatedMeta.modifiedTime;
            }
          } catch {
            // ignore
          }

          setSyncDriveStatus('Đã đồng bộ 2 chiều thành công lên Google Drive');
        }
      } catch (err: any) {
        recordSyncAuditLog({
          type: 'SYNC_ERROR',
          title: 'Lỗi đồng bộ lên Google Drive',
          status: 'error',
          userEmail: currentUser?.email,
          currentRole: settingsRef.current?.currentRole,
          sheetName: settingsRef.current?.googleSheetName,
          summary: `Lỗi ghi file Google Drive: ${err?.message || err}`,
          errorMessage: err?.stack || err?.message,
          details: {
            stage: 'push',
            booksCount: booksToWrite.length,
            settlementsCount: currentAdjustments?.length ?? settlementAdjustmentsRef.current.length,
          },
        });
        if (
          err?.message?.includes('FILE_NOT_FOUND') ||
          err?.message?.includes('xóa') ||
          err?.message?.includes('thùng rác') ||
          err?.message?.includes('404')
        ) {
          console.warn('Google Drive file push failed - file not accessible:', err?.message);
          setSyncDriveStatus('⚠️ Không thể ghi vào file Google Drive. Vui lòng kiểm tra quyền chỉnh sửa của tài khoản.');
        } else if (
          err?.message?.includes('hết hạn') ||
          err?.message?.includes('invalid authentication credentials')
        ) {
          console.warn('Push to Drive notice:', err?.message);
          setSyncDriveStatus('Phiên đăng nhập Google hết hạn. Vui lòng bấm đăng nhập lại.');
        } else {
          console.error('Push to Drive error:', err);
          setSyncDriveStatus(`❌ Lỗi đồng bộ lên Drive: ${err.message}`);
        }
      } finally {
        isPushingRef.current = false;
        isRestoreMergePushRef.current = false;
        setIsSyncingDrive(false);
        setTimeout(() => setSyncDriveStatus(null), 4000);

        // Kích hoạt đẩy dữ liệu xếp hàng đợi nếu có thay đổi mới nhất trong lúc đang push
        if (needsPushRef.current && pendingBooksRef.current) {
          const nextB = pendingBooksRef.current;
          const nextA = pendingAdjsRef.current || settlementAdjustments;
          needsPushRef.current = false;
          pendingBooksRef.current = null;
          pendingAdjsRef.current = null;
          setTimeout(() => {
            pushBooksToDrive(nextB, nextA);
          }, 400);
        }
      }
    },
    [currentUser, settings.googleSheetUrl, setSettings, settlementAdjustments, setShowFileDeletedRecovery]
  );

  // Auto-sync whenever Google Sheet link is present or user logs in with a valid token
  useEffect(() => {
    if (currentUser?.isOffline) return;
    if (isSwitchingFileRef.current) return;
    if (!settings.googleSheetUrl) {
      lastSyncedUrlRef.current = null;
      return;
    }
    const token = getGoogleAccessToken();
    if (token) {
      if (settings.googleSheetUrl !== lastSyncedUrlRef.current) {
        console.info(`[Central Hub Sync] URL changed to ${settings.googleSheetUrl}. Syncing...`);
        syncBooksFromDrive(false, token);
      }
    }
  }, [settings.googleSheetUrl, currentUser, syncBooksFromDrive]);

  // Tự động nhận diện và kết nối file trung tâm khi login hoặc mở app trên thiết bị mới
  useEffect(() => {
    const performAutoConnect = async () => {
      if (currentUser?.isOffline || isSwitchingFileRef.current || isAutoConnectingRef.current) return;
      isAutoConnectingRef.current = true;
      const token = getGoogleAccessToken();
      if (!token) {
        isAutoConnectingRef.current = false;
        return;
      }

      try {
        // Nếu tên file hiện hành là file test mặc định cũ (So_tiet_kiem_2026), giải phóng ngay
        if (settingsRef.current.googleSheetName && isDefaultTestName(settingsRef.current.googleSheetName)) {
          console.info('[Central Hub Sync] File hiện tại là file test mặc định cũ, tự động dọn dẹp liên kết.');
          setSettings((prev) => ({
            ...prev,
            googleSheetUrl: undefined,
            googleSheetName: undefined,
            lastSyncTime: undefined,
            lastLocalLinkTimestamp: undefined,
          }));
          setExplicitlyUnlinked(true);
          return;
        }

        // 1. Trường hợp máy chưa có file liên kết cục bộ (hoặc máy 2 vừa mở app sau khi máy 1 tạo/liên kết lại)
        if (!settingsRef.current.googleSheetUrl) {
          const discovery = await autoDiscoverLatestCentralHub(token, currentUser?.email);
          const rawHub = discovery.status === 'found' ? discovery.hub : (discovery.status === 'multiple' ? (discovery.recommendedHub || discovery.hubs[0] || null) : null);
          const hub = rawHub && !isDefaultTestName(rawHub.name) ? rawHub : null;
          if (discovery.status === 'multiple' && !hub) {
            setSyncDriveStatus(`Tìm thấy ${discovery.hubs.length} File liên kết; hãy chọn thủ công trong Đồng bộ Drive.`);
          } else if (discovery.status === 'error' && !hub) {
            console.warn(`[Central Hub Sync] ${discovery.message}`);
          }
          if (hub) {
            const masterState = await getMasterSyncStateFromDrive(token, hub.id);
            if (masterState && masterState.status === 'active' && masterState.lastAction !== 'unlink') {
              applyMasterStateToSettings(masterState, currentUser?.email, setSettings, settingsRef.current, token);
              const link = hub.webViewLink || masterState.activeFileUrl || `https://docs.google.com/spreadsheets/d/${hub.id}/edit`;
              const fileName = hub.name || masterState.activeFileName || 'Sổ tiết kiệm';
              console.info(`[Central Hub Sync] Phát hiện file trung tâm "${fileName}". Tự động kết nối và nạp dữ liệu ngay lập tức...`);
              setSyncDriveStatus(`Đang tự động đồng bộ file trung tâm "${fileName}"...`);
              setExplicitlyUnlinked(false);

              try {
                sessionStorage.removeItem('explicitly_unlinked');
              } catch {}

              // Tải dữ liệu từ file trung tâm
              try {
                const res = await downloadRealGoogleDriveFile(token, hub.id, hub.mimeType, currentUser?.email || '');
                if (res.success) {
                  applyMasterSettlements(res.settlements || []);
                  if (res.books && res.books.length > 0) {
                    const activeRemote = res.books.map((b) => ({ ...b, status: 'active' as BookStatus }));
                    const mergedBooks = sortAndReindexBooks(activeRemote);
                    setBooks(mergedBooks);
                    localStorage.setItem('savings_books_v3', JSON.stringify(mergedBooks));
                  }
                  const nowStr = new Date().toLocaleString('vi-VN');
                  setSettings((prev) => ({
                    ...prev,
                    googleSheetUrl: link,
                    googleSheetName: fileName,
                    lastSyncTime: nowStr,
                    lastLocalLinkTimestamp: masterState.linkedTimestamp || new Date().toISOString(),
                    autoSync: true,
                  }));
                  setSyncDriveStatus(`⚡ Đã tự động kết nối & đồng bộ file trung tâm "${fileName}"`);
                  setTimeout(() => setSyncDriveStatus(null), 3500);
                } else {
                  setSyncDriveStatus(null);
                }
              } catch (dlErr: any) {
                console.warn('Lỗi tải dữ liệu cho file tự động phát hiện:', dlErr);
                setSyncDriveStatus(null);
              }
            }
          }
          isAutoConnectingRef.current = false;
          return;
        }

        // 2. Trường hợp máy đã có file liên kết cục bộ: kiểm tra xem file master trên Drive có bị unlinked không
        const currentUrl = settingsRef.current.googleSheetUrl;
        const match = currentUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/) || currentUrl?.match(/id=([a-zA-Z0-9-_]+)/);
        const currentFileId = match ? match[1] : undefined;
        const masterState = await getMasterSyncStateFromDrive(token, currentFileId, { strict: true });

        if (!masterState) {
          console.warn('[Central Hub Sync] Không đọc được trạng thái workspace; giữ nguyên dữ liệu và liên kết local.');
          isAutoConnectingRef.current = false;
          return;
        }

        if (
          masterState.activeFileId === currentFileId &&
          (masterState.status === 'unlinked' || masterState.lastAction === 'unlink')
        ) {
          console.info('[Central Hub Sync] File master đã ở trạng thái unlinked trên Drive -> Hủy liên kết cục bộ.');
          setExplicitlyUnlinked(true);
          setBooks([]);
          if (setSettlementAdjustments) setSettlementAdjustments([]);
          setSettings((prev) => ({
            ...prev,
            googleSheetUrl: undefined,
            googleSheetName: undefined,
            currentRole: 'ADMIN',
            workspaceOwnerEmail: undefined,
            isPersonalWorkspace: true,
            members: [],
            lastSyncTime: undefined,
          }));
          isAutoConnectingRef.current = false;
          return;
        }

        if (masterState.status !== 'active' || masterState.activeFileId !== currentFileId) {
          console.warn('[Central Hub Sync] Master state không khớp file đang liên kết; giữ nguyên dữ liệu local.');
          isAutoConnectingRef.current = false;
          return;
        }

        // Master state tồn tại và active
        applyMasterStateToSettings(masterState, currentUser?.email, setSettings, settingsRef.current, token);
      } catch (err: any) {
        console.warn('Lỗi quét tìm file trung tâm tự động:', err);
        recordSyncAuditLog({
          type: 'SYNC_ERROR',
          title: 'Lỗi quét tìm file trung tâm',
          status: 'error',
          userEmail: currentUser?.email,
          currentRole: settingsRef.current?.currentRole,
          summary: `Lỗi quét file: ${err?.message || err}`,
          errorMessage: err?.stack || err?.message,
        });
      } finally {
        isAutoConnectingRef.current = false;
      }
    };

    performAutoConnect();

    // Lắng nghe khi người dùng quay lại app (sau khi hoàn tất đăng nhập Google trên popup)
    const handleFocus = () => {
      performAutoConnect();
    };

    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
    };
  }, [currentUser, setSettings, setBooks]);

  useEffect(
    () => () => {
      if (pendingQueueRetryRef.current !== null) {
        window.clearTimeout(pendingQueueRetryRef.current);
      }
    },
    []
  );

  // Only explicitly queued book and settlement mutations are eligible for Drive push.
  useEffect(() => {
    const queued = readLocalSyncQueue();
    const hasQueued = hasLocalSyncMutations(queued);
    if (isSyncingRef.current && hasQueued) {
      needsPushRef.current = true;
      pendingBooksRef.current = books;
      pendingAdjsRef.current = settlementAdjustments;
      return;
    }
    if (!isInitialSyncDoneRef.current || isSwitchingFileRef.current || isSyncingRef.current) {
      return;
    }

    const currentBooksStr = JSON.stringify(books);
    const currentAdjsStr = JSON.stringify(settlementAdjustments);

    if (Date.now() < remoteSyncCooldownUntilRef.current) {
      previousBooksStringRef.current = currentBooksStr;
      previousAdjsStringRef.current = currentAdjsStr;
      if (
        hasQueued &&
        pendingQueueRetryRef.current === null &&
        typeof navigator !== 'undefined' &&
        navigator.onLine
      ) {
        const delay = Math.max(250, remoteSyncCooldownUntilRef.current - Date.now() + 250);
        pendingQueueRetryRef.current = window.setTimeout(() => {
          pendingQueueRetryRef.current = null;
          void syncBooksFromDriveRef.current(false);
        }, delay);
      }
      return;
    }

    if (isRemoteUpdateRef.current) {
      isRemoteUpdateRef.current = false;
      previousBooksStringRef.current = currentBooksStr;
      previousAdjsStringRef.current = currentAdjsStr;
      needsPushRef.current = false;
      pendingBooksRef.current = null;
      pendingAdjsRef.current = null;
      return;
    }

    // Chỉ push khi có sự thay đổi thực sự so với snapshot trước đó
    if (
      currentBooksStr !== previousBooksStringRef.current ||
      currentAdjsStr !== previousAdjsStringRef.current
    ) {
      previousBooksStringRef.current = currentBooksStr;
      previousAdjsStringRef.current = currentAdjsStr;

      if (
        localStorage.getItem('savings_master_restore_required') === 'true' ||
        !hasQueued
      ) {
        return;
      }

      // Thành viên vai trò VIEWER (Chỉ xem) không được đẩy dữ liệu lên Drive
      if (!canPushToDrive(settings.currentRole)) {
        return;
      }

      if (isPushingRef.current || isSyncingRef.current || Date.now() < fileSwitchCooldownUntilRef.current) {
        // Đang bận hoặc đang trong cooldown -> Đánh dấu cần push sau khi rảnh
        needsPushRef.current = true;
        pendingBooksRef.current = books;
        pendingAdjsRef.current = settlementAdjustments;
        console.info('[Drive Sync] Phát hiện thay đổi cục bộ trong khi bận, đã xếp hàng đợi cập nhật lên Drive.');
      } else {
        // Rảnh -> Đẩy ngay lập tức
        pushBooksToDrive(books, settlementAdjustments);
      }
    }
  }, [books, settlementAdjustments, pushBooksToDrive, settings.currentRole]);

  const syncBooksFromDriveRef = useRef(syncBooksFromDrive);
  syncBooksFromDriveRef.current = syncBooksFromDrive;

  const checkRemoteSheetChanges = useCallback(
    async (isInitial = false) => {
      if (!isTabVisibleRef.current) return; // Skip polling when tab is hidden
      lastCheckedModifiedTimeTimestampRef.current = Date.now();

      if (!settings.googleSheetUrl || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
      if (
        isSwitchingFileRef.current ||
        isSyncingRef.current ||
        isPushingRef.current ||
        isCheckingRemoteRef.current
      ) {
        return;
      }
      if (Date.now() < fileSwitchCooldownUntilRef.current) {
        return;
      }
      // Khắc phục triệt để vòng lặp tự kích hoạt: Nếu vừa tự đẩy lên Drive trong 8 giây qua, bỏ qua không kéo lại
      if (Date.now() - lastLocalPushTimeRef.current < 8000) {
        return;
      }

      let token = getGoogleAccessToken();
      let isValid = isGoogleTokenValid();
      if (!token || !isValid) {
        const silentToken = await trySilentRefresh();
        if (silentToken) {
          token = silentToken;
          isValid = true;
        } else {
          if (token && !isValid) {
            setGoogleAccessToken(null);
            setIsDriveTokenExpired(true);
            setSyncDriveStatus('⚠️ Cần xác thực lại tài khoản Google Drive.');
          }
          return;
        }
      }

      const match =
        settings.googleSheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/) ||
        settings.googleSheetUrl.match(/id=([a-zA-Z0-9-_]+)/);
      const fileId = match
        ? match[1]
        : settings.googleSheetUrl.length > 20 && !settings.googleSheetUrl.includes('/')
        ? settings.googleSheetUrl
        : null;
      if (!fileId) return;

      try {
        isCheckingRemoteRef.current = true;

        // Check if another device changed the active central hub file on Drive
        try {
          const timeSinceUrlChange = Date.now() - lastUrlChangeTimeRef.current;
          if (timeSinceUrlChange < 10000) {
            // Vừa đổi link cục bộ, chờ Drive index
          } else {
            // Kiểm tra trạng thái file liên kết hiện tại qua tab __CONFIG__
            try {
              const currentMaster = token ? await getMasterSyncStateFromDrive(token, fileId) : null;
              if (currentMaster) {
                applyMasterStateToSettings(currentMaster, currentUser?.email, setSettings, settingsRef.current, token);
                if (currentMaster.status === 'unlinked' || currentMaster.lastAction === 'unlink') {
                  console.info('[Central Hub Sync] Phát hiện thiết bị khác đã hủy liên kết file trung tâm. Tự động ngắt kết nối và dọn dẹp dữ liệu...');
                  
                  // Thực hiện hủy liên kết và làm sạch toàn bộ dữ liệu cục bộ
                  setExplicitlyUnlinked(true);
                  setBooks([]);
                  if (setSettlementAdjustments) setSettlementAdjustments([]);
                  try {
                    localStorage.setItem('savings_books_v3', JSON.stringify([]));
                    localStorage.setItem('savings_settlements_v3', JSON.stringify([]));
                    localStorage.setItem('savings_books_cleared', 'true');
                    clearStaticHistoryFromStorage();
                  } catch {}

                  setSettings((prev) => ({
                    ...prev,
                    googleSheetUrl: '',
                    googleSheetName: '',
                    currentRole: 'ADMIN',
                    workspaceOwnerEmail: undefined,
                    isPersonalWorkspace: true,
                    members: [],
                    lastSyncTime: undefined,
                    lastLocalLinkTimestamp: currentMaster.updatedAt || currentMaster.linkedTimestamp,
                  }));
                  setSyncDriveStatus('⚡ Thiết bị khác đã hủy liên kết. Đã dọn sạch dữ liệu để đảm bảo an toàn.');
                  return;
                }
              }
            } catch (initErr: any) {
              console.warn('Init master state warning:', initErr);
              if (
                initErr?.message?.includes('hết hạn') ||
                initErr?.message?.includes('401') ||
                initErr?.message?.includes('invalid authentication credentials') ||
                initErr?.message?.includes('credentials')
              ) {
                setGoogleAccessToken(null);
                setIsDriveTokenExpired(true);
                setSyncDriveStatus('⚠️ Phiên kết nối Google Drive đã hết hạn.');
                return;
              }
            }
          }
        } catch (hubErr: any) {
          console.warn('Central hub check warning:', hubErr);
          if (
            hubErr?.message?.includes('hết hạn') ||
            hubErr?.message?.includes('401') ||
            hubErr?.message?.includes('invalid authentication credentials') ||
            hubErr?.message?.includes('credentials')
          ) {
            console.warn('[Central Hub Sync] Token expired inside checkRemoteSheetChanges. Clearing token.');
            setGoogleAccessToken(null);
            setIsDriveTokenExpired(true);
            setSyncDriveStatus('⚠️ Phiên kết nối Google Drive đã hết hạn.');
            return;
          }
        }

        const meta = await getRealGoogleDriveFileMetadata(token, fileId);
        if (meta?.isDeleted) {
          console.warn('Google Drive file is marked deleted on Drive:', fileId);
          setSyncDriveStatus('⚠️ File liên kết đang ở trong thùng rác hoặc không khả dụng.');
          return;
        }

        if (isInitial && !isInitialSyncDoneRef.current) {
          if (meta?.modifiedTime) {
            lastCheckedModifiedTimeRef.current = meta.modifiedTime;
          }
          await syncBooksFromDriveRef.current(false, token);
        } else if (meta?.modifiedTime) {
          // Nếu vừa thực hiện đẩy dữ liệu lên Drive trong vòng 8 giây, cập nhật timestamp và bỏ qua kéo về để tránh ghi đè dữ liệu vừa sửa
          if (Date.now() - lastLocalPushTimeRef.current < 8000) {
            lastCheckedModifiedTimeRef.current = meta.modifiedTime;
            return;
          }

          if (!lastCheckedModifiedTimeRef.current) {
            lastCheckedModifiedTimeRef.current = meta.modifiedTime;
          } else if (meta.modifiedTime !== lastCheckedModifiedTimeRef.current) {
            // File trên Google Drive đã được sửa đổi bên ngoài!
            lastCheckedModifiedTimeRef.current = meta.modifiedTime;
            await syncBooksFromDriveRef.current(false, token);
            setSyncDriveStatus('Đã cập nhật dữ liệu mới từ Google Drive');
            setTimeout(() => setSyncDriveStatus(null), 3500);
          }
        }
      } catch (err: any) {
        if (
          err?.message?.includes('hết hạn') ||
          err?.message?.includes('401') ||
          err?.message?.includes('invalid authentication credentials') ||
          err?.message?.includes('credentials')
        ) {
          console.warn('[Central Hub Sync] Token expired/invalid inside checkRemoteSheetChanges outer catch. Clearing token.');
          setGoogleAccessToken(null);
          setIsDriveTokenExpired(true);
          setSyncDriveStatus('⚠️ Phiên kết nối Google Drive đã hết hạn.');
          return;
        }

        if (
          err?.message?.includes('FILE_NOT_FOUND') ||
          err?.message?.includes('xóa') ||
          err?.message?.includes('thùng rác') ||
          err?.message?.includes('404')
        ) {
          console.warn('checkRemoteSheetChanges: file not found or inaccessible for this account:', err?.message);
          recordSyncAuditLog({
            type: 'SYNC_ERROR',
            title: 'File Google Drive không tìm thấy hoặc đã bị xóa',
            status: 'error',
            userEmail: currentUser?.email,
            currentRole: settingsRef.current?.currentRole,
            summary: `File không truy cập được: ${err?.message || err}`,
            errorMessage: err?.stack || err?.message,
            details: { fileId },
          });
        }
      } finally {
        isCheckingRemoteRef.current = false;
      }
    },
    [currentUser, settings.googleSheetUrl, settings.lastLocalLinkTimestamp, setSettings, setShowFileDeletedRecovery]
  );

  const expiredNoticeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const clearExpiredNoticeTimer = useCallback(() => {
    if (expiredNoticeTimerRef.current) {
      clearTimeout(expiredNoticeTimerRef.current);
      expiredNoticeTimerRef.current = null;
    }
    setIsDriveTokenExpired(false);
  }, []);

  // Kiểm tra tính hợp lệ của Token Google Drive định kỳ & tự động kiểm tra liên kết file trung tâm
  const checkDriveTokenValidity = useCallback(async (isPassiveBackground = false) => {
    if (!isTabVisibleRef.current) return; // Skip checking token when tab is hidden
    if (currentUser?.isOffline && !settingsRef.current.googleSheetUrl) {
      setIsDriveTokenExpired(false);
      return;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    let token = getGoogleAccessToken();
    let isValid = isGoogleTokenValid();

    if (!token || !isValid) {
      try {
        const freshToken = await trySilentRefresh();
        if (freshToken) {
          token = freshToken;
          isValid = true;
        }
      } catch {
        // ignore
      }
    }

    if (!token || !isValid) {
      if (settingsRef.current.googleSheetUrl && !isExplicitlyUnlinked()) {
        setIsDriveTokenExpired(true);
      } else {
        setIsDriveTokenExpired(false);
      }
      if (!isPassiveBackground && settingsRef.current.googleSheetUrl) {
        setSyncDriveStatus('⚠️ Cần xác thực lại tài khoản Google Drive.');
      }
      return;
    }

    try {
      const res = await fetch(
        'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)',
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (res.status === 401) {
        console.warn('[Google Drive Auth] Token Drive không hợp lệ hoặc đã hết hạn (401). Thử gia hạn ngầm...');
        const freshToken = await trySilentRefresh();
        if (freshToken) {
          token = freshToken;
          setIsDriveTokenExpired(false);
        } else {
          setGoogleAccessToken(null);
          if (!isPassiveBackground) {
            setIsDriveTokenExpired(true);
            setSyncDriveStatus('⚠️ Cần xác thực lại tài khoản Google Drive.');
          }
        }
      } else if (res.status === 403) {
        console.warn('[Google Drive Auth] Google Drive API bị giới hạn truy cập hoặc hết hạn mức (403). Giữ nguyên Token.');
      } else if (res.ok) {
        clearExpiredNoticeTimer();
        setIsDriveTokenExpired(false);

        // Tự động kiểm tra và đồng bộ trạng thái master cùng danh sách thành viên
        if (currentUser.email) {
          try {
            if (!settingsRef.current.googleSheetUrl) {
              const discovery = await autoDiscoverLatestCentralHub(token, currentUser.email);
              const rawHub = discovery.status === 'found' ? discovery.hub : (discovery.status === 'multiple' ? (discovery.recommendedHub || discovery.hubs[0] || null) : null);
              const hub = rawHub && !isDefaultTestName(rawHub.name) ? rawHub : null;
              if (hub) {
                const sheetUrl = hub.webViewLink || `https://docs.google.com/spreadsheets/d/${hub.id}/edit`;
                setSettings((prev) => ({
                  ...prev,
                  googleSheetUrl: sheetUrl,
                  googleSheetName: hub.name || 'Bảng tính tiết kiệm',
                  currentRole: hub.role || prev.currentRole,
                }));
                setExplicitlyUnlinked(false);
                console.info('[Central Hub Sync] Tự động liên kết và nạp dữ liệu từ master File liên kết...');
                await syncBooksFromDriveRef.current(false, token, false, sheetUrl, currentUser.email);
              }
            } else {
              const currentUrl = settingsRef.current.googleSheetUrl;
              const match = currentUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/) || currentUrl?.match(/id=([a-zA-Z0-9-_]+)/);
              const currentFileId = match ? match[1] : undefined;
              const masterState = token ? await getMasterSyncStateFromDrive(token, currentFileId) : null;
              if (masterState && masterState.status === 'active' && masterState.activeFileId) {
                applyMasterStateToSettings(masterState, currentUser.email, setSettings, settingsRef.current, token);
              } else if (masterState && (masterState.status === 'unlinked' || masterState.lastAction === 'unlink')) {
                setExplicitlyUnlinked(true);
                setBooks([]);
                if (setSettlementAdjustments) setSettlementAdjustments([]);
                setSettings((prev) => ({
                  ...prev,
                  googleSheetUrl: undefined,
                  googleSheetName: undefined,
                  currentRole: 'ADMIN',
                  workspaceOwnerEmail: undefined,
                  isPersonalWorkspace: true,
                  members: [],
                  lastSyncTime: undefined,
                }));
              }
            }
          } catch (hubErr) {
            console.warn('Auto discover hub on token check warning:', hubErr);
          }
        }
      }
    } catch (err) {
      // Lỗi mạng tạm thời, giữ nguyên không làm phiền người dùng
    }
  }, [currentUser, setSettings, clearExpiredNoticeTimer]);

  // SMART SYNC: Lắng nghe sự kiện mở app/máy (Cold start, Focus, Visibility, Android Resume) & Polling nền 5 phút
  useEffect(() => {
    if (currentUser?.isOffline && !settings.googleSheetUrl) return;

    // Khởi động ứng dụng: hiển thị local trước, sau đó đối chiếu Drive và hàng đợi thay đổi.
    checkDriveTokenValidity(true);
    const startupQueue = readLocalSyncQueue();
    if (
      hasLocalSyncMutations(startupQueue) ||
      localStorage.getItem('savings_master_restore_required') === 'true'
    ) {
      void syncBooksFromDriveRef.current(false);
    } else {
      checkRemoteSheetChanges(true);
    }

    let lastCheckTime = Date.now();

    // 2. Mở máy / Mở lại app / Chuyển tab: Kiểm tra tức thì để đảm bảo luôn có số liệu mới nhất
    const handleFocusOrVisible = () => {
      const isVisible = typeof document !== 'undefined' ? document.visibilityState === 'visible' : true;
      isTabVisibleRef.current = isVisible;

      if (isVisible) {
        const now = Date.now();
        const timeHidden = now - lastCheckedModifiedTimeTimestampRef.current;
        lastCheckedModifiedTimeTimestampRef.current = now;

        if (now - lastCheckTime > 5000) {
          lastCheckTime = now;
          checkDriveTokenValidity(true);
          if (timeHidden > 3 * 60 * 1000 && isInitialSyncDoneRef.current) {
            console.info('[Smart Sync] Mở lại app sau khi ẩn (>3 phút). Kích hoạt kiểm tra và nạp dữ liệu mới nhất...');
          }
          checkRemoteSheetChanges(false);
        }
      }
    };
    const handleOnline = () => {
      if (!settingsRef.current.googleSheetUrl) return;
      checkDriveTokenValidity(true);
      const pendingQueue = readLocalSyncQueue();
      if (
        hasLocalSyncMutations(pendingQueue) ||
        localStorage.getItem('savings_master_restore_required') === 'true'
      ) {
        void syncBooksFromDriveRef.current(false);
      } else {
        checkRemoteSheetChanges(true);
      }
    };

    window.addEventListener('focus', handleFocusOrVisible);
    window.addEventListener('pageshow', handleFocusOrVisible);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleFocusOrVisible);
    document.addEventListener('resume', handleFocusOrVisible); // Hỗ trợ Capacitor / Android Native App Resume!

    // 3. Chu kỳ polling ngầm thông minh: 5 phút/lần (300,000ms), tự động dừng hoàn toàn khi màn hình tắt/app ẩn
    const intervalId = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        const now = Date.now();
        lastCheckTime = now;
        lastCheckedModifiedTimeTimestampRef.current = now;
        checkDriveTokenValidity(true); // Kiểm tra âm thầm trong nền, không hiện popup phiền toái
        checkRemoteSheetChanges(false);
      }
    }, 5 * 60 * 1000); // 5 phút: Giảm 85% truy vấn Google API, triệt tiêu lỗi Quota 403 và tiết kiệm pin tối đa

    return () => {
      window.removeEventListener('focus', handleFocusOrVisible);
      window.removeEventListener('pageshow', handleFocusOrVisible);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleFocusOrVisible);
      document.removeEventListener('resume', handleFocusOrVisible);
      clearInterval(intervalId);
    };
  }, [checkDriveTokenValidity, checkRemoteSheetChanges, currentUser?.email, currentUser?.isOffline, settings.googleSheetUrl]);

  const renewTokenAndSync = useCallback(async () => {
    try {
      setSyncDriveStatus('🔄 Đang mở xác thực Google Drive...');
      const authResult = await signInWithGoogle();
      const token = authResult.accessToken;
      if (token) {
        clearExpiredNoticeTimer();
        setIsDriveTokenExpired(false);
        try {
          sessionStorage.removeItem('dismissed_drive_prompt');
        } catch {}

        // Cập nhật ngay lập tức thông tin tài khoản đã đăng nhập vào React state & bộ nhớ
        if (authResult.user && authResult.user.email) {
          const userEmail = authResult.user.email.trim().toLowerCase();
          const onlineUser: AuthUser = {
            email: userEmail,
            name: authResult.user.displayName || userEmail.split('@')[0] || 'Chủ Tài Khoản',
            photoURL: authResult.user.photoURL || undefined,
            role: settingsRef.current.currentRole === 'VIEWER' ? 'viewer' : 'admin',
            title: settingsRef.current.currentRole === 'VIEWER'
              ? 'Thành viên (Chỉ xem) - Xem dữ liệu sổ tiết kiệm'
              : 'Quản trị viên (Admin) - Toàn quyền quản lý & Đồng bộ Google Drive',
            isOffline: false,
          };
          if (setCurrentUser) {
            setCurrentUser(onlineUser);
          }
          try {
            localStorage.setItem('savings_auth_user_v3', JSON.stringify(onlineUser));
            Preferences.set({ key: 'savings_auth_user_v3', value: JSON.stringify(onlineUser) }).catch(() => {});
          } catch {}
        }

        setSyncDriveStatus('🔄 Đang kết nối và cập nhật file trung tâm...');

        // Check for an active membership even after a legacy local unlink.
        const discovery = await autoDiscoverLatestCentralHub(token, authResult.user?.email || currentUser?.email);
        const rawHub = discovery.status === 'found' ? discovery.hub : (discovery.status === 'multiple' ? (discovery.recommendedHub || discovery.hubs[0] || null) : null);
        const hub = rawHub && !isDefaultTestName(rawHub.name) ? rawHub : null;
        if (hub) {
          const hubUrl = hub.webViewLink || `https://docs.google.com/spreadsheets/d/${hub.id}/edit`;
          if (hubUrl !== settingsRef.current.googleSheetUrl) {
            console.info('[Central Hub Sync] Phát hiện thay đổi file trung tâm sau khi gia hạn token:', hub.name);
            setSettings((prev) => ({
              ...prev,
              googleSheetUrl: hubUrl,
              googleSheetName: hub.name,
              currentRole: hub.role || prev.currentRole,
              lastLocalLinkTimestamp: hub.linkedTimestamp || new Date().toISOString(),
            }));
          }
        }

        // 2. Tải và đồng bộ dữ liệu ngay lập tức
        await syncBooksFromDriveRef.current(true, token);
        setSyncDriveStatus('✅ Đã gia hạn kết nối Google Drive & đồng bộ dữ liệu mới nhất!');
        setTimeout(() => setSyncDriveStatus(null), 4000);
      }
    } catch (err: any) {
      console.warn('Gia hạn token thất bại:', err);
      const errMsg = err?.message || String(err);
      setSyncDriveStatus(`❌ Gia hạn kết nối Google Drive thất bại: ${errMsg}`);
      recordSyncAuditLog({
        type: 'SYNC_ERROR',
        title: 'Lỗi gia hạn kết nối Google Drive',
        status: 'error',
        userEmail: currentUser?.email,
        currentRole: settingsRef.current?.currentRole,
        sheetName: settingsRef.current?.googleSheetName,
        summary: `Gia hạn kết nối thất bại: ${errMsg}`,
        errorMessage: err?.stack || errMsg,
      });
      throw err;
    }
  }, [currentUser, setCurrentUser, setSettings, clearExpiredNoticeTimer]);

  return {
    isSyncingDrive,
    syncDriveStatus,
    setSyncDriveStatus,
    setIsSyncingDrive,
    isDriveTokenExpired,
    setIsDriveTokenExpired,
    renewTokenAndSync,
    syncBooksFromDrive,
    pushBooksToDrive,
    detectedDesyncHub,
    setDetectedDesyncHub,
    markAsRemoteUpdate,
    startFileSwitch,
    finishFileSwitch,
    cancelFileSwitch,
  };
}
