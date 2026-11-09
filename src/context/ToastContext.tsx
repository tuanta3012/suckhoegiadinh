import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastType = 'success' | 'info' | 'error';

interface ToastContextType {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const nextId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastType = 'info', duration = 3500) => {
    // Only allow error notifications (red) as requested by user
    if (type !== 'error') return;

    if (timer.current) clearTimeout(timer.current);
    const id = ++nextId.current;
    setToast({ id, message, type });
    timer.current = setTimeout(() => setToast((current) => current?.id === id ? null : current), duration);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toast && (
        <div
          role={toast.type === 'error' ? 'alert' : 'status'}
          className={`fixed top-20 left-1/2 z-[100] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-xl px-4 py-3 text-sm font-semibold shadow-xl ${
            toast.type === 'error'
              ? 'bg-rose-700 text-white'
              : toast.type === 'success'
                ? 'bg-emerald-700 text-white'
                : 'bg-slate-900 text-white'
          }`}
        >
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
};
