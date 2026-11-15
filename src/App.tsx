import { useCallback, useEffect, useState } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { AuthUser } from './types';
import { HealthDashboard } from './components/HealthDashboard';
import { SplashScreen } from './components/SplashScreen';
import { OfflineLockScreen } from './components/OfflineLockScreen';
import { OfflineCachedView } from './components/OfflineCachedView';
import { RELEASE_APP_VERSION } from './version';
import { useToast } from './context/ToastContext';
import {
  auth,
  ensureGeminiAuthUser,
  initGoogleAuth,
  isGoogleTokenValid,
  restoreGoogleAuthSession,
  signInWithGoogle,
  signOutGoogle,
  trySilentRefresh,
} from './utils/googleDriveService';
import { getSecureItem, setSecureItem } from './utils/secureStorage';
import { hasNativeOfflineCache } from './utils/offlineWorkspaceCache';
import { verifyDeviceUnlock } from './utils/offlineAppLock';

const LAST_OFFLINE_ACCOUNT_KEY = 'health_last_offline_account_email';

export default function App() {
  const { showToast } = useToast();
  const [showSplash, setShowSplash] = useState(true);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [driveAuthorized, setDriveAuthorized] = useState(isGoogleTokenValid());
  const [driveRequestFailed, setDriveRequestFailed] = useState(false);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [offlineCacheEmail, setOfflineCacheEmail] = useState<string | null>(null);
  const [offlineCacheUnlocked, setOfflineCacheUnlocked] = useState(false);

  useEffect(() => {
    const initializeStatusBar = async () => {
      if (!Capacitor.isNativePlatform()) return;
      try {
        await StatusBar.setOverlaysWebView({ overlay: false });
        await StatusBar.setBackgroundColor({ color: '#0f172a' });
        await StatusBar.setStyle({ style: Style.Dark });
      } catch (error) {
        console.warn('Không thể cấu hình thanh trạng thái:', error);
      }
    };
    void initializeStatusBar();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void restoreGoogleAuthSession()
      .then(() => {
        if (cancelled) return;
        if (Capacitor.isNativePlatform()) {
          void ensureGeminiAuthUser().catch((error: unknown) => {
            console.warn('[Firebase Auth] Could not initialize anonymous Gemini access.', error);
          });
        }
        unsubscribe = initGoogleAuth(
          (firebaseUser, token) => {
            if (!firebaseUser.email) {
              setCurrentUser(null);
              setDriveAuthorized(false);
              setDriveRequestFailed(false);
              setAuthInitialized(true);
              if (Capacitor.isNativePlatform()) {
                void getSecureItem(LAST_OFFLINE_ACCOUNT_KEY).then((email) => {
                  if (email && !auth.currentUser?.email && hasNativeOfflineCache(email)) {
                    setOfflineCacheEmail(email);
                  }
                });
              }
              return;
            }
            void setSecureItem(LAST_OFFLINE_ACCOUNT_KEY, firebaseUser.email);
            setOfflineCacheEmail(null);
            setOfflineCacheUnlocked(false);
            setCurrentUser({
              email: firebaseUser.email,
              name: firebaseUser.displayName || 'Người dùng',
              photoURL: firebaseUser.photoURL || undefined,
              role: 'Owner',
              title: 'Quản trị viên',
            });
            setDriveAuthorized(Boolean(token) || isGoogleTokenValid());
            setAuthInitialized(true);
          },
          () => {
            setCurrentUser(null);
            setDriveAuthorized(false);
            setDriveRequestFailed(false);
            setAuthInitialized(true);
            if (Capacitor.isNativePlatform()) {
              void getSecureItem(LAST_OFFLINE_ACCOUNT_KEY).then((email) => {
                if (email && !auth.currentUser?.email && hasNativeOfflineCache(email)) {
                  setOfflineCacheEmail(email);
                }
              });
            }
          }
        );
      })
      .catch((error: unknown) => {
        console.warn('Phiên Google Drive:', error);
        setAuthInitialized(true);
      });
    const handleDriveExpired = () => {
      setDriveAuthorized(false);
      setDriveRequestFailed(true);
      showToast('Phiên Google Drive đã hết hạn. Hãy bấm "Cấp quyền Drive" để tiếp tục.', 'error');
    };
    const handleDriveRequestError = () => setDriveRequestFailed(true);
    const handleDriveRequestSucceeded = () => setDriveRequestFailed(false);
    window.addEventListener('google-drive-auth-expired', handleDriveExpired);
    window.addEventListener('google-drive-request-error', handleDriveRequestError);
    window.addEventListener('google-drive-request-succeeded', handleDriveRequestSucceeded);

    // Auto-refresh token on app resume (useful for long-lived background sessions)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && auth.currentUser) {
        void trySilentRefresh().then((token) => {
          if (token) setDriveAuthorized(true);
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      unsubscribe?.();
      window.removeEventListener('google-drive-auth-expired', handleDriveExpired);
      window.removeEventListener('google-drive-request-error', handleDriveRequestError);
      window.removeEventListener('google-drive-request-succeeded', handleDriveRequestSucceeded);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [showToast]);

  useEffect(() => {
    let backgrounded = false;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        backgrounded = true;
      } else if (backgrounded) {
        backgrounded = false;
        if (offlineCacheUnlocked && !currentUser) setOfflineCacheUnlocked(false);
      }
    }).then((registered) => {
      if (disposed) void registered.remove();
      else listener = registered;
    });
    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [currentUser, offlineCacheUnlocked]);

  const connectGoogle = useCallback(async () => {
    try {
      const { accessToken } = await signInWithGoogle();
      setDriveAuthorized(Boolean(accessToken));
      if (!accessToken) {
        showToast('Đăng nhập thành công nhưng chưa có quyền Drive.', 'error');
      } else {
        setDriveRequestFailed(false);
        showToast('Đã kết nối tài khoản Google Drive thành công!', 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đăng nhập Google.', 'error');
    }
  }, [showToast]);

  const logOut = useCallback(async () => {
    try {
      const email = currentUser?.email || auth.currentUser?.email;
      const hasOfflineCopy = Boolean(
        Capacitor.isNativePlatform() &&
        email &&
        hasNativeOfflineCache(email),
      );
      if (Capacitor.isNativePlatform() && email) {
        await setSecureItem(LAST_OFFLINE_ACCOUNT_KEY, email);
      }
      await signOutGoogle();
      setCurrentUser(null);
      setDriveAuthorized(false);
      setDriveRequestFailed(false);
      showToast(
        hasOfflineCopy
          ? 'Đã đăng xuất. Bản dữ liệu đã lưu trên máy sẽ yêu cầu xác minh vân tay hoặc mã khóa để xem.'
          : 'Đã đăng xuất tài khoản.',
        'info',
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đăng xuất.', 'error');
    }
  }, [currentUser?.email, showToast]);

  if (showSplash) {
    return <SplashScreen onFinished={() => setShowSplash(false)} durationMs={1000} />;
  }
  if (!authInitialized) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-slate-50 text-sm font-semibold text-slate-500">
        Đang khôi phục phiên làm việc...
      </div>
    );
  }
  if (!currentUser && !auth.currentUser?.email && offlineCacheEmail) {
    if (!offlineCacheUnlocked) {
      return (
        <OfflineLockScreen
          email={offlineCacheEmail}
          onUnlock={async () => {
            await verifyDeviceUnlock();
            setOfflineCacheUnlocked(true);
          }}
          onSignIn={() => void connectGoogle()}
        />
      );
    }
    return (
      <OfflineCachedView
        key={offlineCacheEmail}
        email={offlineCacheEmail}
        onLock={() => setOfflineCacheUnlocked(false)}
        onSignIn={() => void connectGoogle()}
      />
    );
  }

  return (
    <HealthDashboard
      userEmail={currentUser?.email || auth.currentUser?.email || null}
      userName={currentUser?.name || auth.currentUser?.displayName || null}
      appVersion={RELEASE_APP_VERSION}
      driveAuthorized={driveAuthorized}
      driveRequestFailed={driveRequestFailed}
      onDriveWorkspaceReset={() => setDriveRequestFailed(false)}
      onConnectDrive={async () => {
        try {
          await connectGoogle();
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (!msg.includes('auth/popup-closed-by-user') && !msg.includes('popup_closed_by_user')) {
            showToast(msg, 'error');
          }
        }
      }}
      onLogout={() => void logOut()}
      showToast={showToast}
    />
  );
}
