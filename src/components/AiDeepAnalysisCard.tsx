import React from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Compass,
  FileHeart,
  GitCommit,
  HeartPulse,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  TrendingUp,
  RefreshCw,
} from 'lucide-react';
import type { AiAnalysisBlock, AiDeepAnalysisResult, MedicalHistory } from '../types';

interface AiDeepAnalysisCardProps {
  analysis: AiDeepAnalysisResult | undefined;
  aiAnalysis?: AiAnalysisBlock;
  medicalHistory?: MedicalHistory;
  narrativeSummary?: string;
  isAnalyzing?: boolean;
  onRetry?: () => void;
  onRefine?: () => void;
  isRefining?: boolean;
  error?: string;
}

export function AiDeepAnalysisCard({
  analysis,
  aiAnalysis,
  medicalHistory,
  narrativeSummary,
  isAnalyzing,
  onRetry,
  onRefine,
  isRefining,
  error,
}: AiDeepAnalysisCardProps) {
  if (!analysis && !aiAnalysis) {
    return (
      <div className="rounded-2xl border border-emerald-200/80 bg-white p-4 sm:p-5 shadow-xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h4 className="font-extrabold text-slate-900 text-sm truncate">
                Phân tích Y khoa Chuyên sâu (AI Deep-Dive)
              </h4>
              <p className="text-[11px] text-slate-500 truncate">
                Đánh giá toàn diện chỉ số & lịch sử khám bệnh
              </p>
            </div>
          </div>
        </div>

        {isAnalyzing || isRefining ? (
          <div className="rounded-xl bg-emerald-50/70 border border-emerald-200/80 p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-emerald-800">
              <span className="flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-emerald-600 shrink-0" />
                <span>Đang tổng hợp chỉ số & Phân tích 4 Lớp bằng AI Y khoa...</span>
              </span>
            </div>
            <div className="w-full bg-emerald-200/60 h-1.5 rounded-full overflow-hidden">
              <div className="bg-emerald-600 h-full rounded-full animate-pulse" style={{ width: '75%' }} />
            </div>
          </div>
        ) : error ? (
          <div className="rounded-xl bg-rose-50 border border-rose-100 p-3.5 space-y-3">
            <div className="flex items-start gap-2.5 text-xs text-rose-800 font-medium leading-relaxed">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="py-2 px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-sm transition-all active:scale-95 flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Thử lại phân tích</span>
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 leading-relaxed font-medium">
              {narrativeSummary ||
                'Hệ thống tự động tổng hợp & phân tích 4 lớp y khoa bằng AI ngay sau khi hoàn tất tải lên tài liệu khám bệnh.'}
            </p>
            {onRetry && (
              <div>
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center justify-center gap-2 py-2 px-4 rounded-xl border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-bold transition-all active:scale-95 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>Kích hoạt phân tích ngay</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const healthScore = analysis?.healthScore;
  const overallAssessment = aiAnalysis?.overviewSummary || analysis?.overallAssessment || narrativeSummary;
  const crossCorrelations = analysis?.crossCorrelations || [];
  const velocityTrends = analysis?.velocityTrends || [];
  const chronicSurveillance = analysis?.chronicSurveillance || [];
  const roadmap = analysis?.roadmap;

  const scoreColor =
    healthScore === undefined ? 'text-slate-500 bg-slate-50 border-slate-200' :
    healthScore >= 80 ? 'text-emerald-600 bg-emerald-50 border-emerald-200' :
    healthScore >= 60 ? 'text-amber-600 bg-amber-50 border-amber-200' :
    'text-rose-600 bg-rose-50 border-rose-200';

  const formattedDate = analysis?.analyzedAt
    ? new Date(analysis.analyzedAt).toLocaleDateString('vi-VN')
    : 'Chưa có';

  return (
    <div className="rounded-3xl border border-emerald-200/80 bg-white p-4 sm:p-6 shadow-sm space-y-5">
      {/* Header Banner: Health Score & Model Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-3">
          <div
            className={`w-12 h-12 rounded-2xl border flex flex-col items-center justify-center font-black text-base shadow-xs shrink-0 ${scoreColor}`}
          >
            <span>{healthScore ?? '—'}</span>
            <span className="text-[8px] font-bold uppercase tracking-wider text-slate-500">Điểm AI</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="font-extrabold text-slate-900 text-sm sm:text-base truncate">
                Phân tích Sức khỏe 4 Lớp
              </h4>
              <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-bold shrink-0">
                AI Chuẩn hóa
              </span>
            </div>
            <p className="text-[11px] text-slate-500 truncate mt-0.5">
              Cập nhật: {formattedDate}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0">
          <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold">
            <Sparkles className="w-3.5 h-3.5 text-emerald-600" />
            <span>AI Y khoa Chuyên sâu</span>
          </span>
          {isAnalyzing && (
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-600" />
              <span>Đang phân tích...</span>
            </span>
          )}
        </div>
      </div>

      {/* Overall Medical Assessment */}
      <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-50/70 to-teal-50/50 border border-emerald-100">
        <h5 className="font-bold text-slate-900 text-xs uppercase tracking-wide flex items-center gap-1.5 mb-1.5 text-emerald-900">
          <FileHeart className="w-4 h-4 text-emerald-600" />
          <span>Đánh giá Tổng quan Bác sĩ Gia đình AI:</span>
        </h5>
        <p className="text-xs sm:text-sm text-slate-800 leading-relaxed font-medium">
          {overallAssessment || narrativeSummary}
        </p>
      </div>

      {/* 4 LAYERS GRID */}

      {/* LAYER 1: Cross-Parameter Correlations */}
      {crossCorrelations.length > 0 && (
        <div className="space-y-2.5">
          <h5 className="font-extrabold text-slate-900 text-xs uppercase tracking-wide flex items-center gap-2">
            <GitCommit className="w-4 h-4 text-purple-600" />
            <span>Lớp 1: Phân tích Tương quan Chỉ số Chéo (Cross-Correlation)</span>
          </h5>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {crossCorrelations.map((item, idx) => (
              <div
                key={idx}
                className={`p-3.5 rounded-2xl border text-xs space-y-1.5 ${
                  item.severity === 'critical'
                    ? 'bg-rose-50/80 border-rose-200 text-rose-950'
                    : item.severity === 'warning'
                    ? 'bg-amber-50/80 border-amber-200 text-amber-950'
                    : 'bg-slate-50 border-slate-200 text-slate-900'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex flex-wrap gap-1">
                    {item.parameters.map((p, i) => (
                      <span key={i} className="px-2 py-0.5 rounded-md bg-white border border-slate-200 font-bold text-[11px]">
                        {p}
                      </span>
                    ))}
                  </div>
                  {item.severity === 'critical' ? (
                    <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white font-bold text-[10px]">🔴 Quan trọng</span>
                  ) : item.severity === 'warning' ? (
                    <span className="px-2 py-0.5 rounded-full bg-amber-600 text-white font-bold text-[10px]">🟡 Theo dõi</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-bold text-[10px]">🔵 Thông tin</span>
                  )}
                </div>
                <p className="text-xs font-medium leading-relaxed">{item.findings}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LAYER 2: Velocity & Trend Tracking */}
      {velocityTrends.length > 0 && (
        <div className="space-y-2.5">
          <h5 className="font-extrabold text-slate-900 text-xs uppercase tracking-wide flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-600" />
            <span>Lớp 2: Đánh giá Vận tốc Biến động Lịch sử (Velocity & Trend)</span>
          </h5>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {velocityTrends.map((item, idx) => (
              <div key={idx} className="p-3.5 rounded-2xl border border-slate-200 bg-slate-50/80 text-xs space-y-1">
                <div className="flex items-center justify-between font-bold text-slate-900">
                  <span className="text-sm font-extrabold text-slate-900">{item.metricName}</span>
                  <span
                    className={`px-2 py-0.5 rounded-md text-[10px] font-bold ${
                      item.trendDirection === 'increasing'
                        ? 'bg-amber-100 text-amber-800'
                        : item.trendDirection === 'decreasing'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {item.trendDirection === 'increasing'
                      ? '📈 Có xu hướng tăng'
                      : item.trendDirection === 'decreasing'
                      ? '📉 Có xu hướng giảm'
                      : '➖ Giữ ổn định'}
                  </span>
                </div>
                <p className="text-slate-700 font-semibold">{item.velocityDescription}</p>
                {item.riskProjection && (
                  <p className="text-[11px] text-slate-500 italic border-t border-slate-200/60 pt-1 mt-1">
                    🎯 Dự báo: {item.riskProjection}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LAYER 3: Chronic Disease Surveillance */}
      {(chronicSurveillance.length > 0 || (medicalHistory && (medicalHistory.chronicConditions.length > 0 || medicalHistory.surgeries.length > 0))) && (
        <div className="space-y-2.5">
          <h5 className="font-extrabold text-slate-900 text-xs uppercase tracking-wide flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>Lớp 3: Giám sát Bệnh lý Mạn tính & Tiền sử (Chronic Surveillance)</span>
          </h5>

          {/* Display surgeries / fixed baseline conditions if available */}
          {medicalHistory && (medicalHistory.surgeries.length > 0 || medicalHistory.chronicConditions.length > 0) && (
            <div className="flex flex-wrap gap-2 text-xs">
              {medicalHistory.surgeries.map((s, i) => (
                <span key={i} className="px-3 py-1 rounded-xl bg-purple-50 border border-purple-200 text-purple-900 font-medium">
                  ✂️ Tiền sử phẫu thuật: <strong>{s.procedure}</strong> ({s.year || 'Đã ghi nhận'})
                </span>
              ))}
              {medicalHistory.chronicConditions.map((c, i) => (
                <span key={i} className="px-3 py-1 rounded-xl bg-teal-50 border border-teal-200 text-teal-900 font-medium">
                  🩺 Bệnh mạn/nang: <strong>{c.condition}</strong>
                </span>
              ))}
            </div>
          )}

          <div className="grid gap-2.5 sm:grid-cols-2">
            {chronicSurveillance.map((item, idx) => (
              <div key={idx} className="p-3.5 rounded-2xl border border-teal-200/80 bg-teal-50/40 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-slate-900">{item.conditionName}</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px]">
                    🟢 {item.status === 'stable_benign' ? 'Ổn định / Lành tính' : 'Theo dõi định kỳ'}
                  </span>
                </div>
                <p className="text-slate-700 leading-snug">{item.comparisonOverTime}</p>
                <p className="text-[11px] text-teal-800 font-semibold pt-1">💡 Hướng dẫn: {item.recommendation}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* LAYER 4: Actionable Health Roadmap */}
      {roadmap && (
        <div className="space-y-3 pt-2 border-t border-slate-100">
          <h5 className="font-extrabold text-slate-900 text-xs uppercase tracking-wide flex items-center gap-2">
            <Compass className="w-4 h-4 text-rose-600" />
            <span>Lớp 4: Lập Phác đồ Hành động Cá nhân hóa 3 Tầng</span>
          </h5>

          {/* Tầng 1: Cảnh báo đỏ */}
          {roadmap.criticalAlerts && roadmap.criticalAlerts.length > 0 && (
            <div className="p-4 sm:p-5 rounded-2xl bg-rose-50 border-2 border-rose-300 text-rose-950 text-sm space-y-2 shadow-sm">
              <span className="font-extrabold text-rose-950 flex items-center gap-2 text-sm sm:text-base">
                <AlertOctagon className="w-5 h-5 text-rose-700 shrink-0" />
                <span>Cảnh báo đỏ cấp thiết (Critical Alerts):</span>
              </span>
              <ul className="list-disc list-inside space-y-1.5 font-semibold text-rose-950 pl-1 leading-relaxed">
                {roadmap.criticalAlerts.map((alert, idx) => (
                  <li key={idx}>{alert}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Tầng 2: Chỉ định Khám chuyên khoa */}
          {roadmap.specialistReferrals && roadmap.specialistReferrals.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-slate-50 border border-slate-200 text-xs space-y-2">
              <span className="font-bold text-slate-900 flex items-center gap-1.5">
                <Stethoscope className="w-4 h-4 text-indigo-600" />
                <span>Khuyến nghị Khám Chuyên khoa:</span>
              </span>
              <div className="grid gap-2 sm:grid-cols-2">
                {roadmap.specialistReferrals.map((item, idx) => (
                  <div key={idx} className="p-2.5 rounded-xl bg-white border border-slate-200 flex items-start gap-2">
                    <div className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5 shrink-0" />
                    <div>
                      <span className="font-bold text-indigo-950 block">{item.specialty}</span>
                      <span className="text-[11px] text-slate-600 block">{item.reason}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tầng 3: Lộ trình Mốc Thời gian 3-6-12 tháng */}
          {roadmap.timeBoundPlan && (
            <div className="grid gap-2.5 sm:grid-cols-3 text-sm">
              {roadmap.timeBoundPlan.next3Months && roadmap.timeBoundPlan.next3Months.length > 0 && (
                <div className="p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 space-y-1">
                  <span className="font-bold text-emerald-900 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Lộ trình 3 tháng tới:</span>
                  </span>
                  <ul className="list-disc list-inside space-y-1.5 text-emerald-950 text-xs sm:text-sm pl-0.5 leading-relaxed">
                    {roadmap.timeBoundPlan.next3Months.map((act, i) => (
                      <li key={i}>{act}</li>
                    ))}
                  </ul>
                </div>
              )}

              {roadmap.timeBoundPlan.next6Months && roadmap.timeBoundPlan.next6Months.length > 0 && (
                <div className="p-3 rounded-2xl bg-blue-50/80 border border-blue-200 space-y-1">
                  <span className="font-bold text-blue-900 flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-blue-600" />
                    <span>Lộ trình 6 tháng tới:</span>
                  </span>
                  <ul className="list-disc list-inside space-y-1.5 text-blue-950 text-xs sm:text-sm pl-0.5 leading-relaxed">
                    {roadmap.timeBoundPlan.next6Months.map((act, i) => (
                      <li key={i}>{act}</li>
                    ))}
                  </ul>
                </div>
              )}

              {roadmap.timeBoundPlan.next12Months && roadmap.timeBoundPlan.next12Months.length > 0 && (
                <div className="p-3 rounded-2xl bg-purple-50/80 border border-purple-200 space-y-1">
                  <span className="font-bold text-purple-900 flex items-center gap-1">
                    <HeartPulse className="w-3.5 h-3.5 text-purple-600" />
                    <span>Tái khám 12 tháng:</span>
                  </span>
                  <ul className="list-disc list-inside space-y-1.5 text-purple-950 text-xs sm:text-sm pl-0.5 leading-relaxed">
                    {roadmap.timeBoundPlan.next12Months.map((act, i) => (
                      <li key={i}>{act}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SCHEMA V2 AI ANALYSIS BLOCK (Action Roadmap & Critical Alerts) */}
      {aiAnalysis && (
        <div className="space-y-3 pt-3 border-t border-slate-100">
          <h5 className="font-extrabold text-slate-900 text-xs uppercase tracking-wide flex items-center gap-2">
            <Compass className="w-4 h-4 text-emerald-600" />
            <span>Phác đồ AI Deep-Dive & Khuyến nghị Dinh dưỡng</span>
          </h5>

          {aiAnalysis.criticalAlerts && aiAnalysis.criticalAlerts.length > 0 && !roadmap?.criticalAlerts?.length && (
            <div className="p-4 sm:p-5 rounded-2xl bg-rose-50 border-2 border-rose-300 text-rose-950 text-sm space-y-2 shadow-sm">
              <span className="font-extrabold text-rose-950 flex items-center gap-2 text-sm sm:text-base">
                <AlertOctagon className="w-5 h-5 text-rose-700 shrink-0" />
                <span>Cảnh báo Y tế Quan trọng (criticalAlerts):</span>
              </span>
              <ul className="list-disc list-inside space-y-1.5 font-semibold text-rose-950 pl-1 leading-relaxed">
                {aiAnalysis.criticalAlerts.map((alert, idx) => (
                  <li key={idx}>{alert}</li>
                ))}
              </ul>
            </div>
          )}

          {aiAnalysis.chronicConditionsTracking && aiAnalysis.chronicConditionsTracking.length > 0 && (
            <div className="p-3.5 rounded-2xl bg-teal-50/80 border border-teal-200 text-xs space-y-1">
              <span className="font-bold text-teal-950 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-teal-600" />
                <span>Giám sát Bệnh lý Mạn tính (chronicConditionsTracking):</span>
              </span>
              <ul className="list-disc list-inside space-y-1 font-medium text-teal-900 pl-1">
                {aiAnalysis.chronicConditionsTracking.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {aiAnalysis.actionRoadmap && (
            <div className="grid gap-2.5 sm:grid-cols-2 text-xs">
              {aiAnalysis.actionRoadmap.specialistConsultation && aiAnalysis.actionRoadmap.specialistConsultation.length > 0 && (
                <div className="p-3 rounded-2xl bg-indigo-50/80 border border-indigo-200 space-y-1">
                  <span className="font-bold text-indigo-900 flex items-center gap-1.5">
                    <Stethoscope className="w-4 h-4 text-indigo-600" />
                    <span>Chỉ định Chuyên khoa Khám:</span>
                  </span>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {aiAnalysis.actionRoadmap.specialistConsultation.map((spec, idx) => (
                      <span key={idx} className="px-2.5 py-1 rounded-lg bg-white border border-indigo-200 text-indigo-950 font-bold text-[11px]">
                        🩺 {spec}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {aiAnalysis.actionRoadmap.dietaryModifications && aiAnalysis.actionRoadmap.dietaryModifications.length > 0 && (
                <div className="p-3 rounded-2xl bg-amber-50/80 border border-amber-200 space-y-1">
                  <span className="font-bold text-amber-900 flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-amber-600" />
                    <span>Hướng dẫn Dinh dưỡng & Lối sống:</span>
                  </span>
                  <ul className="list-disc list-inside space-y-1.5 text-amber-950 text-xs sm:text-sm pl-0.5 font-medium leading-relaxed">
                    {aiAnalysis.actionRoadmap.dietaryModifications.map((diet, idx) => (
                      <li key={idx}>{diet}</li>
                    ))}
                  </ul>
                </div>
              )}

              {aiAnalysis.actionRoadmap.followUpSchedule && (
                <div className="sm:col-span-2 p-3 rounded-2xl bg-emerald-50/80 border border-emerald-200 flex items-center gap-2">
                  <Clock className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span className="text-emerald-950 font-bold text-xs">
                    📅 Lịch Tái khám Khuyên dùng: {aiAnalysis.actionRoadmap.followUpSchedule}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
