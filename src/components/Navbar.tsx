import React, { useState, useRef, useEffect } from 'react';
import {
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
import { Preferences } from '@capacitor/preferences';
import { setSecureItem } from '../utils/secureStorage';
import { useToast } from '../context/ToastContext';
import { AppLogo } from './AppLogo';

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
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <header className="bg-white/95 backdrop-blur-md text-slate-900 border-b border-slate-100 sticky top-0 z-30 shadow-sm safe-area-header">
      <div className="mx-auto px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <AppLogo size="sm" />
            <h1 className="text-sm font-black text-slate-900 truncate">Sức khỏe Gia đình</h1>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500 shrink-0">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                !isOnline
                  ? 'bg-slate-400'
                  : needsDriveAuth
                  ? 'bg-amber-400'
                  : isSyncingDrive
                  ? 'bg-amber-400 animate-ping'
                  : hasLinkedData
                  ? 'bg-emerald-500'
                  : 'bg-slate-400'
              }`}
            />
            <span className="truncate">
              {syncDriveStatus || (hasLinkedData ? 'Đã kết nối' : 'Chưa liên kết')}
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setShowMenu(!showMenu)}
              className={`p-2 rounded-xl border transition-all flex items-center justify-center ${
                showMenu
                  ? 'bg-slate-900 text-white border-slate-900 shadow-sm'
                  : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
              }`}
            >
              {showMenu ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>

            {showMenu && (
              <div className="absolute right-0 mt-2 w-72 max-h-[85vh] overflow-y-auto bg-white border border-slate-200 rounded-2xl shadow-xl p-2.5 space-y-2 z-50 animate-in fade-in zoom-in-95 duration-150">
                <div className="p-3 bg-slate-50 rounded-xl border border-slate-100 space-y-2">
                  <div className="text-xs font-bold text-slate-900 truncate text-center">
                    {currentUser && !currentUser.isOffline ? currentUser.name : 'Chưa đăng nhập'}
                  </div>
                  {currentUser && !currentUser.isOffline ? (
                    onLogout && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowMenu(false);
                          onLogout();
                        }}
                        className="w-full mt-2 py-2 px-3 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-bold border border-rose-200 transition-all flex items-center justify-center space-x-1.5"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        <span>Đăng xuất</span>
                      </button>
                    )
                  ) : (
                    onLoginGoogle && (
                      <button
                        type="button"
                        disabled={isLoggingInGoogle}
                        onClick={() => {
                          setShowMenu(false);
                          onLoginGoogle();
                        }}
                        className="w-full mt-2 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-xs font-bold shadow-xs transition-all flex items-center justify-center space-x-1.5"
                      >
                        {isLoggingInGoogle ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <LogIn className="w-3.5 h-3.5" />
                        )}
                        <span>{isLoggingInGoogle ? 'Đang kết nối...' : 'Đăng nhập'}</span>
                      </button>
                    )
                  )}
                </div>

                <div className="space-y-1 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      if (onSyncDrive) onSyncDrive();
                    }}
                    className="w-full flex items-center space-x-2.5 p-2 rounded-xl hover:bg-emerald-50 text-slate-700 hover:text-emerald-800 transition-colors text-left"
                  >
                    <Cloud className="w-4 h-4 text-emerald-600 shrink-0" />
                    <div className="font-bold">Đồng bộ Google Drive</div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      if (onOpenUserManagement) onOpenUserManagement();
                    }}
                    className="w-full flex items-center space-x-2.5 p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-all text-left"
                  >
                    <Users className="w-4 h-4 text-teal-600 shrink-0" />
                    <span className="font-semibold text-xs">Quản lý thành viên</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      showToast('Tính năng thông báo đang được nâng cấp.', 'info');
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-all text-left"
                  >
                    <div className="flex items-center space-x-2.5">
                      <Bell className="w-4 h-4 text-amber-500 shrink-0" />
                      <span className="font-semibold text-xs">Thông báo</span>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        settings.notificationsEnabled
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
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
                    className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-all text-left"
                  >
                    <div className="flex items-center space-x-2.5">
                      <Fingerprint className="w-4 h-4 text-emerald-600 shrink-0" />
                      <span className="font-semibold text-xs">Khóa sinh trắc học</span>
                    </div>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                        settings.enableBiometricLogin
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {settings.enableBiometricLogin ? 'BẬT' : 'TẮT'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      if (onTriggerManualCheckUpdate) onTriggerManualCheckUpdate();
                    }}
                    className="w-full flex items-center justify-between p-2 rounded-xl hover:bg-slate-50 text-slate-700 transition-all text-left"
                  >
                    <div className="flex items-center space-x-2.5">
                      <Download className="w-4 h-4 text-cyan-600 shrink-0" />
                      <span className="font-semibold text-xs">Phiên bản {currentVersion}</span>
                    </div>
                    <RefreshCw className="w-3.5 h-3.5 text-slate-400" />
                  </button>
                  {onOpenClearDataModal && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowMenu(false);
                        onOpenClearDataModal();
                      }}
                      className="w-full flex items-center space-x-2.5 p-2 rounded-xl hover:bg-rose-50 text-rose-600 transition-all text-left border-t border-slate-100 pt-2"
                    >
                      <Trash2 className="w-4 h-4 text-rose-500 shrink-0" />
                      <span className="font-semibold text-rose-600 text-xs">Xóa dữ liệu</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <nav className="flex items-center space-x-1 sm:space-x-2 mt-2 pt-2 border-t border-slate-100 w-full overflow-x-auto no-scrollbar">
        <button
          type="button"
          onClick={() => setActiveTab('health-records')}
          className={`flex-1 flex items-center justify-center space-x-2 px-3 py-2 rounded-xl text-xs font-bold transition-all ${
            activeTab === 'health-records'
              ? 'bg-emerald-600 text-white shadow-xs'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <FolderOpen className="w-4 h-4" />
          <span>Hồ sơ sức khỏe</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('family-members')}
          className={`flex-1 flex items-center justify-center space-x-2 px-3 py-2 rounded-xl text-xs font-bold transition-all ${
            activeTab === 'family-members'
              ? 'bg-emerald-600 text-white shadow-xs'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Users className="w-4 h-4" />
          <span>Thành viên</span>
        </button>
      </nav>
    </header>
  );
};
