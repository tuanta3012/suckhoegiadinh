import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ToastProvider } from './context/ToastContext.tsx';
import { ConfirmDialogProvider } from './context/ConfirmDialogContext.tsx';
import { enforceFreshInstallCleanState, autoCleanupStartupCache } from './utils/secureStorage.ts';
import './index.css';

async function bootstrapApp() {
  try {
    // Tầng 3 (Runtime Keystore Guard): Chặn triệt để Google One Zombie restore trên cài đặt mới
    await enforceFreshInstallCleanState();
    await autoCleanupStartupCache();
  } catch (err) {
    console.error('[Bootstrap] Lỗi khởi tạo Runtime Keystore Guard:', err);
  }

  const container = document.getElementById('root');
  if (container) {
    createRoot(container).render(
      <StrictMode>
        <ErrorBoundary>
          <ToastProvider>
            <ConfirmDialogProvider>
              <App />
            </ConfirmDialogProvider>
          </ToastProvider>
        </ErrorBoundary>
      </StrictMode>
    );
  }
}

bootstrapApp();
