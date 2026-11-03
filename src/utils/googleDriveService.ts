import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
  setPersistence,
  browserLocalPersistence,
  signInWithCredential,
} from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import { getAuthSecureItem, setAuthSecureItem, removeSecureItem } from './secureStorage';
import firebaseConfig from '../../firebase-applet-config.json';
import { SavingsBook, SettlementAdjustment, WorkspaceMember, UserRole, AppSettings, MasterSyncState, BankInfo } from '../types';
import { parseWorkbook, parseMatrixData, getSavingsExcelArrayBuffer, ParseExcelResult } from './excelParser';
import { translateBooksToDataRows, deduplicateSettlementAdjustments, translateDateToSheet } from './dataTranslator';
import { getOwnerLabel } from './formatters';
import {
  getDynamicAnnualInterestHistory,
  getDynamicBalanceGrowthHistory,
} from '../data/historicalGrowth';
import {
  beginSyncAuditSession,
  combineSyncAuditLogsForSession,
  endSyncAuditSession,
  flushSyncAuditLogWrites,
  getActiveSyncAuditSession,
  getSyncAuditLogs,
  getSyncAuditLogsForSession,
  compactAuditLogsForSheet,
  mergeAuditLogEntries,
  mergeAuditDevices,
  auditDevicesFromLogs,
  recordSyncAuditLog,
  SyncAuditLogEntry,
} from './syncAuditLog';
import { getBankShortCode, getAllBanks, updateBanksFromRemote } from '../data/banks';
import { resolveUserRole } from './roleHelper';
import {
  publishWorkspaceFileToMembers,
  readWorkspaceFileAssignment,
  removeWorkspaceFileAssignment,
} from './workspaceShareRelay';


// Initialize Firebase App
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Configure local persistence to keep user logged in across refreshes.
const firebasePersistenceReady = setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error('[Firebase Auth] Could not configure local persistence; continuing with Firebase defaults.', error);
});

// Provider with requested Drive scope (drive.file non-sensitive scope)
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');
provider.addScope('https://www.googleapis.com/auth/spreadsheets');

// Existing users must consent again after the Sheets scope is added.
const areGoogleScopesMigrated = (() => {
  try {
    return (
      localStorage.getItem('drive_scope_migrated_v2') === 'true' &&
      localStorage.getItem('google_sheets_scope_migrated_v1') === 'true'
    );
  } catch {
    return false;
  }
})();

provider.setCustomParameters({
  prompt: areGoogleScopesMigrated ? 'select_account' : 'consent',
});

function markGoogleScopesMigrated(): void {
  try {
    localStorage.setItem('drive_scope_migrated_v2', 'true');
    localStorage.setItem('google_sheets_scope_migrated_v1', 'true');
  } catch {
    console.warn('[GoogleAuth] Không thể lưu trạng thái đã cấp quyền Google Sheets.');
  }
  provider.setCustomParameters({ prompt: 'select_account' });
}

// Storage Keys for persistent Google OAuth tokens and metadata
const TOKEN_KEY = 'google_drive_access_token_v4';
const TOKEN_EXPIRES_AT_KEY = 'google_drive_token_expires_at';
const REFRESH_TOKEN_KEY = 'google_drive_refresh_token_v4';
const ID_TOKEN_KEY = 'google_drive_id_token_v4';
const USER_PROFILE_KEY = 'google_drive_user_profile_v4';
const MASTER_POINTER_FILE_ID_KEY = 'master_pointer_file_id';
const SAVINGS_APP_ID = 'com.tietkiemgiadinh.app';
const SAVINGS_APP_PROPERTY_KEY = 'stk_app_id';
const SAVINGS_APP_LINKED_PROPERTY_KEY = 'stk_linked_app_id';
const SAVINGS_APP_DISCOVERY_PROPERTY_KEY = 'tietkiemgiadinh_app_id';

const isNativeGoogleAuth = Capacitor.isNativePlatform();

let cachedAccessToken: string | null = (() => {
  if (isNativeGoogleAuth) return null;
  try {
    for (const key of [TOKEN_KEY, TOKEN_EXPIRES_AT_KEY, REFRESH_TOKEN_KEY, ID_TOKEN_KEY]) {
      localStorage.removeItem(key);
    }
    const sessToken = sessionStorage.getItem(TOKEN_KEY);
    const sessExp = sessionStorage.getItem(TOKEN_EXPIRES_AT_KEY);
    if (sessToken && sessExp && Date.now() < Number(sessExp) - 60_000) {
      return sessToken;
    }
  } catch {
    console.warn('[Google Auth] Không thể đọc credential web từ sessionStorage.');
  }
  return null;
})();
let cachedIdToken: string | null = null;
let cachedRefreshToken: string | null = null;
let cachedUserProfile: ReturnType<typeof JSON.parse> | null = (() => {
  try {
    const saved = localStorage.getItem(USER_PROFILE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
})();
let cachedTokenExpiresAt: number | null = (() => {
  if (isNativeGoogleAuth) return null;
  try {
    const sessExp = sessionStorage.getItem(TOKEN_EXPIRES_AT_KEY);
    if (sessExp && Date.now() < Number(sessExp) - 60_000) {
      return Number(sessExp);
    }
  } catch {}
  return null;
})();
let isSigningIn = false;

const getTokenExpiresAt = <T extends object>(authentication: T): number => {
  const tokenDetails = authentication as T & { expires?: number | string; expires_in?: number | string };
  const absoluteExpiry = Number(tokenDetails.expires);
  if (Number.isFinite(absoluteExpiry) && absoluteExpiry > 0) {
    return absoluteExpiry < 10_000_000_000 ? absoluteExpiry * 1000 : absoluteExpiry;
  }
  const expiresInSeconds = Number(tokenDetails.expires_in);
  if (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    return Date.now() + expiresInSeconds * 1000;
  }
  if (!isNativeGoogleAuth) {
    return Date.now() + 3500 * 1000;
  }
  throw new Error('Google không trả thời hạn Access Token hợp lệ.');
};

export interface RealDriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  iconLink?: string;
  isSheetOrExcel: boolean;
  isCentralHub?: boolean;
  isSharedWithMe?: boolean;
  isCreatedByApp?: boolean;
  isManagedByApp?: boolean;
  linkedTimestamp?: string;
}

/**
 * Get current access token from memory only.
 */
export function getGoogleAccessToken(): string | null {
  return cachedAccessToken;
}

/**
 * Get current refresh token
 */
export function getGoogleRefreshToken(): string | null {
  return isNativeGoogleAuth ? cachedRefreshToken : null;
}

/**
 * Get current ID token
 */
export function getGoogleIdToken(): string | null {
  return isNativeGoogleAuth ? cachedIdToken : null;
}

/**
 * Get current user profile
 */
export function getGoogleUserProfile(): { email?: string; name?: string; photoUrl?: string } | null {
  if (isNativeGoogleAuth) return cachedUserProfile;
  try {
    const saved = localStorage.getItem(USER_PROFILE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

/**
 * Check if the stored Google access token is valid and not expired
 */
export function isGoogleTokenValid(): boolean {
  const token = getGoogleAccessToken();
  if (!token) return false;
  return cachedTokenExpiresAt !== null && Date.now() < cachedTokenExpiresAt - 60_000;
}

/**
 * Set the in-memory access token; native credentials are persisted only in Secure Storage.
 */
export function setGoogleAccessToken(token: string | null, expiresAtMs?: number) {
  const previousToken = cachedAccessToken;
  const previousExpiry = cachedTokenExpiresAt;
  cachedAccessToken = token;
  cachedTokenExpiresAt = token
    ? (expiresAtMs || (previousToken === token ? previousExpiry : null) || (!isNativeGoogleAuth ? Date.now() + 3500 * 1000 : null))
    : null;
  try {
    if (token && cachedTokenExpiresAt) {
      const expiresAt = cachedTokenExpiresAt.toString();
      if (isNativeGoogleAuth) {
        setAuthSecureItem(TOKEN_KEY, token).catch((err) => {
          console.error('[Google Auth] Không thể lưu Access Token vào Secure Storage.', err);
        });
        setAuthSecureItem(TOKEN_EXPIRES_AT_KEY, expiresAt).catch((err) => {
          console.error('[Google Auth] Không thể lưu hạn Access Token vào Secure Storage.', err);
        });
      } else {
        sessionStorage.setItem(TOKEN_KEY, token);
        sessionStorage.setItem(TOKEN_EXPIRES_AT_KEY, expiresAt);
      }
      localStorage.setItem('google_drive_ever_logged_in', 'true');
      if (!isNativeGoogleAuth) {
        Preferences.set({ key: 'google_drive_ever_logged_in', value: 'true' }).catch((err) => {
          console.warn('[Google Auth] Could not persist Drive session marker.', err);
        });
      }
    } else {
      cachedIdToken = null;
      cachedRefreshToken = null;
      cachedUserProfile = null;
      for (const key of [TOKEN_KEY, TOKEN_EXPIRES_AT_KEY, REFRESH_TOKEN_KEY, ID_TOKEN_KEY]) {
        localStorage.removeItem(key);
      }
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
      Preferences.remove({ key: TOKEN_KEY }).catch((err) => console.warn('[Google Auth] Could not clear token preference.', err));
      Preferences.remove({ key: TOKEN_EXPIRES_AT_KEY }).catch((err) => console.warn('[Google Auth] Could not clear token expiry preference.', err));
      removeSecureItem(TOKEN_KEY).catch(() => {});
      removeSecureItem(TOKEN_EXPIRES_AT_KEY).catch(() => {});
    }
  } catch (err) {
    console.error('[Google Auth] Không thể lưu hoặc xóa thông tin Access Token.', err);
  }
}

/**
 * Centralized saver for Google OAuth session parameters
 */
export async function saveGoogleAuthSession(session: {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  userProfile?: {
    email?: string;
    name?: string;
    photoUrl?: string;
  }
}): Promise<void> {
  if (!session.accessToken) throw new Error('Không nhận được Google Access Token.');
  const expiresAt = session.expiresAt || (!isNativeGoogleAuth ? Date.now() + 3500 * 1000 : null);
  if (!expiresAt) throw new Error('Không nhận được hạn dùng Google Access Token.');

  if (isNativeGoogleAuth) {
    const secureWrites: Promise<void>[] = [
      setAuthSecureItem(TOKEN_KEY, session.accessToken),
      setAuthSecureItem(TOKEN_EXPIRES_AT_KEY, expiresAt.toString()),
    ];
    if (session.idToken) secureWrites.push(setAuthSecureItem(ID_TOKEN_KEY, session.idToken));
    if (session.refreshToken) secureWrites.push(setAuthSecureItem(REFRESH_TOKEN_KEY, session.refreshToken));
    if (session.userProfile) secureWrites.push(setAuthSecureItem(USER_PROFILE_KEY, JSON.stringify(session.userProfile)));
    await Promise.all(secureWrites);
  } else {
    try {
      sessionStorage.setItem(TOKEN_KEY, session.accessToken);
      sessionStorage.setItem(TOKEN_EXPIRES_AT_KEY, expiresAt.toString());
      if (session.userProfile) {
        localStorage.setItem(USER_PROFILE_KEY, JSON.stringify(session.userProfile));
      }
    } catch (e) {
      console.warn('[Google Auth] Lỗi lưu session web vào sessionStorage:', e);
    }
    for (const key of [TOKEN_KEY, TOKEN_EXPIRES_AT_KEY, REFRESH_TOKEN_KEY, ID_TOKEN_KEY]) {
      localStorage.removeItem(key);
    }
  }

  cachedAccessToken = session.accessToken;
  cachedTokenExpiresAt = expiresAt;
  cachedIdToken = session.idToken || null;
  cachedRefreshToken = session.refreshToken || null;
  cachedUserProfile = session.userProfile || null;
  if (!isNativeGoogleAuth) localStorage.setItem('google_drive_ever_logged_in', 'true');
  if (!isNativeGoogleAuth) {
    await Preferences.set({ key: 'google_drive_ever_logged_in', value: 'true' });
  } else {
    localStorage.setItem('google_drive_ever_logged_in', 'true');
  }
}

/**
 * Restore Google Auth Session credentials from native secure storage (used at app startup)
 */
export async function restoreGoogleAuthSession(): Promise<boolean> {
  if (!isNativeGoogleAuth) {
    try {
      for (const key of [TOKEN_KEY, TOKEN_EXPIRES_AT_KEY, REFRESH_TOKEN_KEY, ID_TOKEN_KEY]) {
        localStorage.removeItem(key);
      }
      const token = sessionStorage.getItem(TOKEN_KEY);
      const expiresAtStr = sessionStorage.getItem(TOKEN_EXPIRES_AT_KEY);
      const expiresAt = expiresAtStr ? Number(expiresAtStr) : null;
      if (token && expiresAt && Date.now() < expiresAt - 60_000) {
        cachedAccessToken = token;
        cachedTokenExpiresAt = expiresAt;
        const savedProfile = localStorage.getItem(USER_PROFILE_KEY);
        if (savedProfile) {
          try {
            cachedUserProfile = JSON.parse(savedProfile);
          } catch {}
        }
        return true;
      }
    } catch (err) {
      console.warn(`[Google Auth] Không thể khôi phục phiên web từ sessionStorage:`, err);
    }
    return false;
  }

  try {
    const token = await getAuthSecureItem(TOKEN_KEY);
    const expiresAt = await getAuthSecureItem(TOKEN_EXPIRES_AT_KEY);
    const refreshToken = await getAuthSecureItem(REFRESH_TOKEN_KEY);
    const idToken = await getAuthSecureItem(ID_TOKEN_KEY);
    const userProfile = await getAuthSecureItem(USER_PROFILE_KEY);

    if (isNativeGoogleAuth) {
      for (const key of [TOKEN_KEY, TOKEN_EXPIRES_AT_KEY, REFRESH_TOKEN_KEY, ID_TOKEN_KEY, USER_PROFILE_KEY]) {
        localStorage.removeItem(key);
      }
      await Promise.all(
        [TOKEN_KEY, TOKEN_EXPIRES_AT_KEY, REFRESH_TOKEN_KEY, ID_TOKEN_KEY, USER_PROFILE_KEY].map((key) =>
          Preferences.remove({ key }).catch((err) => {
            console.warn(`[SecureStorage] Could not remove plaintext credential copy for "${key}".`, err);
          })
        )
      );
    }

    if (token) {
      cachedAccessToken = token;
      const parsedExpiry = Number(expiresAt);
      cachedTokenExpiresAt = Number.isFinite(parsedExpiry) && parsedExpiry > 0 ? parsedExpiry : null;
      cachedRefreshToken = refreshToken;
      cachedIdToken = idToken;
      cachedUserProfile = userProfile ? JSON.parse(userProfile) : null;
      localStorage.setItem('google_drive_ever_logged_in', 'true');
      console.info('[SecureStorage] Successfully restored Google OAuth credentials from native secure storage.');
      return true;
    }
  } catch (err) {
    console.warn('[SecureStorage] Failed to restore session from secure storage:', err);
  }
  return false;
}

let isGoogleAuthInitialized = false;
let googleAuthInitialization: Promise<void> | null = null;

/**
 * Ensures GoogleAuth native plugin is initialized exactly once on mobile platforms.
 */
export async function ensureGoogleAuthInitialized(): Promise<void> {
  if (isGoogleAuthInitialized || !Capacitor.isNativePlatform()) return;
  if (googleAuthInitialization) return googleAuthInitialization;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  googleAuthInitialization = Promise.race([
    Promise.resolve().then(() =>
      (GoogleAuth as any).initialize({
        clientId: firebaseConfig.oAuthClientId,
        serverClientId: firebaseConfig.oAuthClientId,
        scopes: [
          'email',
          'profile',
          'openid',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/spreadsheets',
        ],
        grantOfflineAccess: false,
      })
    ),
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('TIMEOUT_INIT: Quá thời gian khởi tạo đăng nhập Google trên thiết bị.')),
        10000
      );
    }),
  ])
    .then(() => {
      isGoogleAuthInitialized = true;
    })
    .catch((err) => {
      console.error('[GoogleAuth] Native initialization failed:', err);
      throw err;
    })
    .finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
      googleAuthInitialization = null;
    });

  return googleAuthInitialization;
}

/**
 * Attempt to silently refresh Google credentials without showing popups/consents.
 * Returns the fresh accessToken if successful, or null if interactive re-auth is needed.
 */
const performSilentRefresh = async (): Promise<string | null> => {
  // If the token is already valid, return it instantly
  if (isGoogleTokenValid()) {
    return getGoogleAccessToken();
  }

  // Prevent overlapping auth requests
  if (isSigningIn) {
    console.info('[Silent Auth] Tiến trình đăng nhập khác đang chạy, bỏ qua silent refresh.');
    return null;
  }

  // 1. Silent Refresh on Native Platforms (Android/iOS)
  if (Capacitor.isNativePlatform()) {
    console.info('[Silent Auth] Đang gia hạn phiên làm việc ngầm trên Native...');
    try {
      await ensureGoogleAuthInitialized();

      // Try silent refresh using offline refresh token with a strict 8-second timeout to prevent native hangs
      try {
        const refreshPromise = GoogleAuth.refresh();
        const timeoutPromise = new Promise<any>((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT_REFRESH: Quá thời gian gia hạn phiên Google (8 giây).')), 8000)
        );
        const refreshResult = await Promise.race([refreshPromise, timeoutPromise]);
        if (refreshResult && refreshResult.accessToken) {
          console.info('[Silent Auth] Gia hạn thành công bằng GoogleAuth.refresh()');
          const expiresAt = getTokenExpiresAt(refreshResult);
          await saveGoogleAuthSession({
            accessToken: refreshResult.accessToken,
            idToken: refreshResult.idToken || undefined,
            expiresAt,
          });
          return refreshResult.accessToken;
        }
      } catch (refreshErr) {
        console.warn('[Silent Auth] GoogleAuth.refresh() failed or timed out:', refreshErr);
      }
    } catch (nativeErr) {
      console.warn('[Silent Auth] Native silent refresh failed:', nativeErr);
    }
  }

  // 2. Web Platform / AI Studio Preview Flow
  // On Web, if Firebase auth session is preserved, but access token expired, we let re-auth handle it gracefully
  return null;
};

let activeSilentRefreshPromise: Promise<string | null> | null = null;

export function trySilentRefresh(): Promise<string | null> {
  if (isGoogleTokenValid()) return Promise.resolve(getGoogleAccessToken());
  if (activeSilentRefreshPromise) return activeSilentRefreshPromise;
  activeSilentRefreshPromise = performSilentRefresh().finally(() => {
    activeSilentRefreshPromise = null;
  });
  return activeSilentRefreshPromise;
}

/**
 * Initialize Auth State Listener with background startup silent-refresh
 */
export const initGoogleAuth = (
  onSuccess?: (user: User, token: string | null) => void,
  onSignedOut?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    await firebasePersistenceReady;
    if (user) {
      let token = getGoogleAccessToken();
      if (!token || !isGoogleTokenValid()) {
        console.info('[initGoogleAuth] Token is missing or expired, running silent refresh...');
        const refreshed = await trySilentRefresh();
        if (refreshed) {
          token = refreshed;
        }
      }
      if (onSuccess) onSuccess(user, token);
    } else {
      const everLoggedIn = localStorage.getItem('google_drive_ever_logged_in') === 'true';
      if (everLoggedIn) {
        console.info('[initGoogleAuth] User is not in Firebase Auth but everLoggedIn is true, attempting silent restore...');
        const silentToken = await trySilentRefresh();
        
        // Auto sign-in to Firebase Auth using stored idToken and silent refreshed accessToken
        const savedIdToken = getGoogleIdToken();
        if (silentToken && savedIdToken) {
          try {
            console.info('[initGoogleAuth] Re-authenticating Firebase Auth with Google Credentials...');
            await firebasePersistenceReady;
            const credential = GoogleAuthProvider.credential(savedIdToken, silentToken);
            const fbCredential = await signInWithCredential(auth, credential);
            if (fbCredential?.user) {
              console.info('[initGoogleAuth] Firebase Auth successfully re-authenticated silently.');
              if (onSuccess) onSuccess(fbCredential.user, silentToken);
              return;
            }
          } catch (fbErr) {
            console.warn('[initGoogleAuth] Silent Firebase re-auth failed:', fbErr);
          }
        }

        if (silentToken && auth.currentUser) {
          if (onSuccess) onSuccess(auth.currentUser, silentToken);
          return;
        }

        if (Capacitor.isNativePlatform() && document.visibilityState === 'visible') {
          const promptedAt = Number(sessionStorage.getItem('drive_auto_auth_prompted_at'));
          if (!Number.isFinite(promptedAt) || Date.now() - promptedAt >= 10 * 60 * 1000) {
            sessionStorage.setItem('drive_auto_auth_prompted_at', Date.now().toString());
            try {
              console.info('[initGoogleAuth] Silent restore failed; requesting Google sign-in while the app is foregrounded.');
              const restoredSession = await signInWithGoogle();
              sessionStorage.removeItem('drive_auto_auth_prompted_at');
              if (onSuccess) onSuccess(restoredSession.user, restoredSession.accessToken);
              return;
            } catch (authErr) {
              console.info('[initGoogleAuth] Automatic foreground Google sign-in was not completed.', authErr);
            }
          }
        }
      }
      cachedAccessToken = null;
      if (onSignedOut) onSignedOut();
    }
  });
};

/**
 * Check if the application is running inside an iframe (like AI Studio preview)
 */
export const isRunningInIframe = (): boolean => {
  if (Capacitor.isNativePlatform()) {
    return false;
  }
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
};

/**
 * Check if the user is returning from a Google OAuth redirect
 */
export const checkRedirectResult = async (): Promise<{ user: User; accessToken: string } | null> => {
  if (Capacitor.isNativePlatform()) {
    // Native platforms use signInWithCredential/GoogleAuth.signIn, so redirect flows don't apply.
    return null;
  }
  try {
    await firebasePersistenceReady;
    const result = await getRedirectResult(auth);
    sessionStorage.removeItem('pending_google_redirect_auth');
    if (result) {
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        const expiresAt = getTokenExpiresAt(credential);
        await saveGoogleAuthSession({
          accessToken: credential.accessToken,
          idToken: credential.idToken || undefined,
          expiresAt,
          userProfile: {
            email: result.user.email || undefined,
            name: result.user.displayName || undefined,
            photoUrl: result.user.photoURL || undefined,
          }
        });
        markGoogleScopesMigrated();
        return {
          user: result.user,
          accessToken: credential.accessToken,
        };
      }
    }
  } catch (error: any) {
    sessionStorage.removeItem('pending_google_redirect_auth');
    console.error('Error checking Google redirect result:', error);
  }
  return null;
};

/**
 * Sign in using Google Redirect (Fallback for popup blocked environments)
 */
