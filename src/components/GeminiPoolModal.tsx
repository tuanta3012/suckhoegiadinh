import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cpu,
  Layers,
  RefreshCw,
  Server,
  ShieldCheck,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';

interface GeminiServerStatus {
  status: string;
  hasDefaultServerKey?: boolean;
  hasEnvPoolKeys?: boolean;
  totalServerKeys: number;
  supportedTasks?: string[];
  taskModels?: {
    digitization: string[];
    analysis: string[];
  };
  architecture?: string;
}

interface GeminiPoolModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function GeminiPoolModal({ isOpen, onClose }: GeminiPoolModalProps) {
  const [serverStatus, setServerStatus] = useState<GeminiServerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/gemini/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as GeminiServerStatus;
      setServerStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không thể kết nối máy chủ AI');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void fetchStatus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const totalKeys = serverStatus?.totalServerKeys ?? 0;
  const isHealthy = Boolean(serverStatus && totalKeys > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/70 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-slate-900 border border-slate-700/80 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-emerald-500 flex items-center justify-center text-white shadow-lg shadow-indigo-500/20">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base sm:text-lg text-white flex items-center gap-2">
                Hệ thống AI Gemini Server
              </h3>
              <p className="text-xs text-slate-400">
                Điều phối tự động • Bảo mật Server-Side • Cân bằng tải đa luồng
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
          {/* Status Banner */}
          <div
            className={`p-4 rounded-2xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
              isHealthy
                ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                : 'bg-amber-950/30 border-amber-500/30 text-amber-200'
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                  isHealthy ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-400'
                }`}
              >
                {isHealthy ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
              </div>
              <div>
                <div className="font-bold text-sm text-white flex items-center gap-2">
                  <span>
                    {isHealthy ? 'Máy chủ AI đang hoạt động tối ưu' : 'Đang đồng bộ cấu hình máy chủ'}
                  </span>
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                </div>
                <p className="text-xs text-slate-300 mt-0.5 leading-relaxed">
                  {isHealthy
                    ? `Đã nạp thành công ${totalKeys} khóa API từ biến môi trường máy chủ (GEMINI_API_KEYS).`
                    : 'Chưa tìm thấy khóa API trên máy chủ. Đang chờ kết nối.'}
                </p>
              </div>
            </div>

            <button
              onClick={() => void fetchStatus()}
              disabled={isLoading}
              className="self-end sm:self-center px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-200 flex items-center gap-1.5 transition-all active:scale-95 shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-emerald-400' : ''}`} />
              <span>{isLoading ? 'Đang kiểm tra...' : 'Kiểm tra lại'}</span>
            </button>
          </div>

          {error && (
            <div className="p-3 bg-rose-950/40 border border-rose-500/30 text-rose-300 rounded-xl text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
              <span>Lỗi kết nối máy chủ: {error}</span>
            </div>
          )}

          {/* Quick Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-slate-800/50 border border-slate-700/60 p-3.5 rounded-2xl">
              <span className="text-xs text-slate-400 block mb-1 flex items-center gap-1">
                <Server className="w-3.5 h-3.5 text-indigo-400" />
                Khóa API Máy chủ
              </span>
              <div className="text-xl font-bold text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                {totalKeys} khóa hoạt động
              </div>
              <span className="text-[10px] text-slate-500 block mt-1">Từ GEMINI_API_KEYS</span>
            </div>

            <div className="bg-slate-800/50 border border-slate-700/60 p-3.5 rounded-2xl">
              <span className="text-xs text-slate-400 block mb-1 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                Kiến trúc Bảo mật
              </span>
              <div className="text-base font-bold text-white flex items-center gap-1.5">
                Server-Side 100%
              </div>
              <span className="text-[10px] text-slate-500 block mt-1">Không lộ khóa ở trình duyệt</span>
            </div>

            <div className="bg-slate-800/50 border border-slate-700/60 p-3.5 rounded-2xl col-span-2 sm:col-span-1">
              <span className="text-xs text-slate-400 block mb-1 flex items-center gap-1">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                Cơ chế Chống nghẽn
              </span>
              <div className="text-base font-bold text-amber-300">
                Tự động Failover
              </div>
              <span className="text-[10px] text-slate-500 block mt-1">Luân phiên tài khoản & model</span>
            </div>
          </div>

          {/* Task-Based Routing Hierarchy */}
          <div className="border border-slate-800 rounded-2xl bg-slate-950/40 p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-slate-200 text-xs uppercase tracking-wider flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-indigo-400" />
                Phân luồng 2 nhóm tác vụ theo mô hình tối ưu
              </h4>
              <span className="text-[11px] text-slate-400 font-mono">Tự động điều phối</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 text-xs">
              {/* Group 1 */}
              <div className="bg-slate-900/90 p-4 rounded-xl border border-slate-800 flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-bold text-emerald-400 text-sm">
                      1. Số hóa, OCR & Bóc tách
                    </span>
                    <span className="text-[10px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20 font-bold">
                      Tốc độ cao
                    </span>
                  </div>
                  <p className="text-slate-400 text-xs leading-relaxed">
                    Xử lý tài liệu y tế (ảnh đơn thuốc, kết quả xét nghiệm, phiếu khám, tệp PDF nhiều trang).
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-slate-300">
                    Thứ tự ưu tiên mô hình:
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between bg-slate-800/80 px-2.5 py-1.5 rounded-lg border border-slate-700">
                      <span className="font-mono text-emerald-300 text-xs font-bold">
                        1. gemini-3.5-flash-lite
                      </span>
                      <span className="text-[10px] text-emerald-400 font-bold">Ưu tiên chính</span>
                    </div>
                    <div className="flex items-center justify-between bg-slate-800/50 px-2.5 py-1.5 rounded-lg border border-slate-800">
                      <span className="font-mono text-slate-300 text-xs">
                        2. gemini-3.1-flash-lite
                      </span>
                      <span className="text-[10px] text-slate-400">Dự phòng</span>
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-800/80">
                  ⚡ Điều phối qua <b className="text-emerald-400">{totalKeys}</b> khóa API (ước tính tối đa ~{totalKeys * 15} lượt/phút).
                </div>
              </div>

              {/* Group 2 */}
              <div className="bg-slate-900/90 p-4 rounded-xl border border-slate-800 flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-bold text-indigo-400 text-sm">
                      2. Phân tích & Trợ lý bác sĩ
                    </span>
                    <span className="text-[10px] bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded-full border border-indigo-500/20 font-bold">
                      Chuyên sâu
                    </span>
                  </div>
                  <p className="text-slate-400 text-xs leading-relaxed">
                    Suy luận y khoa, đánh giá diễn tiến bệnh, cảnh báo tương tác thuốc và giải đáp thắc mắc sức khỏe.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-slate-300">
                    Thứ tự ưu tiên mô hình:
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between bg-slate-800/80 px-2.5 py-1.5 rounded-lg border border-slate-700">
                      <span className="font-mono text-indigo-300 text-xs font-bold">
                        1. gemini-3.8-flash
                      </span>
                      <span className="text-[10px] text-indigo-400 font-bold">Ưu tiên chính</span>
                    </div>
                    <div className="flex items-center justify-between bg-slate-800/50 px-2.5 py-1.5 rounded-lg border border-slate-800">
                      <span className="font-mono text-slate-300 text-xs">
                        2. gemini-3.6-flash
                      </span>
                      <span className="text-[10px] text-slate-400">Dự phòng 1</span>
                    </div>
                    <div className="flex items-center justify-between bg-slate-800/50 px-2.5 py-1.5 rounded-lg border border-slate-800">
                      <span className="font-mono text-slate-300 text-xs">
                        3. gemini-3-flash
                      </span>
                      <span className="text-[10px] text-slate-400">Dự phòng 2</span>
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-800/80">
                  🧠 Khả năng suy luận lâm sàng nâng cao với ngữ cảnh toàn diện.
                </div>
              </div>
            </div>
          </div>

          {/* Explanation Box */}
          <div className="bg-slate-950/50 border border-slate-800 p-4 rounded-2xl space-y-2 text-xs text-slate-300">
            <div className="font-bold text-slate-200 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              Tại sao bạn không cần nhập API Key ở đây nữa?
            </div>
            <p className="text-slate-400 leading-relaxed">
              Tất cả các khóa API đã được cấu hình trực tiếp trong biến môi trường bí mật <code className="text-emerald-400 bg-slate-900 px-1.5 py-0.5 rounded font-mono">GEMINI_API_KEYS</code> của máy chủ backend. Máy chủ tự động xoay vòng và bảo vệ các khóa này an toàn tuyệt đối, bạn và gia đình chỉ cần an tâm tải tài liệu lên sử dụng mà không cần thao tác kỹ thuật nào thêm!
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Hệ thống AI sẵn sàng phục vụ gia đình bạn</span>
          </span>
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-95 text-white font-bold transition-all shadow-sm"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
