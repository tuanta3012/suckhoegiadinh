import React from 'react';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Layers,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { BackPriority, useBackHandler } from '../utils/backNavigation';
import type { CapturedPageItem } from '../utils/cameraDocumentBundle';

interface MultiPageCaptureModalProps {
  isOpen: boolean;
  pages: CapturedPageItem[];
  targetLabel: string;
  isAutoDetect: boolean;
  isCapturing: boolean;
  isFinalizing: boolean;
  onCaptureNext: () => void;
  onRemovePage: (pageId: string) => void;
  onMovePage: (pageId: string, direction: 'left' | 'right') => void;
  onComplete: () => void;
  onCancel: () => void;
}

export const MultiPageCaptureModal: React.FC<MultiPageCaptureModalProps> = ({
  isOpen,
  pages,
  targetLabel,
  isAutoDetect,
  isCapturing,
  isFinalizing,
  onCaptureNext,
  onRemovePage,
  onMovePage,
  onComplete,
  onCancel,
}) => {
  useBackHandler(
    isOpen,
    () => {
      if (!isCapturing && !isFinalizing) {
        onCancel();
      }
      return true;
    },
    BackPriority.MODAL,
  );

  if (!isOpen) return null;

  const isBusy = isCapturing || isFinalizing;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-950/60 backdrop-blur-xs p-0 sm:p-4 animate-in fade-in duration-150"
      onClick={() => {
        if (!isBusy) onCancel();
      }}
    >
      <div
        className="w-full sm:max-w-md max-h-[88vh] bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-3 border-b border-slate-100 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-teal-50 text-teal-600 flex items-center justify-center shrink-0">
              <Layers className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-extrabold text-slate-900 truncate">
                Tài liệu ({pages.length} trang)
              </h3>
              <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500">
                {isAutoDetect ? (
                  <Sparkles className="w-3 h-3 text-emerald-600 shrink-0" />
                ) : (
                  <User className="w-3 h-3 text-slate-500 shrink-0" />
                )}
                <span className="truncate">{targetLabel}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={isBusy}
            onClick={onCancel}
            aria-label="Đóng"
            className="w-8 h-8 rounded-full bg-slate-100 hover:bg-slate-200 text-slate-500 flex items-center justify-center shrink-0 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3.5 overflow-y-auto flex-1">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            {pages.map((page, index) => (
              <div
                key={page.id}
                className="relative aspect-[3/4] rounded-2xl overflow-hidden border border-slate-200 bg-slate-100 group"
              >
                <img
                  src={page.previewUrl}
                  alt={`Trang ${index + 1}`}
                  className="w-full h-full object-cover"
                />
                <span className="absolute top-1.5 left-1.5 px-2 py-0.5 rounded-lg bg-slate-900/75 text-white text-[10px] font-bold">
                  Trang {index + 1}
                </span>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => onRemovePage(page.id)}
                  aria-label={`Xóa trang ${index + 1}`}
                  className="absolute top-1.5 right-1.5 w-7 h-7 rounded-lg bg-white/90 hover:bg-rose-50 text-rose-600 flex items-center justify-center shadow-xs disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                {pages.length > 1 && (
                  <div className="absolute bottom-1.5 inset-x-1.5 flex items-center justify-between gap-1">
                    <button
                      type="button"
                      disabled={isBusy || index === 0}
                      onClick={() => onMovePage(page.id, 'left')}
                      aria-label="Chuyển lên trước"
                      className="w-7 h-7 rounded-lg bg-white/90 text-slate-700 flex items-center justify-center shadow-xs disabled:opacity-30"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      disabled={isBusy || index === pages.length - 1}
                      onClick={() => onMovePage(page.id, 'right')}
                      aria-label="Chuyển ra sau"
                      className="w-7 h-7 rounded-lg bg-white/90 text-slate-700 flex items-center justify-center shadow-xs disabled:opacity-30"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            ))}

            <button
              type="button"
              disabled={isBusy}
              onClick={onCaptureNext}
              className="aspect-[3/4] rounded-2xl border-2 border-dashed border-emerald-300 bg-emerald-50/40 hover:bg-emerald-50 active:scale-[0.98] text-emerald-700 flex flex-col items-center justify-center gap-1.5 transition-all disabled:opacity-40"
            >
              <div className="w-9 h-9 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-xs">
                <Plus className="w-5 h-5" />
              </div>
              <span className="text-xs font-bold">Chụp tiếp</span>
            </button>
          </div>
        </div>

        <div className="p-3.5 border-t border-slate-100 bg-slate-50/80 grid grid-cols-2 gap-2.5 shrink-0 safe-area-bottom">
          <button
            type="button"
            disabled={isBusy}
            onClick={onCaptureNext}
            className="min-h-[46px] px-3 py-2.5 rounded-2xl border border-emerald-200 bg-white hover:bg-emerald-50 active:scale-[0.98] text-emerald-700 font-extrabold text-xs flex items-center justify-center gap-1.5 transition-all disabled:opacity-50"
          >
            {isCapturing ? (
              <LoaderCircle className="w-4 h-4 animate-spin shrink-0" />
            ) : (
              <Camera className="w-4 h-4 shrink-0" />
            )}
            <span>Chụp tiếp</span>
          </button>
          <button
            type="button"
            disabled={isBusy || pages.length === 0}
            onClick={onComplete}
            className="min-h-[46px] px-3 py-2.5 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-extrabold text-xs flex items-center justify-center gap-1.5 shadow-sm transition-all disabled:opacity-50"
          >
            {isFinalizing ? (
              <>
                <LoaderCircle className="w-4 h-4 animate-spin shrink-0" />
                <span>Đang xử lý...</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4 shrink-0" />
                <span>{pages.length >= 2 ? `Gộp PDF (${pages.length})` : 'Xác nhận (1)'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