export const signInWithGoogleRedirect = async (): Promise<void> => {
  if (Capacitor.isNativePlatform()) {
    await signInWithGoogle();
    return;
  }
  if (isRunningInIframe()) {
    window.open(window.location.href, '_blank');
    throw new Error('Đã mở ứng dụng ở thẻ (tab) trình duyệt mới để đăng nhập Google an toàn.');
  }
  try {
    await firebasePersistenceReady;
    sessionStorage.setItem('pending_google_redirect_auth', 'true');
  } catch {}
  await signInWithRedirect(auth, provider);
};

/**
 * Sign in with Google Popup and obtain real OAuth Access Token
 */
const performGoogleSignIn = async (autoFallbackToRedirect = false): Promise<{ user: User; accessToken: string }> => {
  try {
    isSigningIn = true;
    await firebasePersistenceReady;

    // 1. Native App (Capacitor) Flow
    if (Capacitor.isNativePlatform()) {
      console.info('[Google Sign-In] Khởi chạy GoogleAuth trên thiết bị Native App...');
      await ensureGoogleAuthInitialized();

      let nativeResult: any;
      try {
        // DO NOT call GoogleAuth.signOut() here!
        // Calling signOut() synchronously right before signIn() interrupts native GoogleSignInClient state on Android,
        // causing the signIn intent callback to be lost or hang indefinitely.
        const signInPromise = GoogleAuth.signIn();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  'TIMEOUT: Quá thời gian thao tác chọn tài khoản Google (25 giây). Vui lòng kiểm tra lại thiết bị hoặc bấm Đăng nhập lại.'
                )
              ),
            25000
          )
        );
        nativeResult = await Promise.race([signInPromise, timeoutPromise]);
      } catch (signInErr: any) {
        console.error('[Google Sign-In Native Error]', signInErr);
        const rawMsg = String(signInErr?.message || signInErr || '');
        if (
          rawMsg.includes('Something went wrong') ||
          rawMsg.includes('10') ||
          rawMsg.includes('12500') ||
          rawMsg.includes('10002')
        ) {
          throw new Error(
            'Lỗi xác thực Google trên Android (Mã 10/12500: Cần thêm mã SHA-1 Fingerprint của file APK vào Firebase Console > Project Settings).'
          );
        }
        if (rawMsg.includes('canceled') || rawMsg.includes('12501') || rawMsg.includes('closed')) {
          throw new Error('Bạn đã hủy thao tác chọn tài khoản Google.');
        }
        throw new Error(rawMsg || 'Đăng nhập Google trên thiết bị Android không thành công.');
      }

      const idToken = nativeResult.authentication?.idToken || (nativeResult as any).idToken;
      let accessToken = nativeResult.authentication?.accessToken || (nativeResult as any).accessToken;
      const refreshToken = nativeResult.authentication?.refreshToken || (nativeResult as any).refreshToken;

      if (!idToken || !accessToken) {
        throw new Error('Google không trả đủ ID Token và Access Token.');
      }

      const expiresAt = getTokenExpiresAt(nativeResult.authentication || nativeResult);
      await saveGoogleAuthSession({
        accessToken,
        idToken: idToken || undefined,
        refreshToken: refreshToken || undefined,
        expiresAt,
        userProfile: {
          email: nativeResult.email || undefined,
          name: nativeResult.displayName || undefined,
          photoUrl: nativeResult.imageUrl || undefined,
        },
      });

      console.info('[Google Sign-In] Đang xác thực với Firebase bằng Google Credential...');
      const credential = GoogleAuthProvider.credential(idToken || null, accessToken !== idToken ? accessToken : null);
      
      const signInFirebasePromise = signInWithCredential(auth, credential);
      const signInFirebaseTimeout = new Promise<any>((_, reject) =>
        setTimeout(() => reject(new Error('TIMEOUT_FIREBASE: Quá thời gian xác thực với Firebase (15 giây).')), 15000)
      );

      const firebaseUserCredential = await Promise.race([signInFirebasePromise, signInFirebaseTimeout]).catch((fbErr) => {
        console.warn('[Firebase Auth Native Signin Fallback] Sử dụng tài khoản offline tạm thời do lỗi kết nối Firebase:', fbErr);
        return { user: { email: nativeResult.email || 'user@google.com', displayName: nativeResult.displayName || 'Chủ Tài Khoản', photoURL: nativeResult.imageUrl || undefined } as any };
      });
      const user = firebaseUserCredential.user;

      markGoogleScopesMigrated();

      return {
        user,
        accessToken,
      };
    }

    // 2. Web / AI Studio Preview Flow
    if (isRunningInIframe()) {
      window.open(window.location.href, '_blank');
      throw new Error('Khung xem trước AI Studio chặn cửa sổ bật lên (popup) của Google. Ứng dụng đã tự động mở sang Tab trình duyệt mới để bạn đăng nhập Google an toàn.');
    }
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);

    if (!credential?.accessToken) {
      throw new Error('Không nhận được mã truy cập (Access Token) từ Google Authentication.');
    }

    const expiresAt = getTokenExpiresAt(credential);
    await saveGoogleAuthSession({
      accessToken: credential.accessToken,
      idToken: credential.idToken || undefined,
      expiresAt,
      userProfile: {
        email: result.user.email || undefined,
        name: result.user.displayName || undefined,
        photoUrl: result.user.photoURL || undefined,
      }
    });
    markGoogleScopesMigrated();

    return {
      user: result.user,
      accessToken: credential.accessToken,
    };
  } catch (error: any) {
    if (error?.message?.includes('Khung xem trước') || error?.message?.includes('Tab trình duyệt')) {
      console.info('Opened application in new tab for Google auth:', error.message);
      throw error;
    }
    if (error?.code === 'auth/popup-blocked' || error?.message?.includes('popup-blocked')) {
      console.warn('Google Sign In popup blocked:', error?.message);
      if (autoFallbackToRedirect && !isRunningInIframe()) {
        try {
          sessionStorage.setItem('pending_google_redirect_auth', 'true');
          await signInWithRedirect(auth, provider);
          throw new Error('Đang chuyển hướng sang trang đăng nhập Google...');
        } catch (redirectErr: any) {
          console.warn('Redirect sign-in error:', redirectErr);
        }
      }
      throw new Error(error?.message?.includes('mở sang Tab trình duyệt mới') ? error.message : 'Trình duyệt hoặc khung xem trước (iframe) đã chặn cửa sổ bật lên (popup). Vui lòng bấm nút "Mở ở Tab mới" bên dưới để đăng nhập Google.');
    }
    if (error?.code === 'auth/popup-closed-by-user' || error?.message?.includes('popup-closed-by-user')) {
      console.warn('Google Sign In popup closed by user');
      throw new Error('Đã đóng cửa sổ đăng nhập Google.');
    }
    if (error?.code === 'auth/cancelled-popup-request' || error?.message?.includes('cancelled-popup-request')) {
      console.warn('Google Sign In cancelled popup request');
      throw new Error('Yêu cầu mở cửa sổ đăng nhập Google bị hủy do có cửa sổ khác đang mở.');
    }
    console.warn('Google Sign In Notice:', error?.message || error);
    recordSyncAuditLog({
      type: 'SYNC_ERROR',
      title: 'Lỗi đăng nhập / xác thực Google',
      status: 'error',
      summary: `Đăng nhập Google thất bại: ${error?.message || error}`,
      errorMessage: error?.stack || error?.message || String(error),
    });
    throw error;
  } finally {
    isSigningIn = false;
  }
};

let activeSignInPromise: Promise<{ user: User; accessToken: string }> | null = null;

export function signInWithGoogle(autoFallbackToRedirect = false): Promise<{ user: User; accessToken: string }> {
  if (activeSignInPromise) return activeSignInPromise;
  activeSignInPromise = performGoogleSignIn(autoFallbackToRedirect).finally(() => {
    activeSignInPromise = null;
  });
  return activeSignInPromise;
}

/**
 * Ensure valid token or trigger sign-in
 */
export async function ensureGoogleAccessToken(): Promise<string> {
  const silentToken = await trySilentRefresh();
  if (silentToken) return silentToken;

  const res = await signInWithGoogle();
  return res.accessToken;
}

/**
 * Actively validate the token by checking validity first, then making a test API call if needed.
 * If the token is missing, expired, or invalid, it will automatically try silent-refresh,
 * and if that also fails, it will call signInWithGoogle() to re-authorize.
 */
export async function validateAndEnsureToken(): Promise<string> {
  // 1. Nếu token hiện tại còn hạn hợp lệ, trả về ngay lập tức (0ms, không tạo thêm request mạng thừa)
  if (isGoogleTokenValid()) {
    const existing = getGoogleAccessToken();
    if (existing) return existing;
  }

  // 2. Thử làm mới ngầm (Silent Refresh) nếu có phiên hợp lệ
  const silentToken = await trySilentRefresh();
  if (silentToken) return silentToken;

  // 3. Fallback: Nếu không có token hoặc đã hết hạn hoàn toàn, yêu cầu đăng nhập lại
  const res = await signInWithGoogle();
  return res.accessToken;
}

/**
 * Sign out (removes all saved tokens, sessions, and credentials)
 */
export async function signOutGoogle(): Promise<void> {
  // 1. Dọn sạch toàn bộ Token, User Profile và Session trong Storage trước
  cachedAccessToken = null;
  cachedTokenExpiresAt = null;
  cachedIdToken = null;
  cachedRefreshToken = null;
  cachedUserProfile = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_EXPIRES_AT_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(ID_TOKEN_KEY);
    localStorage.removeItem(USER_PROFILE_KEY);
    localStorage.removeItem('google_drive_ever_logged_in');
    localStorage.removeItem(MASTER_POINTER_FILE_ID_KEY);
    localStorage.removeItem('savings_auth_user_v3');
    localStorage.removeItem('savings_settings_v3');

    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_EXPIRES_AT_KEY);

    Preferences.remove({ key: TOKEN_KEY }).catch(() => {});
    Preferences.remove({ key: TOKEN_EXPIRES_AT_KEY }).catch(() => {});
    Preferences.remove({ key: REFRESH_TOKEN_KEY }).catch(() => {});
    Preferences.remove({ key: ID_TOKEN_KEY }).catch(() => {});
    Preferences.remove({ key: USER_PROFILE_KEY }).catch(() => {});
    Preferences.remove({ key: 'google_drive_ever_logged_in' }).catch(() => {});
    Preferences.remove({ key: 'savings_auth_user_v3' }).catch(() => {});

    // Secure storage clean
    removeSecureItem(TOKEN_KEY).catch(() => {});
    removeSecureItem(TOKEN_EXPIRES_AT_KEY).catch(() => {});
    removeSecureItem(REFRESH_TOKEN_KEY).catch(() => {});
    removeSecureItem(ID_TOKEN_KEY).catch(() => {});
    removeSecureItem(USER_PROFILE_KEY).catch(() => {});
  } catch (storageErr) {
    console.warn('Storage cleanup error:', storageErr);
  }

  // 2. Đăng xuất Firebase Auth an toàn
  try {
    await signOut(auth);
  } catch (fbErr) {
    console.warn('Firebase signOut error:', fbErr);
  }

  // 3. Đăng xuất Native GoogleAuth có bọc try/catch chống sập ứng dụng
  if (Capacitor.isNativePlatform()) {
    try {
      await ensureGoogleAuthInitialized();
      await (GoogleAuth as any).signOut();
    } catch (err) {
      console.warn('[GoogleAuth] Native signOut safe warning:', err);
    }
  }
}

/**
 * Helper to format file bytes to KB / MB
 */
export const formatFileSizeBytes = (bytes?: string | number): string => {
  if (!bytes) return '0 KB';
  const num = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
  if (isNaN(num)) return '0 KB';
  if (num >= 1024 * 1024) {
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(num / 1024))} KB`;
};

/**
 * A highly robust fetch wrapper that handles transient network dropouts with exponential backoff retries.
 * It also translates CORS/Adblock/Shield-blocked requests into crystal clear troubleshooting steps.
 */
async function fetchWithRetry(url: string | URL, options?: RequestInit, retries = 3, delay = 1000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const mergedOptions: RequestInit = {
    ...options,
    signal: options?.signal || controller.signal,
  };

  try {
    const response = await fetch(url.toString(), mergedOptions);
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    const isNetworkOrBlocked = 
      error instanceof TypeError || 
      error?.name === 'AbortError' ||
      error?.message?.includes('Failed to fetch') || 
      error?.message?.includes('network') || 
      error?.message?.includes('aborted') ||
      !navigator.onLine;

    if (isNetworkOrBlocked) {
      if (retries > 0) {
        console.warn(`Fetch failed for ${url}. Retrying in ${delay}ms... (${retries} retries left). Error: ${error?.message}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return fetchWithRetry(url, options, retries - 1, delay * 2);
      }
      
      // If it fails after all retries, analyze if it is likely blocked by an Adblocker or sandbox iframe
      const isIframe = window.self !== window.top;
      let adblockWarning = 'Lỗi kết nối (Failed to fetch). ';
      if (error?.name === 'AbortError') {
        adblockWarning += 'Kết nối tới Google Drive bị quá thời gian chờ (Timeout sau 15s). Vui lòng kiểm tra kết nối mạng và thử lại.';
      } else if (isIframe) {
        adblockWarning += 'Trình duyệt hoặc phần mềm chặn quảng cáo (Adblock / Brave Shields) đã chặn kết nối Google Drive API từ môi trường xem trước (iframe) của AI Studio. Vui lòng bấm vào biểu tượng "Mở trong tab mới" (ở góc trên bên phải màn hình AI Studio) để chạy ứng dụng trực tiếp, hoặc tạm thời vô hiệu hóa Adblock cho trang web này.';
      } else {
        adblockWarning += 'Không thể kết nối tới máy chủ Google Drive. Vui lòng kiểm tra lại đường truyền internet của bạn hoặc tạm thời tắt các phần mềm chặn quảng cáo (Adblock / Brave Shields).';
      }
      throw new Error(adblockWarning);
    }
    throw error;
  }
}

/**
 * List Google Sheets created by this app that are accessible to the signed-in user.
 */
export async function listRealGoogleDriveFiles(
  accessToken: string,
  searchKeyword?: string
): Promise<RealDriveFile[]> {
  try {
    let query = `trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`;

    if (searchKeyword && searchKeyword.trim()) {
      const sanitized = searchKeyword.replace(/'/g, "\\'");
      query += ` and name contains '${sanitized}'`;
    }

    const rawFiles: Array<{
      id: string;
      name: string;
      mimeType: string;
      modifiedTime?: string;
      size?: string;
      webViewLink?: string;
      iconLink?: string;
      appProperties?: Record<string, string>;
    }> = [];
    let pageToken: string | undefined;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('pageSize', '100');
      url.searchParams.set(
        'fields',
        'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink,appProperties)'
      );
      url.searchParams.set('orderBy', 'modifiedTime desc');
      url.searchParams.set('spaces', 'drive');
      url.searchParams.set('q', query);
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetchWithRetry(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!res.ok) {
        if (res.status === 401) {
          setGoogleAccessToken(null);
          throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
        }
        const errorData = await res.json().catch(() => ({}));
        if (errorData?.error?.status === 'UNAUTHENTICATED' || errorData?.error?.code === 401 || errorData?.error?.message?.includes('invalid authentication credentials')) {
          setGoogleAccessToken(null);
          throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
        }
        if (res.status === 403 && errorData?.error?.message?.includes('insufficient authentication scopes')) {
          setGoogleAccessToken(null);
          throw new Error('Tài khoản Google chưa cấp quyền Google Drive (drive.file). Vui lòng đăng xuất và đăng nhập lại để cấp quyền.');
        }
        throw new Error(errorData?.error?.message || `Lỗi từ Google Drive API (Mã ${res.status})`);
      }

      const data = await res.json();
      rawFiles.push(...(data.files || []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    // Lấy thông tin Master Sync Pointer file (nguồn chân lý duy nhất) để đánh dấu file nào đang là Hub
    const masterState = await getMasterSyncStateFromDrive(accessToken).catch(() => null);
    const activeFileId = masterState && masterState.status === 'active' ? masterState.activeFileId : null;

    const files = rawFiles.filter(
      (file) => file.mimeType === 'application/vnd.google-apps.spreadsheet'
    );

    const mappedFiles: RealDriveFile[] = files.map((f) => {
      const isHub = activeFileId === f.id;
      const linkedTimestamp = isHub ? masterState?.linkedTimestamp : undefined;

      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        size: formatFileSizeBytes(f.size),
        webViewLink: f.webViewLink || `https://docs.google.com/spreadsheets/d/${f.id}/edit`,
        iconLink: f.iconLink,
        isSheetOrExcel: true,
        isCentralHub: isHub,
        linkedTimestamp,
      };
    });

    mappedFiles.sort((a, b) => {
      const aModifiedTime = Date.parse(a.modifiedTime || '') || 0;
      const bModifiedTime = Date.parse(b.modifiedTime || '') || 0;
      return bModifiedTime - aModifiedTime;
    });

    return mappedFiles;
  } catch (error: any) {
    if (error?.message?.includes('hết hạn') || error?.message?.includes('invalid authentication credentials')) {
      console.warn('Lỗi phiên đăng nhập Google Drive:', error.message);
    } else {
      console.error('Lỗi khi tải danh sách file Google Drive:', error);
    }
    throw error;
  }
}

/**
 * List app-created spreadsheets and shared spreadsheet files already authorized for this app.
 * drive.file intentionally limits results to files created by or explicitly opened with the app.
 */
export async function listSavingsDrivePickerFiles(accessToken: string): Promise<RealDriveFile[]> {
  const mimeTypes = [
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  const mimeQuery = mimeTypes.map((mimeType) => `mimeType = '${mimeType}'`).join(' or ');
  const query = `trashed = false and (${mimeQuery})`;
  const files: Array<{
    id: string;
    name: string;
    mimeType: string;
    modifiedTime?: string;
    size?: string;
    webViewLink?: string;
    iconLink?: string;
    sharedWithMeTime?: string;
    appProperties?: Record<string, string>;
  }> = [];
  let pageToken: string | undefined;

  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('pageSize', '100');
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,modifiedTime,size,webViewLink,iconLink,sharedWithMeTime,appProperties)'
    );
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set('spaces', 'drive');
    url.searchParams.set('q', query);
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      if (response.status === 401) {
        setGoogleAccessToken(null);
        throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng xác thực lại.');
      }
      const errorData = await response.json().catch(() => ({}));
      if (response.status === 403 && errorData?.error?.message?.includes('insufficient authentication scopes')) {
        throw new Error('Google Drive chỉ hiển thị các file đã cấp quyền cho ứng dụng.');
      }
      throw new Error(errorData?.error?.message || `Không thể tìm file trên Google Drive (Mã ${response.status}).`);
    }

    const data = await response.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const masterState = await getMasterSyncStateFromDrive(accessToken).catch(() => null);
  const activeFileId = masterState?.status === 'active' ? masterState.activeFileId : null;

  return files
    .filter((file) => mimeTypes.includes(file.mimeType))
    .map((file) => {
      const isCreatedByApp = file.appProperties?.[SAVINGS_APP_PROPERTY_KEY] === SAVINGS_APP_ID;
      const isManagedByApp =
        file.appProperties?.[SAVINGS_APP_LINKED_PROPERTY_KEY] === SAVINGS_APP_ID ||
        file.appProperties?.[SAVINGS_APP_DISCOVERY_PROPERTY_KEY] === SAVINGS_APP_ID;
      const isCentralHub = activeFileId === file.id;
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: file.modifiedTime,
        size: formatFileSizeBytes(file.size),
        webViewLink:
          file.webViewLink ||
          (file.mimeType === 'application/vnd.google-apps.spreadsheet'
            ? `https://docs.google.com/spreadsheets/d/${file.id}/edit`
            : `https://drive.google.com/file/d/${file.id}/view`),
        iconLink: file.iconLink,
        isSheetOrExcel: true,
        isCentralHub,
        isSharedWithMe: Boolean(file.sharedWithMeTime),
        isCreatedByApp,
        isManagedByApp,
        linkedTimestamp: isCentralHub ? masterState?.linkedTimestamp : undefined,
      };
    })
    .sort((a, b) => Date.parse(b.modifiedTime || '') - Date.parse(a.modifiedTime || ''));
}

/**
 * Get metadata (name, mimeType, webViewLink) of a specific file from Google Drive / Sheets
 */
