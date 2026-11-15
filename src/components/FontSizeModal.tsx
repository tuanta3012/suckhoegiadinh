import { Minus, Plus, Type, X } from 'lucide-react';
import { BackPriority, useBackHandler } from '../utils/backNavigation';

interface FontSizeModalProps {
  isOpen: boolean;
  scale: number;
  onChange: (scale: number) => void;
  onClose: () => void;
}

function getScaleLabel(scale: number): string {
  const adjustment = scale - 100;
  return `${adjustment > 0 ? '+' : ''}${adjustment}%`;
}

export function FontSizeModal({ isOpen, scale, onChange, onClose }: FontSizeModalProps) {
  useBackHandler(isOpen, () => {
    onClose();
    return true;
  }, BackPriority.TOP_MODAL);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="font-size-title"
        className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
              <Type className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="font-size-title" className="text-base font-bold text-slate-900">Cỡ chữ</h2>
              <p className="text-xs text-slate-500">Điều chỉnh chữ trên toàn ứng dụng</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Đóng điều chỉnh cỡ chữ"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mb-4 flex items-center justify-center gap-3 rounded-2xl bg-slate-50 py-4">
          <Type className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <output className="min-w-20 text-center text-2xl font-bold tabular-nums text-emerald-700" aria-live="polite">
            {getScaleLabel(scale)}
          </output>
          <Type className="h-7 w-7 text-slate-700" aria-hidden="true" />
        </div>

        <label htmlFor="app-font-size" className="sr-only">Cỡ chữ toàn ứng dụng</label>
        <input
          id="app-font-size"
          type="range"
          min={50}
          max={150}
          step={10}
          value={scale}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
          className="h-2 w-full cursor-pointer accent-emerald-600"
          aria-valuetext={getScaleLabel(scale)}
        />
        <div className="mt-2 flex justify-between text-xs text-slate-500" aria-hidden="true">
          <span className="flex items-center gap-1"><Minus className="h-3 w-3" />-50%</span>
          <span>Mặc định</span>
          <span className="flex items-center gap-1">+50%<Plus className="h-3 w-3" /></span>
        </div>

        <button
          type="button"
          onClick={() => onChange(100)}
          disabled={scale === 100}
          className="mt-5 w-full rounded-xl border border-slate-200 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-default disabled:opacity-45"
        >
          Đặt lại mặc định
        </button>
      </section>
    </div>
  );
}
