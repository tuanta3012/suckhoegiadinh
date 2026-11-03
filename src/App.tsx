import React, { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { AuthUser, AppSettings } from './types';
import { Navbar, NavTabType } from './components/Navbar';
import { auth, initGoogleAuth, signOutGoogle, signInWithGoogle } from './utils/googleDriveService';
import { useToast } from './context/ToastContext';
import { FamilyMemberProvider } from './context/FamilyMemberContext';
import { FamilySwitcher } from './components/FamilySwitcher';
import { HealthDashboard } from './components/HealthDashboard';

export default function App() {
  const { showToast } = useToast();
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [settings, setSettings] = useState<AppSettings>({
    notificationsEnabled: false,
    enableBiometricLogin: false,
  });
  const [activeTab, setActiveTab] = useState<NavTabType>('health-records');

  useEffect(() => {
    const initNativeStatusBar = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          await StatusBar.setOverlaysWebView({ overlay: false });
          await StatusBar.setBackgroundColor({ color: '#0f172a' });
          await StatusBar.setStyle({ style: Style.Dark });
        }
      } catch (err) {}
    };
    initNativeStatusBar();
  }, []);

  useEffect(() => {
    const unsubscribe = initGoogleAuth(
      (firebaseUser, token) => {
        if (firebaseUser && firebaseUser.email) {
            setCurrentUser({
                email: firebaseUser.email,
                name: firebaseUser.displayName || 'Người dùng',
                role: 'ADMIN',
                title: 'Quản trị viên',
                isOffline: false
            });
        }
      },
      () => { setCurrentUser(null); }
    );
    return () => unsubscribe();
  }, []);

  return (
    <FamilyMemberProvider>
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <Navbar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          settings={settings}
          setSettings={setSettings}
          isMobilePreview={false}
          setIsMobilePreview={() => {}}
          currentUser={currentUser}
          onLogout={signOutGoogle}
          onLoginGoogle={signInWithGoogle}
        />
        <FamilySwitcher />
        <main className="flex-1 overflow-y-auto">
          <HealthDashboard />
        </main>
      </div>
    </FamilyMemberProvider>
  );
}
