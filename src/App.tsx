import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import type { AuthUser } from './types';
import { HealthDashboard } from './components/HealthDashboard';
import { SplashScreen } from './components/SplashScreen';
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

export default function App() {
  const { showToast } = useToast();
  const [showSplash, setShowSplash] = useState(true);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [driveAuthorized, setDriveAuthorized] = useState(isGoogleTokenValid());
  const [driveRequestFailed, setDriveRequestFailed] = useState(false);

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
              return;
            }
            setCurrentUser({
              email: firebaseUser.email,
              name: firebaseUser.displayName || 'Người dùng',
              photoURL: firebaseUser.photoURL || undefined,
              role: 'ADMIN',
              title: 'Quản trị viên',
            });
            setDriveAuthorized(Boolean(token) || isGoogleTokenValid());
          },
          () => {
            setCurrentUser(null);
            setDriveAuthorized(false);
            setDriveRequestFailed(false);
          }
        );
      })
      .catch((error: unknown) => {
        console.warn('Phiên Google Drive:', error);
      });
    const handleDriveExpired = () => {
      setDriveAuthorized(false);
      setDriveRequestFailed(true);
      showToast('Phiên Google Drive đã hết hạn. Hãy bấm "Cấp quyền Drive" để tiếp tục.', 'error');
    };
    const handleDriveRequestError = () => setDriveRequestFailed(true);
    window.addEventListener('google-drive-auth-expired', handleDriveExpired);
    window.addEventListener('google-drive-request-error', handleDriveRequestError);

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
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [showToast]);

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
      await signOutGoogle();
      setCurrentUser(null);
      setDriveAuthorized(false);
      setDriveRequestFailed(false);
      showToast('Đã đăng xuất tài khoản.', 'info');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Không thể đăng xuất.', 'error');
    }
  }, [showToast]);

  if (showSplash) {
    return <SplashScreen onFinished={() => setShowSplash(false)} durationMs={1000} />;
  }

  return (
    <HealthDashboard
      userEmail={currentUser?.email || auth.currentUser?.email || null}
      userName={currentUser?.name || auth.currentUser?.displayName || null}
      appVersion={RELEASE_APP_VERSION}
      driveAuthorized={driveAuthorized}
      driveRequestFailed={driveRequestFailed}
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
