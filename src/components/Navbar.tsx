import React, { useState, useRef, useEffect } from 'react';
import {
  Eye,
  EyeOff,
  Smartphone,
  Menu,
  X,
  Database,
  Cloud,
  Fingerprint,
  LogOut,
  LogIn,
  Trash2,
  Users,
  Bell,
  Download,
  RefreshCw,
  FolderOpen,
} from 'lucide-react';
import { AppSettings, AuthUser } from '../types';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { setSecureItem } from '../utils/secureStorage';
import { useToast } from '../context/ToastContext';

export type NavTabType = 'health-records' | 'family-members' | 'settings';

interface NavbarProps {
  activeTab: NavTabType;
  setActiveTab: (tab: NavTabType) => void;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  isMobilePreview: boolean;
  setIsMobilePreview: React.Dispatch<React.SetStateAction<boolean>>;
  onOpenClearDataModal?: () => void;
  onOpenUserManagement?: () => void;
  currentUser?: AuthUser | null;
  onLogout?: () => void;
  onLoginGoogle?: () => void;
  onSyncDrive?: () => void;
  isLoggingInGoogle?: boolean;
  isSyncingDrive?: boolean;
  isOnline?: boolean;
  needsDriveAuth?: boolean;
  syncDriveStatus?: string | null;
  onTriggerManualCheckUpdate?: () => void;
  currentVersion?: string;
}

