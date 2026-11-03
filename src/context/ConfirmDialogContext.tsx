import React, { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | undefined>(undefined);

export const ConfirmDialogProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const pendingResolve = useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions) => {
    pendingResolve.current?.(false);
    return new Promise<boolean>((resolve) => {
      pendingResolve.current = resolve;
      setRequest({ ...options, resolve });
    });
  }, []);

  const resolveRequest = (confirmed: boolean) => {
    request?.resolve(confirmed);
    pendingResolve.current = null;
    setRequest(null);
  };

  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') resolveRequest(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [request]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {request && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xs animate-in fade-in duration-150"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) resolveRequest(false);
          }}
        >
          <section
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-dialog-title"
            aria-describedby="confirm-dialog-message"
            className="w-full max-w-sm overflow-hidden rounded-2xl border border-rose-200 bg-white shadow-2xl animate-in zoom-in-95 duration-150"
          >
            <div className="flex items-center gap-3 border-b border-rose-100 bg-rose-50/80 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-rose-200 bg-rose-100 text-rose-700">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <h2 id="confirm-dialog-title" className="text-sm font-extrabold text-slate-900">
                {request.title}
              </h2>
            </div>
            <p id="confirm-dialog-message" className="px-4 py-4 text-sm leading-relaxed text-slate-600">
              {request.message}
            </p>
            <div className="grid grid-cols-2 gap-2 border-t border-slate-100 bg-slate-50 p-3">
              <button
                type="button"
                autoFocus
                onClick={() => resolveRequest(false)}
                className="rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-xs font-bold text-slate-700 transition-colors hover:bg-slate-100"
              >
                {request.cancelLabel || 'Hủy'}
              </button>
              <button
                type="button"
                onClick={() => resolveRequest(true)}
                className="rounded-xl bg-rose-600 px-3 py-2.5 text-xs font-extrabold text-white shadow-sm transition-colors hover:bg-rose-700 active:bg-rose-800"
              >
                {request.confirmLabel || 'Xóa'}
              </button>
            </div>
          </section>
        </div>
      )}
    </ConfirmContext.Provider>
  );
};

export const useConfirmDialog = (): ConfirmContextValue => {
  const context = useContext(ConfirmContext);
  if (!context) {
    throw new Error('useConfirmDialog must be used within ConfirmDialogProvider');
  }
  return context;
};
