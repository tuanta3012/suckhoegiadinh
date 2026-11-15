import { useState } from 'react';
import { Fingerprint, LoaderCircle, LockKeyhole, LogIn } from 'lucide-react';

interface OfflineLockScreenProps {
  email: string;
  onUnlock: () => Promise<void>;
  onSignIn: () => void;
}

export function OfflineLockScreen({ email, onUnlock, onSignIn }: OfflineLockScreenProps) {
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [error, setError] = useState('');

  async function handleUnlock() {
    setIsUnlocking(true);
    setError('');
    try {
      await onUnlock();
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : 'Không thể xác minh trên thiết bị.');
    } finally {
      setIsUnlocking(false);
    }
  }

  return (
    <main className="flex h-[100dvh] items-center justify-center bg-slate-950 px-5 safe-area-bottom">
      <section className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
          <LockKeyhole className="h-7 w-7" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-extrabold text-slate-900">Dữ liệu ngoại tuyến đang khóa</h1>
        <p className="mt-2 break-all text-sm text-slate-600">{email}</p>
        <p className="mt-3 text-sm leading-6 text-slate-500">
          Xác minh bằng vân tay hoặc mã khóa màn hình của thiết bị để chỉ xem bản dữ liệu đã lưu.
        </p>
        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-rose-50 p-3 text-left text-xs text-rose-700">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={() => void handleUnlock()}
          disabled={isUnlocking}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-60"
        >
          {isUnlocking
            ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
            : <Fingerprint className="h-5 w-5" aria-hidden="true" />}
          Mở bằng vân tay / mã khóa
        </button>
        <button
          type="button"
          onClick={onSignIn}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700"
        >
          <LogIn className="h-4 w-4" aria-hidden="true" />
          Đăng nhập Google
        </button>
      </section>
    </main>
  );
}
