import React, { useState, useRef, useEffect } from 'react';
import {
  Eye,
  EyeOff,
  Smartphone,
  Plus,
  FileSpreadsheet,
  BarChart3,
  Cloud,
  Menu,
  X,
  Database,
  Sparkles,
  Building2,
  Fingerprint,
  LogOut,
  LogIn,
  Trash2,
  Users,
  Bell,
  FileText,
  Download,
  RefreshCw,
} from 'lucide-react';
import { SyncAuditLogModal } from './SyncAuditLogModal';
import { AppSettings, AuthUser, canEditData } from '../types';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { setSecureItem } from '../utils/secureStorage';
import { formatVND } from '../utils/formatters';
import { useToast } from '../context/ToastContext';
import {
  requestNotificationPermission,
  triggerTestNotification,
} from '../utils/notificationService';

export type NavTabType = 'sheet-view' | 'interest-calc' | 'optimizer' | 'analytics' | 'timeline' | 'portfolio' | 'charts' | 'history' | 'android-spec';

interface NavbarProps {
  activeTab: NavTabType;
  setActiveTab: (tab: NavTabType) => void;
  settings: AppSettings;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>;
  totalPrincipal: number;
  totalEstimatedInterest: number;
  activeBooksCount: number;
  isMobilePreview: boolean;
  setIsMobilePreview: React.Dispatch<React.SetStateAction<boolean>>;
  onOpenAddModal: () => void;
  onResetData?: () => void;
  onOpenAndroidSpec: () => void;
  onOpenManageBanks?: () => void;
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
  totalPrincipal,
  totalEstimatedInterest,
  activeBooksCount,
  onOpenAddModal,
  onOpenManageBanks,
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
  const [isAuditLogOpen, setIsAuditLogOpen] = useState(false);
  const [syncErrorMessage, setSyncErrorMessage] = useState<string | null>(() =>
    isSyncErrorStatus(syncDriveStatus) ? syncDriveStatus || null : null
  );
  const menuRef = useRef<HTMLDivElement>(null);

  const togglePrivacy = () => {
    setSettings((prev) => ({ ...prev, privacyMode: !prev.privacyMode }));
  };

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

  // Normalize active tab into 3 main tabs
  const getActiveTabKey = (): 'sheet-view' | 'optimizer' | 'analytics' => {
    if (activeTab === 'optimizer') return 'optimizer';
    if (activeTab === 'interest-calc' || activeTab === 'charts' || activeTab === 'history' || activeTab === 'analytics' || activeTab === 'timeline') return 'analytics';
    return 'sheet-view';
  };

  const currentTab = getActiveTabKey();
  const hasLinkedData = Boolean(settings.googleSheetUrl);
  const hasSyncError = Boolean(syncErrorMessage);

  useEffect(() => {
    if (syncDriveStatus) {
      setSyncErrorMessage(isSyncErrorStatus(syncDriveStatus) ? syncDriveStatus : null);
    } else if (!hasLinkedData) {
      setSyncErrorMessage(null);
    }
  }, [syncDriveStatus, hasLinkedData]);
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
    ? 'Chưa liên kết dữ liệu'
    : 'Dữ liệu đã liên kết, có thể đồng bộ';