export async function getRealGoogleDriveFileMetadata(
  accessToken: string,
  fileId: string
): Promise<{
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  version?: string;
  isDeleted?: boolean;
} | null> {
  if (!accessToken || !fileId) {
    throw new Error('Thiếu phiên Google Drive hoặc ID file để kiểm tra metadata.');
  }
  try {
    // 1. Thử gọi Google Drive API v3
    const driveRes = await fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,webViewLink,modifiedTime,version,trashed`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (driveRes.ok) {
      const data = await driveRes.json();
      if (data?.trashed) {
        return { id: fileId, name: data.name || '', mimeType: '', isDeleted: true };
      }
      if (data?.name) {
        return {
          id: data.id || fileId,
          name: data.name,
          mimeType: data.mimeType || '',
          webViewLink: data.webViewLink,
          modifiedTime: data.modifiedTime,
          version: data.version,
          isDeleted: false,
        };
      }
    }
    if (driveRes.status === 401) {
      setGoogleAccessToken(null);
      throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng đăng nhập lại.');
    }

    // 2. Fallback: Nếu là Google Spreadsheet và Drive API bị chặn quyền đọc danh mục, thử gọi Google Sheets API v4
    const sheetsRes = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=properties.title`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (sheetsRes.ok) {
      const sheetsData = await sheetsRes.json();
      if (sheetsData?.properties?.title) {
        return {
          id: fileId,
          name: sheetsData.properties.title,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          webViewLink: `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
          isDeleted: false,
        };
      }
    }
    if (sheetsRes.status === 401) {
      setGoogleAccessToken(null);
      throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng đăng nhập lại.');
    }
    if (driveRes.status === 403 || driveRes.status === 404 || sheetsRes.status === 403 || sheetsRes.status === 404) {
      throw new Error('FILE_ACCESS_UNVERIFIED: Không thể xác minh file trên Drive do thiếu quyền hoặc API chưa được cấp quyền. File chưa bị kết luận là đã xóa.');
    }
    throw new Error(`Không thể xác minh metadata file trên Google Drive (Drive HTTP ${driveRes.status}, Sheets HTTP ${sheetsRes.status}).`);
  } catch (err) {
    console.warn('Không thể tải tên file từ Google Drive/Sheets API:', err);
    throw err;
  }
}

/**
 * Download and parse a real Google Drive file (Sheet or Excel)
 */
export async function downloadRealGoogleDriveFile(
  accessToken: string,
  fileId: string,
  mimeType: string | undefined,
  userEmail: string
): Promise<ParseExcelResult> {
  try {
    // 0. Check if file is trashed or deleted first
    const metaCheck = await getRealGoogleDriveFileMetadata(accessToken, fileId);
    if (metaCheck?.isDeleted) {
      throw new Error('FILE_NOT_FOUND: File liên kết đã bị xóa hoặc chuyển vào thùng rác trên Google Drive.');
    }

    let resolvedMime = mimeType || metaCheck?.mimeType;
    if (!resolvedMime || resolvedMime === 'application/vnd.google-apps.spreadsheet') {
      await assertWorkspaceMembership(accessToken, fileId, userEmail, { allowUnlinked: true });
    }
    
    // 1. Try all non-config data tabs through Sheets API before exporting the workbook.
    if (!resolvedMime || resolvedMime === 'application/vnd.google-apps.spreadsheet') {
      try {
        const metaSheetRes = await fetchWithRetry(
          `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties(title,sheetId))`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );

        if (metaSheetRes.ok) {
          const metaSheetData = await metaSheetRes.json();
          const dataRanges = (metaSheetData?.sheets || [])
            .filter(
              (sheet: { properties?: { title?: string } }) =>
                sheet.properties?.title && sheet.properties.title !== '__CONFIG__'
            )
            .map((sheet: { properties: { title: string } }) => {
              const quotedTitle = sheet.properties.title.replace(/'/g, "''");
              return `'${quotedTitle}'!A1:AC1000`;
            });

          if (dataRanges.length > 0) {
            const valuesUrl = new URL(
              `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchGet`
            );
            dataRanges.forEach((range) => valuesUrl.searchParams.append('ranges', range));
            const liveSheetsRes = await fetchWithRetry(valuesUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (liveSheetsRes.status === 404) {
              throw new Error('FILE_ACCESS_UNVERIFIED: Sheets API không xác minh được file (HTTP 404); file có thể vẫn tồn tại nhưng ứng dụng chưa được cấp quyền.');
            }
            if (liveSheetsRes.ok) {
              const liveData = await liveSheetsRes.json();
              let bestMatrixResult: ParseExcelResult | null = null;
              for (const valueRange of liveData?.valueRanges || []) {
                if (!Array.isArray(valueRange.values) || valueRange.values.length === 0) continue;
                const matrixResult = parseMatrixData(valueRange.values);
                if (
                  matrixResult.success &&
                  (matrixResult.books.length > 0 || (matrixResult.settlements?.length || 0) > 0) &&
                  (!bestMatrixResult || matrixResult.books.length > bestMatrixResult.books.length)
                ) {
                  bestMatrixResult = matrixResult;
                }
              }
              if (bestMatrixResult) return bestMatrixResult;
            } else if (liveSheetsRes.status === 401) {
              setGoogleAccessToken(null);
              throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
            }
          }
        }

        if (metaSheetRes.status === 404) {
          throw new Error('FILE_ACCESS_UNVERIFIED: Sheets API không xác minh được file (HTTP 404); file có thể vẫn tồn tại nhưng ứng dụng chưa được cấp quyền.');
        }
      } catch (sheetsErr: any) {
        if (
          sheetsErr?.message?.includes('hết hạn') ||
          sheetsErr?.message?.includes('FILE_NOT_FOUND') ||
          sheetsErr?.message?.includes('FILE_ACCESS_UNVERIFIED')
        ) {
          throw sheetsErr;
        }
        console.warn('Direct Google Sheets API fetch fallback to Drive API:', sheetsErr);
      }
    }

    // 2. If not a native Google Sheet or if direct Sheets API didn't return rows, fetch metadata
    if (!resolvedMime) {
      const metaRes = await fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType,name,trashed`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      if (metaRes.status === 404) {
        throw new Error('FILE_ACCESS_UNVERIFIED: Google Drive không xác minh được file (HTTP 404); file có thể vẫn tồn tại nhưng tài khoản/app chưa có quyền.');
      }
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (meta?.trashed) {
          throw new Error('FILE_NOT_FOUND: File liên kết đã bị chuyển vào thùng rác trên Google Drive.');
        }
        resolvedMime = meta.mimeType;
      }
    }

    let fetchUrl: string;

    if (resolvedMime === 'application/vnd.google-apps.spreadsheet') {
      // Export Google Sheet as Excel binary (.xlsx)
      fetchUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
    } else {
      // Download binary file (Excel or CSV)
      fetchUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    }

    const res = await fetchWithRetry(fetchUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (
        res.status === 401 ||
        err?.error?.status === 'UNAUTHENTICATED' ||
        err?.error?.code === 401 ||
        err?.error?.message?.includes('invalid authentication credentials') ||
        err?.error?.message?.includes('Invalid Credentials')
      ) {
        setGoogleAccessToken(null);
        throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
      }
      if (res.status === 404) {
        throw new Error('FILE_ACCESS_UNVERIFIED: Google Drive không xác minh được file (HTTP 404); file có thể vẫn tồn tại nhưng tài khoản/app chưa có quyền.');
      }
      throw new Error(err?.error?.message || `Không thể tải nội dung file từ Google Drive (Mã ${res.status})`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const parsedBinary = await parseWorkbook(arrayBuffer);
    return parsedBinary;
  } catch (error: any) {
    if (error?.message?.includes('hết hạn') || error?.message?.includes('invalid authentication credentials')) {
      console.warn('Lỗi phiên đăng nhập Google Drive:', error.message);
    } else {
      console.error('Lỗi khi đọc file từ Google Drive:', error);
    }
    throw error;
  }
}

const MASTER_DATA_AUDIT_SNAPSHOT_SHEET = '__AUDIT_SNAPSHOT__';
const MASTER_DATA_AUDIT_SNAPSHOT_MARKER = 'STK_AUDIT_SNAPSHOT_V1';
let masterDataAuditQueue: Promise<void> = Promise.resolve();

function quoteSheetTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

function sheetColumnName(columnIndex: number): string {
  let name = '';
  let index = columnIndex + 1;
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

async function readMasterDataAuditMatrix(
  accessToken: string,
  fileId: string
): Promise<{ sheetId: number; title: string; values: unknown[][] }> {
  const metadataResponse = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties(sheetId,title,index))`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!metadataResponse.ok) {
    throw new Error(`Không đọc được cấu trúc sheet master để audit (Mã ${metadataResponse.status}).`);
  }
  const metadata = await metadataResponse.json();
  const firstSheet = (metadata.sheets || [])
    .slice()
    .sort((a: { properties?: { index?: number } }, b: { properties?: { index?: number } }) =>
      (a.properties?.index || 0) - (b.properties?.index || 0)
    )[0]?.properties;
  if (!firstSheet?.title || typeof firstSheet.sheetId !== 'number') {
    throw new Error('Không tìm thấy sheet dữ liệu master để audit.');
  }

  const range = `${quoteSheetTitle(firstSheet.title)}!A:AC`;
  const valuesResponse = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!valuesResponse.ok) {
    throw new Error(`Không đọc được dữ liệu A:AC của sheet master để audit (Mã ${valuesResponse.status}).`);
  }
  const valuesData = await valuesResponse.json();
  return {
    sheetId: firstSheet.sheetId,
    title: firstSheet.title,
    values: Array.isArray(valuesData.values) ? valuesData.values : [],
  };
}

async function getOrCreateMasterDataAuditSnapshotSheet(
  accessToken: string,
  fileId: string,
  minimumRows: number
): Promise<{ sheetId: number; rowCount: number }> {
  const metadataResponse = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!metadataResponse.ok) {
    throw new Error(`Không kiểm tra được sheet lưu snapshot audit (Mã ${metadataResponse.status}).`);
  }
  const metadata = await metadataResponse.json();
  let snapshot = (metadata.sheets || []).find(
    (sheet: { properties?: { title?: string } }) =>
      sheet.properties?.title === MASTER_DATA_AUDIT_SNAPSHOT_SHEET
  );
  if (!snapshot) {
    const createResponse = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            {
              addSheet: {
                properties: {
                  title: MASTER_DATA_AUDIT_SNAPSHOT_SHEET,
                  hidden: true,
                  gridProperties: { rowCount: Math.max(100, minimumRows), columnCount: 32 },
                },
              },
            },
          ],
        }),
      }
    );
    if (!createResponse.ok) {
      const error = await createResponse.json().catch(() => ({}));
      throw new Error(error?.error?.message || `Không thể tạo sheet snapshot audit (Mã ${createResponse.status}).`);
    }
    const created = await createResponse.json();
    const properties = created.replies?.[0]?.addSheet?.properties;
    if (!properties || typeof properties.sheetId !== 'number') {
      throw new Error('Google Sheets không trả về ID của sheet snapshot audit vừa tạo.');
    }
    return {
      sheetId: properties.sheetId,
      rowCount: properties.gridProperties?.rowCount || Math.max(100, minimumRows),
    };
  }

  const properties = snapshot.properties;
  const markerResponse = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(`${MASTER_DATA_AUDIT_SNAPSHOT_SHEET}!AE1`)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!markerResponse.ok) {
    throw new Error(`Không xác minh được quyền sở hữu sheet snapshot audit (Mã ${markerResponse.status}).`);
  }
  const markerData = await markerResponse.json();
  if (markerData.values?.[0]?.[0] !== MASTER_DATA_AUDIT_SNAPSHOT_MARKER) {
    throw new Error(`Tên sheet ${MASTER_DATA_AUDIT_SNAPSHOT_SHEET} đã được sử dụng bởi dữ liệu khác.`);
  }
  const rowCount = properties.gridProperties?.rowCount || 1000;
  if (rowCount < minimumRows) {
    const resizeResponse = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: [
            {
              updateSheetProperties: {
                properties: {
                  sheetId: properties.sheetId,
                  gridProperties: { rowCount: minimumRows },
                },
                fields: 'gridProperties.rowCount',
              },
            },
          ],
        }),
      }
    );
    if (!resizeResponse.ok) {
      throw new Error(`Không thể mở rộng sheet snapshot audit (Mã ${resizeResponse.status}).`);
    }
    return { sheetId: properties.sheetId, rowCount: minimumRows };
  }
  return { sheetId: properties.sheetId, rowCount };
}

async function writeMasterDataAuditSnapshot(
  accessToken: string,
  fileId: string,
  source: { sheetId: number; title: string; values: unknown[][] }
): Promise<void> {
  await getOrCreateMasterDataAuditSnapshotSheet(
    accessToken,
    fileId,
    source.values.length
  );
  const snapshotRange = `${MASTER_DATA_AUDIT_SNAPSHOT_SHEET}!A:AC`;
  const clearResponse = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(snapshotRange)}:clear`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!clearResponse.ok) {
    throw new Error(`Không thể xóa snapshot audit cũ (Mã ${clearResponse.status}).`);
  }
  if (source.values.length > 0) {
    const lastColumn = Math.min(
      29,
      Math.max(1, ...source.values.map((row) => row.length))
    );
    const range = `${MASTER_DATA_AUDIT_SNAPSHOT_SHEET}!A1:${sheetColumnName(lastColumn - 1)}${source.values.length}`;
    const writeResponse = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ majorDimension: 'ROWS', values: source.values }),
      }
    );
    if (!writeResponse.ok) {
      throw new Error(`Không thể lưu snapshot dữ liệu master (Mã ${writeResponse.status}).`);
    }
  }

  const markerResponse = await fetchWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(`${MASTER_DATA_AUDIT_SNAPSHOT_SHEET}!AE1:AF2`)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        majorDimension: 'ROWS',
        values: [
          [MASTER_DATA_AUDIT_SNAPSHOT_MARKER, new Date().toISOString()],
          [String(source.sheetId), source.title],
        ],
      }),
    }
  );
  if (!markerResponse.ok) {
    throw new Error(`Không thể xác nhận snapshot audit đã lưu (Mã ${markerResponse.status}).`);
  }
}

function getAuditCellValue(row: unknown[] | undefined, index: number): unknown {
  const value = row?.[index];
  return value === '' || value === undefined ? null : value;
}

