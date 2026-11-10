import { AlertTriangle, Check, Eye, KeyRound, LoaderCircle, Save, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  loadSharedAiResources,
  saveSharedAiResources,
} from '../utils/healthDriveService';
import {
  parseGeminiKeyInput,
  setSharedGeminiKeys,
  testGeminiApiKey,
} from '../utils/geminiSharedResources';

interface AiResourcesModalProps {
  isOpen: boolean;
  folderId: string;
  isAdmin: boolean;
  onClose: () => void;
}

export function AiResourcesModal({ isOpen, folderId, isAdmin, onClose }: AiResourcesModalProps) {
  const [keys, setKeys] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setIsLoading(true);
    setMessage('');
    setError('');
    void loadSharedAiResources(folderId)
      .then(({ keys: loadedKeys }) => {
        if (!active) return;
        setKeys(loadedKeys);
        setSharedGeminiKeys(loadedKeys);
        if (isAdmin) setInput(loadedKeys.join('\n'));
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : 'Không thể đọc Tài nguyên AI từ Drive.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [folderId, isAdmin, isOpen]);

  if (!isOpen) return null;

  async function testAndSave() {
    const parsedKeys = parseGeminiKeyInput(input);
    if (parsedKeys.length === 0) {
      setError('Nhập ít nhất một API key.');
      return;
    }

    setIsTesting(true);
    setError('');
    setMessage('');
    try {
      const failures: string[] = [];
      for (let index = 0; index < parsedKeys.length; index += 1) {
        try {
          await testGeminiApiKey(parsedKeys[index]);
        } catch (testError) {
          const reason = testError instanceof Error ? testError.message : 'Lỗi không xác định.';
          failures.push(`Key ${index + 1}: ${reason}`);
        }
      }
      if (failures.length > 0) {
        setError(`Kiểm tra thất bại (${failures.length}/${parsedKeys.length}). ${failures.join(' ')}`);
        return;
      }
      await saveSharedAiResources(folderId, parsedKeys);
      setSharedGeminiKeys(parsedKeys);
      setKeys(parsedKeys);
      setInput(parsedKeys.join('\n'));
      setMessage(`Đã kiểm tra và lưu ${parsedKeys.length} key.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Không thể lưu Tài nguyên AI lên Drive.');
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-resources-title"
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <KeyRound className="h-5 w-5 text-teal-600" />
            <h2 id="ai-resources-title" className="text-base font-bold text-slate-800">Tài nguyên AI</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Đóng" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 p-5">
          <div className="flex gap-2 rounded-xl bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Key được lưu dạng đọc được trong folder Drive dùng chung. Thành viên có quyền folder có thể lấy và dùng key bên ngoài app.</p>
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-slate-500">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Đang đọc folder dùng chung...
            </div>
          ) : isAdmin ? (
            <>
              <label htmlFor="ai-resource-keys" className="block text-xs font-semibold text-slate-600">
                API key (ngăn cách bằng dấu phẩy hoặc xuống dòng)
              </label>
              <textarea
                id="ai-resource-keys"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                rows={5}
                autoComplete="off"
                spellCheck={false}
                placeholder="Nhập một hoặc nhiều Gemini API key"
                className="w-full resize-y rounded-xl border border-slate-200 px-3 py-2.5 font-mono text-xs text-slate-800 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
              />
              <button
                type="button"
                disabled={isTesting}
                onClick={() => void testAndSave()}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-teal-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-teal-700 disabled:opacity-50"
              >
                {isTesting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {isTesting ? 'Đang kiểm tra và lưu...' : 'Test key & lưu'}
              </button>
            </>
          ) : (
            <div className="rounded-xl bg-slate-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-600">
                <Eye className="h-4 w-4" /> Chỉ xem · {keys.length} key
              </div>
              {keys.length > 0 ? (
                <ul className="space-y-1 font-mono text-xs text-slate-500">
                  {keys.map((key, index) => (
                    <li key={`${index}-${key.length}`} className="truncate">
                      Key {index + 1}: {`${key.slice(0, 4)}${'•'.repeat(8)}${key.slice(-4)}`}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-slate-400">Chưa có key được chia sẻ.</p>
              )}
            </div>
          )}

          {error && <p role="alert" className="text-xs leading-relaxed text-rose-600">{error}</p>}
          {message && (
            <p role="status" className="flex items-center gap-1.5 text-xs text-emerald-700">
              <Check className="h-4 w-4" /> {message}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
