import React, { createContext, useContext, ReactNode } from 'react';

export type ToastType = 'success' | 'info' | 'error';

interface ToastContextType {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);
const ignoreToast: ToastContextType['showToast'] = () => undefined;

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  return (
    <ToastContext.Provider value={{ showToast: ignoreToast }}>
      {children}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextType => {
  const context = useContext(ToastContext);
  if (!context) {
    return { showToast: ignoreToast };
  }
  return context;
};
