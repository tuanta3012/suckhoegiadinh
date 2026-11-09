import { getApps, getApp, initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInAnonymously,
  signInWithPopup,
  signOut,
  setPersistence,
  browserLocalPersistence,
  type User,
} from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  getAuthSecureItem,
  removeAuthSecureItem,
  setAuthSecureItem,
} from './secureStorage';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export function getSignedInGoogleEmail(): string | null {
  return auth.currentUser?.email?.trim().toLowerCase() || null;
}
const isNative = Capacitor.isNativePlatform();
const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');

const ACCESS_TOKEN_KEY = 'health_google_drive_access_token';
const ACCESS_TOKEN_EXPIRY_KEY = 'health_google_drive_access_token_expiry';
const ACCESS_TOKEN_LIFETIME_MS = 55 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 8000;

let cachedAccessToken: string | null = null;
let cachedTokenExpiresAt: number | null = null;
let googleAuthInitialization: Promise<void> | null = null;
let silentRefreshInFlight: Promise<string | null> | null = null;

const firebasePersistenceReady = setPersistence(auth, browserLocalPersistence).catch((error: unknown) => {
  console.error('[Firebase Auth] Could not configure local persistence.', error);
});
let anonymousSignInInFlight: Promise<User> | null = null;

export async function ensureGeminiAuthUser(): Promise<User> {
  await firebasePersistenceReady;
  if (auth.currentUser) return auth.currentUser;
  if (!isNative) {
    throw new Error('Vui lòng đăng nhập tài khoản Google để sử dụng tính năng AI Gemini.');
  }
  if (!anonymousSignInInFlight) {
    anonymousSignInInFlight = signInAnonymously(auth)
      .then(({ user }) => user)
      .finally(() => {
        anonymousSignInInFlight = null;
      });
  }
  return anonymousSignInInFlight;
}

export function getGoogleAccessToken(): string | null {
  if (cachedAccessToken) return cachedAccessToken;
  if (typeof window !== 'undefined') {
    return sessionStorage.getItem(ACCESS_TOKEN_KEY);
  }
  return null;
}

export function isGoogleTokenValid(): boolean {
  return Boolean(
    cachedAccessToken &&
      cachedTokenExpiresAt &&
      Date.now() < cachedTokenExpiresAt - 60_000,
  );
}

async function storeAccessToken(token: string, expiresAt = Date.now() + ACCESS_TOKEN_LIFETIME_MS): Promise<void> {
  if (!token) throw new Error('Google không trả về Drive access token.');

  if (isNative) {
    await Promise.all([
      setAuthSecureItem(ACCESS_TOKEN_KEY, token),
      setAuthSecureItem(ACCESS_TOKEN_EXPIRY_KEY, String(expiresAt)),
    ]);
  } else if (typeof window !== 'undefined') {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
    sessionStorage.setItem(ACCESS_TOKEN_EXPIRY_KEY, String(expiresAt));
  }
  cachedAccessToken = token;
  cachedTokenExpiresAt = expiresAt;
}

export async function clearAccessToken(): Promise<void> {
  cachedAccessToken = null;
  cachedTokenExpiresAt = null;
  if (isNative) {
    await Promise.all([
      removeAuthSecureItem(ACCESS_TOKEN_KEY),
      removeAuthSecureItem(ACCESS_TOKEN_EXPIRY_KEY),
    ]);
  } else if (typeof window !== 'undefined') {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    sessionStorage.removeItem(ACCESS_TOKEN_EXPIRY_KEY);
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(ACCESS_TOKEN_EXPIRY_KEY);
  }
}

export async function restoreGoogleAuthSession(): Promise<boolean> {
  try {
    const [token, expiry] = isNative
      ? await Promise.all([
          getAuthSecureItem(ACCESS_TOKEN_KEY),
          getAuthSecureItem(ACCESS_TOKEN_EXPIRY_KEY),
        ])
      : [
          sessionStorage.getItem(ACCESS_TOKEN_KEY),
          sessionStorage.getItem(ACCESS_TOKEN_EXPIRY_KEY),
        ];
    if (!token) {
      return false;
    }

    const expiresAt = expiry ? Number(expiry) : NaN;
    cachedAccessToken = token;
    cachedTokenExpiresAt = Number.isFinite(expiresAt) ? expiresAt : Date.now() + ACCESS_TOKEN_LIFETIME_MS;
    return true;
  } catch (error) {
    console.error('[Google Auth] Could not restore the Drive session.', error);
    return false;
  }
}

