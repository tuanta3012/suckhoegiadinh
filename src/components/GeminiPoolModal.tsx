import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Key,
  Layers,
  RefreshCw,
  Shield,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { geminiPool, type PoolSummaryState, TASK_MODEL_CONFIG } from '../utils/geminiPoolManager';
import { useToast } from '../context/ToastContext';

interface GeminiPoolModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function GeminiPoolModal({ isOpen, onClose }: GeminiPoolModalProps) {
  const { showToast } = useToast();
  const [poolState, setPoolState] = useState<PoolSummaryState>(() => geminiPool.getPoolState());
  const [isEditing, setIsEditing] = useState(false);
  const [keysInput, setKeysInput] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const update = () => setPoolState(geminiPool.getPoolState());
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, [isOpen]);

  const handleOpenEdit = () => {
    const currentKeys = geminiPool.getKeys();
    setKeysInput(currentKeys.join('\n'));
    setIsEditing(true);
  };

  const handleSaveKeys = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const parsedKeys = keysInput
        .split(/[\n,;]+/)
        .map((k) => k.trim())
        .filter((k) => k.length > 5);

      await geminiPool.setKeys(parsedKeys);
      setPoolState(geminiPool.getPoolState());
      setIsEditing(false);
      showToast(`Đã lưu ${parsedKeys.length} khóa API Gemini vào kho bảo mật.`, 'success');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Không thể lưu khóa.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-700 w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-lg text-white flex items-center gap-2">
                Trung tâm Quản lý 6 API Key Gemini
              </h3>
              <p className="text-xs text-slate-400">
                Điều phối đa luồng • Tự động failover • Phân luồng theo nhiệm vụ
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto space-y-6 flex-1 text-slate-200 text-sm">
          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-slate-800/60 border border-slate-700/60 p-3 rounded-xl">
              <span className="text-xs text-slate-400 block mb-1">Khóa hoạt động</span>
              <div className="text-xl font-bold text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                {poolState.activeKeys} / {poolState.totalKeys}
              </div>
            </div>
            <div className="bg-slate-800/60 border border-slate-700/60 p-3 rounded-xl">
              <span className="text-xs text-slate-400 block mb-1">Đang Cooldown</span>
              <div className="text-xl font-bold text-amber-400 flex items-center gap-1.5">
                <RefreshCw className="w-4 h-4" />
                {poolState.cooldownKeys}
              </div>
            </div>
            <div className="bg-slate-800/60 border border-slate-700/60 p-3 rounded-xl">
              <span className="text-xs text-slate-400 block mb-1">Luồng đang chạy</span>
              <div className="text-xl font-bold text-sky-400 flex items-center gap-1.5">
                <Zap className="w-4 h-4" />
                {poolState.activeConcurrent} req
              </div>
            </div>
            <div className="bg-slate-800/60 border border-slate-700/60 p-3 rounded-xl">
              <span className="text-xs text-slate-400 block mb-1">Hàng đợi</span>
              <div className="text-xl font-bold text-indigo-400 flex items-center gap-1.5">
                <Layers className="w-4 h-4" />
                {poolState.queueLength} chờ
              </div>
            </div>
          </div>

          {/* Task-Based Routing Specs */}
          <div className="border border-slate-800 rounded-xl bg-slate-950/40 p-4 space-y-3">
            <h4 className="font-medium text-slate-200 text-xs uppercase tracking-wider flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
              Cấu hình phân luồng nhiệm vụ & Quota miễn phí
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                <div className="font-semibold text-emerald-400 mb-1 flex items-center justify-between">
                  <span>1. Số hóa, OCR & Sắp xếp dữ liệu</span>
                  <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/20">
                    RPM 15 • RPD 500
                  </span>
                </div>
                <p className="text-slate-400 text-[11px] mb-2 leading-relaxed">
                  {TASK_MODEL_CONFIG.digitization.description}
                </p>
                <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-slate-300">
                  {TASK_MODEL_CONFIG.digitization.primaryModels.map((m) => (
                    <span key={m} className="bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                      {m}
                    </span>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-emerald-500/80">
                  Tổng 6 key: tối đa 90 RPM (3.000 req/ngày)
                </div>
              </div>

              <div className="bg-slate-900/80 p-3 rounded-lg border border-slate-800">
                <div className="font-semibold text-sky-400 mb-1 flex items-center justify-between">
                  <span>2. Đánh giá hồ sơ y tế & Lời khuyên</span>
                  <span className="text-[10px] bg-sky-500/10 text-sky-400 px-2 py-0.5 rounded border border-sky-500/20">
                    RPM 5 • RPD 20
                  </span>
                </div>
                <p className="text-slate-400 text-[11px] mb-2 leading-relaxed">
                  {TASK_MODEL_CONFIG.analysis.description}
                </p>
                <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-slate-300">
                  {TASK_MODEL_CONFIG.analysis.primaryModels.map((m) => (
                    <span key={m} className="bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                      {m}
                    </span>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-sky-500/80">
                  Tổng 6 key: tối đa 30 RPM (120 req/ngày)
                </div>
              </div>
            </div>
          </div>

          {/* Key Pool List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-medium text-slate-200 text-xs uppercase tracking-wider flex items-center gap-2">
                <Shield className="w-3.5 h-3.5 text-indigo-400" />
                Danh sách 6 Tài khoản Google trong kho ({poolState.keys.length} khóa)
              </h4>
              <button
                onClick={handleOpenEdit}
                className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-medium transition-colors"
              >
                <Key className="w-3.5 h-3.5" />
                Cập nhật danh sách khóa
              </button>
            </div>

            {poolState.keys.length === 0 ? (
              <div className="bg-slate-950/60 border border-dashed border-slate-800 rounded-xl p-6 text-center">
                <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-2 opacity-80" />
                <p className="text-slate-300 font-medium mb-1">Chưa có API Key nào được nạp</p>
                <p className="text-slate-500 text-xs mb-3">
                  Bạn có thể thêm 6 API key từ biến môi trường GEMINI_API_KEYS hoặc nhập trực tiếp tại đây.
                </p>
                <button
                  onClick={handleOpenEdit}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-all"
                >
                  Nhập danh sách 6 khóa API
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {poolState.keys.map((k) => (
                  <div
                    key={k.index}
                    className="bg-slate-800/40 border border-slate-800 rounded-xl p-3 flex flex-col justify-between"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-slate-750 flex items-center justify-center text-xs font-semibold text-slate-300">
                          #{k.index}
                        </div>
                        <div>
                          <span className="font-medium text-slate-200 block text-xs">{k.label}</span>
                          <span className="font-mono text-[11px] text-slate-500">{k.maskedKey}</span>
                        </div>
                      </div>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded font-medium border ${
                          k.status === 'active'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : k.status === 'cooldown'
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                            : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                        }`}
                      >
                        {k.status === 'active'
                          ? 'Sẵn sàng'
                          : k.status === 'cooldown'
                          ? `Cooldown (${k.cooldownRemainingSec}s)`
                          : 'Vô hiệu hóa'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-800/60">
                      <span>Hôm nay: <b className="text-slate-300">{k.todayCalls}</b> lượt</span>
                      <span className="text-emerald-400/90">Thành công: <b>{k.totalSuccess}</b></span>
                      {k.totalFailures > 0 && (
                        <span className="text-rose-400/90">Lỗi: <b>{k.totalFailures}</b></span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Edit Modal / Form Drawer */}
          {isEditing && (
            <form onSubmit={handleSaveKeys} className="bg-slate-950 p-4 rounded-xl border border-indigo-500/30 space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-xs text-indigo-300 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5" />
                  Nhập 6 API key (Mỗi dòng một key hoặc phân tách bằng dấu phẩy)
                </span>
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="text-slate-500 hover:text-slate-300 text-xs"
                >
                  Hủy
                </button>
              </div>
              <textarea
                value={keysInput}
                onChange={(e) => setKeysInput(e.target.value)}
                rows={6}
                placeholder="AIzaSy...&#10;AIzaSy...&#10;AIzaSy...&#10;AIzaSy...&#10;AIzaSy...&#10;AIzaSy..."
                className="w-full bg-slate-900 border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:bg-slate-800"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-1.5 rounded-lg text-xs bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
                >
                  {isSaving ? 'Đang lưu...' : 'Lưu vào kho an toàn'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Cơ chế Failover tự động bảo toàn 100% khi xảy ra 429 hoặc lỗi tạm thời
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