async function readMasterDataAuditSnapshot(
  accessToken: string,
  fileId: string
): Promise<{ sourceSheetId: string; values: unknown[][] } | null> {
  const [metadataResponse, valuesResponse] = await Promise.all([
    fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(`${MASTER_DATA_AUDIT_SNAPSHOT_SHEET}!AE1:AF2`)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ),
    fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(`${MASTER_DATA_AUDIT_SNAPSHOT_SHEET}!A:AC`)}?valueRenderOption=UNFORMATTED_VALUE`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    ),
  ]);
  if (metadataResponse.status === 400 || metadataResponse.status === 404) return null;
  if (!metadataResponse.ok || !valuesResponse.ok) {
    const failure = !metadataResponse.ok ? metadataResponse : valuesResponse;
    throw new Error(`Không đọc được snapshot audit master (Mã ${failure.status}).`);
  }
  const markerData = await metadataResponse.json();
  const marker = markerData.values?.[0] || [];
  const source = markerData.values?.[1] || [];
  if (marker[0] !== MASTER_DATA_AUDIT_SNAPSHOT_MARKER || !source[0]) return null;
  const data = await valuesResponse.json();
  return {
    sourceSheetId: String(source[0]),
    values: Array.isArray(data.values) ? data.values : [],
  };
}

export async function initializeMasterDataAuditSnapshot(
  accessToken: string,
  fileId: string,
  forceReset = false
): Promise<void> {
  const currentSnapshot = await readMasterDataAuditSnapshot(accessToken, fileId);
  if (currentSnapshot && !forceReset) return;
  const currentMasterData = await readMasterDataAuditMatrix(accessToken, fileId);
  await writeMasterDataAuditSnapshot(accessToken, fileId, currentMasterData);
  if (!currentSnapshot && !forceReset) {
    recordSyncAuditLog({
      type: 'SYNC_ERROR',
      title: 'Thiếu mốc audit dữ liệu master',
      status: 'warning',
      fileId,
      sheetName: currentMasterData.title,
      summary: 'Không tìm thấy snapshot audit của phiên đang hoạt động; mốc hiện tại đã tạo nhưng có thể thiếu lịch sử trước đó.',
      details: { stage: 'link_baseline', reason: 'snapshot_missing', auditGapPossible: true },
    });
  }
}

export async function captureMasterDataCellChanges(
  accessToken: string,
  fileId: string,
  source: string,
  actor?: { userEmail?: string; currentRole?: string; sheetName?: string }
): Promise<number> {
  let changeCount = 0;
  const operation = masterDataAuditQueue.then(async () => {
    const currentMasterData = await readMasterDataAuditMatrix(accessToken, fileId);
    const previousSnapshot = await readMasterDataAuditSnapshot(accessToken, fileId);
    if (!previousSnapshot || previousSnapshot.sourceSheetId !== String(currentMasterData.sheetId)) {
      await writeMasterDataAuditSnapshot(accessToken, fileId, currentMasterData);
      recordSyncAuditLog({
        type: 'SYNC_ERROR',
        title: previousSnapshot ? 'Đặt lại mốc audit dữ liệu master' : 'Thiếu mốc audit dữ liệu master',
        status: 'warning',
        fileId,
        userEmail: actor?.userEmail,
        currentRole: actor?.currentRole,
        sheetName: actor?.sheetName || currentMasterData.title,
        summary: previousSnapshot
          ? 'Không thể tiếp tục so sánh với snapshot trước; đã tạo mốc mới và có thể thiếu lịch sử thay đổi.'
          : 'Không tìm thấy snapshot ban đầu; đã tạo mốc hiện tại, các thay đổi trước thời điểm này không thể khôi phục.',
        details: {
          source,
          reason: previousSnapshot ? 'snapshot_source_changed' : 'snapshot_missing',
          auditGapPossible: true,
        },
      });
      return;
    }

    const rowCount = Math.max(previousSnapshot.values.length, currentMasterData.values.length);
    const changes: NonNullable<SyncAuditLogEntry['details']>['changes'] = [];
    const activityIdHeader = String(
      currentMasterData.values[0]?.[20] || previousSnapshot.values[0]?.[20] || ''
    ).trim().toLowerCase();
    const hasLegacyActivityIdColumn = activityIdHeader.includes('id');
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      for (let columnIndex = 0; columnIndex < 29; columnIndex += 1) {
        if (hasLegacyActivityIdColumn && columnIndex === 20) continue;
        const from = getAuditCellValue(previousSnapshot.values[rowIndex], columnIndex);
        const to = getAuditCellValue(currentMasterData.values[rowIndex], columnIndex);
        if (JSON.stringify(from) === JSON.stringify(to)) continue;
        const cellCoord = `${sheetColumnName(columnIndex)}${rowIndex + 1}`;
        let location = `Ô ${cellCoord}`;
        if (columnIndex <= 12) {
          location = `Khu vực Danh mục sổ (Ô ${cellCoord}, Dòng ${rowIndex + 1})`;
        } else if (columnIndex >= 13 && columnIndex <= 15) {
          location = `Khu vực Lãi hàng năm (Ô ${cellCoord}, Dòng ${rowIndex + 1})`;
        } else if (columnIndex >= 16 && columnIndex <= 18) {
          location = `Khu vực Số dư cuối & Thu nhập (Ô ${cellCoord}, Dòng ${rowIndex + 1})`;
        } else if (columnIndex >= 20) {
          location = `Khu vực Tất toán / Điều chỉnh (Ô ${cellCoord}, Dòng ${rowIndex + 1})`;
        }
        changes.push({
          entity: 'cell',
          id: cellCoord,
          action: 'updated',
          location,
          fields: {
            value: {
              from: from === null ? { empty: true } : from,
              to: to === null ? { empty: true } : to,
            },
          },
        });
      }
    }
    changeCount = changes.length;

    if (changes.length === 0) return;

    recordSyncAuditLog({
        type: source === 'app_write' ? 'SYNC_PUSH' : 'DATA_DIVERGENCE',
        title: source === 'app_write' ? 'Thay đổi ô dữ liệu trên sheet master' : 'Phát hiện thay đổi trên sheet master',
        status: source === 'app_write' ? 'success' : 'warning',
        fileId,
        userEmail: actor?.userEmail,
        currentRole: actor?.currentRole,
        sheetName: actor?.sheetName || currentMasterData.title,
        summary: `${changes.length} ô thay đổi (${changes[0].id}${changes.length > 1 ? `…${changes[changes.length - 1].id}` : ''}).`,
        details: { source, changes },
      });
    await flushSyncAuditLogWrites();
    await writeMasterDataAuditSnapshot(accessToken, fileId, currentMasterData);
  });
  masterDataAuditQueue = operation.then(() => undefined, () => undefined);
  await operation;
  return changeCount;
}

/**
 * Upload and update an existing file on Google Drive (Real 2-way sync Push)
 * Works for both native Google Sheets (via Sheets API) and binary Excel files (.xlsx)
 */
export async function updateRealGoogleDriveFile(
  accessToken: string,
  fileId: string,
  books: SavingsBook[],
  settlements: SettlementAdjustment[] = [],
  auditActor?: { userEmail?: string; currentRole?: string; sheetName?: string },
  expectedModifiedTime?: string
): Promise<boolean> {
  try {
    // 0. Check if file is trashed or deleted first
    const metaCheck = await getRealGoogleDriveFileMetadata(accessToken, fileId);
    if (metaCheck?.isDeleted) {
      throw new Error('FILE_NOT_FOUND: File liên kết đã bị xóa hoặc chuyển vào thùng rác trên Google Drive.');
    }
    const verifyExpectedModifiedTime = async () => {
      if (!expectedModifiedTime) return;
      const latestMetadata = await getRealGoogleDriveFileMetadata(accessToken, fileId);
      if (
        !latestMetadata?.modifiedTime ||
        latestMetadata.modifiedTime !== expectedModifiedTime
      ) {
        throw new Error(
          'CONCURRENT_REMOTE_CHANGE: File trên Drive đã thay đổi kể từ lần đồng bộ gần nhất. Đã dừng ghi để tránh ghi đè; hãy tải dữ liệu mới và xử lý xung đột.'
        );
      }
    };
    // 1. Get file metadata to check if it's a native Google Sheet or an uploaded Excel file
    let isGoogleSheet = false;
    try {
      const metaRes = await fetchWithRetry(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=mimeType,name`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (metaRes.status === 404) {
        throw new Error('FILE_ACCESS_UNVERIFIED: Google Drive không xác minh được file (HTTP 404); file có thể vẫn tồn tại nhưng tài khoản/app chưa có quyền.');
      }
      if (metaRes.ok) {
        const meta = await metaRes.json();
        if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
          isGoogleSheet = true;
        }
      } else {
        throw new Error(`Không thể xác minh loại file Google Drive (HTTP ${metaRes.status}).`);
      }
    } catch (err: any) {
      if (err?.message?.includes('FILE_NOT_FOUND')) {
        throw err;
      }
      throw new Error(`Không thể xác minh loại file trước khi ghi: ${err?.message || err}`);
    }

    if (isGoogleSheet) {
      const actorEmail = auditActor?.userEmail?.trim().toLowerCase();
      const verifiedMaster = await assertWorkspaceMembership(accessToken, fileId, actorEmail || '');
      if (!verifiedMaster) {
        throw new Error('Không thể ghi dữ liệu vì file chưa có File liên kết active đã xác minh.');
      }
      if (
        resolveUserRole(
          actorEmail,
          undefined,
          verifiedMaster.members,
          verifiedMaster.adminEmail
        ) === 'VIEWER'
      ) {
        throw new Error('Viewer chỉ được đọc, không thể ghi dữ liệu lên Google Sheets.');
      }
      const auditSession = getActiveSyncAuditSession();
      const shouldAudit = auditSession?.fileId === fileId;
      if (shouldAudit) {
        try {
          await captureMasterDataCellChanges(accessToken, fileId, 'pre_app_write', auditActor);
        } catch (auditError: any) {
          recordSyncAuditLog({
            type: 'SYNC_ERROR',
            title: 'Dừng ghi vì không thể đối chiếu dữ liệu master',
            status: 'error',
            fileId,
            userEmail: auditActor?.userEmail,
            currentRole: auditActor?.currentRole,
            sheetName: auditActor?.sheetName,
            summary: `Không thể tạo/đọc snapshot audit trước khi ghi: ${auditError?.message || auditError}`,
            errorMessage: auditError?.message,
            details: { stage: 'pre_write_audit' },
          });
          throw new Error(`Không thể ghi an toàn vì audit master thất bại: ${auditError?.message || auditError}`);
        }
      }

      // 0. Fetch first sheet title to prefix ranges safely (in case user has custom sheet name)
      let sheetPrefix = '';
      let targetSheetId = 0;
      try {
        const metaSheetRes = await fetchWithRetry(
          `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties(title,sheetId))`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (metaSheetRes.ok) {
          const metaSheetData = await metaSheetRes.json();
          const firstProp = metaSheetData?.sheets?.[0]?.properties;
          if (firstProp) {
            if (firstProp.title) {
              sheetPrefix = /[\s!@#$%^&*()\-+=\[\]{};:",.<>?\/\\|]/.test(firstProp.title)
                ? `'${firstProp.title}'!`
                : `${firstProp.title}!`;
            }
            if (firstProp.sheetId !== undefined) {
              targetSheetId = firstProp.sheetId;
            }
          }
        }
      } catch {
        // fallback
      }

      // 1. Translate App SavingsBook[] to exact 12-column data rows (starting at Row 2)
      // Note: Sổ đã tất toán đã bị loại bỏ khỏi books, nên dataRows chỉ gồm các sổ đang hoạt động
      const dataRows = translateBooksToDataRows(books);
      const rowCount = dataRows.length;

      // 2. Clear ONLY the book rows range (A2:L35 max), preserving Row 1 Headers and Columns N..S
      const maxBookRows = Math.max(35, rowCount + 10);
      const clearRange = `${sheetPrefix}A2:L${maxBookRows}`;

      await verifyExpectedModifiedTime();
      try {
        await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(clearRange)}:clear`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        });
      } catch {
        // ignore clear error
      }

      // 3. Đọc dữ liệu các cột N:AC hiện có từ Google Sheet để bảo toàn dữ liệu lịch sử
      let existingMatrixNtoAC: any[][] = [];
      try {
        const getMetaRange = `${sheetPrefix}N1:AC40`;
        const getRes = await fetchWithRetry(
          `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(getMetaRange)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (getRes.ok) {
          const getData = await getRes.json();
          if (Array.isArray(getData?.values)) {
            existingMatrixNtoAC = getData.values;
          }
        }
      } catch (readErr) {
        console.warn('Không thể đọc trước dữ liệu N:AC từ Google Sheet:', readErr);
      }

      // 3.1. Tính toán LÃI HÀNG NĂM & SỐ CUỐI NĂM
      const annualInterestList = getDynamicAnnualInterestHistory(books, settlements);
      const balanceGrowthList = getDynamicBalanceGrowthHistory(books, settlements);
      const activityLogList = deduplicateSettlementAdjustments(settlements || []);

      const batchDataPayload: { range: string; majorDimension: string; values: any[][] }[] = [];
      const updatedRangesAudit: string[] = [];

      // A. CẬP NHẬT DANH MỤC SỔ TIẾT KIỆM (A2:L...)
      const targetRange = `${sheetPrefix}A2:L${1 + rowCount}`;
      batchDataPayload.push({
        range: targetRange,
        majorDimension: 'ROWS',
        values: dataRows,
      });
      updatedRangesAudit.push(`A2:L${1 + rowCount}`);

      // Xóa triệt để các hàng sổ cũ dôi dư (ví dụ vừa tất toán sổ làm giảm số lượng sổ từ 18 xuống 17)
      // Giúp ngăn ngừa việc PULL lại từ Sheet làm "hồi sinh" sổ cũ đã tất toán!
      const clearBookStartRow = 2 + rowCount;
      const clearBookEndRow = Math.max(clearBookStartRow + 10, 100);
      const emptyBookRow = ['', '', '', '', '', '', '', '', '', '', '', ''];
      const clearBookRowCount = clearBookEndRow - clearBookStartRow + 1;
      const clearBookRows = Array.from({ length: clearBookRowCount }, () => [...emptyBookRow]);
      batchDataPayload.push({
        range: `${sheetPrefix}A${clearBookStartRow}:L${clearBookEndRow}`,
        majorDimension: 'ROWS',
        values: clearBookRows,
      });

      // B. BẢO VỆ & CẬP NHẬT LÃI HÀNG NĂM (Cột N & O)
      // Tìm các năm hiện có ở cột N (index 0)
      const existingAnnualMap = new Map<number, number>(); // year -> sheet row (1-indexed)
      for (let i = 1; i < existingMatrixNtoAC.length; i++) {
        const yrRaw = parseInt(String(existingMatrixNtoAC[i]?.[0] || '').replace(/\D/g, ''), 10);
        if (yrRaw >= 2000 && yrRaw <= 2099) {
          existingAnnualMap.set(yrRaw, i + 1);
        }
      }

      const hasHistoricalAnnuals =
        existingAnnualMap.has(2022) ||
        existingAnnualMap.has(2023) ||
        existingAnnualMap.has(2024) ||
        existingAnnualMap.has(2025);

      if (hasHistoricalAnnuals) {
        // Sheet ĐÃ CÓ các năm cũ: TUYỆT ĐỐI KHÔNG GHI ĐÈ các hàng cũ!
        // Chỉ cập nhật hoặc ghi tiếp cho các năm 2026, 2027, 2028
        const yearsToUpdate = [2026, 2027, 2028];
        let maxAnnualRow = Math.max(...Array.from(existingAnnualMap.values()), 1);

        yearsToUpdate.forEach((yr) => {
          const rec = annualInterestList.find((a) => a.year === yr);
          const amtMil = rec?.interestEarnedMillion ?? 0;
          let targetRow = existingAnnualMap.get(yr);
          if (!targetRow) {
            maxAnnualRow++;
            targetRow = maxAnnualRow;
            existingAnnualMap.set(yr, targetRow);
          }
          batchDataPayload.push({
            range: `${sheetPrefix}N${targetRow}:O${targetRow}`,
            majorDimension: 'ROWS',
            values: [[yr, amtMil]],
          });
          updatedRangesAudit.push(`N${targetRow}:O${targetRow} (Năm ${yr})`);
        });
      } else if (annualInterestList && annualInterestList.length > 0) {
        const annualRows = annualInterestList.map((a) => [a.year, a.interestEarnedMillion]);
        batchDataPayload.push({
          range: `${sheetPrefix}N2:O${1 + annualRows.length}`,
          majorDimension: 'ROWS',
          values: annualRows,
        });
        updatedRangesAudit.push(`N2:O${1 + annualRows.length} (Cập nhật Lãi Hàng Năm)`);
      }

      // C. BẢO VỆ & CẬP NHẬT SỐ DƯ CUỐI NĂM & THU NHẬP NĂM (Cột Q, R, S)
      const existingBalanceMap = new Map<number, number>(); // year -> sheet row (1-indexed)
      for (let i = 1; i < existingMatrixNtoAC.length; i++) {
        const yrRaw = parseInt(String(existingMatrixNtoAC[i]?.[3] || '').replace(/\D/g, ''), 10);
        if (yrRaw >= 2000 && yrRaw <= 2099) {
          existingBalanceMap.set(yrRaw, i + 1);
        }
      }

      if (balanceGrowthList && balanceGrowthList.length > 0) {
        if (existingBalanceMap.size > 0) {
          // Sheet đã có các dòng số dư: Cập nhật hoặc thêm mới các năm chưa có
          balanceGrowthList.forEach((rec) => {
            let targetRow = existingBalanceMap.get(rec.year);
            if (!targetRow) {
              const maxBalRow = Math.max(...Array.from(existingBalanceMap.values()), 1);
              targetRow = maxBalRow + 1;
              existingBalanceMap.set(rec.year, targetRow);
            }
            batchDataPayload.push({
              range: `${sheetPrefix}Q${targetRow}:S${targetRow}`,
              majorDimension: 'ROWS',
              values: [[rec.year, rec.balanceMillion, rec.annualIncomeMillion !== undefined ? rec.annualIncomeMillion : '']],
            });
            updatedRangesAudit.push(`Q${targetRow}:S${targetRow} (Năm ${rec.year})`);
          });
        } else {
          // Sheet chưa có dữ liệu số dư: Ghi toàn bộ danh sách
          const fullBalances = balanceGrowthList.map((b) => [
            b.year,
            b.balanceMillion,
            b.annualIncomeMillion !== undefined ? b.annualIncomeMillion : '',
          ]);
          batchDataPayload.push({
            range: `${sheetPrefix}Q2:S${1 + fullBalances.length}`,
            majorDimension: 'ROWS',
            values: fullBalances,
          });
          updatedRangesAudit.push(`Q2:S${1 + fullBalances.length} (Khởi tạo Bảng Số Dư)`);
        }
      }

      // D. BẢO VỆ & CẬP NHẬT NHẬT KÝ BIẾN ĐỘNG / TẤT TOÁN (Cột U..AC)
      // Tự động nhận diện cấu trúc 9 cột (có ID biến động ở U) hoặc cấu trúc cũ 8 cột (bắt đầu bằng Ngày ở U)
      let colUHeader = '';
      if (existingMatrixNtoAC.length > 0 && existingMatrixNtoAC[0]) {
        colUHeader = String(existingMatrixNtoAC[0][7] || '').toLowerCase().normalize('NFC').trim();
      }
      const is9ColLayout = colUHeader.includes('id');

      let maxExistingActivityRow = 1;
      existingMatrixNtoAC.slice(1).forEach((r, idx) => {
        const rowNum = idx + 2;
        // Kiểm tra xem hàng này ở cột U..AC có dữ liệu không (indices 7..15 trong N:AC)
        const checkIndices = is9ColLayout ? [7, 8, 9, 10, 11, 12, 13, 14, 15] : [7, 8, 9, 10, 11, 12, 13, 14];
        const hasData = checkIndices.some(
          (cIdx) => r[cIdx] !== undefined && String(r[cIdx]).trim() !== ''
        );
        if (hasData) {
          maxExistingActivityRow = Math.max(maxExistingActivityRow, rowNum);
        }
      });
      if (activityLogList.length > 0) {
        const activityRows = activityLogList.map((s, idx) => {
          const cleanCode = (s.bookCode || 'SO').replace(/\s+/g, '').toUpperCase();
          const shortBank = getBankShortCode(s.bankId, cleanCode);
          const standardizedId = `ADJ_${idx + 1}_${cleanCode}`;

          if (is9ColLayout) {
            return [
              standardizedId,
              translateDateToSheet(s.settlementDate || '', 'yyyy-mm-dd'),
              s.settlementType === 'early' ? 'Tất toán trước hạn' : 'Tất toán đúng hạn',
              s.bookCode || '',
              shortBank,
              getOwnerLabel(s.owner),
              s.principal ? Math.round(s.principal / 1_000_000) : 0,
              s.actualInterestVND ? Math.round(s.actualInterestVND / 1_000_000) : 0,
              s.note || '',
            ];
          } else {
            return [
              translateDateToSheet(s.settlementDate || '', 'yyyy-mm-dd'),
              s.settlementType === 'early' ? 'Tất toán trước hạn' : 'Tất toán đúng hạn',
              s.bookCode || '',
              shortBank,
              getOwnerLabel(s.owner),
              s.principal ? Math.round(s.principal / 1_000_000) : 0,
              s.actualInterestVND ? Math.round(s.actualInterestVND / 1_000_000) : 0,
              s.note || '',
            ];
          }
        });

        // Nếu số dòng nhật ký hiện có trên Sheet nhiều hơn số dòng app ghi (ví dụ Sheet đang có 4 dòng, nhưng app chỉ ghi 1 dòng):
        // Bắt buộc xóa sạch các dòng dôi dư để dọn sạch nhật ký thừa
        if (maxExistingActivityRow > 1 + activityRows.length) {
          const clearStartRow = 2 + activityRows.length;
          const clearEndRow = Math.max(maxExistingActivityRow, 10);
          const emptyRow = is9ColLayout ? ['', '', '', '', '', '', '', '', ''] : ['', '', '', '', '', '', '', ''];
          const clearRowCount = clearEndRow - clearStartRow + 1;
          const clearRows = Array.from({ length: clearRowCount }, () => [...emptyRow]);

          const clearColLetter = is9ColLayout ? 'AC' : 'AB';
          batchDataPayload.push({
            range: `${sheetPrefix}U${clearStartRow}:${clearColLetter}${clearEndRow}`,
            majorDimension: 'ROWS',
            values: clearRows,
          });
          updatedRangesAudit.push(`U${clearStartRow}:${clearColLetter}${clearEndRow} (Dọn sạch ${clearRowCount} dòng nhật ký thừa trên Sheet)`);
        }

        const targetColLetter = is9ColLayout ? 'AC' : 'AB';
        batchDataPayload.push({
          range: `${sheetPrefix}U2:${targetColLetter}${1 + activityRows.length}`,
          majorDimension: 'ROWS',
          values: activityRows,
        });
        updatedRangesAudit.push(`U2:${targetColLetter}${1 + activityRows.length} (${activityRows.length} dòng nhật ký)`);
      }
      // Lưu ý: Nếu existingActivityCount > 0 và activityLogList rỗng, TUYỆT ĐỐI KHÔNG GHI ĐÈ để bảo vệ dòng dữ liệu cũ trong Sheet!

      // 4. Batch update chính xác vào các ô được chỉ định (KHÔNG DÙNG PADDING Ô TRỐNG ĐỂ XÓA DỮ LIỆU)
      if (rowCount > 0) {
        const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchUpdate`;

        const batchBody = {
          valueInputOption: 'USER_ENTERED',
          data: batchDataPayload,
        };

        const putRes = await fetchWithRetry(batchUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(batchBody),
        });

        if (!putRes.ok) {
          const err = await putRes.json().catch(() => ({}));
          const errMsg = err?.error?.message || `Lỗi cập nhật Google Sheet (Mã ${putRes.status})`;

          if (
            putRes.status === 401 ||
            err?.error?.status === 'UNAUTHENTICATED' ||
            err?.error?.code === 401 ||
            err?.error?.message?.includes('invalid authentication credentials') ||
            err?.error?.message?.includes('Invalid Credentials')
          ) {
            setGoogleAccessToken(null);
            throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
          }
          if (putRes.status === 404) {
            throw new Error('FILE_ACCESS_UNVERIFIED: Sheets API không xác minh được quyền ghi file (HTTP 404); chưa kết luận file đã bị xóa.');
          }
          throw new Error(errMsg);
        }

        // 5. Đồng bộ định dạng font (Arial 10pt), kẻ khung viền (Borders) và sao chép định dạng đồng đều cho toàn bộ các dòng
        try {
          const sheetsMetaRes = await fetchWithRetry(
            `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets.properties`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );
          if (sheetsMetaRes.ok) {
            const sheetsData = await sheetsMetaRes.json();
            const sheetId = sheetsData?.sheets?.[0]?.properties?.sheetId ?? targetSheetId ?? 0;

            const formatBody = {
              requests: [
                // 1. Format Cột F (5) & Cột G (6) Ngày gửi & Ngày đáo hạn dạng DATE (dd/mm/yyyy)
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 5,
                      endColumnIndex: 7,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'DATE',
                          pattern: 'dd/mm/yyyy',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                // 2. Format Cột V (21) Ngày biến động dạng DATE (dd/mm/yyyy)
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 21,
                      endColumnIndex: 22,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'DATE',
                          pattern: 'dd/mm/yyyy',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                // 3. Format Cột E (4) Tiền gửi dạng NUMBER (#,##0)
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 4,
                      endColumnIndex: 5,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'NUMBER',
                          pattern: '#,##0',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                // 4. Format Cột J (9) & K (10) Tiền lãi dạng NUMBER (#,##0.0#)
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 9,
                      endColumnIndex: 11,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'NUMBER',
                          pattern: '#,##0.0#',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                // 5. Format Cột O (14), R (17), S (18), AA (26) dạng NUMBER (#,##0)
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 14,
                      endColumnIndex: 15,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'NUMBER',
                          pattern: '#,##0',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 17,
                      endColumnIndex: 19,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'NUMBER',
                          pattern: '#,##0',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 26,
                      endColumnIndex: 27,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'NUMBER',
                          pattern: '#,##0',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                // 6. Format Cột AB (27) Lãi thực nhận biến động dạng NUMBER (#,##0.0#)
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 27,
                      endColumnIndex: 28,
                    },
                    cell: {
                      userEnteredFormat: {
                        numberFormat: {
                          type: 'NUMBER',
                          pattern: '#,##0.0#',
                        },
                      },
                    },
                    fields: 'userEnteredFormat.numberFormat',
                  },
                },
                // 7. Ép phông chữ Arial 10pt Bold cho tiêu đề hàng 1
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 0,
                      endRowIndex: 1,
                      startColumnIndex: 0,
                      endColumnIndex: 29,
                    },
                    cell: {
                      userEnteredFormat: {
                        textFormat: {
                          fontFamily: 'Arial',
                          fontSize: 10,
                          bold: true,
                        },
                        verticalAlignment: 'MIDDLE',
                      },
                    },
                    fields: 'userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment',
                  },
                },
                // 8. Phông chữ Arial 10pt cho các dòng dữ liệu
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 100,
                      startColumnIndex: 0,
                      endColumnIndex: 29,
                    },
                    cell: {
                      userEnteredFormat: {
                        textFormat: {
                          fontFamily: 'Arial',
                          fontSize: 10,
                          bold: false,
                        },
                        verticalAlignment: 'MIDDLE',
                      },
                    },
                    fields: 'userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment',
                  },
                },
                // 9. Kẻ khung viền mỏng
                {
                  updateBorders: {
                    range: {
                      sheetId,
                      startRowIndex: 1,
                      endRowIndex: 1 + Math.max(1, rowCount),
                      startColumnIndex: 0,
                      endColumnIndex: 12,
                    },
                    top: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
                    bottom: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
                    left: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
                    right: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
                    innerHorizontal: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
                    innerVertical: { style: 'SOLID', color: { red: 0.85, green: 0.85, blue: 0.85 } },
                  },
                },
              ],
            };

            await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(formatBody),
            });
          }
        } catch (formatErr) {
          console.warn('Không thể tự động áp dụng định dạng lên Google Sheet:', formatErr);
        }
        if (shouldAudit) {
          try {
            await captureMasterDataCellChanges(accessToken, fileId, 'app_write', auditActor);
          } catch (auditError: any) {
            console.error('[SYNC AUDIT] Đã ghi dữ liệu nhưng không lưu được snapshot/diff sau ghi.', auditError);
            recordSyncAuditLog({
              type: 'SYNC_ERROR',
              title: 'Không lưu được audit sau khi ghi dữ liệu',
              status: 'error',
              fileId,
              userEmail: auditActor?.userEmail,
              currentRole: auditActor?.currentRole,
              sheetName: auditActor?.sheetName,
              summary: `Dữ liệu đã ghi lên sheet nhưng audit chưa chốt được: ${auditError?.message || auditError}`,
              errorMessage: auditError?.message,
              details: { stage: 'post_write_audit', auditGapPossible: true },
            });
          }
        }
      }
      return true;
    } else {
      // Binary Excel (.xlsx) file on Google Drive
      const currentYear = new Date().getFullYear();
      const annualInterestList = getDynamicAnnualInterestHistory(books, settlements).filter(
        (r) => r.year <= currentYear
      );
      const balanceGrowthList = getDynamicBalanceGrowthHistory(books, settlements).filter(
        (r) => r.year < currentYear
      );
      const excelBuffer = await getSavingsExcelArrayBuffer(books, annualInterestList, balanceGrowthList);
      const blob = new Blob([excelBuffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

      const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`;
      await verifyExpectedModifiedTime();
      const res = await fetchWithRetry(uploadUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
        body: blob,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (
          res.status === 401 ||
          err?.error?.status === 'UNAUTHENTICATED' ||
          err?.error?.code === 401 ||
          err?.error?.message?.includes('invalid authentication credentials') ||
          err?.error?.message?.includes('Invalid Credentials')
        ) {
          setGoogleAccessToken(null);
          throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
        }
        if (res.status === 404) {
           throw new Error('FILE_ACCESS_UNVERIFIED: Google Drive không xác minh được quyền ghi file (HTTP 404); chưa kết luận file đã bị xóa.');
        }
        throw new Error(err?.error?.message || `Không thể cập nhật file lên Google Drive (Mã ${res.status})`);
      }

      return true;
    }
  } catch (error: any) {
    if (error?.message?.includes('hết hạn') || error?.message?.includes('invalid authentication credentials')) {
      console.warn('Lỗi phiên đăng nhập Google Drive:', error.message);
    } else {
      console.error('Lỗi khi đẩy dữ liệu lên Google Drive:', error);
    }
    throw error;
  }
}

/**
 * Create a brand new Excel file on the user's real Google Drive
 */