  return (
    <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-30 shadow-md safe-area-header">
      {/* Top Banner / Brand Header */}
      <div className="max-w-7xl mx-auto px-2.5 sm:px-6 py-2 sm:py-2.5">
        <div className="flex items-center justify-between gap-2 sm:gap-3">
          {/* Logo & Title */}
          <div className="flex items-center space-x-2 sm:space-x-2.5 shrink-0 min-w-0">
            <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl overflow-hidden bg-slate-950/60 border border-emerald-500/40 flex items-center justify-center shadow-lg shadow-emerald-500/20 shrink-0">
              <img 
                src="/stk_app_icon.png" 
                alt="Logo" 
                className="w-full h-full object-cover" 
              />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-1.5 sm:space-x-2">
                <h1 className="text-sm sm:text-lg font-bold tracking-tight text-white truncate">
                  Sổ tiết kiệm
                </h1>
                <span
                  role="img"
                  aria-label={syncIndicatorTitle}
                  title={syncIndicatorTitle}
                  className={`relative inline-flex shrink-0 rounded-md ${syncIndicatorClass}`}
                >
                  <Database className="w-[17px] h-[17px] sm:w-[19px] sm:h-[19px]" />
                  {isOnline && needsDriveAuth && (
                    <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border border-slate-900 bg-amber-400 px-0.5 text-[9px] font-black leading-none text-slate-950">
                      !
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Center Summary Stats (Hidden on small mobile) */}
          <div className="hidden lg:flex items-center space-x-3 text-xs">
            <div className="bg-slate-800/90 px-3 py-1.5 rounded-xl border border-slate-700/70">
              <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                Tổng gốc ({activeBooksCount} sổ)
              </span>
              <span className="font-bold text-emerald-400 text-sm">
                {formatVND(totalPrincipal, settings.privacyMode)}
              </span>
            </div>

            <div className="bg-slate-800/90 px-3 py-1.5 rounded-xl border border-slate-700/70">
              <span className="text-slate-400 block text-[10px] uppercase font-semibold">
                Lãi dự kiến cả kỳ
              </span>
              <span className="font-bold text-amber-400 text-sm">
                +{formatVND(totalEstimatedInterest, settings.privacyMode)}
              </span>
            </div>
          </div>

          {/* Action Toolbar: Add Book, Privacy Toggle & Hamburger Menu */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            {/* Quick Add Book */}
            <button
              id="btn-add-new-book"
              onClick={onOpenAddModal}
              className="hidden sm:flex items-center space-x-1 px-3 py-1.5 sm:py-2 rounded-xl bg-teal-700 hover:bg-teal-600 text-white font-medium text-xs border border-teal-600 shadow-xs transition-colors"
            >
              <Plus className="w-3.5 h-3.5 text-teal-100" />
              <span>Thêm sổ</span>
            </button>

            {/* Privacy Toggle Quick Button */}
            <button
              id="btn-toggle-privacy"
              onClick={togglePrivacy}
              title={settings.privacyMode ? 'Hiện số tiền' : 'Ẩn số tiền (Chế độ riêng tư)'}
              className="p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors border border-slate-700"
            >
              {settings.privacyMode ? (
                <EyeOff className="w-4 h-4 text-amber-400" />
              ) : (
                <Eye className="w-4 h-4 text-slate-300" />
              )}
            </button>

            {/* MENU 3 GẠCH (HAMBURGER MENU) */}
            <div className="relative" ref={menuRef}>
              <button
                id="btn-hamburger-menu"
                onClick={() => setShowMenu(!showMenu)}
                title="Menu công cụ & Cài đặt bổ sung"
                className={`p-2 rounded-xl border transition-all flex items-center justify-center ${
                  showMenu
                    ? 'bg-amber-500 text-slate-950 border-amber-400 shadow-md font-bold'
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700'
                }`}
              >
                {showMenu ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>

              {/* Hamburger Dropdown Drawer */}
              {showMenu && (
                <div className="absolute right-0 mt-2 w-72 sm:w-80 max-h-[85vh] overflow-y-auto bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl p-3 space-y-2 z-50 animate-in fade-in zoom-in-95 duration-150">
                  {/* User Profile / Info */}
                  <div className="p-3 bg-slate-800/95 rounded-xl border border-slate-700 space-y-2">
                    <div className="text-xs font-bold text-white truncate text-center">
                      {currentUser && !currentUser.isOffline ? (() => {
                        const name = currentUser.name || '';
                        const email = currentUser.email || '';
                        const username = email.includes('@') ? email.split('@')[0] : '';
                        return username ? `${name} (${username})` : name;
                      })() : 'Chưa đăng nhập'}
                    </div>

                    {/* Action button inside drawer: Đăng xuất khi đã login, Đăng nhập khi chưa login */}
                    {currentUser && !currentUser.isOffline ? (
                      onLogout && (
                        <button
                          onClick={() => {
                            setShowMenu(false);
                            onLogout();
                          }}
                          className="w-full mt-2 py-2 px-3 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 text-xs font-bold border border-rose-500/30 transition-all flex items-center justify-center space-x-1.5 active:scale-98 cursor-pointer"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          <span>Đăng xuất</span>
                        </button>
                      )
                    ) : (
                      onLoginGoogle && (
                        <button
                          disabled={isLoggingInGoogle}
                          onClick={() => {
                            setShowMenu(false);
                            onLoginGoogle();
                          }}
                          className="w-full mt-2 py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white text-xs font-bold shadow-xs transition-all flex items-center justify-center space-x-1.5 active:scale-98 cursor-pointer"
                        >
                          {isLoggingInGoogle ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>Đang kết nối...</span>
                            </>
                          ) : (
                            <>
                              <LogIn className="w-3.5 h-3.5" />
                              <span>Đăng nhập</span>
                            </>
                          )}
                        </button>
                      )
                    )}
                  </div>

                  {/* Menu Items List */}
                  <div className="space-y-1 text-xs">
                    {/* Google Drive sync */}
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        if (onSyncDrive) onSyncDrive();
                      }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-emerald-950/60 hover:text-emerald-300 text-slate-200 transition-colors text-left"
                    >
                      <Cloud className={`w-4 h-4 shrink-0 ${needsDriveAuth && isOnline ? 'text-amber-400' : 'text-emerald-400'}`} />
                      <div>
                        <div className="font-bold">{isOnline && needsDriveAuth ? 'Đồng bộ ngay!' : 'Đồng bộ Google Drive'}</div>
                        <p className="text-[10px] text-slate-400">
                          {settings.lastSyncTime
                            ? `Gần nhất: ${settings.lastSyncTime}`
                            : 'Gần nhất: Chưa đồng bộ'}
                        </p>
                      </div>
                    </button>
                    {/* Quản lý thành viên gia đình */}
                    <button
                      id="btn-nav-user-management"
                      onClick={() => {
                        setShowMenu(false);
                        if (onOpenUserManagement) onOpenUserManagement();
                      }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left group active:scale-[0.99] cursor-pointer"
                    >
                      <Users className="w-4 h-4 text-teal-400 shrink-0 group-hover:scale-110 transition-transform" />
                      <span className="font-semibold text-xs text-slate-200">Quản lý thành viên</span>
                    </button>

                    {/* Quản lý danh sách ngân hàng */}
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        if (onOpenManageBanks) onOpenManageBanks();
                      }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left group active:scale-[0.99] cursor-pointer"
                    >
                      <Building2 className="w-4 h-4 text-teal-400 shrink-0 group-hover:scale-110 transition-transform" />
                      <span className="font-semibold text-xs text-slate-200">Danh sách ngân hàng</span>
                    </button>

                    {/* Cài đặt Thông báo tự động */}
                    <button
                      type="button"
                      onClick={async () => {
                        const nextState = !settings.notificationsEnabled;
                        if (nextState) {
                          const granted = await requestNotificationPermission();
                          if (!granted) {
                            showToast('Vui lòng cấp quyền thông báo trên thiết bị.', 'error');
                            return;
                          }
                          triggerTestNotification();
                        }
                        setSettings((prev) => ({
                          ...prev,
                          notificationsEnabled: nextState,
                        }));
                        // Lưu đồng thời vào cả 3 tầng: LocalStorage, Preferences (Android) và SecureStorage (Keystore)
                        try {
                          const val = String(nextState);
                          localStorage.setItem('savings_setting_notifications', val);
                          Preferences.set({ key: 'savings_setting_notifications', value: val }).catch(() => {});
                          setSecureItem('savings_setting_notifications', val).catch(() => {});
                        } catch (err) {
                          console.warn('Lỗi ghi nhớ cài đặt thông báo:', err);
                        }
                      }}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left group active:scale-[0.99] cursor-pointer"
                    >
                      <div className="flex items-center space-x-2.5">
                        <Bell className="w-4 h-4 text-amber-400 shrink-0 group-hover:scale-110 transition-transform" />
                        <span className="font-semibold text-xs text-slate-200">Thông báo</span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-all ${
                          settings.notificationsEnabled
                            ? 'bg-emerald-500 text-slate-950 shadow-xs shadow-emerald-500/20'
                            : 'bg-slate-700/80 text-slate-300'
                        }`}
                      >
                        {settings.notificationsEnabled ? 'BẬT' : 'TẮT'}
                      </span>
                    </button>

                    {/* Cài đặt Khóa vân tay */}
                    <button
                      type="button"
                      onClick={async () => {
                        const nextState = !settings.enableBiometricLogin;
                        if (nextState) {
                          let isSupported = false;
                          try {
                            if (Capacitor.isNativePlatform() || (typeof window !== 'undefined' && 'Capacitor' in window)) {
                              const res = await NativeBiometric.isAvailable();
                              isSupported = res.isAvailable;
                            } else if (window.PublicKeyCredential) {
                              isSupported = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
                            }
                          } catch {
                            isSupported = false;
                          }
                          if (!isSupported) {
                            showToast('Thiết bị chưa kích hoạt sinh trắc học hoặc mở khóa màn hình.', 'error');
                          }
                        }
                        setSettings((prev) => ({
                          ...prev,
                          enableBiometricLogin: nextState,
                        }));
                        // Lưu đồng thời vào cả 3 tầng: LocalStorage, Preferences (Android) và SecureStorage (Keystore)
                        try {
                          const val = String(nextState);
                          localStorage.setItem('savings_setting_biometrics', val);
                          Preferences.set({ key: 'savings_setting_biometrics', value: val }).catch(() => {});
                          setSecureItem('savings_setting_biometrics', val).catch(() => {});
                        } catch (err) {
                          console.warn('Lỗi ghi nhớ cài đặt khóa vân tay:', err);
                        }
                      }}
                      className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left group active:scale-[0.99] cursor-pointer"
                    >
                      <div className="flex items-center space-x-2.5">
                        <Fingerprint className="w-4 h-4 text-emerald-400 shrink-0 group-hover:scale-110 transition-transform" />
                        <span className="font-semibold text-xs text-slate-200">Khóa vân tay</span>
                      </div>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold transition-all ${
                          settings.enableBiometricLogin
                            ? 'bg-emerald-500 text-slate-950 shadow-xs shadow-emerald-500/20'
                            : 'bg-slate-700/80 text-slate-300'
                        }`}
                      >
                        {settings.enableBiometricLogin ? 'BẬT' : 'TẮT'}
                      </span>
                    </button>

                    {/* Nhật Ký Kiểm Toán Đồng Bộ */}
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        setIsAuditLogOpen(true);
                      }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-blue-300 transition-all text-left group active:scale-[0.99] cursor-pointer"
                    >
                      <FileText className="w-4 h-4 text-blue-400 shrink-0 group-hover:scale-110 transition-transform" />
                      <span className="font-semibold text-xs text-slate-200">Kiểm toán đồng bộ</span>
                    </button>

                    {/* Phiên bản & Cập nhật */}
                    {(import.meta as any).env.VITE_APP_MODE === 'play' ? (
                      <div className="w-full flex items-center justify-between p-2.5 rounded-xl text-slate-400 text-left">
                        <div className="flex items-center space-x-2.5">
                          <Smartphone className="w-4 h-4 text-cyan-400 shrink-0" />
                          <div className="font-semibold text-xs text-slate-300 flex items-center space-x-1.5">
                            <span>Phiên bản</span>
                            <span className="font-mono text-cyan-300 font-bold">
                              {currentVersion.startsWith('v') ? currentVersion : `v${currentVersion}`}
                            </span>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setShowMenu(false);
                          if (onTriggerManualCheckUpdate) {
                            onTriggerManualCheckUpdate();
                          }
                        }}
                        className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-slate-800 text-slate-200 transition-all text-left group active:scale-[0.99] cursor-pointer"
                      >
                        <div className="flex items-center space-x-2.5">
                          <Smartphone className="w-4 h-4 text-cyan-400 shrink-0 group-hover:scale-110 transition-transform" />
                          <div className="font-semibold text-xs text-slate-200 flex items-center space-x-1.5">
                            <span>Phiên bản</span>
                            <span className="font-mono text-cyan-300 font-bold">
                              {currentVersion.startsWith('v') ? currentVersion : `v${currentVersion}`}
                            </span>
                          </div>
                        </div>

                        <div
                          title="Tải cập nhật mới"
                          className="p-1.5 rounded-lg bg-teal-500/10 text-teal-400 border border-teal-500/30 group-hover:bg-gradient-to-r group-hover:from-teal-500 group-hover:to-emerald-500 group-hover:text-slate-950 group-hover:border-transparent font-bold shrink-0 shadow-sm transition-all flex items-center justify-center"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </div>
                      </button>
                    )}

