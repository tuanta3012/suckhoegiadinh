import React from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Calendar,
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
import { formatDateVN } from '../utils/formatters';

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

function AnalysisBullet({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="break-words leading-relaxed text-slate-800 text-xs sm:text-sm">
      <strong className="font-extrabold text-slate-900">{label}:</strong> {children}
    </div>
  );
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
      <div className="rounded-2xl border border-emerald-200/80 bg-white p-3.5 sm:p-5 shadow-2xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
              <Sparkles className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h4 className="font-extrabold text-slate-900 text-xs sm:text-sm truncate">
                Phân tích Y khoa Chuyên sâu (AI Deep-Dive)
              </h4>
              <p className="text-[11px] text-slate-500 truncate">
                Đánh giá toàn diện chỉ số & lịch sử khám bệnh
              </p>
            </div>
          </div>
        </div>

        {isAnalyzing || isRefining ? (
          <div className="rounded-xl bg-emerald-50/70 border border-emerald-200/80 p-3 space-y-2">
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
          <div className="rounded-xl bg-rose-50 border border-rose-100 p-3 space-y-2.5">
            <div className="flex items-start gap-2 text-xs text-rose-800 font-medium leading-relaxed">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <p>{error}</p>
            </div>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="py-1.5 px-3.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold shadow-xs transition-all active:scale-95 flex items-center justify-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Thử lại phân tích</span>
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-2.5">
            <div className="text-xs text-slate-600">
              <AnalysisBullet label="Tóm tắt">
                {narrativeSummary ||
                  'Nhấn nút "AI Y Khoa Chuyên Sâu" bên dưới để kích hoạt hệ thống tổng hợp chỉ số & phân tích 4 lớp y khoa cho hồ sơ thành viên.'}
              </AnalysisBullet>
            </div>
            {onRetry && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  disabled={isAnalyzing || isRefining}
                  onClick={onRetry}
                  className="inline-flex items-center justify-center gap-1.5 py-2 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold shadow-xs transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                >
                  {isAnalyzing || isRefining ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  <span>{isAnalyzing || isRefining ? 'Đang phân tích...' : 'Phân tích AI Chuyên sâu'}</span>
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
  const criticalCorrelations = crossCorrelations.filter((item) => item.severity === 'critical');
  const criticalAlerts = Array.from(
    new Set([...(roadmap?.criticalAlerts || []), ...(aiAnalysis?.criticalAlerts || [])]),
  );

  const scoreColor =
    healthScore === undefined ? 'text-slate-500 bg-slate-50 border-slate-200' :
    healthScore >= 80 ? 'text-emerald-600 bg-emerald-50 border-emerald-200' :
    healthScore >= 60 ? 'text-amber-600 bg-amber-50 border-amber-200' :
    'text-rose-600 bg-rose-50 border-rose-200';

  const formattedDate = analysis?.analyzedAt
    ? formatDateVN(analysis.analyzedAt)
    : 'Chưa có';

  return (
    <div className="rounded-2xl border border-emerald-200/80 bg-white p-3 sm:p-5 shadow-2xs space-y-3.5">
      {/* Header Banner: Health Score & Model Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-slate-100">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-11 h-11 rounded-xl border flex flex-col items-center justify-center font-black text-sm shadow-2xs shrink-0 ${scoreColor}`}
          >
            <span>{healthScore ?? '—'}</span>
            <span className="text-[7.5px] font-extrabold uppercase tracking-wider text-slate-500">Điểm AI</span>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <h4 className="font-extrabold text-slate-900 text-xs sm:text-sm truncate">
                Phân tích Sức khỏe 4 Lớp
              </h4>
              <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-[9px] font-bold shrink-0">
                AI Chuẩn hóa
              </span>
            </div>
            <p className="text-[10.5px] text-slate-500 truncate mt-0.5">
              Cập nhật: {formattedDate}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto shrink-0 justify-center sm:justify-start">
          {onRetry && (
            <button
              type="button"
              disabled={isAnalyzing || isRefining}
              onClick={onRetry}
              title="Bấm để kích hoạt phân tích Y khoa Chuyên sâu 4 Lớp"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white text-xs font-extrabold shadow-xs transition-all cursor-pointer disabled:opacity-60"
            >
              {isAnalyzing || isRefining ? (
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Sparkles className="w-3.5 h-3.5" />
              )}
              <span>{isAnalyzing || isRefining ? 'Đang phân tích AI...' : 'AI Y khoa Chuyên sâu'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Overall Medical Assessment */}
      <div className="p-3 sm:p-4 rounded-xl bg-gradient-to-r from-emerald-50/80 to-teal-50/60 border border-emerald-200/60 shadow-2xs space-y-1.5">
        <h5 className="font-extrabold text-slate-900 text-xs uppercase tracking-wide flex items-center gap-1.5 text-emerald-900">
          <FileHeart className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>Đánh giá Tổng quan Bác sĩ Gia đình AI:</span>
        </h5>
        <div className="space-y-1.5 text-xs sm:text-sm text-slate-800">
          <AnalysisBullet label="Tổng quan">{overallAssessment || narrativeSummary}</AnalysisBullet>
        </div>
      </div>

      {/* Critical Alerts */}
      {(criticalAlerts.length > 0 || criticalCorrelations.length > 0) && (
        <div className="rounded-xl border border-rose-300 bg-rose-50/90 p-3 sm:p-4 text-rose-950 space-y-2 shadow-2xs">
          <h5 className="flex items-center gap-1.5 text-xs sm:text-sm font-extrabold text-rose-900">
            <AlertOctagon className="h-4.5 w-4.5 shrink-0 text-rose-700" />
            <span>Cảnh báo quan trọng</span>
          </h5>
          <div className="space-y-1.5 text-xs sm:text-sm">
            {criticalAlerts.map((alert, idx) => (
              <AnalysisBullet key={idx} label="Cảnh báo">{alert}</AnalysisBullet>
            ))}
            {criticalCorrelations.map((item, idx) => (
              <AnalysisBullet key={`correlation-${idx}`} label={item.parameters.join(' · ')}>
                {item.findings}
              </AnalysisBullet>
            ))}
          </div>
        </div>
      )}

      {/* 4 LAYERS GRID */}

      {/* LAYER 1: Cross-Parameter Correlations */}
      {crossCorrelations.length > 0 && (
        <details className="group rounded-xl border border-slate-200/90 bg-white shadow-2xs overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 sm:px-4 sm:py-3 text-xs font-extrabold text-slate-900 hover:bg-slate-50 transition-colors [&::-webkit-details-marker]:hidden">
            <GitCommit className="w-4 h-4 text-purple-600 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Lớp 1 · Tương quan chỉ số ({crossCorrelations.length})</span>
            <span className="ml-auto text-[10px] font-semibold text-slate-500 group-open:hidden shrink-0">Xem</span>
            <span className="ml-auto hidden text-[10px] font-semibold text-slate-500 group-open:inline shrink-0">Thu gọn</span>
          </summary>
          <div className="grid gap-2.5 border-t border-slate-100 p-2.5 sm:p-4 sm:grid-cols-2 bg-slate-50/30">
            {crossCorrelations.map((item, idx) => (
              <div
                key={idx}
                className={`min-w-0 p-3 sm:p-3.5 rounded-xl border text-xs space-y-2 bg-white shadow-2xs ${
                  item.severity === 'critical'
                    ? 'border-rose-200 text-rose-950'
                    : item.severity === 'warning'
                    ? 'border-amber-200 text-amber-950'
                    : 'border-slate-200 text-slate-900'
                }`}
              >
                <div className="flex items-center justify-between gap-1 flex-wrap">
                  <div className="flex flex-wrap gap-1">
                    {item.parameters.map((p, i) => (
                      <span key={i} className="px-2 py-0.5 rounded bg-slate-100 border border-slate-200/80 font-bold text-[10.5px]">
                        {p}
                      </span>
                    ))}
                  </div>
                  {item.severity === 'critical' ? (
                    <span className="px-2 py-0.5 rounded-full bg-rose-600 text-white font-bold text-[9.5px]">🔴 Quan trọng</span>
                  ) : item.severity === 'warning' ? (
                    <span className="px-2 py-0.5 rounded-full bg-amber-600 text-white font-bold text-[9.5px]">🟡 Theo dõi</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-slate-200 text-slate-700 font-bold text-[9.5px]">🔵 Thông tin</span>
                  )}
                </div>
                <div className="text-xs">
                  <AnalysisBullet label="Nhận định">{item.findings}</AnalysisBullet>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* LAYER 2: Velocity & Trend Tracking */}
      {velocityTrends.length > 0 && (
        <details className="group rounded-xl border border-slate-200/90 bg-white shadow-2xs overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 sm:px-4 sm:py-3 text-xs font-extrabold text-slate-900 hover:bg-slate-50 transition-colors [&::-webkit-details-marker]:hidden">
            <TrendingUp className="w-4 h-4 text-blue-600 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Lớp 2 · Xu hướng theo thời gian ({velocityTrends.length})</span>
            <span className="ml-auto text-[10px] font-semibold text-slate-500 group-open:hidden shrink-0">Xem</span>
            <span className="ml-auto hidden text-[10px] font-semibold text-slate-500 group-open:inline shrink-0">Thu gọn</span>
          </summary>
          <div className="grid gap-2.5 border-t border-slate-100 p-2.5 sm:p-4 sm:grid-cols-2 bg-slate-50/30">
            {velocityTrends.map((item, idx) => (
              <div key={idx} className="min-w-0 p-3 sm:p-3.5 rounded-xl border border-slate-200 bg-white text-xs space-y-1.5 shadow-2xs">
                <div className="flex items-center justify-between font-bold text-slate-900 flex-wrap gap-1">
                  <span className="text-xs font-extrabold text-slate-900">{item.metricName}</span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      item.trendDirection === 'increasing'
                        ? 'bg-amber-100 text-amber-800'
                        : item.trendDirection === 'decreasing'
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {item.trendDirection === 'increasing'
                      ? '📈 Tăng'
                      : item.trendDirection === 'decreasing'
                      ? '📉 Giảm'
                      : '➖ Ổn định'}
                  </span>
                </div>
                <div className="text-xs text-slate-800">
                  <AnalysisBullet label="Diễn biến">{item.velocityDescription}</AnalysisBullet>
                </div>
                {item.riskProjection && (
                  <div className="border-t border-slate-100 pt-1.5 text-xs text-slate-600">
                    <AnalysisBullet label="Dự báo">{item.riskProjection}</AnalysisBullet>
                  </div>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* LAYER 3: Chronic Disease Surveillance */}
      {(chronicSurveillance.length > 0 || (medicalHistory && (medicalHistory.chronicConditions.length > 0 || medicalHistory.surgeries.length > 0))) && (
        <details className="group rounded-xl border border-slate-200/90 bg-white shadow-2xs overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 sm:px-4 sm:py-3 text-xs font-extrabold text-slate-900 hover:bg-slate-50 transition-colors [&::-webkit-details-marker]:hidden">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Lớp 3 · Theo dõi bệnh mạn tính ({chronicSurveillance.length})</span>
            <span className="ml-auto text-[10px] font-semibold text-slate-500 group-open:hidden shrink-0">Xem</span>
            <span className="ml-auto hidden text-[10px] font-semibold text-slate-500 group-open:inline shrink-0">Thu gọn</span>
          </summary>
          <div className="space-y-3 border-t border-slate-100 p-2.5 sm:p-4 bg-slate-50/30">

          {/* Display surgeries / fixed baseline conditions if available */}
          {medicalHistory && (medicalHistory.surgeries.length > 0 || medicalHistory.chronicConditions.length > 0) && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {medicalHistory.surgeries.map((s, i) => (
                <span key={i} className="px-2.5 py-1 rounded-lg bg-purple-50 border border-purple-200 text-purple-900 font-medium">
                  ✂️ Phẫu thuật: <strong>{s.procedure}</strong> ({s.year || 'Đã ghi nhận'})
                </span>
              ))}
              {medicalHistory.chronicConditions.map((c, i) => (
                <span key={i} className="px-2.5 py-1 rounded-lg bg-teal-50 border border-teal-200 text-teal-900 font-medium">
                  🩺 Mạn/nang: <strong>{c.condition}</strong>
                </span>
              ))}
            </div>
          )}

          <div className="grid gap-2.5 sm:grid-cols-2">
            {chronicSurveillance.map((item, idx) => (
              <div key={idx} className="min-w-0 p-3 sm:p-3.5 rounded-xl border border-teal-200/80 bg-white text-xs space-y-1.5 shadow-2xs">
                <div className="flex items-center justify-between gap-1 flex-wrap">
                  <span className="font-extrabold text-slate-900">{item.conditionName}</span>
                  <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[9.5px]">
                    🟢 {item.status === 'stable_benign' ? 'Ổn định' : 'Theo dõi định kỳ'}
                  </span>
                </div>
                <div className="space-y-1 text-slate-800">
                  <AnalysisBullet label="Theo dõi">{item.comparisonOverTime}</AnalysisBullet>
                  <AnalysisBullet label="Khuyến nghị">{item.recommendation}</AnalysisBullet>
                </div>
              </div>
            ))}
          </div>
          </div>
        </details>
      )}

      {/* LAYER 4: Actionable Health Roadmap */}
      {roadmap && (
        <details className="group rounded-xl border border-slate-200/90 bg-white shadow-2xs overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 sm:px-4 sm:py-3 text-xs font-extrabold text-slate-900 hover:bg-slate-50 transition-colors [&::-webkit-details-marker]:hidden">
            <Compass className="w-4 h-4 text-rose-600 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Lớp 4 · Kế hoạch hành động</span>
            <span className="ml-auto text-[10px] font-semibold text-slate-500 group-open:hidden shrink-0">Xem</span>
            <span className="ml-auto hidden text-[10px] font-semibold text-slate-500 group-open:inline shrink-0">Thu gọn</span>
          </summary>
          <div className="space-y-3 border-t border-slate-100 p-2.5 sm:p-4 bg-slate-50/30">

          {/* Specialist Referrals */}
          {roadmap.specialistReferrals && roadmap.specialistReferrals.length > 0 && (
            <div className="p-3 rounded-xl bg-white border border-slate-200 text-xs space-y-2 shadow-2xs">
              <span className="font-bold text-slate-900 flex items-center gap-1.5">
                <Stethoscope className="w-4 h-4 text-indigo-600 shrink-0" />
                <span>Khuyến nghị Khám Chuyên khoa:</span>
              </span>
              <div className="grid gap-2 sm:grid-cols-2">
                {roadmap.specialistReferrals.map((item, idx) => (
                  <div key={idx} className="p-2.5 rounded-lg bg-slate-50 border border-slate-200/80 flex items-start gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <span className="font-bold text-indigo-950 block">{item.specialty}</span>
                      <div className="text-[11px] text-slate-600">
                        <AnalysisBullet label="Lý do">{item.reason}</AnalysisBullet>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Time Bound Plan */}
          {roadmap.timeBoundPlan && (
            <div className="grid gap-2.5 sm:grid-cols-3 text-xs">
              {roadmap.timeBoundPlan.next3Months && roadmap.timeBoundPlan.next3Months.length > 0 && (
                <div className="p-3 rounded-xl bg-emerald-50/90 border border-emerald-200 space-y-1 shadow-2xs">
                  <span className="font-bold text-emerald-900 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    <span>Lộ trình 3 tháng tới:</span>
                  </span>
                  <div className="space-y-1 text-emerald-950 leading-relaxed">
                    {roadmap.timeBoundPlan.next3Months.map((act, i) => (
                      <AnalysisBullet key={i} label="Kế hoạch">{act}</AnalysisBullet>
                    ))}
                  </div>
                </div>
              )}

              {roadmap.timeBoundPlan.next6Months && roadmap.timeBoundPlan.next6Months.length > 0 && (
                <div className="p-3 rounded-xl bg-blue-50/90 border border-blue-200 space-y-1 shadow-2xs">
                  <span className="font-bold text-blue-900 flex items-center gap-1">
                    <Calendar className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                    <span>Lộ trình 6 tháng tới:</span>
                  </span>
                  <div className="space-y-1 text-blue-950 leading-relaxed">
                    {roadmap.timeBoundPlan.next6Months.map((act, i) => (
                      <AnalysisBullet key={i} label="Kế hoạch">{act}</AnalysisBullet>
                    ))}
                  </div>
                </div>
              )}

              {roadmap.timeBoundPlan.next12Months && roadmap.timeBoundPlan.next12Months.length > 0 && (
                <div className="p-3 rounded-xl bg-purple-50/90 border border-purple-200 space-y-1 shadow-2xs">
                  <span className="font-bold text-purple-900 flex items-center gap-1">
                    <HeartPulse className="w-3.5 h-3.5 text-purple-600 shrink-0" />
                    <span>Tái khám 12 tháng:</span>
                  </span>
                  <div className="space-y-1 text-purple-950 leading-relaxed">
                    {roadmap.timeBoundPlan.next12Months.map((act, i) => (
                      <AnalysisBullet key={i} label="Kế hoạch">{act}</AnalysisBullet>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          </div>
        </details>
      )}

      {/* SCHEMA V2 AI ANALYSIS BLOCK (Action Roadmap & Critical Alerts) */}
      {aiAnalysis && (
        <details className="group rounded-xl border border-slate-200/90 bg-white shadow-2xs overflow-hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 p-3 sm:px-4 sm:py-3 text-xs font-extrabold text-slate-900 hover:bg-slate-50 transition-colors [&::-webkit-details-marker]:hidden">
            <Compass className="w-4 h-4 text-emerald-600 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Khuyến nghị & giám sát bổ sung</span>
            <span className="ml-auto text-[10px] font-semibold text-slate-500 group-open:hidden shrink-0">Xem</span>
            <span className="ml-auto hidden text-[10px] font-semibold text-slate-500 group-open:inline shrink-0">Thu gọn</span>
          </summary>
          <div className="space-y-3 border-t border-slate-100 p-2.5 sm:p-4 bg-slate-50/30">

          {aiAnalysis.chronicConditionsTracking && aiAnalysis.chronicConditionsTracking.length > 0 && (
            <div className="p-3 rounded-xl bg-teal-50/90 border border-teal-200 text-xs space-y-1 shadow-2xs">
              <span className="font-bold text-teal-950 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-teal-600 shrink-0" />
                <span>Giám sát Bệnh lý Mạn tính:</span>
              </span>
              <div className="space-y-1 font-medium text-teal-900">
                {aiAnalysis.chronicConditionsTracking.map((item, idx) => (
                  <AnalysisBullet key={idx} label="Theo dõi">{item}</AnalysisBullet>
                ))}
              </div>
            </div>
          )}

          {aiAnalysis.actionRoadmap && (
            <div className="grid gap-2.5 sm:grid-cols-2 text-xs">
              {aiAnalysis.actionRoadmap.specialistConsultation && aiAnalysis.actionRoadmap.specialistConsultation.length > 0 && (
                <div className="p-3 rounded-xl bg-indigo-50/90 border border-indigo-200 space-y-1 shadow-2xs">
                  <span className="font-bold text-indigo-900 flex items-center gap-1.5">
                    <Stethoscope className="w-4 h-4 text-indigo-600 shrink-0" />
                    <span>Chỉ định Chuyên khoa Khám:</span>
                  </span>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {aiAnalysis.actionRoadmap.specialistConsultation.map((spec, idx) => (
                      <span key={idx} className="px-2 py-0.5 rounded-md bg-white border border-indigo-200 text-indigo-950 font-bold text-[10.5px]">
                        🩺 {spec}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {aiAnalysis.actionRoadmap.dietaryModifications && aiAnalysis.actionRoadmap.dietaryModifications.length > 0 && (
                <div className="p-3 rounded-xl bg-amber-50/90 border border-amber-200 space-y-1 shadow-2xs">
                  <span className="font-bold text-amber-900 flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>Hướng dẫn Dinh dưỡng & Lối sống:</span>
                  </span>
                  <div className="space-y-1 text-amber-950 leading-relaxed font-medium">
                    {aiAnalysis.actionRoadmap.dietaryModifications.map((diet, idx) => (
                      <AnalysisBullet key={idx} label="Khuyến nghị">{diet}</AnalysisBullet>
                    ))}
                  </div>
                </div>
              )}

              {aiAnalysis.actionRoadmap.followUpSchedule && (
                <div className="sm:col-span-2 p-3 rounded-xl bg-emerald-50/90 border border-emerald-200 flex items-start gap-2 shadow-2xs">
                  <Clock className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <div className="text-emerald-950 text-xs">
                    <AnalysisBullet label="Lịch tái khám">{aiAnalysis.actionRoadmap.followUpSchedule}</AnalysisBullet>
                  </div>
                </div>
              )}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
