import React from 'react';
import { Cloud, Download, LogOut, X, ShieldAlert, FileSpreadsheet } from 'lucide-react';
import { SavingsBook } from '../types';
import { formatShortVND } from '../utils/formatters';

interface LogoutWarningModalProps {
  isOpen: boolean;
  onClose: () => void;
  books: SavingsBook[];
  privacyMode?: boolean;
  onConnectDrive: () => void;
  onExportExcel: () => void;
  onConfirmLogout: () => void;
}

export const LogoutWarningModal: React.FC<LogoutWarningModalProps> = ({
  isOpen,
  onClose,
  books,
  privacyMode = false,
  onConnectDrive,
  onExportExcel,
  onConfirmLogout,
}) => {
  if (!isOpen) return null;

  const totalPrincipal = books.reduce((sum, b) => sum + b.principal, 0);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 space-y-5 relative">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 p-1.5 rounded-full hover:bg-slate-100 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Warning Badge & Icon */}
        <div className="text-center space-y-3 pt-1">
          <div className="w-16 h-16 rounded-2xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center mx-auto shadow-xs">
            <ShieldAlert className="w-8 h-8 animate-pulse" />
          </div>

          <div>
            <h3 className="text-lg font-bold text-slate-900">
              Cảnh Báo Sao Lưu Dữ Liệu!
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Bạn sắp đăng xuất nhưng <span className="font-semibold text-amber-700">chưa liên kết với Google Drive</span>.
            </p>
          </div>
        </div>

        {/* Portfolio Summary Card */}
        <div className="bg-amber-50/60 rounded-2xl border border-amber-200/80 p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600 font-medium">Danh mục hiện tại:</span>
            <span className="font-bold text-slate-900">{books.length} sổ tiết kiệm</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-600 font-medium">Tổng tiền gốc:</span>
            <span className="font-bold text-emerald-700 font-mono">
              {formatShortVND(totalPrincipal, privacyMode)}
            </span>
          </div>
          <p className="text-[11px] text-amber-800 leading-relaxed pt-1 border-t border-amber-200/60">
            ⚠️ Dữ liệu này đang nằm trong bộ nhớ trình duyệt điện thoại. Nếu đăng xuất hoặc dọn dẹp trình duyệt mà chưa sao lưu, bạn có thể mất dữ liệu vừa nhập!
          </p>
        </div>

        {/* Action Options */}
        <div className="space-y-2.5">
          {/* Option 1: Link Google Drive */}
          <button
            onClick={onConnectDrive}
            className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-98 text-white font-bold text-xs shadow-md shadow-emerald-600/20 transition-all flex items-center justify-center space-x-2 cursor-pointer"
          >
            <Cloud className="w-4 h-4" />
            <span>Liên Kết Google Drive Ngay (Khuyên dùng)</span>
          </button>

          {/* Option 2: Export Excel file to phone */}
          <button
            onClick={onExportExcel}
            className="w-full py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-98 text-white font-bold text-xs transition-all flex items-center justify-center space-x-2 cursor-pointer"
          >
            <Download className="w-4 h-4 text-amber-400" />
            <FileSpreadsheet className="w-4 h-4 text-emerald-400" />
            <span>Tải File Excel (.xlsx) Sao Lưu Về Máy</span>
          </button>

          {/* Option 3: Confirm Logout anyway */}
          <button
            onClick={onConfirmLogout}
            className="w-full py-2 px-4 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold text-xs transition-colors flex items-center justify-center space-x-1.5 cursor-pointer mt-2"
          >
            <LogOut className="w-3.5 h-3.5 text-rose-600" />
            <span>Vẫn Đăng Xuất (Tôi Đã Hiểu Rủi Ro)</span>
          </button>
        </div>
      </div>
    </div>
  );
};
