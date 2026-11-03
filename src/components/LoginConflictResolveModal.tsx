import { AlertTriangle, HardDriveDownload, Merge, PlusCircle } from 'lucide-react';
import { useConfirmDialog } from '../context/ConfirmDialogContext';

interface LoginConflictResolveModalProps {
  isOpen: boolean;
  onClose: () => void;
  fileName: string;
  localBooksCount: number;
  onResolveMerge: () => void;
  onResolveOverwriteLocal: () => void;
  onResolveCreateNewFile: () => void;
}

export function LoginConflictResolveModal({
  isOpen,
  onClose,
  fileName,
  localBooksCount,
  onResolveMerge,
  onResolveOverwriteLocal,
  onResolveCreateNewFile,
}: LoginConflictResolveModalProps) {
  const { confirm } = useConfirmDialog();
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="p-5 border-b border-slate-800 flex items-center gap-3">
          <div className="p-2 rounded-xl bg-amber-500/15 text-amber-400">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-bold text-white">Dữ liệu khác nhau</h2>
            <p className="text-xs text-slate-400 truncate">
              Drive: {fileName} · Máy: {localBooksCount} sổ
            </p>
          </div>
        </div>

        <div className="p-4 space-y-2">
          <button
            type="button"
            onClick={onResolveMerge}
            className="w-full p-3 rounded-xl bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-700/60 text-left text-emerald-200 font-semibold flex items-center gap-3 transition-colors"
          >
            <Merge className="w-5 h-5 shrink-0 text-emerald-400" />
            <span>Gộp dữ liệu</span>
          </button>

          <button
            type="button"
            onClick={async () => {
              if (await confirm({
                title: 'Thay dữ liệu trên máy?',
                message: `${localBooksCount} sổ sẽ được thay bằng dữ liệu Drive.`,
                confirmLabel: 'Thay dữ liệu',
              })) {
                onResolveOverwriteLocal();
              }
            }}
            className="w-full p-3 rounded-xl bg-rose-950/40 hover:bg-rose-900/50 border border-rose-800/60 text-left text-rose-200 font-semibold flex items-center gap-3 transition-colors"
          >
            <HardDriveDownload className="w-5 h-5 shrink-0 text-rose-400" />
            <span>Dùng dữ liệu Drive</span>
          </button>

          <button
            type="button"
            onClick={onResolveCreateNewFile}
            className="w-full p-3 rounded-xl bg-slate-800/70 hover:bg-slate-800 border border-slate-700 text-left text-slate-200 font-semibold flex items-center gap-3 transition-colors"
          >
            <PlusCircle className="w-5 h-5 shrink-0 text-slate-400" />
            <span>Tạo file mới</span>
          </button>
        </div>

        <div className="px-4 pb-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            Tiếp tục ngoại tuyến
          </button>
        </div>
      </div>
    </div>
  );
}
