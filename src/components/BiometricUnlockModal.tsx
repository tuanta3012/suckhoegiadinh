import React, { useState, useEffect } from 'react';
import { Fingerprint, ShieldCheck, HelpCircle, LogOut, Globe } from 'lucide-react';
import { NativeBiometric } from '@capgo/capacitor-native-biometric';
import { Capacitor } from '@capacitor/core';

interface BiometricUnlockModalProps {
  isOpen: boolean;
  onSuccess: () => void;
  onCancel?: () => void;
  userName: string;
  userEmail: string;
}

export const BiometricUnlockModal: React.FC<BiometricUnlockModalProps> = ({
  isOpen,
  onSuccess,
  onCancel,
  userName,
  userEmail,
}) => {
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [, setHasBiometricSensor] = useState<boolean>(true);
  const isNative = Capacitor.isNativePlatform();

  useEffect(() => {
    const checkAvailability = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          // Bật useFallback: true để kiểm tra cả mã khóa thiết bị (PIN/Pattern/Password) lẫn sinh trắc học
          const res = await NativeBiometric.isAvailable({ useFallback: true });
          setHasBiometricSensor(res.isAvailable);
        } else {
          // Trên môi trường Web preview trình duyệt di động / PC
          setHasBiometricSensor(false);
        }
      } catch {
        setHasBiometricSensor(false);
      }
    };

    if (isOpen) {
      checkAvailability();
    }
  }, [isOpen]);

  // Tự động kích hoạt khi màn hình mở khóa vừa xuất hiện
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        handleBiometricScan();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleBiometricScan = async () => {
    if (isScanning) return;
    setIsScanning(true);

    try {
      if (Capacitor.isNativePlatform()) {
        // BẮT BUỘC gọi verifyIdentity với useFallback: true trên file APK Android / iOS đóng gói
        await NativeBiometric.verifyIdentity({
          reason: 'Mở khóa ứng dụng Sổ tiết kiệm',
          title: 'Xác thực bảo mật',
          subtitle: 'Sổ tiết kiệm',
          description: 'Vân tay, Khuôn mặt (bao gồm 2D) hoặc Hình vẽ mở khóa máy (Pattern / PIN)',
          useFallback: true,
          maxAttempts: 5,
        });

        // Chỉ đi tiếp khi hệ thống Android trả về kết quả xác thực thành công thực tế
        setIsScanning(false);
        onSuccess();
        return;
      } else {
        // Môi trường Web Preview trình duyệt (Chrome Mobile / Desktop):
        // Không gọi WebAuthn không hỗ trợ tránh gây đơ/kẹt màn hình
        setIsScanning(false);
        onSuccess();
        return;
      }
    } catch (err: any) {
      setIsScanning(false);
      console.warn('Xác thực hệ thống không thành công hoặc người dùng đã hủy:', err);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md animate-in fade-in">
      <div className="bg-slate-900 w-full max-w-sm rounded-3xl shadow-2xl border border-slate-800 text-center p-6 space-y-6">
        {/* Biểu tượng chính */}
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 text-emerald-400 mx-auto flex items-center justify-center border border-emerald-500/20 shadow-inner">
          <Fingerprint className="w-9 h-9 animate-pulse text-emerald-400" />
        </div>

        {/* Thông tin tài khoản */}
        <div className="space-y-1.5">
          <h3 className="text-lg font-bold text-slate-100">Xác Thực Thiết Bị</h3>
          <p className="text-xs text-slate-400">
            Xin chào <strong className="text-emerald-400">{userName}</strong>
          </p>
          <p className="text-[10px] text-slate-500">{userEmail}</p>
        </div>

        {/* Khung hướng dẫn */}
        <div className="bg-slate-800/50 border border-slate-800 rounded-2xl p-4 space-y-2 text-slate-300">
          <div className="flex items-center justify-center space-x-1.5 text-emerald-400 font-semibold text-xs">
            {isNative ? <ShieldCheck className="w-4 h-4" /> : <Globe className="w-4 h-4" />}
            <span>{isNative ? 'Hệ Thống Bảo Mật Thiết Bị' : 'Môi Trường Xem Thử Web Preview'}</span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            {isNative
              ? 'Ứng dụng sử dụng màn hình khóa bảo mật của thiết bị. Bạn có thể sử dụng Vân tay, Nhận diện khuôn mặt hoặc Hình vẽ/Mã PIN để mở khóa.'
              : 'Bạn đang truy cập qua trình duyệt Web. Bấm nút bên dưới để mở khóa và truy cập ứng dụng ngay lập tức.'}
          </p>
        </div>

        <div className="space-y-3 pt-2">
          {/* Nút bấm kích hoạt mở khóa */}
          <button
            onClick={handleBiometricScan}
            disabled={isScanning}
            className="w-full py-3.5 px-4 rounded-2xl bg-emerald-500 hover:bg-emerald-600 active:scale-[0.98] text-slate-950 font-bold shadow-lg shadow-emerald-500/10 flex items-center justify-center space-x-2 transition-all disabled:opacity-50"
          >
            <Fingerprint className="w-5 h-5" />
            <span>
              {isScanning
                ? 'Đang xác thực hệ thống...'
                : isNative
                ? 'Mở Khóa Bằng Thiết Bị'
                : 'Mở Khóa Vào Ứng Dụng (Web Preview)'}
            </span>
          </button>

          {/* Nút đăng nhập tài khoản Google khác */}
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="w-full py-2.5 px-4 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs font-semibold flex items-center justify-center space-x-2 transition-colors border border-slate-800 mt-2"
            >
              <LogOut className="w-4 h-4 text-rose-500" />
              <span>Đăng nhập tài khoản Google khác</span>
            </button>
          )}
        </div>

        {/* Tip nhỏ */}
        <div className="flex items-center justify-center space-x-1 text-[10px] text-slate-500 pt-1">
          <HelpCircle className="w-3.5 h-3.5" />
          <span>
            {isNative
              ? 'Thông tin sinh trắc học hoàn toàn bảo mật trên thiết bị'
              : 'Tính năng sinh trắc học Native sẽ tự kích hoạt khi chạy trên App APK'}
          </span>
        </div>
      </div>
    </div>
  );
};