export async function createRealGoogleDriveFile(
  accessToken: string,
  fileName: string,
  books: SavingsBook[],
  settlements: SettlementAdjustment[] = [],
  userEmail?: string
): Promise<{ id: string; name: string; webViewLink: string; linkedTimestamp?: string }> {
  try {
    const annualInterestList = getDynamicAnnualInterestHistory(books, settlements);
    const balanceGrowthList = getDynamicBalanceGrowthHistory(books, settlements);
    const excelBuffer = await getSavingsExcelArrayBuffer(books, annualInterestList, balanceGrowthList, settlements);
    const fileBlob = new Blob([excelBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const cleanFileName = fileName.replace(/\.xlsx$/i, '').trim() || 'So_Tiet_Kiem_Gia_Dinh';

    const metadata = {
      name: cleanFileName,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      appProperties: {
        [SAVINGS_APP_PROPERTY_KEY]: SAVINGS_APP_ID,
        [SAVINGS_APP_DISCOVERY_PROPERTY_KEY]: SAVINGS_APP_ID,
        [SAVINGS_APP_LINKED_PROPERTY_KEY]: SAVINGS_APP_ID,
        app_label: SAVINGS_APP_ID,
        is_savings_hub: 'true',
      },
    };

    const form = new FormData();
    form.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json; charset=UTF-8' })
    );
    form.append('file', fileBlob);

    const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
    const res = await fetchWithRetry(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: form,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (
        res.status === 401 ||
        err?.error?.status === 'UNAUTHENTICATED' ||
        err?.error?.code === 401 ||
        err?.error?.message?.includes('invalid authentication credentials') ||
        err?.error?.message?.includes('Invalid Credentials')
      ) {
        setGoogleAccessToken(null);
        throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
      }
      throw new Error(err?.error?.message || `Không thể tạo Google Sheet mới trên Google Drive (Mã ${res.status})`);
    }

    const data = await res.json();
    const linkedTimestamp = new Date().toISOString();
    const webViewLink = data.webViewLink || `https://docs.google.com/spreadsheets/d/${data.id}/edit`;

    // Đảm bảo gán nhãn com.tietkiemgiadinh.app ngay sau khi tạo
    try {
      await markDriveFileAsManagedByApp(accessToken, data.id);
    } catch (tagErr) {
      console.warn('[Google Drive] Gán nhãn app sau khi tạo file mới có cảnh báo:', tagErr);
    }

    const effectiveOwnerEmail = (
      userEmail ||
      getGoogleUserProfile()?.email ||
      auth.currentUser?.email ||
      ''
    ).trim().toLowerCase();

    const initialMembers: WorkspaceMember[] = effectiveOwnerEmail
      ? [
          {
            id: `owner-${Date.now()}`,
            email: effectiveOwnerEmail,
            name: getGoogleUserProfile()?.name || auth.currentUser?.displayName || 'Admin',
            role: 'ADMIN',
            addedAt: linkedTimestamp,
          },
        ]
      : [];

    // Save Master Sync State on Drive for this new file (Single Source of Truth)
    try {
      await saveMasterSyncStateOnDrive(accessToken, {
        status: 'active',
        lastAction: 'create_and_link',
        activeFileId: data.id,
        activeFileName: data.name,
        activeFileUrl: webViewLink,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        linkedTimestamp,
        linkedAccountEmail: effectiveOwnerEmail || 'Google User',
        adminEmail: effectiveOwnerEmail || 'admin',
        members: initialMembers,
        settlements,
        updatedAt: linkedTimestamp,
      }, { allowCreateConfig: true });
    } catch (saveErr) {
      console.warn('Failed to update master sync state on newly created drive file:', saveErr);
    }

    return {
      id: data.id,
      name: data.name,
      webViewLink,
      linkedTimestamp,
    };
  } catch (error: any) {
    if (error?.message?.includes('hết hạn') || error?.message?.includes('invalid authentication credentials')) {
      console.warn('Lỗi phiên đăng nhập Google Drive:', error.message);
    } else {
      console.error('Lỗi khi tạo file mới trên Google Drive:', error);
    }
    throw error;
  }
}

/**
 * Delete a file on the user's real Google Drive
 */
export async function deleteRealGoogleDriveFile(
  accessToken: string,
  fileId: string
): Promise<boolean> {
  try {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    const res = await fetchWithRetry(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!res.ok && res.status !== 404) {
      if (res.status === 401) {
        setGoogleAccessToken(null);
        throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng bấm đăng nhập lại.');
      }
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Không thể xóa tệp trên Google Drive (Mã ${res.status})`);
    }
    return true;
  } catch (error: any) {
    console.error('Lỗi khi xóa tệp trên Google Drive:', error);
    throw error;
  }
}

/**
 * Stamp central hub metadata (appProperties, description, linked_timestamp) on a linked Google Drive file.
 * Ensures any device logging in with the same account can auto-discover this file as the central data hub (Single Source of Truth).
 * Automatically un-stamps any previous files so only 1 file on Drive remains marked as active central hub.
 */
/**
 * Master Sync State stored directly on user's Google Drive as a single source of truth
 */
export type { MasterSyncState };

export const MASTER_STATE_FILENAME = 'so_tiet_kiem_backup.json';

export async function markDriveFileAsManagedByApp(accessToken: string, fileId: string): Promise<void> {
  const metadataUrl = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  metadataUrl.searchParams.set('fields', 'appProperties');
  const metadataResponse = await fetchWithRetry(metadataUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metadataResponse.ok) {
    throw new Error(`Không đọc được metadata file để đánh dấu ứng dụng (Mã ${metadataResponse.status}).`);
  }
  const metadata = await metadataResponse.json();
  const patchUrl = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
  patchUrl.searchParams.set('fields', 'appProperties');
  const patchResponse = await fetchWithRetry(patchUrl, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      appProperties: {
        ...(metadata.appProperties || {}),
        [SAVINGS_APP_PROPERTY_KEY]: SAVINGS_APP_ID,
        [SAVINGS_APP_DISCOVERY_PROPERTY_KEY]: SAVINGS_APP_ID,
        [SAVINGS_APP_LINKED_PROPERTY_KEY]: SAVINGS_APP_ID,
        app_label: SAVINGS_APP_ID,
        is_savings_hub: 'true',
      },
    }),
  });
  if (!patchResponse.ok) {
    const errorData = await patchResponse.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || `Không thể đánh dấu file đã liên kết (Mã ${patchResponse.status}).`);
  }
}

/**
 * Kiểm tra file có mang nhãn nhận diện của ứng dụng (com.tietkiemgiadinh.app)
 */
export function isFileLabeledWithApp(file: { appProperties?: Record<string, string> }): boolean {
  if (!file.appProperties) return false;
  return (
    file.appProperties[SAVINGS_APP_PROPERTY_KEY] === SAVINGS_APP_ID ||
    file.appProperties[SAVINGS_APP_LINKED_PROPERTY_KEY] === SAVINGS_APP_ID ||
    file.appProperties[SAVINGS_APP_DISCOVERY_PROPERTY_KEY] === SAVINGS_APP_ID ||
    file.appProperties.app_label === SAVINGS_APP_ID ||
    file.appProperties.is_savings_hub === 'true'
  );
}

/**
 * Kiểm tra file có phải tên mặc định test (ví dụ So_tiet_kiem_2026) hay không
 */
export function isDefaultTestName(fileName?: string): boolean {
  if (!fileName) return false;
  const clean = fileName.trim().toLowerCase().replace(/[\s_-]+/g, '_');
  return (
    clean === 'so_tiet_kiem_2026' ||
    clean === 'so_tiet_kiem_2026.xlsx' ||
    clean === 'so_tiet_kiem_2026.gsheet' ||
    clean.includes('so_tiet_kiem_2026') ||
    clean.includes('so_tiet_kiem_2025') ||
    clean.includes('so_tiet_kiem_2024') ||
    clean.includes('so_tiet_kiem_2023') ||
    clean.includes('so_tiet_kiem_202') ||
    clean.startsWith('so_tiet_kiem_20') ||
    /^so_tiet_kiem_\d{4}/i.test(clean) ||
    /^so_tiet_kiem_\d{4}\.(xlsx|gsheet)$/i.test(clean)
  );
}

/**
 * Helper to sync MasterSyncState into AppSettings and compute current role dynamically.
 * Accepts optional currentSettings to compare and skip redundant setSettings calls (avoiding app re-renders).
 */
export function applyMasterStateToSettings(
  masterState: MasterSyncState | null,
  currentUserEmail: string | undefined,
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>,
  currentSettings?: AppSettings,
  accessToken?: string
) {
  if (!masterState) return;

  const cleanUserEmail = currentUserEmail?.trim().toLowerCase();
  const adminEmail = (masterState.adminEmail || masterState.linkedAccountEmail || '').trim().toLowerCase();

  let resolvedRole: UserRole = 'VIEWER';
  if (cleanUserEmail) {
    if (adminEmail && cleanUserEmail === adminEmail) {
      resolvedRole = 'ADMIN';
    } else if (masterState.members && masterState.members.length > 0) {
      const matchedMember = masterState.members.find(
        (m) => m.email && m.email.trim().toLowerCase() === cleanUserEmail
      );
      if (matchedMember && matchedMember.role) {
        resolvedRole = matchedMember.role.toUpperCase() as UserRole;
      } else {
        resolvedRole = 'VIEWER';
      }
    }
  }

  const newMembers = masterState.members && masterState.members.length > 0 ? masterState.members : [];
  const newFileUrl = masterState.activeFileId ? (masterState.activeFileUrl || `https://docs.google.com/spreadsheets/d/${masterState.activeFileId}/edit`) : undefined;
  const newFileName = masterState.activeFileId ? masterState.activeFileName : undefined;
  const newTimestamp = masterState.activeFileId ? masterState.linkedTimestamp : undefined;

  // Auto-revoke permissions if Admin detects members who self-exited on Drive
  if (accessToken && cleanUserEmail && adminEmail && cleanUserEmail === adminEmail && currentSettings?.members) {
    const missingMembers = currentSettings.members.filter(
      (oldM) => !newMembers.some((newM) => newM.email.trim().toLowerCase() === oldM.email.trim().toLowerCase())
    );
    for (const missingM of missingMembers) {
      if (missingM.email) {
        console.info(`[Master State Auto Cleanup] Admin detected self-exited member ${missingM.email}. Revoking permissions on Drive...`);
        removeMemberFromDriveMaster(accessToken, missingM.email).catch(() => {});
      }
    }
  }

  // Tự động rà soát và đồng bộ quyền Google Drive (file Excel và file JSON master) khớp với danh sách members trong JSON khi Admin đăng nhập/đồng bộ:
  // Nếu JSON không có danh sách user (danh sách members rỗng hoặc chỉ có Admin), toàn bộ quyền chia sẻ cho người khác phải bị thu hồi ngay!
  if (accessToken && cleanUserEmail && adminEmail && cleanUserEmail === adminEmail) {
    if (masterState.activeFileId) {
      void synchronizeDrivePermissionsWithJsonMembers(
        accessToken,
        masterState.activeFileId,
        newMembers,
        adminEmail
      ).then((result) => {
        if (!result.success) {
          console.error('[Workspace Permissions] Một số quyền Drive chưa khớp roster.', result.entries);
        }
      }).catch((err) => {
        console.error('[Workspace Permissions] Không thể tải/đồng bộ quyền Drive.', err);
      });
    }

    void getMasterPointerFileId(accessToken).then((pointerId) => {
      if (pointerId) {
        return synchronizeDrivePermissionsWithJsonMembers(
          accessToken,
          pointerId,
          newMembers,
          adminEmail
        ).then((result) => {
          if (!result.success) {
            console.error('[Workspace Permissions] Quyền file master pointer chưa khớp roster.', result.entries);
          }
        });
      }
    }).catch((err) => {
      console.error('[Workspace Permissions] Không thể đồng bộ quyền file master pointer.', err);
    });
  }

  // Jump out early if currentSettings provided and nothing changed
  if (currentSettings) {
    const hasRoleChange = currentSettings.currentRole !== resolvedRole;
    const hasMembersChange = JSON.stringify(currentSettings.members || []) !== JSON.stringify(newMembers);
    const hasOwnerChange = Boolean(adminEmail && currentSettings.workspaceOwnerEmail !== adminEmail);
    const hasFileChange = Boolean(newFileUrl && currentSettings.googleSheetUrl !== newFileUrl);
    const hasFileNameChange = Boolean(newFileName && currentSettings.googleSheetName !== newFileName);
    const hasTimestampChange = Boolean(newTimestamp && currentSettings.lastLocalLinkTimestamp !== newTimestamp);
    const hasWorkspaceTypeChange =
      masterState.status === 'active' && currentSettings.isPersonalWorkspace !== false;

    if (!hasRoleChange && !hasMembersChange && !hasOwnerChange && !hasFileChange && !hasFileNameChange && !hasTimestampChange && !hasWorkspaceTypeChange) {
      return; // Skip setSettings completely to prevent unnecessary re-renders
    }
  }

  setSettings((prev) => {
    const updates: Partial<AppSettings> = {};

    if (prev.currentRole !== resolvedRole) {
      updates.currentRole = resolvedRole;
    }

    if (newMembers.length > 0 && JSON.stringify(prev.members || []) !== JSON.stringify(newMembers)) {
      updates.members = newMembers;
    }

    if (adminEmail && prev.workspaceOwnerEmail !== adminEmail) {
      updates.workspaceOwnerEmail = adminEmail;
    }

    if (masterState.activeFileId && masterState.status !== 'unlinked') {
      if (prev.isPersonalWorkspace !== false) {
        updates.isPersonalWorkspace = false;
      }
      if (newFileUrl && prev.googleSheetUrl !== newFileUrl) {
        updates.googleSheetUrl = newFileUrl;
      }
      if (newFileName && prev.googleSheetName !== newFileName) {
        updates.googleSheetName = newFileName;
      }
      if (newTimestamp && prev.lastLocalLinkTimestamp !== newTimestamp) {
        updates.lastLocalLinkTimestamp = newTimestamp;
      }
    }

    if (Object.keys(updates).length === 0) {
      return prev; // Return prev unchanged so React skips re-render
    }

    return { ...prev, ...updates };
  });
}

/**
 * Helper to get current Vietnam time formatted nicely for human reading in JSON
 */
export function formatIsoToVietnamTime(isoStr?: string): string {
  try {
    const d = isoStr ? new Date(isoStr) : new Date();
    if (isNaN(d.getTime())) return isoStr || '';
    return (
      d.toLocaleString('vi-VN', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }) + ' (GMT+7)'
    );
  } catch {
    return (isoStr ? new Date(isoStr) : new Date()).toLocaleString('vi-VN') + ' (GMT+7)';
  }
}

const LOCAL_MASTER_STATE_KEY = 'master_sync_state_local_v2';
const LOCAL_ACTIVE_FILE_ID_KEY = 'last_linked_file_id_v2';

export function getLocalMasterPointerFileId(): string | null {
  try {
    return localStorage.getItem(LOCAL_ACTIVE_FILE_ID_KEY) || localStorage.getItem(MASTER_POINTER_FILE_ID_KEY) || null;
  } catch {
    return null;
  }
}

export function isExplicitlyUnlinked(): boolean {
  try {
    return (
      localStorage.getItem('explicitly_unlinked') === 'true' ||
      sessionStorage.getItem('explicitly_unlinked') === 'true'
    );
  } catch {
    return false;
  }
}

export function setExplicitlyUnlinked(unlinked: boolean): void {
  try {
    if (unlinked) {
      localStorage.setItem('explicitly_unlinked', 'true');
      sessionStorage.setItem('explicitly_unlinked', 'true');
      const currentFileId = getLocalMasterPointerFileId();
      if (currentFileId) {
        addBlockedUnlinkedFileId(currentFileId);
      }
      saveLocalMasterPointerFileId(null);
      saveLocalMasterPointerState(null);
    } else {
      localStorage.removeItem('explicitly_unlinked');
      sessionStorage.removeItem('explicitly_unlinked');
    }
  } catch {}
}

const BLOCKED_UNLINKED_FILE_IDS_KEY = 'blocked_unlinked_file_ids_v2';

export function getBlockedUnlinkedFileIds(): string[] {
  try {
    const raw = localStorage.getItem(BLOCKED_UNLINKED_FILE_IDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addBlockedUnlinkedFileId(fileId: string): void {
  try {
    if (!fileId) return;
    const existing = getBlockedUnlinkedFileIds();
    if (!existing.includes(fileId)) {
      existing.push(fileId);
      localStorage.setItem(BLOCKED_UNLINKED_FILE_IDS_KEY, JSON.stringify(existing));
    }
  } catch {}
}

export function removeBlockedUnlinkedFileId(fileId: string): void {
  try {
    if (!fileId) return;
    const remaining = getBlockedUnlinkedFileIds().filter((blockedId) => blockedId !== fileId);
    localStorage.setItem(BLOCKED_UNLINKED_FILE_IDS_KEY, JSON.stringify(remaining));
  } catch {}
}

export function saveLocalMasterPointerFileId(fileId: string | null): void {
  try {
    if (fileId) {
      localStorage.setItem(LOCAL_ACTIVE_FILE_ID_KEY, fileId);
      localStorage.setItem(MASTER_POINTER_FILE_ID_KEY, fileId);
    } else {
      localStorage.removeItem(LOCAL_ACTIVE_FILE_ID_KEY);
      localStorage.removeItem(MASTER_POINTER_FILE_ID_KEY);
    }
  } catch {}
}

export function getLocalMasterPointerState(): MasterSyncState | null {
  try {
    const raw = localStorage.getItem(LOCAL_MASTER_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLocalMasterPointerState(state: MasterSyncState | null): void {
  try {
    if (state) {
      localStorage.setItem(LOCAL_MASTER_STATE_KEY, JSON.stringify(state));
      if (state.activeFileId) {
        saveLocalMasterPointerFileId(state.activeFileId);
      }
    } else {
      localStorage.removeItem(LOCAL_MASTER_STATE_KEY);
    }
  } catch {}
}

/**
 * Đọc cấu hình Master Workspace và phân quyền trực tiếp từ Tab ẩn __CONFIG__ của Google Sheet
 */
export async function readMasterSyncStateFromGoogleSheet(
  accessToken: string,
  fileId: string,
  options: { strict?: boolean } = {}
): Promise<MasterSyncState | null> {
  try {
    if (!accessToken || !fileId) {
      if (options.strict) throw new Error('Thiếu access token hoặc file ID để xác minh File liên kết.');
      return null;
    }

    // 1. Lấy dữ liệu dải ô cấu hình từ tab ẩn __CONFIG__
    const configRange = '__CONFIG__!A1:B1000';
    const res = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(configRange)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (res.status === 404 || res.status === 403) {
      if (options.strict) {
        throw new Error(
          `Không thể xác minh __CONFIG__ của file (HTTP ${res.status}); cần kiểm tra quyền hoặc file còn truy cập được không.`
        );
      }
      return null;
    }

    if (res.ok) {
      const data = await res.json();
      const rows: any[][] = data.values || [];
      if (rows.length === 0 && options.strict) {
        throw new Error('__CONFIG__ tồn tại nhưng không chứa trạng thái File liên kết hợp lệ.');
      }
      if (rows.length > 0) {
        // Đọc danh sách Key-Value từ tab __CONFIG__
        const kvMap = new Map<string, any>();
        let metadataParsed: any = null;
        for (const row of rows) {
          if (row[0] !== undefined) {
            const key = String(row[0]).trim().toLowerCase();
            const val = row[1];
            kvMap.set(key, val);
            if (key === '__metadata_json__' && typeof val === 'string') {
              try {
                metadataParsed = JSON.parse(val);
              } catch {
                if (options.strict) throw new Error('__CONFIG__ chứa metadata không hợp lệ.');
                return null;
              }
            }
          }
        }

        const resolvedStatus = String(metadataParsed?.status || kvMap.get('status') || 'active').trim().toLowerCase();
        const resolvedAction = String(metadataParsed?.lastAction || kvMap.get('last action') || 'link').trim().toLowerCase();
        const resolvedActiveFileId = String(metadataParsed?.activeFileId || kvMap.get('active file id') || fileId).trim();
        const resolvedSchemaVersion = Number(metadataParsed?.schemaVersion ?? kvMap.get('schema version') ?? 1);

        if (
          (resolvedStatus !== 'active' && resolvedStatus !== 'unlinked') ||
          (resolvedActiveFileId && resolvedActiveFileId !== fileId)
        ) {
          if (options.strict) throw new Error('__CONFIG__ không có trạng thái File liên kết hợp lệ.');
          return null;
        }

        let membersList: WorkspaceMember[] = Array.isArray(metadataParsed.members) ? metadataParsed.members : [];
        const rawMembers = kvMap.get('members json') || kvMap.get('members');
        if (typeof rawMembers === 'string') {
          try {
            const p = JSON.parse(rawMembers);
            if (Array.isArray(p) && p.length > 0) membersList = p;
          } catch {}
        }

        let banksConfigList: BankInfo[] | undefined = Array.isArray(metadataParsed.banksConfig) ? metadataParsed.banksConfig : undefined;
        const rawBanks = kvMap.get('banks config json') || kvMap.get('banks config');
        if (typeof rawBanks === 'string') {
          try {
            const p = JSON.parse(rawBanks);
            if (Array.isArray(p) && p.length > 0) banksConfigList = p;
          } catch {}
        }
        let auditLogsList: SyncAuditLogEntry[] | undefined = Array.isArray(metadataParsed.auditLogs) ? metadataParsed.auditLogs : undefined;
        const auditLogChunks = rows
          .map((row) => ({
            key: String(row[0] || '').trim().toLowerCase(),
            value: row[1],
          }))
          .map((row) => {
            const match = row.key.match(/^audit logs json(?:\s+(\d+))?$/);
            return match ? { index: Number(match[1] || 0), value: row.value } : null;
          })
          .filter((row): row is { index: number; value: unknown } =>
            Boolean(row && typeof row.value === 'string')
          )
          .sort((a, b) => a.index - b.index);
        const rawAudit = auditLogChunks.length
          ? auditLogChunks.map((chunk) => chunk.value).join('')
          : kvMap.get('audit logs');
        if (typeof rawAudit === 'string') {
          try {
            const p = JSON.parse(rawAudit);
            if (Array.isArray(p)) auditLogsList = p;
          } catch {}
        }
        const auditSessionId =
          metadataParsed.auditSessionId || kvMap.get('audit session id') || undefined;
        const allAuditLogs = Array.isArray(auditLogsList) ? auditLogsList : [];
        const sessionAuditLogs = auditSessionId
          ? allAuditLogs.filter((log) => log.auditSessionId === auditSessionId)
          : allAuditLogs;

        return {
          status: resolvedStatus as 'active' | 'unlinked',
          lastAction: (resolvedAction || 'link') as MasterSyncState['lastAction'],
          activeFileId: resolvedActiveFileId,
          activeFileName: metadataParsed?.activeFileName || kvMap.get('vault name') || kvMap.get('active file name') || '',
          activeFileUrl: metadataParsed?.activeFileUrl || kvMap.get('active file url') || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          linkedTimestamp: metadataParsed?.linkedTimestamp || kvMap.get('linked timestamp') || '',
          auditSessionId: auditSessionId || '',
          auditSessionStartedAt: metadataParsed?.auditSessionStartedAt || '',
          auditSessionEndedAt: metadataParsed?.auditSessionEndedAt || '',
          linkedLocalTimeVi: metadataParsed?.linkedLocalTimeVi || kvMap.get('linked local time') || '',
          linkedAccountEmail: metadataParsed?.linkedAccountEmail || kvMap.get('linked account') || '',
          adminEmail: metadataParsed?.adminEmail || kvMap.get('admin email') || '',
          schemaVersion: resolvedSchemaVersion,
          updatedAt: metadataParsed?.updatedAt || kvMap.get('updated at') || '',
          updatedAtVi: metadataParsed?.updatedAtVi || '',
          members: membersList,
          auditDevices: (() => {
            const rawDevices = kvMap.get('audit devices json');
            if (typeof rawDevices === 'string') {
              try {
                const parsed = JSON.parse(rawDevices);
                if (Array.isArray(parsed)) return parsed;
              } catch (err) {
                console.warn('[Sheet Config] Không đọc được danh sách thiết bị audit:', err);
              }
            }
            return Array.isArray(metadataParsed.auditDevices) ? metadataParsed.auditDevices : [];
          })(),
          settlements: [],
          banksConfig: banksConfigList || getAllBanks(),
          auditLogs: compactAuditLogsForSheet(allAuditLogs.length ? allAuditLogs : sessionAuditLogs),
        };
      }
    }

    if (!res.ok && options.strict) {
      const errorData = await res.json().catch(() => ({}));
      const errorMessage = String(errorData?.error?.message || '');
      if (
        res.status === 400 &&
        /^unable to parse range:\s*'?__CONFIG__'?!A1:B1000$/i.test(errorMessage.trim())
      ) {
        return null;
      }
      throw new Error(
        errorMessage || `Không thể đọc __CONFIG__ (HTTP ${res.status}).`
      );
    }
    return null;
  } catch (err) {
    console.warn('[Sheet Config] Lỗi đọc tab cấu hình __CONFIG__ từ Google Sheet:', err);
    if (options.strict) throw err;
    return null;
  }
}

export async function assertWorkspaceMembership(
  accessToken: string,
  fileId: string,
  userEmail: string,
  options: { allowUnlinked?: boolean } = {}
): Promise<MasterSyncState | null> {
  const cleanEmail = userEmail.trim().toLowerCase();
  if (!cleanEmail) throw new Error('Không thể xác minh thành viên vì tài khoản Google chưa có email.');

  let master: MasterSyncState | null;
  try {
    master = await readMasterSyncStateFromGoogleSheet(accessToken, fileId, { strict: true });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : '';
    const normalizedMessage = rawMessage.toLowerCase();
    if (
      rawMessage.startsWith('Workspace của file') ||
      rawMessage.startsWith('Tài khoản này không còn') ||
      rawMessage.startsWith('__CONFIG__ tồn tại') ||
      rawMessage.startsWith('__CONFIG__ chứa') ||
      rawMessage.startsWith('__CONFIG__ không có') ||
      rawMessage.startsWith('Không thể xác minh __CONFIG__')
    ) {
      throw err;
    }
    if (
      rawMessage.includes('401') ||
      normalizedMessage.includes('hết hạn') ||
      normalizedMessage.includes('invalid authentication credentials')
    ) {
      throw new Error('Phiên Google Drive đã hết hạn. Vui lòng đăng nhập lại.');
    }
    if (normalizedMessage.includes('insufficient authentication scopes')) {
      throw new Error('Ứng dụng chưa được cấp đủ quyền Google Drive để xác minh File liên kết.');
    }
    if (rawMessage.includes('__CONFIG__')) {
      throw new Error(
        'Không thể xác minh cấu hình File liên kết của file. Tab __CONFIG__ có thể chưa được khởi tạo hoặc chứa dữ liệu không hợp lệ; hãy kiểm tra file hoặc liên hệ Admin.'
      );
    }
    throw new Error(
      'Không thể xác minh File liên kết của file. Hãy kiểm tra kết nối mạng, quyền truy cập file và thử lại.'
    );
  }
  if (!master) return null;
  if (
    !options.allowUnlinked &&
    (master.status !== 'active' ||
     master.activeFileId !== fileId ||
     master.lastAction === 'unlink')
  ) {
    throw new Error('File liên kết không còn hoạt động hoặc đã được hủy liên kết.');
  }

  const adminEmail = (master.adminEmail || '').trim().toLowerCase();
  const member = master.members?.find(
    (entry) => entry.email?.trim().toLowerCase() === cleanEmail
  );
  const validMemberRole =
    member && ['ADMIN', 'EDITOR', 'VIEWER'].includes(String(member.role).toUpperCase())
      ? member.role
      : null;
  if (!options.allowUnlinked) {
    if (cleanEmail !== adminEmail && !validMemberRole) {
      throw new Error('Tài khoản này không còn trong danh sách thành viên của Nhóm thành viên.');
    }
  } else {
    if (adminEmail && cleanEmail !== adminEmail && !validMemberRole && master.members && master.members.length > 0) {
      throw new Error('Tài khoản này không phải Admin hoặc thành viên của Nhóm thành viên này.');
    }
  }
  return master;
}

/**
 * Ghi trạng thái Master Workspace và thông tin thành viên trực tiếp vào Tab ẩn __CONFIG__ của Google Sheet
 */
export async function saveMasterSyncStateToGoogleSheet(
  accessToken: string,
  fileId: string,
  state: MasterSyncState,
  options: { allowCreateConfig?: boolean } = {}
): Promise<boolean> {
  try {
    if (!accessToken || !fileId) return false;

    const effectiveBanksConfig =
      Array.isArray(state.banksConfig) && state.banksConfig.length > 0
        ? state.banksConfig
        : getAllBanks();

    const effectiveAuditLogs = Array.isArray(state.auditLogs)
      ? state.auditLogs
      : state.auditSessionId
      ? getSyncAuditLogsForSession(state.auditSessionId)
      : [];

    const compactAuditLogs = compactAuditLogsForSheet(effectiveAuditLogs);

    const nowIso = state.updatedAt || new Date().toISOString();
    const nowVi = state.updatedAtVi || formatIsoToVietnamTime(nowIso);
    const coreMetadata = {
      schemaVersion: 2,
      status: state.status || 'active',
      lastAction: state.lastAction || 'link',
      activeFileId: state.activeFileId || fileId,
      activeFileName: state.activeFileName || '',
      activeFileUrl: state.activeFileUrl || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
      adminEmail: state.adminEmail || '',
      linkedAccountEmail: state.linkedAccountEmail || '',
      linkedTimestamp: state.linkedTimestamp || '',
      auditSessionId: state.auditSessionId || '',
      auditSessionStartedAt: state.auditSessionStartedAt || '',
      auditSessionEndedAt: state.auditSessionEndedAt || '',
      linkedLocalTimeVi: state.linkedLocalTimeVi || '',
      updatedAt: nowIso,
      updatedAtVi: nowVi,
    };
    const coreMetadataPayload = JSON.stringify(
      Object.fromEntries(
        Object.entries(coreMetadata).filter(([, value]) => value !== undefined && value !== null && value !== '')
      )
    );

    const auditLogsJson = JSON.stringify(compactAuditLogs);
    const auditLogChunks: string[] = [];
    for (let index = 0; index < auditLogsJson.length; index += 30000) {
      auditLogChunks.push(auditLogsJson.slice(index, index + 30000));
    }
    const configRows: Array<[string, string]> = [
      ['__METADATA_JSON__', coreMetadataPayload],
      ['Vault Name', state.activeFileName || ''],
      ['Admin Email', state.adminEmail || ''],
      ['Linked Account', state.linkedAccountEmail || ''],
      ['Status', state.status || 'active'],
      ['Last Action', state.lastAction || 'link'],
      ['Linked Timestamp', state.linkedLocalTimeVi || state.linkedTimestamp || ''],
      ['Audit Session ID', state.auditSessionId || ''],
      ['Updated At', nowVi],
      ['Members JSON', JSON.stringify(state.members || [])],
      ['Banks Config', JSON.stringify(effectiveBanksConfig)],
      ['Audit Devices JSON', JSON.stringify(state.auditDevices || [])],
      ...auditLogChunks.map((chunk, index) => [`Audit Logs JSON ${index + 1}`, chunk] as [string, string]),
    ];
    const values = configRows.filter(
      ([key, value]) => key === '__METADATA_JSON__' || value.trim() !== ''
    );

    // 0. Kiểm tra mimeType file trước: Google Sheets API v4 chỉ hoạt động với native Google Sheets
    const metaCheck = await getRealGoogleDriveFileMetadata(accessToken, fileId);
    if (metaCheck?.mimeType && metaCheck.mimeType !== 'application/vnd.google-apps.spreadsheet') {
      console.info('[Sheet Config] File liên kết là file Office Excel (.xlsx), tự động bỏ qua ghi tab __CONFIG__ qua Sheets API.');
      return true;
    }

    const configSheetMetaRes = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties(sheetId,title,gridProperties(rowCount)))`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (configSheetMetaRes.ok) {
      const configSheetMeta = await configSheetMetaRes.json();
      const configSheetProperties = configSheetMeta.sheets?.find(
        (sheet: { properties?: { title?: string } }) => sheet.properties?.title === '__CONFIG__'
      )?.properties;
      if (
        configSheetProperties?.sheetId !== undefined &&
        (configSheetProperties.gridProperties?.rowCount || 0) < 1000
      ) {
        const resizeConfigRes = await fetchWithRetry(
          `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requests: [{
                updateSheetProperties: {
                  properties: {
                    sheetId: configSheetProperties.sheetId,
                    gridProperties: { rowCount: 1000 },
                  },
                  fields: 'gridProperties.rowCount',
                },
              }],
            }),
          }
        );
        if (!resizeConfigRes.ok) {
          throw new Error(`Không thể mở rộng tab __CONFIG__ để lưu audit log (Mã ${resizeConfigRes.status}).`);
        }
      }
    } else {
      throw new Error(`Không kiểm tra được dung lượng tab __CONFIG__ (Mã ${configSheetMetaRes.status}).`);
    }

    const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values:batchUpdate`;
    const writeData = () => fetchWithRetry(batchUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [
          {
            range: `__CONFIG__!A1:B${values.length}`,
            majorDimension: 'ROWS',
            values: values,
          }
        ]
      }),
    });

    // 1. Thử ghi dữ liệu trực tiếp lên tab __CONFIG__
    let updateRes = await writeData();

    // 2. Nếu thất bại vì tab __CONFIG__ chưa tồn tại, tiến hành tạo mới rồi thử ghi lại
    let errJson: any = null;
    if (!updateRes.ok) {
      errJson = await updateRes.json().catch(() => ({}));
      
      // Chấp nhận mọi lỗi 400 (vì khi chưa có tab __CONFIG__ thì API ghi luôn báo lỗi 400 dải ô không tồn tại độc lập với ngôn ngữ vùng của người dùng)
      if (updateRes.status === 400 && options.allowCreateConfig) {
        console.warn('[Sheet Config] Tab __CONFIG__ chưa tồn tại hoặc dải ô không hợp lệ, tiến hành tạo mới...');
        
        const createRes = await fetchWithRetry(`https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: [
              {
                addSheet: {
                  properties: {
                    title: '__CONFIG__',
                    hidden: true,
                    gridProperties: { rowCount: 1000, columnCount: 5 }
                  }
                }
              }
            ]
          }),
        });

        if (createRes.ok) {
          updateRes = await writeData();
          if (!updateRes.ok) {
            errJson = await updateRes.json().catch(() => ({}));
          }
        }
      }
      if (updateRes.status === 400 && !options.allowCreateConfig) {
        console.warn('[Sheet Config] Từ chối tạo __CONFIG__ tự động vì file chưa được xác thực là File liên kết.');
        return false;
      }
    }

    if (!updateRes.ok) {
      const finalErr = errJson || await updateRes.json().catch(() => ({}));
      console.warn('[Sheet Config] Bỏ qua ghi tab __CONFIG__:', finalErr?.error?.message || 'Ghi tab không khả thi');
      return false;
    }

    const clearLegacyRes = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}/values/${encodeURIComponent(`__CONFIG__!A${values.length + 1}:B1000`)}:clear`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    if (!clearLegacyRes.ok) {
      const errorData = await clearLegacyRes.json().catch(() => ({}));
      console.warn(
        '[Sheet Config] Không thể dọn dữ liệu cấu hình cũ dư thừa:',
        errorData?.error?.message || `Mã ${clearLegacyRes.status}`
      );
    }

    const spreadsheetRes = await fetchWithRetry(
      `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets(properties(sheetId,title,hidden))`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!spreadsheetRes.ok) {
      const errorData = await spreadsheetRes.json().catch(() => ({}));
      console.warn(
        '[Sheet Config] Đã ghi cấu hình nhưng không thể kiểm tra trạng thái ẩn của tab __CONFIG__:',
        errorData?.error?.message || `Mã ${spreadsheetRes.status}`
      );
      return false;
    }

    const spreadsheet = await spreadsheetRes.json();
    const configSheet = spreadsheet.sheets?.find(
      (sheet: { properties?: { title?: string; sheetId?: number; hidden?: boolean } }) =>
        sheet.properties?.title === '__CONFIG__'
    );
    if (!configSheet?.properties || typeof configSheet.properties.sheetId !== 'number') {
      console.warn('[Sheet Config] Không tìm thấy tab __CONFIG__ sau khi ghi cấu hình.');
      return false;
    }

    if (!configSheet.properties.hidden) {
      const hideRes = await fetchWithRetry(
        `https://sheets.googleapis.com/v4/spreadsheets/${fileId}:batchUpdate`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: [
              {
                updateSheetProperties: {
                  properties: {
                    sheetId: configSheet.properties.sheetId,
                    hidden: true,
                  },
                  fields: 'hidden',
                },
              },
            ],
          }),
        }
      );
      if (!hideRes.ok) {
        const errorData = await hideRes.json().catch(() => ({}));
        console.warn(
          '[Sheet Config] Đã ghi cấu hình nhưng không thể ẩn tab __CONFIG__:',
          errorData?.error?.message || `Mã ${hideRes.status}`
        );
        return false;
      }
    }

    return true;
  } catch (err: any) {
    console.warn('[Sheet Config] Lỗi hệ thống khi ghi tab cấu hình:', err);
    return false;
  }
}

