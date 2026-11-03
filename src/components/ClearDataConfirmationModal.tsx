import React from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';

interface ClearDataConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  booksCount?: number;
  totalPrincipal?: number;
  onExportBackup?: () => void;
  onConfirmClear: () => void;
}

export const ClearDataConfirmationModal: React.FC<ClearDataConfirmationModalProps> = ({
  isOpen,
  onClose,
  booksCount = 0,
  onConfirmClear,
}) => {
  if (!isOpen) return null;

  const handleExecuteWipe = () => {
    onConfirmClear();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="bg-white w-full max-w-sm rounded-2xl shadow-2xl border border-rose-200 overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
        
        {/* Simple Confirmation Content */}
        <div className="p-5 text-center space-y-3">
          <div className="w-12 h-12 rounded-xl bg-rose-100 text-rose-700 border border-rose-200 flex items-center justify-center mx-auto">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div className="space-y-1">
            <h3 className="font-extrabold text-base text-slate-900">Xóa toàn bộ dữ liệu?</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              {booksCount > 0 ? `Xóa ${booksCount} sổ trên thiết bị.` : 'Xóa dữ liệu trên thiết bị.'} Không thể hoàn tác.
            </p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="p-3 bg-slate-50 border-t border-slate-200 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-white hover:bg-slate-100 text-slate-700 font-semibold text-xs border border-slate-300 transition-colors cursor-pointer"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={handleExecuteWipe}
            className="w-full py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-extrabold text-xs shadow-sm transition-all active:scale-98 flex items-center justify-center space-x-1.5 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            <span>Xóa</span>
          </button>
        </div>

      </div>
    </div>
  );
};