const isSyncErrorStatus = (status?: string | null): boolean => {
  if (!status) return false;
  if (/đang|thành công|hoàn tất|đã kết nối|đã nạp/i.test(status) && !/lỗi|thất bại|hết hạn|không thể/i.test(status)) {
    return false;
  }
  return Boolean(/❌|⚠️|lỗi|thất bại|hết hạn|không thể|chưa hoàn tất|không khả dụng/i.test(status));
};

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  settings,
  setSettings,
  onOpenClearDataModal,
  onOpenUserManagement,
  currentUser,
  onLogout,
  onLoginGoogle,
  onSyncDrive,
  isLoggingInGoogle = false,
  isSyncingDrive,
  isOnline = true,
  needsDriveAuth = false,
  syncDriveStatus,
  onTriggerManualCheckUpdate,
  currentVersion = '1.0.0',
}) => {
  const { showToast } = useToast();
  const [showMenu, setShowMenu] = useState(false);
  const [syncErrorMessage] = useState<string | null>(() =>
    isSyncErrorStatus(syncDriveStatus) ? syncDriveStatus || null : null
  );
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  const hasLinkedData = Boolean(settings.sharedFolderId);
  const hasSyncError = Boolean(syncErrorMessage);

  const syncIndicatorClass = !isOnline
    ? 'text-slate-500'
    : needsDriveAuth
    ? 'text-amber-400'
    : isSyncingDrive
    ? 'text-amber-400 animate-pulse'
    : hasSyncError
    ? 'text-rose-500'
    : !hasLinkedData
    ? 'text-slate-500'
    : 'text-emerald-400';
  const syncIndicatorTitle = !isOnline
    ? 'Ngoại tuyến'
    : needsDriveAuth
    ? 'Cần đăng nhập hoặc cấp quyền Google Drive'
    : hasSyncError
    ? `Lỗi đồng bộ: ${syncErrorMessage}`
    : isSyncingDrive
    ? 'Đang đồng bộ dữ liệu'
    : !hasLinkedData
    ? 'Chưa liên kết folder'
    : 'Dữ liệu đã liên kết, có thể đồng bộ';

  return (
    <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-30 shadow-md safe-area-header">
      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 py-2 sm:py-2.5">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          <div className="flex items-center space-x-2 sm:space-x-2.5 shrink-0 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl overflow-hidden bg-slate-950/60 border border-emerald-500/40 flex items-center justify-center shadow-lg shadow-emerald-500/20 shrink-0">
              <img src="/stk_app_icon.png" alt="Logo" className="w-full h-full object-cover" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-1.5 sm:space-x-2">
                <h1 className="text-sm sm:text-lg font-bold tracking-tight text-white truncate">Sức khỏe Gia đình</h1>
                <span
                  role="img"
                  aria-label={syncIndicatorTitle}
                  title={syncIndicatorTitle}
                  className={`relative inline-flex shrink-0 rounded-md ${syncIndicatorClass}`}
                >
                  <Database className="w-[17px] h-[17px] sm:w-[19px] sm:h-[19px]" />
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            <div className="relative" ref={menuRef}>
              <button
                onClick={() => setShowMenu(!showMenu)}
                className={`p-2 rounded-xl border transition-all flex items-center justify-center ${
                  showMenu
                    ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-md font-bold'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                }`}
              >
                {showMenu ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>

              {showMenu && (
                <div className="absolute right-0 mt-2 w-72 sm:w-80 max-h-[85vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-3 space-y-2 z-50 animate-in fade-in zoom-in-95 duration-150">
                  <div className="p-3 bg-slate-800/95 rounded-xl border border-slate-700 space-y-2">
                    <div className="text-xs font-bold text-white truncate text-center">
                      {currentUser && !currentUser.isOffline ? currentUser.name : 'Chưa đăng nhập'}
                    </div>
                    {currentUser && !currentUser.isOffline ? (
                      onLogout && (
                        <button
                          onClick={() => { setShowMenu(false); onLogout(); }}
                          className="w-full mt-2 py-2 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-xs font-bold border border-rose-500/30 transition-all flex items-center justify-center space-x-1.5"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          <span>Đăng xuất</span>
                        </button>
                      )
                    ) : (
                      onLoginGoogle && (
                        <button
                          disabled={isLoggingInGoogle}
                          onClick={() => { setShowMenu(false); onLoginGoogle(); }}
                          className="w-full mt-2 py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-bold shadow-xs transition-all flex items-center justify-center space-x-1.5"
                        >
                          {isLoggingInGoogle ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />}
                          <span>{isLoggingInGoogle ? 'Đang kết nối...' : 'Đăng nhập'}</span>
                        </button>
                      )
                    )}
                  </div>
                  <div className="space-y-1 text-xs">
                    <button
                      onClick={() => { setShowMenu(false); if (onSyncDrive) onSyncDrive(); }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-emerald-950/60 hover:text-emerald-300 text-slate-200 transition-colors text-left"
                    >
                      <Cloud className="w-4 h-4 text-emerald-400 shrink-0" />
                      <div className="font-bold">Đồng bộ Google Drive</div>
                    </button>
                    <button
                      onClick={() => { setShowMenu(false); if (onOpenUserManagement) onOpenUserManagement(); }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left"
                    >
                      <Users className="w-4 h-4 text-teal-400 shrink-0" />
                      <span className="font-semibold text-xs">Quản lý thành viên</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => { showToast('Tính năng thông báo đang được nâng cấp.', 'info'); }}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left"
                    >
                      <div className="flex items-center space-x-2.5">
                        <Bell className="w-4 h-4 text-amber-400 shrink-0" />
                        <span className="font-semibold text-xs">Thông báo</span>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${settings.notificationsEnabled ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700/80 text-slate-300'}`}>
                        {settings.notificationsEnabled ? 'BẬT' : 'TẮT'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        const nextState = !settings.enableBiometricLogin;
                        setSettings((prev) => ({ ...prev, enableBiometricLogin: nextState }));
                        try {
                          const val = String(nextState);
                          localStorage.setItem('savings_setting_biometrics', val);
                          Preferences.set({ key: 'savings_setting_biometrics', value: val });
                          setSecureItem('savings_setting_biometrics', val);
                        } catch {}
                      }}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left"
                    >
                      <div className="flex items-center space-x-2.5">
                        <Fingerprint className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span className="font-semibold text-xs">Khóa vân tay</span>
                      </div>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${settings.enableBiometricLogin ? 'bg-emerald-500 text-slate-950' : 'bg-slate-700/80 text-slate-300'}`}>
                        {settings.enableBiometricLogin ? 'BẬT' : 'TẮT'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowMenu(false);
                        if (onTriggerManualCheckUpdate) onTriggerManualCheckUpdate();
                      }}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left"
                    >
                      <div className="flex items-center space-x-2.5">
                        <Smartphone className="w-4 h-4 text-cyan-400 shrink-0" />
                        <span className="font-semibold text-xs">Phiên bản {currentVersion}</span>
                      </div>
                      <Download className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => { setShowMenu(false); if (onOpenClearDataModal) onOpenClearDataModal(); }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-rose-950/60 text-slate-300 hover:text-rose-300 transition-all text-left border-t border-slate-800/80 pt-2"
                    >
                      <Trash2 className="w-4 h-4 text-rose-400 shrink-0" />
                      <span className="font-semibold text-rose-300 text-xs">Xóa dữ liệu</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <nav className="flex items-center space-x-1 sm:space-x-2 mt-1.5 sm:mt-2 pt-1.5 sm:pt-2 border-t border-slate-800/90 w-full overflow-x-auto no-scrollbar">
          <button
            onClick={() => setActiveTab('health-records')}
            className={`flex-1 flex items-center justify-center space-x-2 px-3 py-2 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'health-records' ? 'bg-emerald-500 text-slate-950' : 'text-emerald-300 hover:bg-slate-800/80'
            }`}
          >
            <FolderOpen className="w-4 h-4" />
            <span>Hồ sơ sức khỏe</span>
          </button>
          <button
            onClick={() => setActiveTab('family-members')}
            className={`flex-1 flex items-center justify-center space-x-2 px-3 py-2 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'family-members' ? 'bg-emerald-500 text-slate-950' : 'text-emerald-300 hover:bg-slate-800/80'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Thành viên</span>
          </button>
        </nav>
      </div>
    </header>
  );
};
