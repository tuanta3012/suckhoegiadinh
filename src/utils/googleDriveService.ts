import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
  signOut,
  setPersistence,
  browserLocalPersistence,
  signInWithPopup,
  signInWithCredential,
} from 'firebase/auth';
import { Capacitor } from '@capacitor/core';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { AppSettings } from '../types';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');

let cachedAccessToken: string | null = null;
let cachedTokenExpiresAt: number | null = null;

export function getGoogleAccessToken(): string | null { return cachedAccessToken; }

export function isGoogleTokenValid(): boolean {
  return cachedAccessToken !== null && cachedTokenExpiresAt !== null && Date.now() < cachedTokenExpiresAt - 60_000;
}

export function setGoogleAccessToken(token: string | null, expiresAtMs?: number) {
    cachedAccessToken = token;
    cachedTokenExpiresAt = expiresAtMs || null;
}

export async function fetchWithRetry(url: string | URL, options?: RequestInit, retries = 3, delay = 1000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url.toString(), { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return fetchWithRetry(url, options, retries - 1, delay * 2);
    }
    throw error;
  }
}

export async function signOutGoogle(): Promise<void> {
  cachedAccessToken = null;
  await signOut(auth);
  if (Capacitor.isNativePlatform()) {
     try { await (GoogleAuth as any).signOut(); } catch {}
  }
}

export const initGoogleAuth = (
  onSuccess?: (user: User, token: string | null) => void,
  onSignedOut?: () => void
) => {
  return onAuthStateChanged(auth, (user) => {
    if (user && onSuccess) onSuccess(user, null);
    else if (!user && onSignedOut) onSignedOut();
  });
};

export async function signInWithGoogle(): Promise<{ user: User; accessToken: string }> {
  let accessToken: string;
  let user: User;

  if (Capacitor.isNativePlatform()) {
    const result = await GoogleAuth.signIn();
    accessToken = result.authentication.accessToken;
    const credential = GoogleAuthProvider.credential(result.authentication.idToken);
    const userCredential = await signInWithCredential(auth, credential);
    user = userCredential.user;
  } else {
    const result = await signInWithPopup(auth, provider);
    user = result.user;
    const credential = GoogleAuthProvider.credentialFromResult(result);
    accessToken = credential?.accessToken || "";
  }

  setGoogleAccessToken(accessToken, Date.now() + 3600 * 1000); // Assuming 1 hour expiry for now
  return { user, accessToken };
}
