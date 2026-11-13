import React, { useState } from 'react';
import {
  CheckCircle2,
  FolderSync,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { HealthDriveWorkspace } from '../utils/healthDriveService';
import type { HealthProfile } from '../types';
import { cleanupWorkspaceDuplicates } from '../utils/workspaceAuditService';
import {
  loadHealthProfile,
  saveHealthProfile,
  listRawFiles,
  restoreTrashedDriveFile,
  trashDriveFile,
} from '../utils/healthDriveService';
import { BackPriority, useBackHandler } from '../utils/backNavigation';

interface WorkspaceAuditModalProps {
  isOpen: boolean;
  workspace: HealthDriveWorkspace | null;
  profiles: Record<string, HealthProfile>;
  userEmail: string | null;
  onClose: () => void;
  onFactoryReset: () => Promise<void>;
  showToast: (msg: string, type: 'success' | 'error' | 'info') => void;
}

export function WorkspaceAuditModal({
  isOpen,
  workspace,
  profiles,
  userEmail,
  onClose,
  onFactoryReset,
  showToast,
}: WorkspaceAuditModalProps) {
  const [isCleaning, setIsCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{ deletedRawFiles: number; mergedEvents: number } | null>(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);

  const [isResetting, setIsResetting] = useState(false);
  const [isConfirmingReset, setIsConfirmingReset] = useState(false);

  useBackHandler(
    isOpen,
    () => {
      if (isConfirmingReset && !isResetting) {
        setIsConfirmingReset(false);
        return true;
      }
      if (!isCleaning && !isResetting) onClose();
      return true;
    },
    BackPriority.MODAL,
  );

  if (!isOpen) return null;

  const handleStartCleanup = async () => {
    if (!workspace) return;
    setIsCleaning(true);
    setCleanResult(null);
    setProgressPercent(10);
    setProgressMsg('Đang rà soát toàn bộ tệp raw trên Google Drive...');

    try {
      const result = await cleanupWorkspaceDuplicates(
        workspace,
        async (fileId) => loadHealthProfile(fileId),
        async (fileId, prof) => saveHealthProfile(fileId, prof),
        async (member) => listRawFiles(member),
        async (fileId) => trashDriveFile(fileId),
        async (fileId) => restoreTrashedDriveFile(fileId),
        (prog) => {
          setProgressPercent(prog.percent);
          setProgressMsg(prog.message);
        }
      );
      setCleanResult(result);
      showToast(
        `Đã dọn dẹp sạch sẽ: Xóa ${result.deletedRawFiles} tệp thừa & Hợp nhất ${result.mergedEvents} sự kiện!`,
        'success'
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể dọn dẹp thư mục.', 'error');
    } finally {
      setIsCleaning(false);
    }
  };

  const executeFactoryReset = async () => {
    setIsResetting(true);
    try {
      await onFactoryReset();
      showToast('Đã xóa toàn bộ dữ liệu và khởi tạo lại Workspace sạch sẽ.', 'success');
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể khởi tạo lại thư mục.', 'error');
    } finally {
      setIsResetting(false);
      setIsConfirmingReset(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-slate-900 border border-slate-700/80 w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-teal-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-teal-500/20">
              <FolderSync className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base sm:text-lg text-white">
                Dọn dẹp & Tối ưu Thư mục
              </h3>
              <p className="text-xs text-slate-400">
                Tự động quét trùng lặp và giữ lại bản duy nhất
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            aria-label="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-5 flex-1 text-slate-200 text-sm">
          {/* Main Auto-Cleanup Card */}
          <div className="bg-gradient-to-br from-teal-950/40 to-slate-800/80 border border-teal-500/30 p-5 rounded-2xl space-y-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-teal-500/20 text-teal-400 flex items-center justify-center shrink-0 mt-0.5">
                <Sparkles className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h4 className="font-bold text-white text-sm sm:text-base">
                  Dọn dẹp tệp & sự kiện trùng lặp
                </h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Tự động xóa tệp gốc trùng/đã bao trùm trên Drive và gộp sự kiện trùng lặp.
                </p>
              </div>
            </div>

            {isCleaning && (
              <div className="space-y-2 pt-2 border-t border-teal-500/20 animate-in fade-in">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-teal-300 font-medium truncate">{progressMsg}</span>
                  <span className="font-mono text-teal-400 font-bold">{progressPercent}%</span>
                </div>
                <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                  <div
                    className="bg-teal-500 h-full transition-all duration-300 rounded-full"
                    style={{ width: `${Math.max(5, progressPercent)}%` }}
                  />
                </div>
              </div>
            )}

            {cleanResult && !isCleaning && (
              <div className="p-3 bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 rounded-xl text-xs flex items-center gap-2 animate-in fade-in">
                <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                <span>
                  Đã dọn dẹp thành công: Xóa <b>{cleanResult.deletedRawFiles}</b> tệp raw thừa & Hợp nhất <b>{cleanResult.mergedEvents}</b> sự kiện!
                </span>
              </div>
            )}

            <button
              type="button"
              onClick={() => void handleStartCleanup()}
              disabled={isCleaning}
              className="w-full py-3 rounded-xl bg-teal-600 hover:bg-teal-500 disabled:opacity-50 active:scale-[0.99] text-white font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-lg"
            >
              <RefreshCw className={`w-4 h-4 ${isCleaning ? 'animate-spin' : ''}`} />
              <span>{isCleaning ? 'Đang dọn dẹp...' : 'Bắt đầu Dọn dẹp & Check trùng ngay'}</span>
            </button>
          </div>

          {/* Factory Reset Section */}
          <div className="border border-rose-500/20 bg-rose-500/5 rounded-2xl p-4 sm:p-5 space-y-3">
            <div className="flex items-center gap-2 text-rose-400">
              <ShieldAlert className="w-5 h-5 shrink-0" />
              <h4 className="font-bold text-sm">Xóa toàn bộ dữ liệu & Khởi tạo lại</h4>
            </div>
            
            <p className="text-xs text-slate-400 leading-relaxed">
              Thao tác này sẽ xóa vĩnh viễn tất cả hồ sơ và tệp gốc trên Google Drive để bạn bắt đầu lại từ đầu. Hãy cẩn thận, không thể hoàn tác.
            </p>

            <div className="pt-1">
              {!isConfirmingReset ? (
                <button
                  type="button"
                  onClick={() => setIsConfirmingReset(true)}
                  className="w-full py-2.5 px-4 rounded-xl border border-rose-500/30 text-rose-500 hover:bg-rose-500/10 font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Yêu cầu khởi tạo lại Workspace</span>
                </button>
              ) : (
                <div className="space-y-2 animate-in zoom-in-95 duration-200">
                  <button
                    type="button"
                    disabled={isResetting}
                    onClick={() => void executeFactoryReset()}
                    className="w-full py-3 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-black text-xs flex items-center justify-center gap-2 transition-all shadow-lg shadow-rose-600/20"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>{isResetting ? 'Đang thực hiện xóa...' : 'XÁC NHẬN XÓA VĨNH VIỄN'}</span>
                  </button>
                  <button
                    type="button"
                    disabled={isResetting}
                    onClick={() => setIsConfirmingReset(false)}
                    className="w-full py-2 rounded-xl text-slate-500 hover:text-slate-300 font-bold text-[11px] transition-all"
                  >
                    Tôi đã đổi ý, đừng xóa
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <RotateCcw className="w-3 h-3 text-teal-400" />
            <span>Tự động tối ưu hóa</span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-white font-bold transition-all"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