function restoreLocalAuditSession(state: MasterSyncState): MasterSyncState {
  if (state.status === 'active' && state.activeFileId) {
    const session = state.auditSessionId
      ? beginSyncAuditSession(
          state.activeFileId,
          state.auditSessionId,
          state.auditSessionStartedAt || state.linkedTimestamp
        )
      : beginSyncAuditSession(state.activeFileId);
    state.auditSessionId = session.id;
    state.auditSessionStartedAt = session.startedAt;
    state.auditSessionEndedAt = undefined;
    state.auditLogs = compactAuditLogsForSheet(Array.isArray(state.auditLogs) ? state.auditLogs : []);
    saveLocalMasterPointerState(state);
  } else if (state.status === 'unlinked' && state.activeFileId) {
    endSyncAuditSession(state.activeFileId);
  }
  return state;
}

/**
 * Nạp trạng thái Master Sync Pointer trực tiếp từ Google Sheet liên kết (hoặc bộ nhớ cục bộ)
 */
export async function getMasterSyncStateFromDrive(
  accessToken: string,
  explicitFileId?: string,
  options: { strict?: boolean } = {}
): Promise<MasterSyncState | null> {
  try {
    const localState = explicitFileId ? null : getLocalMasterPointerState();
    const targetFileId =
      explicitFileId ||
      getLocalMasterPointerFileId() ||
      localState?.activeFileId;
    if (accessToken) {
      if (!targetFileId) return null;
      const sheetState = await readMasterSyncStateFromGoogleSheet(accessToken, targetFileId, {
        strict: options.strict,
      });
      if (sheetState) {
        if (
          sheetState.status === 'active' &&
          sheetState.activeFileId &&
          sheetState.activeFileId === targetFileId
        ) {
          if (!sheetState.auditSessionId) {
            const session = beginSyncAuditSession(targetFileId);
            sheetState.auditSessionId = session.id;
            sheetState.auditSessionStartedAt = session.startedAt;
            sheetState.auditSessionEndedAt = undefined;
            sheetState.auditLogs = compactAuditLogsForSheet(sheetState.auditLogs || []);
            saveLocalMasterPointerState(sheetState);
            const saved = await saveMasterSyncStateToGoogleSheet(accessToken, targetFileId, sheetState);
            if (!saved) {
              console.warn('[Sheet Config] Không thể khởi tạo phiên audit log cho file đang liên kết.');
            }
          } else {
            beginSyncAuditSession(
              targetFileId,
              sheetState.auditSessionId,
              sheetState.auditSessionStartedAt || sheetState.linkedTimestamp
            );
          }
        } else if (sheetState.status === 'unlinked' && sheetState.activeFileId) {
          endSyncAuditSession(sheetState.activeFileId);
        }
        if (sheetState.status === 'active' && sheetState.banksConfig?.length) {
          updateBanksFromRemote(sheetState.banksConfig);
        }
        saveLocalMasterPointerState(sheetState);
        return sheetState;
      }
      return null;
    }

    if (explicitFileId) return null;

    // Chỉ dùng cache local khi không có phiên Drive để đọc nguồn cấu hình hiện hành.
    const cachedState = localState || getLocalMasterPointerState();
    if (cachedState) return restoreLocalAuditSession(cachedState);

    return null;
  } catch (err) {
    console.warn('Error reading master sync pointer from sheet:', err);
    if (options.strict) throw err;
    if (accessToken || explicitFileId) return null;
    const localState = getLocalMasterPointerState();
    return localState ? restoreLocalAuditSession(localState) : null;
  }
}

/**
 * Lấy file ID của file master pointer trên Google Drive (nếu có để dọn dẹp)
 */
export async function getMasterPointerFileId(_accessToken: string): Promise<string | null> {
  return getLocalMasterPointerFileId();
}

/**
 * Lưu trạng thái Master Workspace trực tiếp vào Tab ẩn __CONFIG__ của Google Sheet và đồng bộ quyền Google Drive
 */
export async function saveMasterSyncStateOnDrive(
  accessToken: string,
  state: MasterSyncState,
  options: { allowCreateConfig?: boolean } = {}
): Promise<string | null> {
  try {
    const nowIso = new Date().toISOString();
    const nowVi = formatIsoToVietnamTime(nowIso);
    const existingLocal = getLocalMasterPointerState();
    const effectiveFileId = state.activeFileId || existingLocal?.activeFileId;
    const isLocalUnlink = state.status === 'unlinked' && !state.activeFileId;
    const remoteState =
      effectiveFileId && accessToken
        ? await readMasterSyncStateFromGoogleSheet(accessToken, effectiveFileId)
        : null;

    if (
      effectiveFileId &&
      accessToken &&
      !isLocalUnlink &&
      !remoteState &&
      !options.allowCreateConfig
    ) {
      console.warn(
        `[Sheet Config] Không ghi File liên kết vào file ${effectiveFileId}: chưa có __CONFIG__ hợp lệ.`
      );
      return null;
    }
    if (
      remoteState?.status === 'unlinked' &&
      state.status === 'active' &&
      !options.allowCreateConfig
    ) {
      console.warn(
        `[Sheet Config] Từ chối tự kích hoạt lại file ${effectiveFileId}: __CONFIG__ đang ở trạng thái unlinked.`
      );
      return null;
    }

    const linkedIso =
      state.linkedTimestamp ||
      (state.auditSessionId && remoteState?.auditSessionId === state.auditSessionId
        ? remoteState.linkedTimestamp
        : undefined) ||
      nowIso;
    const linkedVi = state.linkedLocalTimeVi || formatIsoToVietnamTime(linkedIso);

    const mergedMembers =
      state.members !== undefined
        ? state.members
        : remoteState?.members || [];

    const mergedAdminEmail =
      state.adminEmail || remoteState?.adminEmail || state.linkedAccountEmail || 'Google User';

    const mergedBanksConfig =
      state.banksConfig !== undefined && Array.isArray(state.banksConfig) && state.banksConfig.length > 0
        ? state.banksConfig
        : remoteState?.banksConfig && remoteState.banksConfig.length > 0
        ? remoteState.banksConfig
        : getAllBanks();

    const activeSession = getActiveSyncAuditSession();
    const effectiveAuditSessionId =
      state.auditSessionId ||
      (remoteState?.activeFileId === effectiveFileId ? remoteState.auditSessionId : undefined) ||
      (activeSession?.fileId === effectiveFileId ? activeSession.id : undefined);
    const mergedAuditLogs = mergeAuditLogEntries(
      remoteState?.auditLogs,
      Array.isArray(state.auditLogs) ? state.auditLogs : undefined,
      effectiveAuditSessionId && activeSession?.fileId === effectiveFileId
        ? getSyncAuditLogsForSession(effectiveAuditSessionId)
        : undefined,
      getSyncAuditLogs().filter((log) => log.fileId === effectiveFileId)
    );
    const mergedAuditDevices = mergeAuditDevices(
      remoteState?.auditDevices,
      state.auditDevices,
      auditDevicesFromLogs(mergedAuditLogs)
    );

    const preparedState: MasterSyncState = {
      ...remoteState,
      ...state,
      schemaVersion: 2,
      adminEmail: mergedAdminEmail,
      members: mergedMembers,
      banksConfig: mergedBanksConfig,
      auditLogs: mergedAuditLogs,
      auditDevices: mergedAuditDevices,
      linkedTimestamp: linkedIso,
      linkedLocalTimeVi: linkedVi,
      auditSessionId: state.auditSessionId || remoteState?.auditSessionId,
      auditSessionStartedAt: state.auditSessionStartedAt || remoteState?.auditSessionStartedAt,
      auditSessionEndedAt: state.auditSessionEndedAt || remoteState?.auditSessionEndedAt,
      updatedAt: state.updatedAt || nowIso,
      updatedAtVi: nowVi,
    };

    // Kiểm tra vai trò của người dùng hiện tại
    const userEmail = state.linkedAccountEmail || '';
    const userRole = resolveUserRole(userEmail, undefined, mergedMembers, mergedAdminEmail);
    const isViewer = userRole === 'VIEWER';

    // Local pointers are updated only after a valid remote config was read and the write succeeded (hoặc với Viewer thì lưu cục bộ).
    if (preparedState.activeFileId && accessToken) {
      if (isViewer) {
        // THÀNH VIÊN VIEWER: Tuyệt đối không ghi tab __CONFIG__ lên Sheet cũng như không can thiệp quyền Google Drive.
        // Chỉ lưu thông tin liên kết vào bộ nhớ cục bộ để phục vụ đọc dữ liệu và tính toán.
        console.info('[Sheet Config] Người dùng là VIEWER (Chỉ xem). Bỏ qua ghi __CONFIG__ lên Sheet, lưu liên kết vào máy.');
        saveLocalMasterPointerState(preparedState);
        return 'local_pointer_saved';
      }

      const saved = await saveMasterSyncStateToGoogleSheet(
        accessToken,
        preparedState.activeFileId,
        preparedState,
        { allowCreateConfig: options.allowCreateConfig }
      );
      if (!saved) {
        // Nếu không ghi được lên Sheet (ví dụ do tài khoản Google Drive chỉ có quyền xem),
        // tự động chuyển sang lưu trạng thái liên kết cục bộ (Viewer mode) thay vì ngắt và báo lỗi.
        console.warn('[Sheet Config] Không thể ghi tab __CONFIG__ lên Sheet (không có quyền sửa). Chuyển sang lưu liên kết cục bộ (Viewer mode).');
        saveLocalMasterPointerState(preparedState);
        return 'local_pointer_saved';
      }

      saveLocalMasterPointerState(preparedState);
      const permissionSync = await synchronizeDrivePermissionsWithJsonMembers(
        accessToken,
        preparedState.activeFileId,
        preparedState.members || [],
        preparedState.adminEmail
      );
      if (!permissionSync.success) {
        console.error('[Sheet Config] Roster đã lưu nhưng một số quyền Drive chưa đồng bộ.', permissionSync.entries);
      }
    } else {
      saveLocalMasterPointerState(preparedState);
    }

    return 'sheet_config_tab';
  } catch (err) {
    console.warn('Error saving master sync pointer to Sheet Config:', err);
    return null;
  }
}

/**
 * Thiết lập file Google Sheet liên kết hoạt động
 */
