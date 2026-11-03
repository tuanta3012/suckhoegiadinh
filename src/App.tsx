/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { Smartphone, Loader2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Preferences } from '@capacitor/preferences';
import { SavingsBook, AppSettings, AuthUser, SettlementAdjustment } from './types';
import { buildSavingsBookBusinessId, sortAndReindexBooks } from './utils/dataTranslator';
import { Navbar, NavTabType } from './components/Navbar';
import { BiometricUnlockModal } from './components/BiometricUnlockModal';
import { AppUpdateModal } from './components/AppUpdateModal';
import { BookListView } from './components/BookListView';
import { AppModals } from './components/AppModals';
import { LoginConflictResolveModal } from './components/LoginConflictResolveModal';
import {
  downloadRealGoogleDriveFile,
  updateRealGoogleDriveFile,
  getRealGoogleDriveFileMetadata,
  getGoogleAccessToken,
  isGoogleTokenValid,
  setGoogleAccessToken,
  restoreGoogleAuthSession,
  signOutGoogle,
  signInWithGoogle,
  initGoogleAuth,
  checkRedirectResult,
  autoDiscoverLatestCentralHub,
  removeMemberFromDriveMaster,
  setExplicitlyUnlinked,
  isDefaultTestName,
  getLocalMasterPointerFileId,
  addBlockedUnlinkedFileId,
} from './utils/googleDriveService';
import { removeWorkspaceFileAssignment } from './utils/workspaceShareRelay';
import { resolveUserRole } from './utils/roleHelper';
import { exportSavingsBooksToExcel } from './utils/excelParser';
import {
  getDynamicAnnualInterestHistory,
  getDynamicBalanceGrowthHistory,
  clearStaticHistoryFromStorage,
} from './data/historicalGrowth';
import { getSecureItem, setSecureItem, autoCleanupStartupCache } from './utils/secureStorage';
import { useDriveSync } from './hooks/useDriveSync';
import { useSavingsBooks } from './hooks/useSavingsBooks';
import { useToast } from './context/ToastContext';
import { clearLocalSyncQueue } from './utils/localSyncQueue';
import { scheduleMaturityNotifications } from './utils/notificationService';
import { getVietnamDateISO } from './utils/date';

// Chuyển hai component có kích thước lớn và chứa biểu đồ thành dạng lazy load
const MobilizationOptimizer = React.lazy(() =>
  import('./components/MobilizationOptimizer').then((m) => ({ default: m.MobilizationOptimizer }))
);
const InterestCalculationView = React.lazy(() =>
  import('./components/InterestCalculationView').then((m) => ({ default: m.InterestCalculationView }))
);

const TabLoadingFallback = () => (
  <div className="flex flex-col items-center justify-center min-h-[360px] py-16 px-4 bg-white/70 rounded-2xl border border-slate-200/80 shadow-xs animate-in fade-in duration-150">
    <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 mb-3 shadow-xs">
      <Loader2 className="w-6 h-6 animate-spin" />
    </div>
    <span className="text-sm font-bold text-slate-800">Đang tải phân tích &amp; đồ thị dữ liệu...</span>
    <span className="text-xs text-slate-400 mt-1">Hệ thống đang chuẩn bị mô đun tính toán chuyên sâu</span>
  </div>
);

import { CURRENT_APP_VERSION } from './version';

import { useAppUpdate } from './hooks/useAppUpdate';

