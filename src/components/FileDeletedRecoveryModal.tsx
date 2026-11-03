import React, { useState } from 'react';
import { 
  Plus, 
  Download, 
  Trash2, 
  X,
  FileWarning,
  ArrowRight
} from 'lucide-react';
import { SavingsBook } from '../types';
import { useConfirmDialog } from '../context/ConfirmDialogContext';

interface FileDeletedRecoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  books: SavingsBook[];
  settlements?: any[];
  onCreateNewFile: () => Promise<void>;
  onExportExcel: () => void;
  onDeleteAppData: () => void;
}

export const FileDeletedRecoveryModal: React.FC<FileDeletedRecoveryModalProps> = ({
  isOpen,
  onClose,
  books,
  onCreateNewFile,
  onExportExcel,
  onDeleteAppData,
}) => {
  const { confirm } = useConfirmDialog();
  const [isCreating, setIsCreating] = useState(false);

  if (!isOpen) return null;

  const handleCreateNew = async () => {
    setIsCreating(true);
    try {
      await onCreateNewFile();
      onClose();
    } catch (err) {
      console.error('Error creating recovery file:', err);
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteImmediately = async () => {
    if (!(await confirm({
      title: 'Xóa dữ liệu trên thiết bị?',
      message: `Xóa ${books.length} sổ. Không thể hoàn tác.`,
    }))) return;
    onDeleteAppData();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/75 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-sm sm:max-w-md rounded-2xl shadow-2xl border border-slate-200 overflow-hidden animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-5 flex items-start space-x-3.5 border-b border-amber-100 bg-amber-50/70 relative">
          <div className="w-10 h-10 bg-amber-100 text-amber-700 rounded-xl flex items-center justify-center shrink-0">
            <FileWarning className="w-5 h-5" />
          </div>
          <div className="pr-6">
            <h3 className="text-base font-bold text-slate-900 leading-snug">
              File liên kết đã bị xóa trên Drive
            </h3>
            <p className="text-xs text-slate-600 mt-0.5">
              Ứng dụng đã tự động hủy liên kết để bảo vệ dữ liệu.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="absolute top-4 right-4 p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-amber-100 transition-colors cursor-pointer"
            title="Đóng"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-3">
          <div className="bg-slate-50 rounded-lg p-3 text-xs text-slate-600 border border-slate-200 flex items-center justify-between">
            <span>Dữ liệu hiện có trên App:</span>
            <span className="font-bold text-slate-900">{books.length} sổ tiết kiệm</span>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              onClick={handleCreateNew}
              disabled={isCreating}
              className="w-full flex items-center justify-between p-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-xl text-xs sm:text-sm font-bold transition-all shadow-sm group cursor-pointer"
            >
              <div className="flex items-center space-x-2.5">
                <Plus className="w-4 h-4 shrink-0" />
                <span>1. Tạo file mới trên Drive để đồng bộ</span>
              </div>
              <ArrowRight className="w-4 h-4 opacity-70 group-hover:translate-x-0.5 transition-transform" />
            </button>

            <button
              type="button"
              onClick={onExportExcel}
              className="w-full flex items-center justify-between p-3 bg-white border border-slate-300 hover:bg-slate-50 text-slate-800 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer"
            >
              <div className="flex items-center space-x-2.5">
                <Download className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>2. Xuất file sao lưu về máy (.xlsx)</span>
              </div>
              <ArrowRight className="w-4 h-4 text-slate-400" />
            </button>

            <button
              type="button"
              onClick={handleDeleteImmediately}
              className="w-full flex items-center justify-center p-2.5 text-rose-600 hover:bg-rose-50 rounded-xl text-xs font-semibold transition-all border border-rose-200 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5 shrink-0" />
              <span>3. Bỏ qua &amp; Xóa toàn bộ dữ liệu</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