export async function setMasterSyncLinked(
  accessToken: string,
  fileId: string,
  userEmail?: string,
  previousFileId?: string,
  fileName?: string,
  fileUrl?: string,
  existingLinkedTimestamp?: string
): Promise<string> {
  const email = userEmail?.trim().toLowerCase();
  if (!email) throw new Error('Cần email tài khoản Google để liên kết File liên kết.');
  const isSwitching = Boolean(previousFileId && previousFileId !== fileId);
  const targetMaster = await readMasterSyncStateFromGoogleSheet(accessToken, fileId, { strict: true });
  if (targetMaster) {
    const verifiedMaster = await assertWorkspaceMembership(accessToken, fileId, email, { allowUnlinked: true });
    if (!verifiedMaster) throw new Error('Không thể xác minh File liên kết trên Google Drive.');
    const role = resolveUserRole(email, undefined, verifiedMaster.members, verifiedMaster.adminEmail);
    if (role !== 'ADMIN') {
      if (role === 'EDITOR' || role === 'VIEWER') {
        saveLocalMasterPointerFileId(fileId);
        saveLocalMasterPointerState(verifiedMaster);
        setExplicitlyUnlinked(false);
        return verifiedMaster.linkedTimestamp || new Date().toISOString();
      }
      throw new Error('Chỉ Admin đã được xác minh mới có thể thay đổi trạng thái liên kết.');
    }
  }
  const continuingSession = Boolean(
    !isSwitching &&
      targetMaster?.status === 'active' &&
      targetMaster.activeFileId === fileId &&
      targetMaster.lastAction !== 'unlink' &&
      targetMaster.auditSessionId
  );

  // 1. Xác định và bảo toàn linkedTimestamp
  let resolvedLinkedTimestamp = continuingSession
    ? existingLinkedTimestamp || targetMaster?.linkedTimestamp
    : undefined;

  // 2. Lấy metadata của file
  let resolvedName = fileName;
  let resolvedUrl = fileUrl;
  let resolvedMime: string | undefined;

  try {
    const meta = await getRealGoogleDriveFileMetadata(accessToken, fileId);
    if (meta) {
      if (!resolvedName) resolvedName = meta.name;
      if (!resolvedUrl) resolvedUrl = meta.webViewLink || `https://docs.google.com/spreadsheets/d/${fileId}/edit`;
      resolvedMime = meta.mimeType;
    }
  } catch {
    // fallback
  }

  if (!resolvedLinkedTimestamp) {
    resolvedLinkedTimestamp = new Date().toISOString();
  }

  try {
    await markDriveFileAsManagedByApp(accessToken, fileId);
  } catch (markerErr) {
    console.warn('[Google Drive] Không thể đánh dấu file là dữ liệu đã liên kết với ứng dụng.', markerErr);
  }

  // Thu hồi quyền của thành viên trên file cũ nếu chuyển sang file mới
  if (isSwitching && previousFileId) {
    try {
      const currentMaster = await getMasterSyncStateFromDrive(accessToken, previousFileId);
      if (
        currentMaster?.status === 'active' &&
        currentMaster.activeFileId === previousFileId &&
        currentMaster.auditSessionId
      ) {
        recordSyncAuditLog({
          type: 'INFO',
          title: 'Kết thúc phiên liên kết',
          status: 'info',
          fileId: previousFileId,
          userEmail: email,
          summary: `Phiên audit kết thúc do chuyển liên kết sang file ${resolvedName || fileId}.`,
        });
        await flushSyncAuditLogWrites();
        const endedAt = new Date().toISOString();
        const previousAuditLogs = combineSyncAuditLogsForSession(
          currentMaster.auditSessionId,
          currentMaster.auditLogs
        );
        const previousClosedState: MasterSyncState = {
          ...currentMaster,
          status: 'unlinked',
          lastAction: 'unlink',
          auditSessionEndedAt: endedAt,
          auditLogs: previousAuditLogs,
          updatedAt: endedAt,
        };
        const saved = await saveMasterSyncStateToGoogleSheet(
          accessToken,
          previousFileId,
          previousClosedState
        );
        if (!saved) {
          console.warn('[Sync Audit] Không thể chốt audit log trên file cũ khi chuyển liên kết.');
        }
        endSyncAuditSession(previousFileId);
      }
      if (currentMaster && currentMaster.members) {
        for (const member of currentMaster.members) {
          if (member.role !== 'ADMIN' && member.email) {
            try {
              await removeWorkspaceFileAssignment(member.email);
            } catch (relayError) {
              console.error(
                `[Workspace Relay] Không thể xóa vé Firestore cũ cho ${member.email} khi đổi file.`,
                relayError
              );
            }
            revokeFilePermission(accessToken, previousFileId, member.email).catch(() => {});
          }
        }
      }
    } catch (revokeErr) {
      console.warn('Failed to revoke previous file permissions on switch:', revokeErr);
    }
  }

  // 3. Cập nhật Master State vào tab ẩn __CONFIG__ của Sheet và bộ nhớ máy
  try {
    const actionType: 'link' | 'switch' | 'create_and_link' = isSwitching ? 'switch' : 'link';
    const session = beginSyncAuditSession(
      fileId,
      continuingSession ? targetMaster?.auditSessionId : undefined,
      continuingSession ? targetMaster?.auditSessionStartedAt || resolvedLinkedTimestamp : resolvedLinkedTimestamp
    );
    let sessionLogs: SyncAuditLogEntry[] = [];
    if (continuingSession) {
      sessionLogs = combineSyncAuditLogsForSession(session.id, targetMaster?.auditLogs);
    } else {
      recordSyncAuditLog({
        type: 'INFO',
        title: 'Bắt đầu phiên liên kết',
        status: 'info',
        userEmail: email,
        sheetName: resolvedName || 'Bảng tính tiết kiệm',
        summary: `Bắt đầu ghi audit log cho file "${resolvedName || 'Bảng tính tiết kiệm'}".`,
      });
    }
    sessionLogs = mergeAuditLogEntries(
      targetMaster?.auditLogs,
      getSyncAuditLogs().filter((log) => log.fileId === fileId)
    );
    const finalMembers = targetMaster?.members || [];
    const finalAdminEmail = targetMaster?.adminEmail || email.toLowerCase();

    if (
      resolvedMime &&
      resolvedMime !== 'application/vnd.google-apps.spreadsheet'
    ) {
      recordSyncAuditLog({
        type: 'SYNC_ERROR',
        title: 'Không hỗ trợ audit từng ô cho file Excel',
        status: 'warning',
        fileId,
        userEmail: email,
        sheetName: resolvedName || 'Bảng tính tiết kiệm',
        summary: 'Audit đầy đủ ô A:AC chỉ áp dụng cho Google Sheets; file Excel không có snapshot audit trên cloud.',
        details: { stage: 'link_baseline', reason: 'unsupported_file_type', mimeType: resolvedMime },
      });
    } else {
      try {
        await initializeMasterDataAuditSnapshot(accessToken, fileId, !continuingSession);
      } catch (auditInitError: any) {
        recordSyncAuditLog({
          type: 'SYNC_ERROR',
          title: 'Không khởi tạo được mốc audit master',
          status: 'error',
          fileId,
          userEmail: email,
          sheetName: resolvedName || 'Bảng tính tiết kiệm',
          summary: `Không thể tạo snapshot ban đầu: ${auditInitError?.message || auditInitError}`,
          errorMessage: auditInitError?.message,
          details: { stage: 'link_baseline', auditGapPossible: true },
        });
        if (resolveUserRole(email, undefined, finalMembers, finalAdminEmail) !== 'VIEWER') {
          throw new Error(`Không thể bắt đầu audit an toàn cho file đã liên kết: ${auditInitError?.message || auditInitError}`);
        }
      }
    }

    const saved = await saveMasterSyncStateOnDrive(accessToken, {
      status: 'active',
      lastAction: actionType,
      activeFileId: fileId,
      activeFileName: resolvedName || 'Bảng tính tiết kiệm',
      activeFileUrl: resolvedUrl || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
      mimeType: resolvedMime || 'application/vnd.google-apps.spreadsheet',
      linkedTimestamp: resolvedLinkedTimestamp,
      auditSessionId: session.id,
      auditSessionStartedAt: session.startedAt,
      auditSessionEndedAt: undefined,
      auditLogs: sessionLogs,
      auditDevices: mergeAuditDevices(
        targetMaster?.auditDevices,
        auditDevicesFromLogs(sessionLogs)
      ),
      linkedAccountEmail: email,
      adminEmail: finalAdminEmail,
      members: finalMembers,
      updatedAt: new Date().toISOString(),
    }, { allowCreateConfig: true });
    if (!saved) {
      throw new Error('Không thể ghi trạng thái liên kết vào __CONFIG__ của file đã chọn.');
    }

  } catch (saveErr) {
    console.warn('Failed to update master sync state on Sheet Config:', saveErr);
    if (!continuingSession) endSyncAuditSession(fileId);
    throw saveErr;
  }

  const existingMembers = targetMaster?.members || [];
  if (existingMembers.length > 0) {
    try {
      await publishWorkspaceFileToMembers(
        fileId,
        resolvedName || targetMaster?.activeFileName || 'Sổ tiết kiệm',
        targetMaster?.adminEmail || email,
        existingMembers
      );
    } catch (relayError) {
      console.error('[Workspace Relay] File đã liên kết nhưng không phát hành được vé cho thành viên.', relayError);
      throw new Error(
        `File đã được liên kết nhưng không gửi được file ID cho thành viên qua Firestore: ${
          relayError instanceof Error ? relayError.message : 'Lỗi không xác định.'
        }`
      );
    }
  }

  return resolvedLinkedTimestamp;
}

/**
 * Cập nhật updatedAt trên Tab __CONFIG__ của Sheet sau mỗi lần đồng bộ dữ liệu thành công
 */