const hasSameLinkedData = (
  localBooks: SavingsBook[],
  remoteBooks: SavingsBook[],
  localSettlements: SettlementAdjustment[],
  remoteSettlements: SettlementAdjustment[]
): boolean => {
  const booksMatch = (books: SavingsBook[]) =>
    books
      .map((book) => ({
        id: buildSavingsBookBusinessId(book),
        bookCode: book.bookCode,
        bankId: book.bankId,
        owner: book.owner,
        depositType: book.depositType,
        principal: book.principal,
        interestRate: book.interestRate,
        termMonths: book.termMonths,
        startDate: book.startDate,
        maturityDate: book.maturityDate,
        rolloverOption: book.rolloverOption,
        status: book.status,
        customLoanMargin: book.customLoanMargin,
        note: book.note,
        tag: book.tag,
        settlementDate: book.settlementDate,
        isEarlySettled: book.isEarlySettled,
        actualInterestVND: book.actualInterestVND,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

  const settlementsMatch = (settlements: SettlementAdjustment[]) =>
    settlements
      .map((settlement) => ({
        id: settlement.id,
        bookCode: settlement.bookCode,
        bankId: settlement.bankId,
        owner: settlement.owner,
        principal: settlement.principal,
        settlementDate: settlement.settlementDate,
        settlementYear: settlement.settlementYear,
        settlementType: settlement.settlementType,
        actualInterestVND: settlement.actualInterestVND,
        expectedTermInterest: settlement.expectedTermInterest,
        lostInterestVND: settlement.lostInterestVND,
        reinvested: settlement.reinvested,
        note: settlement.note,
        originalMaturityYear: settlement.originalMaturityYear,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

  return (
    JSON.stringify(booksMatch(localBooks)) === JSON.stringify(booksMatch(remoteBooks)) &&
    JSON.stringify(settlementsMatch(localSettlements)) === JSON.stringify(settlementsMatch(remoteSettlements))
  );
};

export default function App() {
  const { showToast } = useToast();
  const [currentDate, setCurrentDate] = useState(getVietnamDateISO);

  useEffect(() => {
    const refreshDate = () => setCurrentDate(getVietnamDateISO());
    const intervalId = window.setInterval(refreshDate, 60_000);
    document.addEventListener('visibilitychange', refreshDate);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refreshDate);
    };
  }, []);

  const [isPendingAuth, setIsPendingAuth] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem('pending_google_redirect_auth') === 'true';
    } catch {
      return false;
    }
  });

  const [currentUser, setCurrentUser] = useState<AuthUser | null>(() => {
    try {
      if (sessionStorage.getItem('pending_google_redirect_auth') === 'true') {
        return null;
      }
      const saved = localStorage.getItem('savings_auth_user_v3');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    return null;
  });

  const [isUnlocked, setIsUnlocked] = useState<boolean>(() => {
    try {
      const savedUser = localStorage.getItem('savings_auth_user_v3');
      const savedSettings = localStorage.getItem('savings_settings_v3');
      const bioDirect = localStorage.getItem('savings_setting_biometrics');

      if (savedUser) {
        if (bioDirect === 'true') {
          return false;
        }
        if (savedSettings) {
          const parsed = JSON.parse(savedSettings);
          if (parsed.enableBiometricLogin) {
            return false;
          }
        }
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  });

  const [isLogoutWarningModalOpen, setIsLogoutWarningModalOpen] = useState<boolean>(false);
  const [showFileDeletedRecovery, setShowFileDeletedRecovery] = useState<boolean>(false);
  const [isClearDataModalOpen, setIsClearDataModalOpen] = useState<boolean>(false);

  // States to manage conflict when logging in online with existing offline books
  const [conflictHub, setConflictHub] = useState<any | null>(null);
  const [conflictToken, setConflictToken] = useState<string | null>(null);
  const [conflictUser, setConflictUser] = useState<AuthUser | null>(null);

  // App settings state - Hỗ trợ khôi phục đồng bộ đa tầng (Direct keys + JSON settings)
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const saved = localStorage.getItem('savings_settings_v3');
      const notiDirect = localStorage.getItem('savings_setting_notifications');
      const bioDirect = localStorage.getItem('savings_setting_biometrics');

      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          privacyMode: parsed.privacyMode ?? false,
          isVipMode: parsed.isVipMode ?? true,
          upfrontNetting: parsed.upfrontNetting ?? true,
          defaultLoanMargin: parsed.defaultLoanMargin ?? 1.5,
          bankLoanMargins: parsed.bankLoanMargins ?? {
            seabank: 1.5,
            shb: 1.5,
            sea2: 1.5,
            vietcombank: 1.5,
            techcombank: 1.8,
            bidv: 1.5,
            vpbank: 2.0,
            mbbank: 1.5,
            acb: 1.6,
            agribank: 1.5,
            hdbank: 2.0,
            vib: 1.9,
            tpbank: 1.8,
          },
          defaultDemandRate: parsed.defaultDemandRate ?? 0.2,
          defaultLTV: parsed.defaultLTV ?? 1.0,
          husbandName: 'Chồng',
          wifeName: 'Vợ',
          googleSheetUrl: isDefaultTestName(parsed.googleSheetName) ? undefined : (parsed.googleSheetUrl || undefined),
          googleSheetName: isDefaultTestName(parsed.googleSheetName) ? undefined : (parsed.googleSheetName || undefined),
          lastSyncTime: isDefaultTestName(parsed.googleSheetName) ? undefined : (parsed.lastSyncTime ?? undefined),
          notificationsEnabled: notiDirect !== null ? notiDirect === 'true' : (parsed.notificationsEnabled ?? false),
          enableBiometricLogin: bioDirect !== null ? bioDirect === 'true' : (parsed.enableBiometricLogin ?? false),
        };
      } else if (notiDirect !== null || bioDirect !== null) {
        return {
          privacyMode: false,
          isVipMode: true,
          upfrontNetting: true,
          defaultLoanMargin: 1.5,
          bankLoanMargins: {
            seabank: 1.5,
            shb: 1.5,
            sea2: 1.5,
            vietcombank: 1.5,
            techcombank: 1.8,
            bidv: 1.5,
            vpbank: 2.0,
            mbbank: 1.5,
            acb: 1.6,
            agribank: 1.5,
            hdbank: 2.0,
            vib: 1.9,
            tpbank: 1.8,
          },
          defaultDemandRate: 0.2,
          defaultLTV: 1.0,
          husbandName: 'Chồng',
          wifeName: 'Vợ',
          googleSheetUrl: undefined,
          googleSheetName: undefined,
          lastSyncTime: undefined,
          notificationsEnabled: notiDirect === 'true',
          enableBiometricLogin: bioDirect === 'true',
        };
      }
    } catch {
      // ignore
    }
    return {
      privacyMode: false,
      isVipMode: true,
      upfrontNetting: true,
      defaultLoanMargin: 1.5,
      bankLoanMargins: {
        seabank: 1.5,
        shb: 1.5,
        sea2: 1.5,
        vietcombank: 1.5,
        techcombank: 1.8,
        bidv: 1.5,
        vpbank: 2.0,
        mbbank: 1.5,
        acb: 1.6,
        agribank: 1.5,
        hdbank: 2.0,
        vib: 1.9,
        tpbank: 1.8,
      },
      defaultDemandRate: 0.2,
      defaultLTV: 1.0,
      husbandName: 'Chồng',
      wifeName: 'Vợ',
      googleSheetUrl: undefined,
      googleSheetName: undefined,
      lastSyncTime: undefined,
      notificationsEnabled: false,
      enableBiometricLogin: false,
    };
  });

  const [isSessionRestored, setIsSessionRestored] = useState<boolean>(false);
  const [isSplashVisible, setIsSplashVisible] = useState<boolean>(true);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setIsSplashVisible(false), 1300);
    return () => window.clearTimeout(timeoutId);
  }, []);

  // 1. Cấu hình chống đè Status Bar trên thiết bị di động
  useEffect(() => {
    const initNativeStatusBar = async () => {
      try {
        if (Capacitor.isNativePlatform() || (typeof window !== 'undefined' && 'Capacitor' in window)) {
          await StatusBar.setOverlaysWebView({ overlay: false });
          await StatusBar.setBackgroundColor({ color: '#0f172a' });
          await StatusBar.setStyle({ style: Style.Dark });
        }
      } catch (err) {
        // Fallback nhẹ trên giao diện Web Preview
      }
    };
    initNativeStatusBar();
  }, []);

  // 2. Tự động khôi phục phiên làm việc ngầm từ Capacitor Preferences và SecureStorage khi mở/khởi động lại app
  useEffect(() => {
    const restoreSessionFromPreferences = async () => {
      try {
        // Tự động dọn dẹp bộ nhớ đệm tạm thời khi mở app
        await autoCleanupStartupCache();

        let hasBiometric = false;
        let hasNotifications = false;

        // Tầng 1: Đọc từ Keystore phần cứng SecureStorage (không bao giờ bị xóa khi cập nhật APK)
        try {
          const secBio = await getSecureItem('savings_setting_biometrics');
          const secNoti = await getSecureItem('savings_setting_notifications');
          if (secBio === 'true') hasBiometric = true;
          if (secNoti === 'true') hasNotifications = true;
        } catch (e) {
          console.warn('Lỗi đọc SecureStorage settings:', e);
        }

        // Tầng 2: Đọc từ Preferences riêng lẻ
        try {
          const { value: pBio } = await Preferences.get({ key: 'savings_setting_biometrics' });
          const { value: pNoti } = await Preferences.get({ key: 'savings_setting_notifications' });
          if (pBio === 'true') hasBiometric = true;
          if (pNoti === 'true') hasNotifications = true;
        } catch (e) {
          console.warn('Lỗi đọc Preferences settings riêng lẻ:', e);
        }

        // Tầng 3: Đọc settings tổng thể từ Preferences
        let parsedPref: any = null;
        try {
          const { value: prefSettings } = await Preferences.get({ key: 'savings_settings_v3' });
          if (prefSettings) {
            parsedPref = JSON.parse(prefSettings);
            if (parsedPref.enableBiometricLogin) hasBiometric = true;
            if (parsedPref.notificationsEnabled) hasNotifications = true;
          }
        } catch (e) {
          console.warn('Lỗi parse settings từ Preferences:', e);
        }

        // Cập nhật state Settings với giá trị đã được khôi phục chắc chắn
        setSettings((prev) => {
          const updated = {
            ...prev,
            ...(parsedPref || {}),
            enableBiometricLogin: hasBiometric || prev.enableBiometricLogin,
            notificationsEnabled: hasNotifications || prev.notificationsEnabled,
          };
          if (isDefaultTestName(updated.googleSheetName)) {
            updated.googleSheetUrl = undefined;
            updated.googleSheetName = undefined;
            updated.lastSyncTime = undefined;
          }
          try {
            const json = JSON.stringify(updated);
            localStorage.setItem('savings_settings_v3', json);
            localStorage.setItem('savings_setting_biometrics', String(updated.enableBiometricLogin));
            localStorage.setItem('savings_setting_notifications', String(updated.notificationsEnabled));
          } catch {}
          return updated;
        });

        // 2. Khôi phục user từ Preferences
        let hasUser = false;
        if (!currentUser) {
          const { value: prefUser } = await Preferences.get({ key: 'savings_auth_user_v3' });
          if (prefUser) {
            try {
              const user = JSON.parse(prefUser);
              setCurrentUser(user);
              hasUser = true;
            } catch (e) {
              console.warn('Lỗi parse user từ Preferences:', e);
            }
          }
        } else {
          hasUser = true;
        }

        // 3. Nếu khôi phục thành công user và thiết bị KHÔNG bật khóa vân tay, tự động mở khóa (isUnlocked = true)
        if (hasUser) {
          if (!hasBiometric) {
            setIsUnlocked(true);
          } else {
            setIsUnlocked(false);
          }
        }

        // 4. Khôi phục token bảo mật dài hạn (Secure Storage)
        await restoreGoogleAuthSession();
      } catch (err) {
        console.warn('Lỗi khôi phục phiên từ Preferences:', err);
      } finally {
        // Đánh dấu đã khôi phục xong để cho phép ghi đè/lưu thay đổi
        setIsSessionRestored(true);
      }
    };
    restoreSessionFromPreferences();
  }, []);

  // Lưu settings khi thay đổi - Chỉ ghi đè sau khi đã hoàn thành khôi phục từ Preferences
  useEffect(() => {
    if (!isSessionRestored) return;
    try {
      const json = JSON.stringify(settings);
      localStorage.setItem('savings_settings_v3', json);
      Preferences.set({ key: 'savings_settings_v3', value: json }).catch(() => {});

      // Đồng thời lưu độc lập vào SecureStorage (Keystore) và Preferences
      if (settings.enableBiometricLogin !== undefined) {
        const bioVal = String(settings.enableBiometricLogin);
        localStorage.setItem('savings_setting_biometrics', bioVal);
        Preferences.set({ key: 'savings_setting_biometrics', value: bioVal }).catch(() => {});
        setSecureItem('savings_setting_biometrics', bioVal).catch(() => {});
      }
      if (settings.notificationsEnabled !== undefined) {
        const notiVal = String(settings.notificationsEnabled);
        localStorage.setItem('savings_setting_notifications', notiVal);
        Preferences.set({ key: 'savings_setting_notifications', value: notiVal }).catch(() => {});
        setSecureItem('savings_setting_notifications', notiVal).catch(() => {});
      }

      if (!settings.googleSheetUrl) {
        clearStaticHistoryFromStorage();
      }
    } catch {
      // ignore
    }
  }, [settings, isSessionRestored]);

  // Lưu user khi thay đổi - Chỉ ghi đè sau khi đã hoàn thành khôi phục từ Preferences
  useEffect(() => {
    if (!isSessionRestored) return;
    try {
      if (currentUser) {
        const json = JSON.stringify(currentUser);
        localStorage.setItem('savings_auth_user_v3', json);
        Preferences.set({ key: 'savings_auth_user_v3', value: json }).catch(() => {});
      } else {
        localStorage.removeItem('savings_auth_user_v3');
        Preferences.remove({ key: 'savings_auth_user_v3' }).catch(() => {});
      }
    } catch {
      // ignore
    }
  }, [currentUser, isSessionRestored]);



  // 3. Tự động kiểm tra cập nhật APK từ xa bằng useAppUpdate hook
  const {
    updateInfo,
    isUpdateModalOpen,
    setIsUpdateModalOpen,
    checkAppUpdate,
  } = useAppUpdate({
    currentVersion: CURRENT_APP_VERSION,
    updateServerUrl: 'https://raw.githubusercontent.com/tuanta3012/sotietkiem/main/version.json',
    autoCheckDelayMs: 2000,
    onNotification: (msg, type) => {
      if (type === 'info') {
        showToast(msg, 'info');
      } else if (type === 'success') {
        showToast(msg, 'success', 4000);
      } else {
        showToast(msg, 'error', 4000);
      }
    },
  });

  // Giữ phiên Google OAuth và Firebase Auth luôn đồng bộ bền vững khi mở app hoặc refresh trang
  useEffect(() => {
    if (!isSessionRestored) return; // Đợi khôi phục xong phiên từ Secure Storage mới lắng nghe Auth

    const unsubscribe = initGoogleAuth(
      (firebaseUser, token) => {
        if (token) {
          setGoogleAccessToken(token);
          setIsDriveTokenExpired(false);
        }
        if (firebaseUser && firebaseUser.email) {
          const cleanEmail = firebaseUser.email.trim().toLowerCase();
          setCurrentUser((prev) => {
            if (prev && !prev.isOffline && prev.email === cleanEmail) {
              return prev;
            }
            const onlineUser: AuthUser = {
              email: cleanEmail,
              name: firebaseUser.displayName || prev?.name || cleanEmail.split('@')[0] || 'Chủ Tài Khoản',
              photoURL: firebaseUser.photoURL || prev?.photoURL || undefined,
              role: (settings.currentRole === 'VIEWER' || prev?.role === 'viewer') ? 'viewer' : 'admin',
              title: (settings.currentRole === 'VIEWER' || prev?.role === 'viewer')
                ? 'Thành viên (Chỉ xem) - Xem dữ liệu sổ tiết kiệm'
                : 'Quản trị viên (Admin) - Toàn quyền quản lý & Đồng bộ Google Drive',
              isOffline: false,
            };
            try {
              localStorage.setItem('savings_auth_user_v3', JSON.stringify(onlineUser));
              Preferences.set({ key: 'savings_auth_user_v3', value: JSON.stringify(onlineUser) }).catch(() => {});
            } catch {}
            return onlineUser;
          });
        }
      },
      () => {
        // signed out
      }
    );
    return () => {
      unsubscribe();
    };
  }, [isSessionRestored, settings.currentRole]);

  // Ref callbacks for useSavingsBooks to push to Google Drive seamlessly
  const pushBooksToDriveRef = useRef<((b: SavingsBook[], a?: SettlementAdjustment[]) => void) | undefined>(undefined);
  const showSyncStatusRef = useRef<((msg: string) => void) | undefined>(undefined);

  // Savings books core management hook
  const {
    books,
    setBooks,
    settlementAdjustments,
    setSettlementAdjustments,
    activeBooks,
    totalPrincipal,
    totalEstimatedInterest,
    sortedBanksInfo,
    banksVersion,
    setBanksVersion,
    searchQuery,
    setSearchQuery,
    ownerFilter,
    setOwnerFilter,
    bankFilter,
    setBankFilter,
    sortBy,
    setSortBy,
    filteredBooks,
    handleUpdateBook,
    handleSaveBook,
    handleDeleteBook,
    handleSettleBook,
    handleRolloverBook,
    handleImportBooks,
    handleDeleteSettlementAdjustment,
    handleDeleteAllAppData,
  } = useSavingsBooks({
    currentRole: settings.currentRole,
    onShowSyncStatus: (msg) => showSyncStatusRef.current?.(msg),
  });

  // Google Drive 2-way sync hook
  const {
    isSyncingDrive,
    syncDriveStatus,
    setSyncDriveStatus,
    setIsSyncingDrive,
    isDriveTokenExpired,
    setIsDriveTokenExpired,
    renewTokenAndSync,
    syncBooksFromDrive,
    pushBooksToDrive,
    markAsRemoteUpdate,
    startFileSwitch,
    finishFileSwitch,
    cancelFileSwitch,
  } = useDriveSync({
    currentUser,
    setCurrentUser,
    settings,
    setSettings,
    books,
    setBooks,
    settlementAdjustments,
    setSettlementAdjustments,
    setShowFileDeletedRecovery,
  });

  const consumeWorkspaceRelay = useCallback(
    async (_relayAssignment: boolean | undefined, memberEmail: string) => {
      if (!memberEmail) return;
      try {
        await removeWorkspaceFileAssignment(memberEmail);
      } catch (error) {
        console.warn('[Workspace Relay] Thông báo dọn dẹp vé Firestore:', error);
      }
    },
    []
  );
  const [driveAuthServiceReachable, setDriveAuthServiceReachable] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      setDriveAuthServiceReachable(false);
      return;
    }
    if (!isDriveTokenExpired) {
      setDriveAuthServiceReachable(true);
      return;
    }

    let isActive = true;
    const verifyDriveReachability = async () => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(
          'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)',
          { signal: controller.signal, cache: 'no-store' }
        );
        if (isActive) {
          setDriveAuthServiceReachable(
            response.ok || response.status === 401 || response.status === 403
          );
        }
      } catch {
        if (isActive) setDriveAuthServiceReachable(false);
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    void verifyDriveReachability();
    const intervalId = window.setInterval(() => void verifyDriveReachability(), 15000);
    return () => {
      isActive = false;
      window.clearInterval(intervalId);
    };
  }, [isDriveTokenExpired, isOnline]);

  pushBooksToDriveRef.current = pushBooksToDrive;
  showSyncStatusRef.current = setSyncDriveStatus;

  // Tự động lập lịch thông báo nhắc đáo hạn (Local Notifications trên Capacitor Android)
  useEffect(() => {
    if (settings.notificationsEnabled && books.length > 0) {
      scheduleMaturityNotifications(books).catch((err) => {
        console.warn('Lỗi tự động lập lịch thông báo đáo hạn:', err);
      });
    }
  }, [settings.notificationsEnabled, books]);

  useEffect(() => {
    const handleRedirect = async () => {
      try {
        const redirectRes = await checkRedirectResult();
        if (redirectRes) {
          const email = redirectRes.user.email || '';
          const cleanEmail = email.trim().toLowerCase();

          const role: 'admin' | 'viewer' = 'admin';
          const title = 'Quản trị viên (Admin) - Toàn quyền quản lý & Đồng bộ Google Drive';
          const name = redirectRes.user.displayName || 'Chủ Tài Khoản';

          const onlineUser: AuthUser = {
            email: cleanEmail,
            name,
            photoURL: redirectRes.user.photoURL || undefined,
            role,
            title,
            isOffline: false,
          };

          setCurrentUser(onlineUser);
          setIsUnlocked(true);
          setGoogleAccessToken(redirectRes.accessToken);
          setIsPendingAuth(false);
          syncBooksFromDrive(
            false,
            redirectRes.accessToken,
            false,
            undefined,
            cleanEmail
          );
        } else {
          setIsPendingAuth(false);
        }
      } catch (err) {
        console.error('Error handling Google OAuth redirect result:', err);
        setIsPendingAuth(false);
      }
    };
    handleRedirect();
  }, [syncBooksFromDrive]);

  // Navigation states
  const [activeTab, setActiveTab] = useState<NavTabType>('sheet-view');
  const [sheetSubView, setSheetSubView] = useState<'excel' | 'cards'>('excel');
  const [, setAnalyticsSubView] = useState<'cashflow' | 'charts'>('cashflow');

  // Preview & Modal states
  const [isMobilePreview, setIsMobilePreview] = useState<boolean>(false);
  const [isAddModalOpen, setIsAddModalOpen] = useState<boolean>(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState<boolean>(false);
  const [isAndroidSpecModalOpen, setIsAndroidSpecModalOpen] = useState<boolean>(false);
  const [isManageBanksModalOpen, setIsManageBanksModalOpen] = useState<boolean>(false);
  const [isUserManagementModalOpen, setIsUserManagementModalOpen] = useState<boolean>(false);
  const [bookToEdit, setBookToEdit] = useState<SavingsBook | null>(null);
  const [selectedBookForDetail, setSelectedBookForDetail] = useState<SavingsBook | null>(null);

  // Tích hợp phím Back cứng và cử chỉ vuốt Back của Android (Capacitor App plugin)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handleBackButton = CapApp.addListener('backButton', () => {
      if (selectedBookForDetail) {
        setSelectedBookForDetail(null);
        return;
      }
      if (isAddModalOpen) {
        setIsAddModalOpen(false);
        setBookToEdit(null);
        return;
      }
      if (isSyncModalOpen) {
        setIsSyncModalOpen(false);
        return;
      }
      if (isAndroidSpecModalOpen) {
        setIsAndroidSpecModalOpen(false);
        return;
      }
      if (isManageBanksModalOpen) {
        setIsManageBanksModalOpen(false);
        return;
      }
      if (isUserManagementModalOpen) {
        setIsUserManagementModalOpen(false);
        return;
      }
      if (isLogoutWarningModalOpen) {
        setIsLogoutWarningModalOpen(false);
        return;
      }
      if (showFileDeletedRecovery) {
        setShowFileDeletedRecovery(false);
        return;
      }
      if (isClearDataModalOpen) {
        setIsClearDataModalOpen(false);
        return;
      }
      if (isUpdateModalOpen) {
        setIsUpdateModalOpen(false);
        return;
      }
      if (conflictHub) {
        setConflictHub(null);
        return;
      }
      if (activeTab !== 'sheet-view') {
        setActiveTab('sheet-view');
        return;
      }
      // Nếu đang ở màn hình chính và không có modal nào mở -> Thoát app
      CapApp.exitApp();
    });

    return () => {
      handleBackButton.then((listener) => listener.remove()).catch(() => {});
    };
  }, [
    selectedBookForDetail,
    isAddModalOpen,
    isSyncModalOpen,
    isAndroidSpecModalOpen,
    isManageBanksModalOpen,
    isUserManagementModalOpen,
    isLogoutWarningModalOpen,
    showFileDeletedRecovery,
    isClearDataModalOpen,
    isUpdateModalOpen,
    conflictHub,
    activeTab,
  ]);

  const handleLeaveWorkspace = async () => {
    const token = getGoogleAccessToken();
    const currentFileId =
      settings.googleSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
      getLocalMasterPointerFileId();
    if (currentFileId) {
      addBlockedUnlinkedFileId(currentFileId);
    }
    if (token && currentUser?.email) {
      try {
        await removeMemberFromDriveMaster(token, currentUser.email);
      } catch (err) {
        console.warn('Lỗi tự động xóa thành viên khỏi Master State trên Drive:', err);
      }
    }

    setExplicitlyUnlinked(true);

    setSettings((prev) => ({
      ...prev,
      googleSheetUrl: undefined,
      googleSheetName: undefined,
      currentRole: 'ADMIN',
      workspaceOwnerEmail: undefined,
      members: [],
      isPersonalWorkspace: true,
      lastLocalLinkTimestamp: undefined,
    }));
    setBooks([]);
    setSettlementAdjustments([]);
    showToast('Đã rời không gian chia sẻ thành công! Bạn hiện là Admin không gian cá nhân mới.', 'success');
  };

  // Switch tab with intelligent normalization
  const handleTabChange = (tab: NavTabType) => {
    if (tab === 'charts') {
      setActiveTab('analytics');
      setAnalyticsSubView('charts');
    } else if (tab === 'portfolio') {
      setActiveTab('sheet-view');
      setSheetSubView('cards');
    } else if (tab === 'android-spec') {
      setIsAndroidSpecModalOpen(true);
    } else {
      setActiveTab(tab);
    }
  };

  const handleOpenEdit = useCallback((book: SavingsBook) => {
    setBookToEdit(book);
    setIsAddModalOpen(true);
  }, []);

  const handleSelectForAnalysis = useCallback((book: SavingsBook) => {
    setSelectedBookForDetail(book);
  }, []);

  // Google Sign-in Handler for Offline User Transition
  const [isLoggingInGoogle, setIsLoggingInGoogle] = useState<boolean>(false);

  const handleLoginGoogle = async () => {
    if (isLoggingInGoogle) return;
    setIsLoggingInGoogle(true);
    try {
      const res = await signInWithGoogle();
      const onlineUser: AuthUser = {
        email: res.user.email || '',
        name: res.user.displayName || 'Chủ Tài Khoản',
        role: 'admin',
        title: 'Quản trị viên (Admin)',
        isOffline: false,
      };
      setCurrentUser(onlineUser);
      setIsUnlocked(true);
      if (res.accessToken) {
        setGoogleAccessToken(res.accessToken);
        setIsDriveTokenExpired(false);
        try {
          const discovery = await autoDiscoverLatestCentralHub(res.accessToken, onlineUser.email);
          const currentFileId =
            settings.googleSheetUrl?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] ||
            settings.googleSheetUrl?.match(/id=([a-zA-Z0-9-_]+)/)?.[1];
          const rawHub =
            discovery.status === 'found'
              ? discovery.hub
              : discovery.status === 'multiple'
                ? (discovery.hubs.find((candidate) => candidate.id === currentFileId) || discovery.recommendedHub || discovery.hubs[0] || null)
                : null;
          const hub = rawHub && !isDefaultTestName(rawHub.name) ? rawHub : null;
          if (hub && books.length > 0) {
            const remote = await downloadRealGoogleDriveFile(
              res.accessToken,
              hub.id,
              hub.mimeType,
              onlineUser.email
            );
            if (!remote.success) {
              throw new Error(remote.errors?.[0] || 'Không thể đọc dữ liệu Google Drive.');
            }
            if (
              !hasSameLinkedData(
                books,
                remote.books || [],
                settlementAdjustments,
                remote.settlements || []
              )
            ) {
              setConflictHub(hub);
              setConflictToken(res.accessToken);
              setConflictUser(onlineUser);
              return;
            }
          }
          if (hub) {
            const targetUrl = hub.webViewLink || `https://docs.google.com/spreadsheets/d/${hub.id}/edit`;
            setSettings((prev) => ({
              ...prev,
              googleSheetUrl: targetUrl,
              googleSheetName: hub.name,
              currentRole: hub.role || prev.currentRole,
              lastLocalLinkTimestamp: hub.linkedTimestamp || new Date().toISOString(),
            }));
            window.setTimeout(async () => {
              let syncSucceeded = false;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  syncSucceeded = Boolean(
                    await syncBooksFromDrive(false, res.accessToken, false, targetUrl, onlineUser.email)
                  );
                  if (syncSucceeded) break;
                } catch {
                  // ignore and retry
                }
                if (attempt < 3) {
                  await new Promise((resolve) => window.setTimeout(resolve, 1000));
                }
              }
              if (syncSucceeded) {
                await consumeWorkspaceRelay(hub.relayAssignment, onlineUser.email);
              }
            }, 200);
          } else if (discovery.status === 'multiple') {
            setIsSyncModalOpen(true);
            showToast(
              `Tìm thấy ${discovery.hubs.length} File liên kết phù hợp. Hãy chọn đúng file trong mục đồng bộ Google Drive.`,
              'error'
            );
          } else if (settings.googleSheetUrl || getLocalMasterPointerFileId()) {
            const existingUrl = settings.googleSheetUrl || `https://docs.google.com/spreadsheets/d/${getLocalMasterPointerFileId()}/edit`;
            await syncBooksFromDrive(false, res.accessToken, false, existingUrl, onlineUser.email);
          } else {
            setIsSyncModalOpen(true);
            if (discovery.status === 'error') {
              showToast(discovery.message, 'error');
            }
          }
        } catch (err: any) {
          console.error('Không thể dò File liên kết sau khi đăng nhập:', err);
          showToast(err?.message || 'Chưa kết nối được Google Drive. Dữ liệu trên máy vẫn được giữ.', 'error');
        }
      }
    } catch (err: any) {
      console.warn('Lỗi đăng nhập Google (đã xử lý):', err?.message || err);
      showToast(err?.message || 'Đăng nhập Google thất bại hoặc bị hủy.', 'error');
    } finally {
      setIsLoggingInGoogle(false);
    }
  };

  const handleNavbarSync = async () => {
    const role = resolveUserRole(
      currentUser?.email,
      settings.currentRole,
      settings.members,
      settings.workspaceOwnerEmail
    );
    if (role === 'ADMIN') {
      setIsSyncModalOpen(true);
      return;
    }
    if (!isOnline || isSyncingDrive || isLoggingInGoogle) return;

    if (settings.googleSheetUrl) {
      await syncBooksFromDrive(true, undefined, true);
      return;
    }

    const token = getGoogleAccessToken();
    if (!token || !isGoogleTokenValid()) {
      try {
        sessionStorage.removeItem('dismissed_drive_prompt');
      } catch {}
      setIsDriveTokenExpired(false);
      await handleLoginGoogle();
      return;
    }

    try {
      const discovery = await autoDiscoverLatestCentralHub(token, currentUser?.email);
      if (discovery.status !== 'found') {
        const message =
          discovery.status === 'multiple'
            ? 'Tìm thấy nhiều file liên kết. Vui lòng liên hệ Admin để xác nhận file nhóm đang dùng.'
            : discovery.status === 'error'
              ? discovery.message
              : 'Không tìm thấy file nhóm đang hoạt động mà tài khoản của bạn được cấp quyền.';
        showToast(message, 'error');
        return;
      }

      const fileUrl =
        discovery.hub.webViewLink ||
        `https://docs.google.com/spreadsheets/d/${discovery.hub.id}/edit`;
      setSettings((prev) => ({
        ...prev,
        googleSheetUrl: fileUrl,
        googleSheetName: discovery.hub.name,
        currentRole: discovery.hub.role || prev.currentRole,
        isPersonalWorkspace: false,
      }));
      await syncBooksFromDrive(
        true,
        token,
        true,
        fileUrl,
        currentUser?.email
      );
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : 'Không thể đồng bộ với file nhóm.',
        'error'
      );
    }
  };

  const clearSessionAndLocalData = () => {
    // Đăng xuất chỉ xóa phiên xác thực; dữ liệu và liên kết local được giữ nguyên.
    try {
      localStorage.removeItem('savings_auth_user_v3');
      localStorage.removeItem('google_drive_access_token');
      localStorage.removeItem('google_drive_access_token_v4');
      sessionStorage.removeItem('google_drive_access_token_v4');
    } catch (err) {
      console.warn('Lỗi khi xóa phiên xác thực cục bộ:', err);
    }

    try {
      Preferences.remove({ key: 'savings_auth_user_v3' }).catch(() => {});
    } catch (err) {
      console.warn('Lỗi khi dọn dẹp Preferences xác thực:', err);
    }
  };

  const handleDeleteAppDataAndUnlink = () => {
    clearLocalSyncQueue();
    try {
      // Xóa sạch dấu vết liên kết file & dữ liệu trong localStorage
      localStorage.removeItem('savings_books_v3');
      localStorage.removeItem('savings_settlements_v3');
      localStorage.setItem('savings_books_cleared', 'true');
      localStorage.setItem('savings_master_restore_required', 'true');
      localStorage.removeItem('last_linked_file_id_v2');
      localStorage.removeItem('master_pointer_file_id');
      localStorage.removeItem('master_sync_state_local_v2');

      const savedSettings = localStorage.getItem('savings_settings_v3');
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings);
        delete parsed.googleSheetUrl;
        delete parsed.googleSheetName;
        delete parsed.lastSyncTime;
        delete parsed.lastLocalLinkTimestamp;
        localStorage.setItem('savings_settings_v3', JSON.stringify(parsed));
      }
    } catch (err) {
      console.warn('Lỗi khi xóa thông tin liên kết:', err);
    }

    // Xóa cứng React State để dọn sạch dữ liệu hiển thị tức thì
    setBooks([]);
    setSettlementAdjustments([]);
    clearStaticHistoryFromStorage();

    setSettings((prev) => ({
      ...prev,
      googleSheetUrl: undefined,
      googleSheetName: undefined,
      lastSyncTime: undefined,
      lastLocalLinkTimestamp: undefined,
    }));
  };

  // Logout Safeguard
  const handleRequestLogout = async () => {
    if (currentUser?.isOffline) {
      clearSessionAndLocalData();
      setCurrentUser(null);
      setIsUnlocked(false);
      setGoogleAccessToken(null);
      signOutGoogle().catch(() => {});
      return;
    }

    if (settings.googleSheetUrl) {
      setIsSyncingDrive(true);
      setSyncDriveStatus('Đang tự động đồng bộ dữ liệu mới nhất lên Google Drive trước khi đăng xuất...');
      try {
        // Tối đa 1.5 giây để đồng bộ, nếu quá thời gian hoặc lỗi mạng, buộc phải bỏ qua để logout lập tức để tránh treo UI
        const pushPromise = pushBooksToDrive(books);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Sync timeout')), 1500)
        );
        await Promise.race([pushPromise, timeoutPromise]);
        setSyncDriveStatus('Đã đồng bộ thành công lên Google Drive. Đã đăng xuất!');
      } catch (err: any) {
        console.warn('Bỏ qua đồng bộ trước đăng xuất do trễ hoặc lỗi mạng (an toàn):', err?.message || err);
      } finally {
        setIsSyncingDrive(false);
      }
      
      // Đăng xuất UI lập tức không chờ tác vụ mạng chặn UI
      clearSessionAndLocalData();
      setCurrentUser(null);
      setIsUnlocked(false);
      setGoogleAccessToken(null);
      signOutGoogle().catch(() => {});
      setTimeout(() => setSyncDriveStatus(null), 3000);
    } else {
      if (books.length > 0) {
        setIsLogoutWarningModalOpen(true);
      } else {
        clearSessionAndLocalData();
        setCurrentUser(null);
        setIsUnlocked(false);
        setGoogleAccessToken(null);
        signOutGoogle().catch(() => {});
      }
    }
  };

  const handleSaveBookFromModal = useCallback(
    (book: SavingsBook) => {
      handleSaveBook(book);
      setIsAddModalOpen(false);
      setBookToEdit(null);
      setActiveTab('sheet-view');
    },
    [handleSaveBook]
  );

  const handleLoginOnlineFromModal = useCallback(
    (user: AuthUser, token?: string) => {
      setCurrentUser(user);
      setIsUnlocked(true);
      if (token) {
        setGoogleAccessToken(token);
        syncBooksFromDrive(false, token, false, undefined, user.email);
      }
    },
    [syncBooksFromDrive]
  );

  const handleDriveFileNotFoundFromModal = useCallback(() => {
    setShowFileDeletedRecovery(true);
  }, []);

  const handleImportBooksFromModal = useCallback(
    (newBooks: SavingsBook[], mode: 'replace' | 'append') => {
      try {
        localStorage.removeItem('savings_books_cleared');
      } catch {
        // ignore
      }
      let updated: SavingsBook[];
      if (mode === 'replace') {
        updated = newBooks;
      } else {
        updated = [...books, ...newBooks];
      }
      setBooks(updated);
    },
    [books, setBooks]
  );

  const handleClearBooksFromModal = useCallback(() => {
    clearLocalSyncQueue();
    try {
      localStorage.setItem('savings_books_cleared', 'true');
      localStorage.setItem('savings_master_restore_required', 'true');
      localStorage.setItem('savings_books_v3', JSON.stringify([]));
      localStorage.setItem('savings_settlements_v3', JSON.stringify([]));
      clearStaticHistoryFromStorage();
    } catch {
      // ignore
    }
    setBooks([]);
    setSettlementAdjustments([]);
  }, [setBooks, setSettlementAdjustments]);

  const handleTriggerManualSyncFromModal = useCallback(async () => {
    const token = getGoogleAccessToken() || undefined;
    await syncBooksFromDrive(true, token, true);
  }, [syncBooksFromDrive]);

  const handleUpdateBookFromModal = useCallback(
    (updatedBook: SavingsBook) => {
      handleUpdateBook(updatedBook);
      setSelectedBookForDetail(updatedBook);
    },
    [handleUpdateBook]
  );

  const handleSettleBookFromModal = useCallback(
    (
      bookId: string,
      extra?: { isEarlySettled: boolean; settlementDate: string; actualInterestVND: number }
    ) => {
      handleSettleBook(bookId, extra);
      setSelectedBookForDetail(null);
      setActiveTab('sheet-view');
      showToast('Đã tất toán sổ tiết kiệm thành công!');
    },
    [handleSettleBook, showToast]
  );

  const handleRolloverBookFromModal = useCallback(
    (
      oldBookId: string,
      config: {
        newPrincipal: number;
        newInterestRate: number;
        newTermMonths: number;
        newStartDate: string;
        newMaturityDate: string;
      }
    ) => {
      handleRolloverBook(oldBookId, config);
      setSelectedBookForDetail(null);
      setActiveTab('sheet-view');
      showToast('Đã tái tục sổ tiết kiệm thành công!');
    },
    [handleRolloverBook, showToast]
  );

  const handleBanksChangedFromModal = useCallback(() => {
    setBanksVersion((v) => v + 1);
  }, [setBanksVersion]);

  const handleConfirmLogoutAnyway = useCallback(async () => {
    setIsLogoutWarningModalOpen(false);
    
    // Đăng xuất UI và xóa dữ liệu lập tức (0ms delay)
    clearSessionAndLocalData();
    setCurrentUser(null);
    setIsUnlocked(false);
    setGoogleAccessToken(null);

    // Chạy ngầm dọn dẹp phiên Google/Firebase ngoài mạng để tối ưu tốc độ phản hồi
    signOutGoogle().catch((err) => console.warn('Background sign out warning:', err));
  }, []);

  const handleExportAndLogout = useCallback(async () => {
    const annualHistory = getDynamicAnnualInterestHistory(books, settlementAdjustments);
    const balanceHistory = getDynamicBalanceGrowthHistory(books, settlementAdjustments);
    
    // 1. Thực hiện xuất file Excel lưu về máy trước
    await exportSavingsBooksToExcel(books, `So_Tiet_Kiem_Gia_Dinh_Backup_${currentDate}.xlsx`, annualHistory, balanceHistory);
    
    setIsLogoutWarningModalOpen(false);
    
    // 2. Đăng xuất UI lập tức
    clearSessionAndLocalData();
    setCurrentUser(null);
    setIsUnlocked(false);
    setGoogleAccessToken(null);

    // 3. Đăng xuất Google ngầm
    signOutGoogle().catch((err) => console.warn('Background sign out warning:', err));
  }, [books, settlementAdjustments]);

  // 4. Các hàm xử lý xung đột đồng bộ giữa sổ tiết kiệm ngoại tuyến và Google Drive
  const resolveConflictMerge = async () => {
    if (!conflictHub || !conflictToken || !conflictUser) return;
    setIsSyncingDrive(true);
    setSyncDriveStatus('Đang thực hiện gộp dữ liệu ngoại tuyến và tệp Google Drive...');
    const fileId = conflictHub.id;
    try {
      const conflictBaseMetadata = await getRealGoogleDriveFileMetadata(conflictToken, fileId);
      if (!conflictBaseMetadata?.modifiedTime) {
        throw new Error('Không thể xác minh phiên bản Drive trước khi gộp dữ liệu.');
      }
      const res = await downloadRealGoogleDriveFile(conflictToken, fileId, undefined, conflictUser.email || '');
      if (res.success) {
        // Gộp danh sách sổ tiết kiệm (Union theo ID)
        const localBooks = books || [];
        const remoteBooks = res.books || [];
        const bookMap = new Map<string, SavingsBook>();
        remoteBooks.forEach((b: SavingsBook) => bookMap.set(b.id, b));
        localBooks.forEach((b: SavingsBook) => bookMap.set(b.id, b));
        const mergedBooks = sortAndReindexBooks(Array.from(bookMap.values()));

        // Gộp nhật ký tất toán (Union theo ID)
        const localAdjs = settlementAdjustments || [];
        const remoteAdjs = res.settlements || [];
        const adjMap = new Map<string, SettlementAdjustment>();
        remoteAdjs.forEach((a: SettlementAdjustment) => adjMap.set(a.id, a));
        localAdjs.forEach((a: SettlementAdjustment) => adjMap.set(a.id, a));
        const mergedAdjs = Array.from(adjMap.values());

        // Cập nhật React State cục bộ
        setBooks(mergedBooks);
        setSettlementAdjustments(mergedAdjs);

        // Thiết lập liên kết Google Sheet trong settings
        const hubUrl = conflictHub.webViewLink || `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
        setSettings((prev) => ({
          ...prev,
          googleSheetUrl: hubUrl,
          googleSheetName: conflictHub.name,
          lastLocalLinkTimestamp: conflictHub.linkedTimestamp || new Date().toISOString(),
        }));

        // Đẩy toàn bộ dữ liệu đã gộp ngược lên Drive trung tâm ngay lập tức
        await updateRealGoogleDriveFile(conflictToken, fileId, mergedBooks, mergedAdjs, {
          userEmail: conflictUser.email,
          currentRole: settings.currentRole,
          sheetName: conflictHub.name,
        }, conflictBaseMetadata.modifiedTime);
        const nowStr = new Date().toLocaleString('vi-VN');
        setSettings((prev) => ({ ...prev, lastSyncTime: nowStr }));
        await consumeWorkspaceRelay(conflictHub.relayAssignment, conflictUser.email);

        showToast('Gộp dữ liệu thành công! Sổ cũ trên Drive và sổ ngoại tuyến mới đã được đồng bộ đồng nhất.', 'success');
      } else {
        showToast('Không thể tải dữ liệu cũ từ Google Drive để gộp. Vui lòng kiểm tra mạng.', 'error');
      }
    } catch (err: any) {
      console.error('Merge conflict error:', err);
      showToast('Lỗi khi gộp dữ liệu: ' + (err?.message || err), 'error');
    } finally {
      setIsSyncingDrive(false);
      setSyncDriveStatus(null);
      setConflictHub(null);
      setConflictToken(null);
      setConflictUser(null);
    }
  };

  const resolveConflictOverwriteLocal = async () => {
    if (!conflictHub || !conflictToken || !conflictUser) return;
    const fileId = conflictHub.id;
    const hubUrl = conflictHub.webViewLink || `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
    setSettings((prev) => ({
      ...prev,
      googleSheetUrl: hubUrl,
      googleSheetName: conflictHub.name,
      lastLocalLinkTimestamp: conflictHub.linkedTimestamp || new Date().toISOString(),
    }));
    const relayAssignment = conflictHub.relayAssignment;
    const memberEmail = conflictUser.email;
    const accessToken = conflictToken;
    setConflictHub(null);
    setConflictToken(null);
    setConflictUser(null);
    showToast('Đang thiết lập kết nối và tải toàn bộ sổ cũ từ Google Drive về máy...', 'info');
    setTimeout(async () => {
      const syncSucceeded = await syncBooksFromDrive(
        false,
        accessToken,
        false,
        hubUrl,
        memberEmail
      );
      if (syncSucceeded) {
        await consumeWorkspaceRelay(relayAssignment, memberEmail);
      }
    }, 200);
  };

  const resolveConflictCreateNewFile = () => {
    setConflictHub(null);
    setConflictToken(null);
    setConflictUser(null);
    setIsSyncModalOpen(true);
    showToast('Vui lòng nhấp vào nút "Tạo file mới" hoặc "Chọn file" trong bảng đồng bộ.', 'info');
  };

  const resolveConflictClose = () => {
    // Trở lại chế độ ngoại tuyến bằng cách hủy phiên Google vừa đăng nhập
    setConflictHub(null);
    setConflictToken(null);
    setConflictUser(null);
    clearSessionAndLocalData();
    setCurrentUser(null);
    setIsUnlocked(false);
    setGoogleAccessToken(null);
    signOutGoogle().catch(() => {});
    showToast('Đã hủy đăng nhập Google. Bạn tiếp tục sử dụng app ở chế độ Ngoại tuyến.', 'info');
  };

  if (isPendingAuth && !currentUser) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 text-white text-center space-y-4">
        <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mx-auto" />
        <div className="space-y-1">
          <h2 className="text-base font-bold text-white">Đang Hoàn Tất Đăng Nhập Google</h2>
          <p className="text-xs text-slate-400">Đang đồng bộ tài khoản và kết nối Google Drive...</p>
        </div>
      </div>
    );
  }

  if (isSplashVisible || !isSessionRestored) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-emerald-950 flex flex-col items-center justify-center gap-3 text-white">
        <div className="w-16 h-16 overflow-hidden rounded-2xl border border-emerald-400/30 shadow-lg shadow-emerald-500/20">
          <img src="/stk_app_icon.png" alt="Sổ tiết kiệm" className="h-full w-full object-cover" />
        </div>
        <h1 className="text-lg font-bold tracking-tight">Sổ tiết kiệm</h1>
        <Loader2 className="h-4 w-4 animate-spin text-emerald-400" aria-label="Đang tải dữ liệu" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-800 font-sans flex flex-col">
      {/* Biometric / Device Unlock Modal */}
      <BiometricUnlockModal
        isOpen={!isUnlocked && !!currentUser && !currentUser.isOffline}
        userName={currentUser?.name || ''}
        userEmail={currentUser?.email || ''}
        onSuccess={() => {
          setIsUnlocked(true);
          showToast('Xác thực Vân tay / Face ID thành công! Đã khôi phục phiên đăng nhập.', 'success');
        }}
        onCancel={() => {
          handleRequestLogout();
        }}
      />

        {/* Top Navbar */}
        <Navbar
          activeTab={activeTab}
          setActiveTab={handleTabChange}
          settings={settings}
          setSettings={setSettings}
          totalPrincipal={totalPrincipal}
          totalEstimatedInterest={totalEstimatedInterest}
          activeBooksCount={activeBooks.length}
          isMobilePreview={isMobilePreview}
          setIsMobilePreview={setIsMobilePreview}
          currentUser={currentUser}
          isSyncingDrive={isSyncingDrive}
          isOnline={isOnline}
          needsDriveAuth={isDriveTokenExpired}
          syncDriveStatus={syncDriveStatus}
          onLoginGoogle={handleLoginGoogle}
          onSyncDrive={handleNavbarSync}
          isLoggingInGoogle={isLoggingInGoogle}
          onLogout={handleRequestLogout}
          onOpenAddModal={() => {
            setBookToEdit(null);
            setIsAddModalOpen(true);
          }}
          onOpenAndroidSpec={() => setIsAndroidSpecModalOpen(true)}
          onOpenManageBanks={() => setIsManageBanksModalOpen(true)}
          onOpenClearDataModal={() => setIsClearDataModalOpen(true)}
          onOpenUserManagement={() => setIsUserManagementModalOpen(true)}
          onTriggerManualCheckUpdate={() => checkAppUpdate(true)}
          currentVersion={CURRENT_APP_VERSION}
        />

        {/* Main Content Area */}
        <main className="flex-1 py-3 sm:py-5 px-2 sm:px-6 max-w-7xl mx-auto w-full">
          {isMobilePreview ? (
            <div className="flex flex-col items-center justify-center py-4">
              <div className="mb-3 flex items-center space-x-2 text-xs text-slate-500 bg-white px-3 py-1 rounded-full border shadow-xs">
                <Smartphone className="w-4 h-4 text-indigo-600" />
                <span>Đang xem mô phỏng trên Khung Điện Thoại Android (Material 3)</span>
              </div>

              {/* Android Device Shell */}
              <div className="w-full max-w-[440px] bg-slate-900 p-3.5 rounded-[44px] shadow-2xl border-4 border-slate-700 ring-1 ring-slate-900/50">
                <div className="w-32 h-4 bg-slate-950 rounded-full mx-auto mb-2 flex items-center justify-center">
                  <div className="w-3 h-3 rounded-full bg-slate-800 mr-2" />
                  <div className="w-10 h-1 bg-slate-800 rounded-full" />
                </div>

                <div className="bg-slate-50 rounded-[32px] overflow-hidden min-h-[720px] max-h-[760px] overflow-y-auto p-3.5 space-y-4 text-slate-900">
                  {activeTab === 'sheet-view' && (
                    <BookListView
                      books={books}
                      filteredBooks={filteredBooks}
                      settings={settings}
                      currentDateStr={currentDate}
                      settlementAdjustments={settlementAdjustments}
                      currentUser={currentUser}
                      sheetSubView={sheetSubView}
                      setSheetSubView={setSheetSubView}
                      searchQuery={searchQuery}
                      setSearchQuery={setSearchQuery}
                      ownerFilter={ownerFilter}
                      setOwnerFilter={setOwnerFilter}
                      bankFilter={bankFilter}
                      setBankFilter={setBankFilter}
                      sortBy={sortBy}
                      setSortBy={setSortBy}
                      sortedBanksInfo={sortedBanksInfo}
                      isSyncingDrive={isSyncingDrive}
                      needsDriveAuth={isDriveTokenExpired}
                      isOnline={isOnline}
                      onOpenSyncModal={handleNavbarSync}
                      onOpenAddModal={() => {
                        setBookToEdit(null);
                        setIsAddModalOpen(true);
                      }}
                      onOpenManageBanks={() => setIsManageBanksModalOpen(true)}
                      onSelectForAnalysis={handleSelectForAnalysis}
                      onOpenEdit={handleOpenEdit}
                      onDeleteBook={handleDeleteBook}
                      onOpenOptimizer={() => setActiveTab('optimizer')}
                      onOpenInterestCalc={() => setActiveTab('interest-calc')}
                      onSyncDrive={async () => {
                        await syncBooksFromDrive(true, undefined, true);
                      }}
                      onImportBooks={handleImportBooks}
                      onDeleteSettlement={handleDeleteSettlementAdjustment}
                    />
                  )}

                  {activeTab === 'optimizer' && (
                    <Suspense fallback={<TabLoadingFallback />}>
                      <MobilizationOptimizer
                        books={books}
                        currentDateStr={currentDate}
                        settings={settings}
                        onOpenBookDetail={handleSelectForAnalysis}
                      />
                    </Suspense>
                  )}

                  {activeTab === 'analytics' && (
                    <Suspense fallback={<TabLoadingFallback />}>
                      <InterestCalculationView
                        books={books}
                        settings={settings}
                        currentDateStr={currentDate}
                        settlements={settlementAdjustments}
                        onOpenOptimizer={() => setActiveTab('optimizer')}
                        onOpenSyncModal={handleNavbarSync}
                      />
                    </Suspense>
                  )}
                </div>

                <div className="w-28 h-1 bg-slate-600 rounded-full mx-auto mt-2" />
              </div>
            </div>
          ) : (
            <div>
              {activeTab === 'sheet-view' && (
                <BookListView
                  books={books}
                  filteredBooks={filteredBooks}
                  settings={settings}
                  currentDateStr={currentDate}
                  settlementAdjustments={settlementAdjustments}
                  currentUser={currentUser}
                  sheetSubView={sheetSubView}
                  setSheetSubView={setSheetSubView}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  ownerFilter={ownerFilter}
                  setOwnerFilter={setOwnerFilter}
                  bankFilter={bankFilter}
                  setBankFilter={setBankFilter}
                  sortBy={sortBy}
                  setSortBy={setSortBy}
                  banksVersion={banksVersion}
                  sortedBanksInfo={sortedBanksInfo}
                  isSyncingDrive={isSyncingDrive}
                  needsDriveAuth={isDriveTokenExpired}
                  isOnline={isOnline}
                  onOpenSyncModal={handleNavbarSync}
                  onOpenAddModal={() => {
                    setBookToEdit(null);
                    setIsAddModalOpen(true);
                  }}
                  onOpenManageBanks={() => setIsManageBanksModalOpen(true)}
                  onSelectForAnalysis={handleSelectForAnalysis}
                  onOpenEdit={handleOpenEdit}
                  onUpdateBook={handleUpdateBook}
                  onSettleBook={handleSettleBook}
                  onRolloverBook={handleRolloverBook}
                  onDeleteBook={handleDeleteBook}
                  onOpenOptimizer={() => setActiveTab('optimizer')}
                  onOpenInterestCalc={() => setActiveTab('interest-calc')}
                  onSyncDrive={async () => {
                    await syncBooksFromDrive(true, undefined, true);
                  }}
                  onImportBooks={handleImportBooks}
                />
              )}

              {activeTab === 'optimizer' && (
                <Suspense fallback={<TabLoadingFallback />}>
                  <MobilizationOptimizer
                    books={books}
                    currentDateStr={currentDate}
                    settings={settings}
                    onOpenBookDetail={handleSelectForAnalysis}
                    onOpenSyncModal={handleNavbarSync}
                  />
                </Suspense>
              )}

              {(activeTab === 'analytics' || activeTab === 'interest-calc' || activeTab === 'timeline') && (
                <Suspense fallback={<TabLoadingFallback />}>
                  <InterestCalculationView
                    books={books}
                    settings={settings}
                    currentDateStr={currentDate}
                    settlements={settlementAdjustments}
                    onOpenOptimizer={() => setActiveTab('optimizer')}
                    onOpenSyncModal={handleNavbarSync}
                  />
                </Suspense>
              )}
            </div>
          )}
        </main>

        {/* App Modals & Dialogs Container */}
        <AppModals
          isAddModalOpen={isAddModalOpen}
          setIsAddModalOpen={setIsAddModalOpen}
          bookToEdit={bookToEdit}
          onSaveBook={handleSaveBookFromModal}
          isSyncModalOpen={isSyncModalOpen}
          setIsSyncModalOpen={setIsSyncModalOpen}
          onOpenSyncModal={handleNavbarSync}
          onLoginOnline={handleLoginOnlineFromModal}
          onDriveFileNotFound={handleDriveFileNotFoundFromModal}
          onImportBooks={handleImportBooksFromModal}
          onClearBooks={handleClearBooksFromModal}
          onTriggerManualSync={handleTriggerManualSyncFromModal}
          onMarkAsRemoteUpdate={markAsRemoteUpdate}
          selectedBookForDetail={selectedBookForDetail}
          setSelectedBookForDetail={setSelectedBookForDetail}
          onUpdateBook={handleUpdateBookFromModal}
          onSettleBook={handleSettleBookFromModal}
          onRolloverBook={handleRolloverBookFromModal}
          isAndroidSpecModalOpen={isAndroidSpecModalOpen}
          setIsAndroidSpecModalOpen={setIsAndroidSpecModalOpen}
          isManageBanksModalOpen={isManageBanksModalOpen}
          setIsManageBanksModalOpen={setIsManageBanksModalOpen}
          onBanksChanged={handleBanksChangedFromModal}
          isLogoutWarningModalOpen={isLogoutWarningModalOpen}
          setIsLogoutWarningModalOpen={setIsLogoutWarningModalOpen}
          onConfirmLogoutAnyway={handleConfirmLogoutAnyway}
          onExportAndLogout={handleExportAndLogout}
          showFileDeletedRecovery={showFileDeletedRecovery}
          setShowFileDeletedRecovery={setShowFileDeletedRecovery}
          onDeleteAppData={handleDeleteAppDataAndUnlink}
          onSetSyncDriveStatus={setSyncDriveStatus}
          onSetIsSyncingDrive={setIsSyncingDrive}
          onStartFileSwitch={startFileSwitch}
          onFinishFileSwitch={finishFileSwitch}
          onCancelFileSwitch={cancelFileSwitch}
          isClearDataModalOpen={isClearDataModalOpen}
          setIsClearDataModalOpen={setIsClearDataModalOpen}
          onClearAllAppData={() => handleDeleteAllAppData(!!currentUser)}
          isDriveTokenExpired={isDriveTokenExpired}
          isOnline={isOnline && driveAuthServiceReachable}
          setIsDriveTokenExpired={setIsDriveTokenExpired}
          onRenewDriveTokenAndSync={renewTokenAndSync}
          isUserManagementModalOpen={isUserManagementModalOpen}
          setIsUserManagementModalOpen={setIsUserManagementModalOpen}
          onLeaveWorkspace={handleLeaveWorkspace}
          books={books}
          setBooks={setBooks}
          settlementAdjustments={settlementAdjustments}
          settings={settings}
          setSettings={setSettings}
          currentUser={currentUser}
          currentDateStr={currentDate}
        />

        {/* Footer */}
        <footer className="bg-white border-t border-slate-200 mt-auto py-4 px-4 text-center text-xs text-slate-400">
          <p>
            Sổ tiết kiệm &bull; Gửi gối đầu &bull; Tối ưu hóa huy động vốn tại Ngân hàng Việt Nam
          </p>
        </footer>

      {/* APK Auto-Update Modal */}
      <AppUpdateModal
        isOpen={isUpdateModalOpen}
        currentVersion={CURRENT_APP_VERSION}
        updateInfo={updateInfo}
        onClose={() => setIsUpdateModalOpen(false)}
      />

      {/* Login Sync Conflict Resolution Modal */}
      <LoginConflictResolveModal
        isOpen={!!conflictHub}
        onClose={resolveConflictClose}
        fileName={conflictHub?.name || 'Sổ tiết kiệm'}
        localBooksCount={books.length}
        onResolveMerge={resolveConflictMerge}
        onResolveOverwriteLocal={resolveConflictOverwriteLocal}
        onResolveCreateNewFile={resolveConflictCreateNewFile}
      />
    </div>
  );
}