                    {/* Clear All App Data */}
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        if (onOpenClearDataModal) onOpenClearDataModal();
                      }}
                      className="w-full flex items-center space-x-2.5 p-2.5 rounded-xl hover:bg-rose-950/60 text-slate-300 hover:text-rose-300 transition-all text-left border-t border-slate-800/80 pt-2 group active:scale-[0.99] cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4 text-rose-400 shrink-0 group-hover:scale-110 transition-transform" />
                      <span className="font-semibold text-rose-300 text-xs">Xóa dữ liệu</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 3 CONSOLIDATED CLEAN TABS */}
        <nav className="flex items-center space-x-1 sm:space-x-2 mt-1.5 sm:mt-2 pt-1.5 sm:pt-2 border-t border-slate-800/90 w-full overflow-x-auto no-scrollbar">
          {/* TAB 1: BẢNG KÊ EXCEL & DANH MỤC */}
          <button
            id="tab-sheet-view"
            onClick={() => setActiveTab('sheet-view')}
            className={`flex-1 flex items-center justify-center space-x-1 sm:space-x-2 px-2 sm:px-3.5 py-1.5 sm:py-2 rounded-xl text-[11px] sm:text-sm font-bold transition-all whitespace-nowrap ${
              currentTab === 'sheet-view'
                ? 'bg-emerald-500 text-slate-950 shadow-sm'
                : 'text-emerald-300 hover:text-white hover:bg-slate-800/80'
            }`}
          >
            <FileSpreadsheet className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span>Bảng kê</span>
            <span className="px-1.5 py-0.2 bg-emerald-950/70 text-emerald-300 text-[10px] font-bold rounded-full">
              {activeBooksCount}
            </span>
          </button>

          {/* TAB 2: TỐI ƯU HUY ĐỘNG VỐN */}
          <button
            id="tab-optimizer"
            onClick={() => setActiveTab('optimizer')}
            className={`flex-1 flex items-center justify-center space-x-1 sm:space-x-2 px-2 sm:px-3.5 py-1.5 sm:py-2 rounded-xl text-[11px] sm:text-sm font-bold transition-all whitespace-nowrap relative ${
              currentTab === 'optimizer'
                ? 'bg-emerald-400 text-slate-950 shadow-sm'
                : 'text-emerald-200 hover:text-white hover:bg-slate-800/80'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span className="sm:hidden">Tối ưu vốn</span>
            <span className="hidden sm:inline">2. Tối Ưu Huy Động Vốn</span>
          </button>

          {/* TAB 3: PHÂN TÍCH & DÒNG TIỀN */}
          <button
            id="tab-analytics"
            onClick={() => setActiveTab('analytics')}
            className={`flex-1 flex items-center justify-center space-x-1 sm:space-x-2 px-2 sm:px-3.5 py-1.5 sm:py-2 rounded-xl text-[11px] sm:text-sm font-bold transition-all whitespace-nowrap ${
              currentTab === 'analytics'
                ? 'bg-indigo-500 text-white shadow-sm'
                : 'text-indigo-300 hover:text-white hover:bg-slate-800/80'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span className="sm:hidden">Dòng tiền</span>
            <span className="hidden sm:inline">3. Phân Tích &amp; Dòng Tiền</span>
          </button>
        </nav>
      </div>

      {/* Modal Nhật ký kiểm toán & điều tra đồng bộ */}
      <SyncAuditLogModal
        isOpen={isAuditLogOpen}
        onClose={() => setIsAuditLogOpen(false)}
        currentUserEmail={currentUser?.email}
        userRole={settings.currentRole || 'ADMIN'}
        settings={settings}
      />
    </header>
  );
};