export async function touchMasterSyncStateOnDrive(
  accessToken: string,
  fileId: string,
  userEmail?: string,
  knownLinkedTimestamp?: string,
  fileName?: string,
  fileUrl?: string
): Promise<void> {
  try {
    const currentMaster = await getMasterSyncStateFromDrive(accessToken, fileId);
    const nowIso = new Date().toISOString();

    if (currentMaster && (currentMaster.status === 'unlinked' || currentMaster.lastAction === 'unlink')) {
      return;
    }

    if (currentMaster && (currentMaster.activeFileId === fileId || !currentMaster.activeFileId)) {
      await saveMasterSyncStateOnDrive(accessToken, {
        ...currentMaster,
        status: 'active',
        lastAction: currentMaster.lastAction === 'unlink' ? 'link' : (currentMaster.lastAction || 'link'),
        activeFileId: fileId,
        activeFileName: currentMaster.activeFileName || fileName || 'Bảng tính tiết kiệm',
        activeFileUrl: currentMaster.activeFileUrl || fileUrl || `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
        linkedTimestamp: currentMaster.linkedTimestamp || knownLinkedTimestamp || nowIso,
        linkedAccountEmail: userEmail || currentMaster.linkedAccountEmail || 'Google User',
        updatedAt: nowIso,
      });
    }
  } catch (err) {
    console.warn('Failed to touch master sync state on Sheet Config:', err);
  }
}

/**
 * Cập nhật trạng thái 'unlinked' khi người dùng hủy liên kết và thu hồi quyền Google Drive của các thành viên
 */
export async function setMasterSyncUnlinked(
  accessToken: string,
  userEmail?: string,
  explicitFileId?: string
): Promise<string[]> {
  const targetFileId = explicitFileId || getLocalMasterPointerFileId();

  // Luôn luôn giải phóng con trỏ cục bộ và ghi nhận explicitly unlinked để không bao giờ bị kẹt
  saveLocalMasterPointerFileId(null);
  saveLocalMasterPointerState(null);
  if (targetFileId) {
    endSyncAuditSession(targetFileId);
    addBlockedUnlinkedFileId(targetFileId);
  }
  setExplicitlyUnlinked(true);

  if (!accessToken || !targetFileId) {
    return [];
  }

  const permissionFailures: string[] = [];

  try {
    const currentMaster = await getMasterSyncStateFromDrive(accessToken, targetFileId);
    if (!currentMaster) {
      console.info('[Sheet Config] File không có tab __CONFIG__ hoặc không thể đọc cấu hình Drive; đã hủy liên kết cục bộ thành công.');
      return [];
    }

    const cleanUser = userEmail?.trim().toLowerCase();
    const adminEmailVal = currentMaster.adminEmail || currentMaster.linkedAccountEmail;
    const adminEmailClean = adminEmailVal?.trim().toLowerCase();
    const isAdmin = !adminEmailClean || !cleanUser || cleanUser === adminEmailClean;

    // Nếu người hủy là Admin (hoặc người tạo), tiến hành ghi nhận status unlinked lên Sheet và thu hồi quyền các thành viên
    if (isAdmin && currentMaster.status !== 'unlinked' && currentMaster.lastAction !== 'unlink') {
      const activeAuditSession = getActiveSyncAuditSession();
      const auditSessionId =
        currentMaster.auditSessionId ||
        (activeAuditSession?.fileId === targetFileId ? activeAuditSession.id : undefined);
      if (auditSessionId) {
        recordSyncAuditLog({
          type: 'INFO',
          title: 'Hủy liên kết file',
          status: 'info',
          fileId: targetFileId,
          userEmail,
          summary: 'Kết thúc phiên audit khi hủy liên kết Google Drive.',
        });
        await flushSyncAuditLogWrites();
      }
      const auditSessionEndedAt = new Date().toISOString();
      const finalAuditLogs = mergeAuditLogEntries(
        currentMaster.auditLogs,
        getSyncAuditLogsForSession(auditSessionId || ''),
        getSyncAuditLogs().filter((log) => log.fileId === targetFileId)
      );
      const unlinkedState: MasterSyncState = {
        ...currentMaster,
        status: 'unlinked',
        lastAction: 'unlink',
        activeFileId: targetFileId,
        activeFileName: '',
        activeFileUrl: '',
        linkedTimestamp: auditSessionEndedAt,
        auditSessionId,
        auditSessionEndedAt,
        auditLogs: finalAuditLogs,
        auditDevices: mergeAuditDevices(
          currentMaster.auditDevices,
          auditDevicesFromLogs(finalAuditLogs)
        ),
        linkedAccountEmail: userEmail,
        adminEmail: adminEmailVal,
        updatedAt: auditSessionEndedAt,
      };

      try {
        await saveMasterSyncStateToGoogleSheet(accessToken, targetFileId, unlinkedState);
      } catch (saveErr) {
        console.warn('[Sheet Config] Không thể ghi trạng thái unlinked lên Sheet:', saveErr);
      }

      for (const member of currentMaster.members || []) {
        if (member.role !== 'ADMIN' && member.email) {
          try {
            await removeWorkspaceFileAssignment(member.email);
          } catch (relayError) {
            console.error(
              `[Workspace Relay] Không thể xóa vé Firestore khi hủy liên kết cho ${member.email}.`,
              relayError
            );
          }
          try {
            const revoked = await revokeFilePermission(accessToken, targetFileId, member.email);
            if (!revoked) permissionFailures.push(member.email);
          } catch (pErr) {
            console.warn(`[Drive Permission] Lỗi thu hồi quyền của ${member.email}:`, pErr);
            permissionFailures.push(member.email);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Sheet Config] Ngoại lệ khi cập nhật trạng thái hủy liên kết trên Drive (đã hủy cục bộ):', err);
  }

  // Đảm bảo con trỏ cục bộ hoàn toàn giải phóng
  saveLocalMasterPointerFileId(null);
  saveLocalMasterPointerState(null);
  if (targetFileId) {
    endSyncAuditSession(targetFileId);
  }
  setExplicitlyUnlinked(true);
  return permissionFailures;
}

async function listGoogleSheetsVisibleToApp(
  accessToken: string
): Promise<Array<{
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
  sharedWithMeTime?: string;
}>> {
  const fileMap = new Map<
    string,
    {
      id: string;
      name: string;
      mimeType: string;
      webViewLink?: string;
      modifiedTime?: string;
      appProperties?: Record<string, string>;
      sharedWithMeTime?: string;
    }
  >();
  const queryErrors: string[] = [];

  const executeDriveQuery = async (query: string): Promise<void> => {
    let pageToken: string | undefined;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('pageSize', '100');
      url.searchParams.set(
        'fields',
        'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime,appProperties,sharedWithMeTime)'
      );
      url.searchParams.set('orderBy', 'modifiedTime desc');
      url.searchParams.set('spaces', 'drive');
      url.searchParams.set('q', query);
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const response = await fetchWithRetry(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        if (response.status === 401) {
          setGoogleAccessToken(null);
          throw new Error('Phiên đăng nhập Google đã hết hạn. Vui lòng xác thực lại.');
        }
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData?.error?.message || `Google Drive API trả về HTTP ${response.status}.`
        );
      }

      const data = await response.json();
      for (const f of data.files || []) {
        if (f.id && !fileMap.has(f.id)) {
          fileMap.set(f.id, {
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            webViewLink: f.webViewLink,
            modifiedTime: f.modifiedTime,
            appProperties: f.appProperties,
            sharedWithMeTime: f.sharedWithMeTime,
          });
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  };

  // 1. Tìm các tệp được chia sẻ với tôi (sharedWithMe = true)
  try {
    const sharedQuery = `trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and sharedWithMe = true`;
    await executeDriveQuery(sharedQuery);
  } catch (err) {
    queryErrors.push(err instanceof Error ? err.message : 'Lỗi khi tìm file được chia sẻ.');
    console.warn('[Google Drive] Lỗi quét bảng tính sharedWithMe:', err);
  }

  // 2. Tìm tất cả bảng tính Google Sheets trong Drive của người dùng
  try {
    const generalQuery = `trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet'`;
    await executeDriveQuery(generalQuery);
  } catch (err) {
    queryErrors.push(err instanceof Error ? err.message : 'Lỗi khi tìm bảng tính trên Drive.');
    console.warn('[Google Drive] Lỗi quét bảng tính Google Sheets trong Drive:', err);
  }

  // 3. Dò tìm các tệp có gắn nhãn nhận diện ứng dụng (appProperties)
  try {
    const taggedQuery =
      `trashed = false and mimeType = 'application/vnd.google-apps.spreadsheet' and ` +
      `(appProperties has { key='${SAVINGS_APP_DISCOVERY_PROPERTY_KEY}' and value='${SAVINGS_APP_ID}' } or ` +
      `appProperties has { key='${SAVINGS_APP_PROPERTY_KEY}' and value='${SAVINGS_APP_ID}' } or ` +
      `appProperties has { key='${SAVINGS_APP_LINKED_PROPERTY_KEY}' and value='${SAVINGS_APP_ID}' } or ` +
      `appProperties has { key='app_label' and value='${SAVINGS_APP_ID}' })`;
    await executeDriveQuery(taggedQuery);
  } catch (err) {
    queryErrors.push(err instanceof Error ? err.message : 'Lỗi khi tìm file có nhãn ứng dụng.');
    console.warn('[Google Drive] Lỗi quét bảng tính có appProperties:', err);
  }

  const allFiles = Array.from(fileMap.values());
  if (allFiles.length === 0 && queryErrors.length > 0) {
    throw new Error(queryErrors[0]);
  }
  allFiles.sort((a, b) => {
    const timeA = new Date(a.modifiedTime || 0).getTime();
    const timeB = new Date(b.modifiedTime || 0).getTime();
    return timeB - timeA;
  });
  return allFiles;
}

/**
 * Tự động tìm File liên kết chỉ từ tab __CONFIG__ đã liên kết trên Google Sheets.
 */
export type CentralHubDiscoveryResult =
  | {
      status: 'found';
      hub: {
        id: string;
        name: string;
        webViewLink?: string;
        mimeType?: string;
        linkedTimestamp?: string;
        role?: UserRole;
        relayAssignment?: boolean;
      };
    }
  | { status: 'none' }
  | {
      status: 'multiple';
      recommendedHub?: {
        id: string;
        name: string;
        webViewLink?: string;
        mimeType?: string;
        linkedTimestamp?: string;
        role?: UserRole;
        relayAssignment?: boolean;
      };
      hubs: Array<{
        id: string;
        name: string;
        webViewLink?: string;
        mimeType?: string;
        linkedTimestamp?: string;
        role?: UserRole;
        relayAssignment?: boolean;
      }>;
    }
  | {
      status: 'error';
      message: string;
      candidates?: Array<{ id: string; name: string; webViewLink?: string; mimeType?: string; linkedTimestamp?: string }>;
    };

export async function autoDiscoverLatestCentralHub(
  accessToken: string,
  userEmail?: string
): Promise<CentralHubDiscoveryResult> {
  const explicitlyUnlinked = isExplicitlyUnlinked();
  const cleanUserEmail = userEmail?.trim().toLowerCase();
  if (!cleanUserEmail) {
    return { status: 'error', message: 'Không xác định được email để kiểm tra thành viên Nhóm thành viên.' };
  }

  try {
    let assignment: Awaited<ReturnType<typeof readWorkspaceFileAssignment>> = null;
    if (!explicitlyUnlinked) {
      try {
        assignment = await readWorkspaceFileAssignment(cleanUserEmail);
      } catch (relayError) {
        console.info(
          '[Workspace Relay] Không đọc được vé chuyển tiếp; tiếp tục dò file liên kết qua Google Drive.',
          relayError
        );
      }
    }

    if (assignment) {
      const blockedIds = explicitlyUnlinked ? [] : getBlockedUnlinkedFileIds();
      if (blockedIds.includes(assignment.assignedFileId)) {
        assignment = null;
      }
    }

    if (assignment) {
      const metadata = await getRealGoogleDriveFileMetadata(accessToken, assignment.assignedFileId);
      if (!metadata || metadata.isDeleted) {
        throw new Error('File được gán qua Firestore không tồn tại hoặc đã bị đưa vào thùng rác.');
      }
      if (metadata.mimeType !== 'application/vnd.google-apps.spreadsheet') {
        throw new Error('File được gán qua Firestore không phải Google Sheets.');
      }

      const masterState = await readMasterSyncStateFromGoogleSheet(
        accessToken,
        assignment.assignedFileId,
        { strict: true }
      );
      const configuredAdminEmail = (masterState?.adminEmail || '').trim().toLowerCase();
      const assignmentAdminEmail = (assignment.adminEmail || '').trim().toLowerCase();
      const resolvedRole = resolveUserRole(
        cleanUserEmail,
        undefined,
        masterState?.members,
        configuredAdminEmail
      );
      if (
        !masterState ||
        masterState.status !== 'active' ||
        (masterState.activeFileId && masterState.activeFileId !== assignment.assignedFileId) ||
        masterState.lastAction === 'unlink' ||
        (assignmentAdminEmail && configuredAdminEmail && configuredAdminEmail !== assignmentAdminEmail) ||
        !['ADMIN', 'EDITOR', 'VIEWER'].includes(resolvedRole)
      ) {
        throw new Error('File được gán không còn hoạt động hoặc tài khoản không thuộc Nhóm thành viên.');
      }

      let discoveryTagWritten = false;
      try {
        await markDriveFileAsManagedByApp(accessToken, assignment.assignedFileId);
        discoveryTagWritten = true;
      } catch (tagError) {
        console.warn(
          '[Workspace Relay] Đã xác minh file qua Sheets API nhưng chưa ghi được nhãn Drive.',
          tagError
        );
      }

      saveLocalMasterPointerFileId(assignment.assignedFileId);
      saveLocalMasterPointerState(masterState);
      setExplicitlyUnlinked(false);
      removeBlockedUnlinkedFileId(assignment.assignedFileId);

      // Luôn dọn dẹp vé Firestore sau khi đã xác thực và liên kết thành công
      try {
        await removeWorkspaceFileAssignment(cleanUserEmail);
      } catch (cleanupErr) {
        console.warn('[Workspace Relay] Không thể dọn dẹp bản ghi Firestore sau khi auto-discover thành công:', cleanupErr);
      }

      return {
        status: 'found',
        hub: {
          id: assignment.assignedFileId,
          name:
            metadata.name ||
            masterState.activeFileName ||
            assignment.assignedFileName ||
            'Sổ tiết kiệm',
          mimeType: metadata.mimeType,
          webViewLink:
            metadata.webViewLink ||
            masterState.activeFileUrl ||
            `https://docs.google.com/spreadsheets/d/${assignment.assignedFileId}/edit`,
          linkedTimestamp: masterState.linkedTimestamp,
          role: resolvedRole,
          relayAssignment: discoveryTagWritten,
        },
      };
    }

    const blockedIds = explicitlyUnlinked ? [] : getBlockedUnlinkedFileIds();
    const driveFiles = (await listGoogleSheetsVisibleToApp(accessToken)).filter(
      (f) => !blockedIds.includes(f.id)
    );

    // 1. Lọc trước các file có gắn nhãn com.tietkiemgiadinh.app để giảm tối đa phạm vi đọc sheet config
    // TUYỆT ĐỐI LOẠI BỎ CÁC FILE CÓ TÊN MẶC ĐỊNH TEST (như So_tiet_kiem_2026)
    const labeledCandidates = driveFiles.filter((f) => isFileLabeledWithApp(f) && !isDefaultTestName(f.name));

    // Scan labeled files first, then use likely workspace names as fallback candidates.
    const labeledIds = new Set(labeledCandidates.map((file) => file.id));
    const savingsPattern = /tiet[_\s-]?kiem|savings/i;
    const namedFallbackCandidates = driveFiles
      .filter(
        (file) =>
          !labeledIds.has(file.id) &&
          savingsPattern.test(file.name || '') &&
          !isDefaultTestName(file.name)
      )
      .slice(0, 10);
    const candidateFiles = [...labeledCandidates, ...namedFallbackCandidates];

    const activeWorkspaces: Array<{
      file: { id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string };
      state: MasterSyncState;
    }> = [];
    const scanErrors: string[] = [];
    let driveSessionExpired = false;
    let missingDriveScope = false;
    let nextFileIndex = 0;

    const scanFile = async () => {
      while (nextFileIndex < candidateFiles.length) {
        const file = candidateFiles[nextFileIndex++];
        if (!file.id || isDefaultTestName(file.name)) continue;
        try {
          const metadataUrl = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}`);
          metadataUrl.searchParams.set('fields', 'sheets(properties(title))');
          const metadataResponse = await fetchWithRetry(metadataUrl, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!metadataResponse.ok) {
            const data = await metadataResponse.json().catch(() => ({}));
            throw new Error(
              data?.error?.message || `Không thể kiểm tra cấu hình (HTTP ${metadataResponse.status}).`
            );
          }
          const spreadsheetMetadata = await metadataResponse.json();
          if (
            !spreadsheetMetadata.sheets?.some(
              (sheet: { properties?: { title?: string } }) =>
                sheet.properties?.title === '__CONFIG__'
            )
          ) {
            continue;
          }

          const masterState = await readMasterSyncStateFromGoogleSheet(
            accessToken,
            file.id,
            { strict: true }
          );
          if (
            masterState?.status === 'active' &&
            masterState.activeFileId === file.id &&
            masterState.lastAction !== 'unlink' &&
            !isDefaultTestName(masterState.activeFileName)
          ) {
            const configuredAdminEmail = (masterState.adminEmail || '').trim().toLowerCase();
            const isAdmin = configuredAdminEmail === cleanUserEmail;
            const isListedMember = masterState.members?.some(
              (member) =>
                member.email?.trim().toLowerCase() === cleanUserEmail &&
                ['ADMIN', 'EDITOR', 'VIEWER'].includes(String(member.role).toUpperCase())
            );
            if (isAdmin || isListedMember) {
              activeWorkspaces.push({ file, state: masterState });
            }
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : 'Lỗi không xác định';
          if (
            reason.includes('401') ||
            reason.includes('hết hạn') ||
            reason.includes('invalid authentication credentials')
          ) {
            driveSessionExpired = true;
          } else if (reason.toLowerCase().includes('insufficient authentication scopes')) {
            missingDriveScope = true;
          } else {
            scanErrors.push(
              `${file.name || 'Một bảng tính Google Sheets'}: ${reason}`
            );
          }
          console.warn(`[Central Hub Sync] Không thể xác minh cấu hình File liên kết của file ${file.id}.`, err);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(5, candidateFiles.length) }, () => scanFile())
    );

    if (driveSessionExpired) {
      return {
        status: 'error',
        message: 'Phiên Google Drive đã hết hạn. Vui lòng đăng nhập lại rồi thử dò File liên kết.',
      };
    }

    if (missingDriveScope) {
      return {
        status: 'error',
        message: 'Ứng dụng chưa được cấp đủ quyền Google Drive để dò File liên kết. Vui lòng đăng nhập lại và cấp quyền Drive.',
      };
    }

    if (scanErrors.length) {
      console.warn(`[Central Hub Sync] Một số bảng tính không đọc được __CONFIG__: ${scanErrors.join(', ')}`);
    }

    // Lọc bỏ HOÀN TOÀN bất kỳ file test mặc định nào
    const validWorkspaces = activeWorkspaces.filter(
      (w) => !isDefaultTestName(w.file.name) && !isDefaultTestName(w.state.activeFileName)
    );
    const reconnectableWorkspaces = explicitlyUnlinked
      ? validWorkspaces.filter(({ state }) => {
          const configuredAdminEmail = (
            state.adminEmail ||
            state.linkedAccountEmail ||
            ''
          ).trim().toLowerCase();
          return (
            configuredAdminEmail !== cleanUserEmail &&
            state.members?.some(
              (member) =>
                member.email?.trim().toLowerCase() === cleanUserEmail &&
                ['EDITOR', 'VIEWER'].includes(String(member.role).toUpperCase())
            )
          );
        })
      : validWorkspaces;

    if (reconnectableWorkspaces.length === 0) {
      if (scanErrors.length > 0) {
        return {
          status: 'error',
          message: `Không thể xác minh cấu hình __CONFIG__ trên Drive: ${scanErrors
            .slice(0, 3)
            .join('; ')}${scanErrors.length > 3 ? `; và ${scanErrors.length - 3} file khác` : ''}.`,
        };
      }
      return { status: 'none' };
    }

    // SẮP XẾP ƯU TIÊN THEO NGUỒN TIN CẬY NHẤT LÀ SHEET CONFIG:
    const localFileId = getLocalMasterPointerFileId();
    reconnectableWorkspaces.sort((a, b) => {
      // 1. File đã được liên kết trước đó trên thiết bị này
      if (localFileId) {
        if (a.file.id === localFileId) return -1;
        if (b.file.id === localFileId) return 1;
      }

      // 2. Ưu tiên file có cấu hình danh sách thành viên thực tế trong __CONFIG__
      const aMembersCount = a.state.members?.length || 0;
      const bMembersCount = b.state.members?.length || 0;
      if (aMembersCount > 0 && bMembersCount === 0) return -1;
      if (aMembersCount === 0 && bMembersCount > 0) return 1;

      // 3. Ưu tiên file mà user hiện tại được cấu hình rõ ràng trong members
      const aHasUser = a.state.members?.some((m) => m.email?.trim().toLowerCase() === cleanUserEmail);
      const bHasUser = b.state.members?.some((m) => m.email?.trim().toLowerCase() === cleanUserEmail);
      if (aHasUser && !bHasUser) return -1;
      if (!aHasUser && bHasUser) return 1;

      // 4. Căn cứ vào thông tin từ sheet config là nguồn tin cậy nhất:
      // So sánh thời gian updatedAt / linkedTimestamp từ chính tab __CONFIG__
      const timeA = new Date(a.state.updatedAt || a.state.linkedTimestamp || 0).getTime();
      const timeB = new Date(b.state.updatedAt || b.state.linkedTimestamp || 0).getTime();
      return timeB - timeA;
    });

    if (reconnectableWorkspaces.length > 1) {
      const topWorkspace = reconnectableWorkspaces[0];
      const recommendedHub = {
        id: topWorkspace.file.id,
        name: topWorkspace.state.activeFileName || topWorkspace.file.name || 'Sổ tiết kiệm',
        mimeType: topWorkspace.file.mimeType,
        role: resolveUserRole(cleanUserEmail, undefined, topWorkspace.state.members, topWorkspace.state.adminEmail),
        webViewLink:
          topWorkspace.state.activeFileUrl ||
          topWorkspace.file.webViewLink ||
          `https://docs.google.com/spreadsheets/d/${topWorkspace.file.id}/edit`,
        linkedTimestamp: topWorkspace.state.linkedTimestamp,
      };
      return {
        status: 'multiple',
        recommendedHub,
        hubs: reconnectableWorkspaces.map(({ file, state }) => ({
          id: file.id,
          name: state.activeFileName || file.name || 'Sổ tiết kiệm',
          mimeType: file.mimeType,
          webViewLink:
            state.activeFileUrl ||
            file.webViewLink ||
            `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
          linkedTimestamp: state.linkedTimestamp,
          role: resolveUserRole(cleanUserEmail, undefined, state.members, state.adminEmail),
        })),
      };
    }

    const { file, state } = reconnectableWorkspaces[0];
    if (state.banksConfig?.length) updateBanksFromRemote(state.banksConfig);
    saveLocalMasterPointerFileId(file.id);
    saveLocalMasterPointerState(state);
    setExplicitlyUnlinked(false);
    removeBlockedUnlinkedFileId(file.id);
    return {
      status: 'found',
      hub: {
        id: file.id,
        name: state.activeFileName || file.name || 'Sổ tiết kiệm',
        mimeType: file.mimeType,
        role: resolveUserRole(cleanUserEmail, undefined, state.members, state.adminEmail),
        webViewLink:
          state.activeFileUrl ||
          file.webViewLink ||
          `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
        linkedTimestamp: state.linkedTimestamp,
      },
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : '';
    const normalizedMessage = rawMessage.toLowerCase();
    const message =
      rawMessage.includes('401') ||
      normalizedMessage.includes('hết hạn') ||
      normalizedMessage.includes('invalid authentication credentials')
        ? 'Phiên Google Drive đã hết hạn. Vui lòng đăng nhập lại rồi thử dò File liên kết.'
        : normalizedMessage.includes('insufficient authentication scopes') ||
            normalizedMessage.includes('drive.file')
          ? 'Ứng dụng chưa được cấp đủ quyền Google Drive để dò File liên kết. Vui lòng đăng nhập lại và cấp quyền Drive.'
        : rawMessage ||
          'Không thể đọc danh sách Google Sheets trên Drive. Vui lòng kiểm tra kết nối mạng và quyền truy cập, sau đó thử lại.';
    console.warn('Error auto-discovering central hub from Drive:', err);
    return { status: 'error', message };
  }
}

async function revokeFilePermissionFromAllPages(
  accessToken: string,
  fileId: string,
  cleanEmail: string
): Promise<boolean> {
  const matches: Array<{ id: string; role?: string }> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`);
    url.searchParams.set('fields', 'nextPageToken,permissions(id,emailAddress,role,type)');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      console.warn(`Failed to list permissions for file ${fileId}: HTTP ${response.status}`);
      return false;
    }
    const page = await response.json();
    for (const permission of page.permissions || []) {
      if (
        permission.type === 'user' &&
        permission.emailAddress?.trim().toLowerCase() === cleanEmail &&
        permission.role !== 'owner' &&
        permission.id
      ) {
        matches.push({ id: permission.id, role: permission.role });
      }
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  for (const permission of matches) {
    const response = await fetchWithRetry(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permission.id}?supportsAllDrives=true`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (!response.ok && response.status !== 204) {
      console.warn(`Failed to revoke permission for ${cleanEmail}: HTTP ${response.status}`);
      return false;
    }
  }
  return true;
}

/**
 * Thu hồi quyền Google Drive của một email thành viên cụ thể
 */
export async function revokeFilePermission(
  accessToken: string,
  fileId: string,
  userEmail: string
): Promise<boolean> {
  try {
    if (!fileId || !userEmail) return false;
    const cleanEmail = userEmail.trim().toLowerCase();
    return await revokeFilePermissionFromAllPages(accessToken, fileId, cleanEmail);
  } catch (err) {
    console.warn(`Error in revokeFilePermission for ${userEmail} on file ${fileId}:`, err);
    return false;
  }
}

/**
 * Xóa thành viên khỏi danh sách và thu hồi quyền Google Drive
 */
export async function removeMemberFromDriveMaster(
  accessToken: string,
  memberEmailToRemove: string
): Promise<void> {
  try {
    const currentMaster = await getMasterSyncStateFromDrive(accessToken);
    if (!currentMaster || !currentMaster.members) return;

    const cleanTarget = memberEmailToRemove.trim().toLowerCase();
    const updatedMembers = currentMaster.members.filter(
      (m) => m.email.trim().toLowerCase() !== cleanTarget
    );

    await saveMasterSyncStateOnDrive(accessToken, {
      ...currentMaster,
      members: updatedMembers,
      updatedAt: new Date().toISOString(),
    });

    // Thu hồi quyền truy cập Drive trên Google Sheet liên kết
    if (currentMaster.activeFileId) {
      await revokeFilePermission(accessToken, currentMaster.activeFileId, cleanTarget).catch(() => {});
    }
  } catch (err) {
    console.warn('Lỗi khi xóa thành viên khỏi Master State:', err);
  }
}

/**
 * Cập nhật vai trò (Role) của thành viên trên Google Drive và lưu vào Tab __CONFIG__
 */
export async function updateMemberRoleOnDrive(
  accessToken: string,
  fileId: string,
  userEmail: string,
  newRole: 'EDITOR' | 'VIEWER'
): Promise<boolean> {
  try {
    if (!fileId || !userEmail) return false;
    const cleanEmail = userEmail.trim().toLowerCase();
    const driveRole = newRole === 'EDITOR' ? 'writer' : 'reader';

    // 1. Thu hồi quyền cũ để tránh xung đột vai trò
    await revokeFilePermission(accessToken, fileId, cleanEmail);

    // 2. Cấp quyền mới tương ứng
    const shareSuccess = await shareFileWithUserEmail(accessToken, fileId, cleanEmail, driveRole);

    // 3. Cập nhật role vào danh sách members trong tab __CONFIG__
    try {
      const currentMaster = await getMasterSyncStateFromDrive(accessToken, fileId);
      if (currentMaster && currentMaster.members) {
        const updatedMembers = currentMaster.members.map((m) =>
          m.email.trim().toLowerCase() === cleanEmail ? { ...m, role: newRole } : m
        );
        await saveMasterSyncStateOnDrive(accessToken, {
          ...currentMaster,
          members: updatedMembers,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch {}

    return shareSuccess;
  } catch (err) {
    console.warn(`Lỗi khi cập nhật role cho ${userEmail} trên Google Drive:`, err);
    return false;
  }
}

/**
 * Grant Google Drive file permissions to a specific email address (e.g., 'reader' or 'writer')
 */
export async function shareFileWithUserEmail(
  accessToken: string,
  fileId: string,
  userEmail: string,
  role: 'reader' | 'writer'
): Promise<boolean> {
  try {
    if (!fileId || !userEmail) return false;
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`;
    const response = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        role,
        type: 'user',
        emailAddress: userEmail,
      }),
    });
    return response.ok;
  } catch (err) {
    console.warn('Failed to share Google Drive file permission:', err);
    return false;
  }
}

/**
 * Synchronizes Google Drive permissions of a file with the list of members in the Master Sync State.
 * - If the JSON member list has NO users (is empty or only has Admin): ALL permissions on Drive
 *   (both Excel and JSON files) are revoked, retaining ONLY the Admin / Owner.
 * - Any user on Drive not present in the JSON member list is immediately revoked.
 * - Any member in the JSON list is granted or updated to the correct role (EDITOR -> writer, VIEWER -> reader).
 */
export interface DrivePermissionSyncEntry {
  email: string;
  action: 'granted' | 'updated' | 'revoked' | 'unchanged' | 'preserved' | 'failed';
  message: string;
}

export interface DrivePermissionSyncResult {
  success: boolean;
  entries: DrivePermissionSyncEntry[];
}

export async function synchronizeDrivePermissionsWithJsonMembers(
  accessToken: string,
  fileId: string,
  members: WorkspaceMember[],
  adminEmail?: string
): Promise<DrivePermissionSyncResult> {
  if (!fileId || !accessToken) throw new Error('Thiếu file ID hoặc access token để đồng bộ quyền Drive.');

  const adminEmails = new Set<string>();
  const cleanAdminEmail = adminEmail?.trim().toLowerCase();
  if (cleanAdminEmail && cleanAdminEmail !== 'admin' && cleanAdminEmail !== 'google user') {
    adminEmails.add(cleanAdminEmail);
  }
  const nonAdminMembers = (members || []).filter(
    (member) =>
      member.email &&
      ['EDITOR', 'VIEWER'].includes(String(member.role).toUpperCase())
  );
  for (const member of members || []) {
    if (String(member.role).toUpperCase() === 'ADMIN' && member.email) {
      adminEmails.add(member.email.trim().toLowerCase());
    }
  }
  const memberByEmail = new Map(
    nonAdminMembers.map((member) => [member.email.trim().toLowerCase(), member])
  );

  type DrivePermission = {
    id: string;
    emailAddress?: string;
    role?: string;
    type?: string;
    displayName?: string;
    permissionDetails?: Array<{ inherited?: boolean }>;
  };
  const permissions: DrivePermission[] = [];
  let pageToken: string | undefined;
  do {
    const listUrl = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`);
    listUrl.searchParams.set(
      'fields',
      'nextPageToken,permissions(id,emailAddress,role,type,displayName,permissionDetails(inherited))'
    );
    listUrl.searchParams.set('supportsAllDrives', 'true');
    listUrl.searchParams.set('pageSize', '100');
    if (pageToken) listUrl.searchParams.set('pageToken', pageToken);
    const response = await fetchWithRetry(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        data?.error?.message || `Không thể tải danh sách quyền Drive (HTTP ${response.status}).`
      );
    }
    const data = await response.json();
    permissions.push(...(data.permissions || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const entries: DrivePermissionSyncEntry[] = [];
  const report = (
    email: string,
    action: DrivePermissionSyncEntry['action'],
    message: string
  ) => entries.push({ email, action, message });
  const revoke = async (permission: DrivePermission, label: string) => {
    if (!permission.id || permission.permissionDetails?.some((detail) => detail.inherited)) {
      report(label, 'failed', 'Quyền được kế thừa hoặc thiếu ID; cần xử lý tại Shared Drive/thư mục nguồn.');
      return;
    }
    try {
      const response = await fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permission.id}?supportsAllDrives=true`,
        { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (response.ok || response.status === 204) {
        report(label, 'revoked', 'Đã thu hồi quyền Drive.');
      } else {
        const data = await response.json().catch(() => ({}));
        report(label, 'failed', data?.error?.message || `Thu hồi thất bại (HTTP ${response.status}).`);
      }
    } catch (err) {
      report(label, 'failed', err instanceof Error ? err.message : 'Lỗi mạng khi thu hồi quyền.');
    }
  };
  const grant = async (email: string, role: 'reader' | 'writer') => {
    try {
      const response = await fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ role, type: 'user', emailAddress: email }),
        }
      );
      if (response.ok) {
        report(email, 'granted', `Đã cấp quyền ${role} trên Drive.`);
      } else {
        const data = await response.json().catch(() => ({}));
        report(
          email,
          'failed',
          data?.error?.message || `Cấp quyền thất bại (HTTP ${response.status}).`
        );
      }
    } catch (err) {
      report(email, 'failed', err instanceof Error ? err.message : 'Lỗi mạng khi cấp quyền Drive.');
    }
  };

  for (const permission of permissions) {
    const email = permission.emailAddress?.trim().toLowerCase();
    const label = email || permission.displayName || permission.type || permission.id;
    if (
      permission.role === 'owner' ||
      permission.role === 'organizer' ||
      permission.role === 'fileOrganizer'
    ) {
      report(label, 'preserved', `Giữ nguyên quyền Drive đặc quyền (${permission.role}).`);
      continue;
    }
    if (email && adminEmails.has(email)) {
      report(email, 'preserved', 'Giữ nguyên quyền Admin.');
      continue;
    }

    const member = email ? memberByEmail.get(email) : undefined;
    if (permission.type === 'anyone' || permission.type === 'domain' || !member) {
      await revoke(permission, label);
      continue;
    }

    const desiredRole = String(member.role).toUpperCase() === 'EDITOR' ? 'writer' : 'reader';
    if (permission.role === desiredRole) {
      report(email || label, 'unchanged', 'Quyền Drive đã khớp với role trong roster.');
      continue;
    }
    if (!permission.id || permission.permissionDetails?.some((detail) => detail.inherited)) {
      report(email || label, 'failed', 'Không thể đổi role của quyền được kế thừa hoặc thiếu permission ID.');
      continue;
    }
    try {
      const response = await fetchWithRetry(
        `https://www.googleapis.com/drive/v3/files/${fileId}/permissions/${permission.id}?supportsAllDrives=true`,
        {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ role: desiredRole }),
        }
      );
      if (response.ok) {
        report(email || label, 'updated', `Đã cập nhật quyền Drive thành ${desiredRole}.`);
      } else {
        const data = await response.json().catch(() => ({}));
        report(email || label, 'failed', data?.error?.message || `Đổi role thất bại (HTTP ${response.status}).`);
      }
    } catch (err) {
      report(email || label, 'failed', err instanceof Error ? err.message : 'Lỗi mạng khi đổi role.');
    }
  }

  const existingUserEmails = new Set(
    permissions
      .filter((permission) => permission.type === 'user' && permission.emailAddress)
      .map((permission) => permission.emailAddress!.trim().toLowerCase())
  );
  for (const member of nonAdminMembers) {
    const email = member.email.trim().toLowerCase();
    if (adminEmails.has(email) || existingUserEmails.has(email)) continue;
    const desiredRole = String(member.role).toUpperCase() === 'EDITOR' ? 'writer' : 'reader';
    await grant(email, desiredRole);
  }

  return { success: entries.every((entry) => entry.action !== 'failed'), entries };
}