export async function ensureGoogleAuthInitialized(): Promise<void> {
  if (!isNative || googleAuthInitialization) {
    await googleAuthInitialization;
    return;
  }

  googleAuthInitialization = GoogleAuth.initialize({
    clientId: firebaseConfig.oAuthClientId,
    scopes: ['profile', 'email', 'openid', 'https://www.googleapis.com/auth/drive.file'],
    grantOfflineAccess: false,
  }).finally(() => {
    googleAuthInitialization = null;
  });
  await googleAuthInitialization;
}

export async function trySilentRefresh(force = false): Promise<string | null> {
  if (!force && isGoogleTokenValid()) return cachedAccessToken;
  if (!isNative) return null;
  if (silentRefreshInFlight) return silentRefreshInFlight;

  silentRefreshInFlight = (async () => {
    try {
      await ensureGoogleAuthInitialized();
      const refreshed = await Promise.race([
        GoogleAuth.refresh(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Hết thời gian gia hạn phiên Google.')), REFRESH_TIMEOUT_MS),
        ),
      ]);
      if (!refreshed.accessToken) return null;
      await storeAccessToken(refreshed.accessToken);
      return refreshed.accessToken;
    } catch (error) {
      console.warn('[Google Auth] Silent token refresh failed; interactive sign-in is required.', error);
      return null;
    } finally {
      silentRefreshInFlight = null;
    }
  })();
  return silentRefreshInFlight;
}

export async function getValidGoogleAccessToken(): Promise<string> {
  if (cachedAccessToken && isGoogleTokenValid()) return cachedAccessToken;

  if (!cachedAccessToken) {
    await restoreGoogleAuthSession().catch(() => false);
    if (cachedAccessToken && isGoogleTokenValid()) return cachedAccessToken;
  }

  const refreshed = await trySilentRefresh();
  if (refreshed) return refreshed;

  // On Web / fallback: If we still have any token candidate in memory or storage,
  // return it and let authenticatedDriveFetch perform the actual request.
  // Google Drive will return 401 if it has truly expired.
  const candidate = cachedAccessToken ||
    (typeof window !== 'undefined'
      ? sessionStorage.getItem(ACCESS_TOKEN_KEY)
      : null);

  if (candidate) {
    cachedAccessToken = candidate;
    return candidate;
  }

  throw new Error('Phiên Google Drive đã hết hạn. Hãy đăng nhập lại để cấp quyền Drive.');
}

export async function signOutGoogle(): Promise<void> {
  await clearAccessToken();
  await signOut(auth);
  if (isNative) {
    await GoogleAuth.signOut();
    await ensureGeminiAuthUser();
  }
}

export function initGoogleAuth(
  onSuccess?: (user: User, token: string | null) => void,
  onSignedOut?: () => void,
): () => void {
  return onAuthStateChanged(auth, (user) => {
    void (async () => {
      await firebasePersistenceReady;
      if (!user) {
        onSignedOut?.();
        return;
      }

      const token = isGoogleTokenValid() ? cachedAccessToken : await trySilentRefresh();
      onSuccess?.(user, token);
    })().catch((error: unknown) => {
      console.error('[Google Auth] Failed to restore authenticated session.', error);
      if (user) onSuccess?.(user, null);
    });
  });
}

export async function signInWithGoogle(): Promise<{ user: User; accessToken: string }> {
  await firebasePersistenceReady;
  let user: User;
  let accessToken: string | null;

  if (isNative) {
    await ensureGoogleAuthInitialized();
    const result = await GoogleAuth.signIn();
    accessToken = result.authentication.accessToken;
    if (!result.authentication.idToken) throw new Error('Google không trả về ID token để đăng nhập.');
    const credential = GoogleAuthProvider.credential(result.authentication.idToken);
    user = (await signInWithCredential(auth, credential)).user;
  } else {
    const result = await signInWithPopup(auth, provider);
    user = result.user;
    accessToken = GoogleAuthProvider.credentialFromResult(result)?.accessToken || null;
  }

  if (!accessToken) throw new Error('Đăng nhập Google thành công nhưng không nhận được quyền Google Drive.');
  await storeAccessToken(accessToken);
  return { user, accessToken };
}
