import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CalendarCheck,
  CheckCircle2,
  LoaderCircle,
  MapPin,
  PlusCircle,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { FamilyMember, HealthProfile } from '../types';
import { BackPriority, useBackHandler } from '../utils/backNavigation';
import { formatDateVN } from '../utils/formatters';
import {
  CalendarPermissionError,
  executePrimaryCalendarSync,
  previewPrimaryCalendarSync,
  type CalendarSyncPreviewPlan,
} from '../utils/googleCalendarSyncService';
import { signInWithGoogle } from '../utils/googleDriveService';
import { digitizationLogger } from '../utils/digitizationLogger';

interface GoogleCalendarSyncModalProps {
  isOpen: boolean;
  userEmail: string | null;
  members: FamilyMember[];
  profiles: Record<string, HealthProfile>;
  onClose: () => void;
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  onAuthRefreshed?: (email: string | null) => void;
}

export function GoogleCalendarSyncModal({
  isOpen,
  userEmail,
  members,
  profiles,
  onClose,
  showToast,
  onAuthRefreshed,
}: GoogleCalendarSyncModalProps) {
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [plan, setPlan] = useState<CalendarSyncPreviewPlan | null>(null);
  const [needsCalendarPermission, setNeedsCalendarPermission] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [removeStaleEvents, setRemoveStaleEvents] = useState(false);

  const handleClose = useCallback(() => {
    if (isSyncing || isAuthorizing) return;
    onClose();
  }, [isAuthorizing, isSyncing, onClose]);

  useBackHandler(isOpen, handleClose, BackPriority.MODAL);

  const loadPreview = useCallback(async (overrideEmail?: string | null) => {
    const activeEmail = overrideEmail !== undefined ? overrideEmail : userEmail;
    setIsLoadingPreview(true);
    setErrorMessage(null);
    setNeedsCalendarPermission(false);
    setRemoveStaleEvents(false);
    try {
      const nextPlan = await previewPrimaryCalendarSync(members, profiles, activeEmail);
      setPlan(nextPlan);
    } catch (error) {
      setPlan(null);
      if (error instanceof CalendarPermissionError) {
        setNeedsCalendarPermission(true);
        setErrorMessage(error.message);
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Không thể kiểm tra Google Calendar.');
      }
    } finally {
      setIsLoadingPreview(false);
    }
  }, [members, profiles, userEmail]);

  useEffect(() => {
    if (!isOpen) {
      setPlan(null);
      setErrorMessage(null);
      setNeedsCalendarPermission(false);
      setRemoveStaleEvents(false);
      return;
    }
    void loadPreview();
  }, [isOpen, loadPreview]);

  useEffect(() => {
    if (!errorMessage) return;
    if (needsCalendarPermission) {
      digitizationLogger.log('warn', 'calendar_permission_required', errorMessage);
      return;
    }
    digitizationLogger.log('error', 'calendar_sync_error', errorMessage);
    const timer = window.setTimeout(() => setErrorMessage(null), 1000);
    return () => window.clearTimeout(timer);
  }, [errorMessage, needsCalendarPermission]);

  if (!isOpen) return null;

  const handleGrantPermission = async () => {
    setIsAuthorizing(true);
    setErrorMessage(null);
    try {
      const { user } = await signInWithGoogle({
        forceConsent: true,
        loginHintEmail: userEmail,
      });
      const signedEmail = user.email?.trim().toLowerCase() || userEmail;
      onAuthRefreshed?.(signedEmail || null);
      await loadPreview(signedEmail);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Không thể cấp quyền Google Calendar.';
      setErrorMessage(message);
    } finally {
      setIsAuthorizing(false);
    }
  };

  const handleConfirmSync = async () => {
    if (!plan || !plan.member) return;
    setIsSyncing(true);
    setErrorMessage(null);
    try {
      const result = await executePrimaryCalendarSync(plan, { removeStaleEvents });
      if (result.failed > 0 && result.created === 0 && result.updated === 0 && result.deleted === 0) {
        setErrorMessage(result.errors[0] || 'Không thể đồng bộ lịch tái khám.');
        return;
      }

      const parts: string[] = [];
      if (result.created > 0) parts.push(`thêm mới ${result.created}`);
      if (result.updated > 0) parts.push(`cập nhật ${result.updated}`);
      if (result.deleted > 0) parts.push(`gỡ ${result.deleted} lịch cũ`);
      if (parts.length === 0 && result.unchanged > 0) {
        showToast('Tất cả lịch tái khám tương lai đã được đồng bộ sẵn trên Google Calendar.', 'info');
      } else if (result.failed > 0) {
        showToast(
          `Đã đồng bộ (${parts.join(', ')}), lỗi ${result.failed} lịch hẹn.`,
          'error',
        );
      } else {
        showToast(
          `Đã đồng bộ Google Calendar chính (${parts.join(', ')}) cho ${plan.member.name}.`,
          'success',
        );
      }
      onClose();
    } catch (error) {
      if (error instanceof CalendarPermissionError) {
        setNeedsCalendarPermission(true);
        setErrorMessage(error.message);
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Đồng bộ Google Calendar thất bại.');
      }
    } finally {
      setIsSyncing(false);
    }
  };

  const pendingChangeCount = plan
    ? plan.toCreate.length + plan.toUpdate.length + (removeStaleEvents ? plan.staleEvents.length : 0)
    : 0;
  const totalFutureItems = plan
    ? plan.toCreate.length + plan.toUpdate.length + plan.unchanged.length
    : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-xs p-3 sm:p-4 overflow-y-auto animate-in fade-in duration-150"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="gcal-sync-title"
        className="my-auto max-h-[92dvh] w-full max-w-lg overflow-hidden rounded-3xl bg-white shadow-2xl flex flex-col border border-slate-100"
      >
        {/* Header */}
        <div className="bg-slate-900 text-white px-4 py-3.5 flex items-center justify-between gap-2 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 border border-emerald-400/30 flex items-center justify-center text-emerald-300 shrink-0">
              <CalendarCheck className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 id="gcal-sync-title" className="text-sm font-bold text-white leading-tight">
                Đồng bộ Google Calendar
              </h3>
              <p className="text-[11px] text-slate-300 truncate">
                {userEmail ? `Lịch chính · ${userEmail}` : 'Lịch tái khám trong tương lai'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleClose}
            disabled={isSyncing || isAuthorizing}
            className="h-9 w-9 flex items-center justify-center rounded-xl hover:bg-slate-800 text-slate-400 hover:text-white transition-colors disabled:opacity-40"
            aria-label="Đóng"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto overscroll-y-contain flex-1 min-h-0 space-y-3.5 text-slate-800">
          {isLoadingPreview ? (
            <div className="py-10 flex flex-col items-center justify-center text-center gap-2.5">
              <LoaderCircle className="w-7 h-7 animate-spin text-emerald-600" />
              <p className="text-xs font-semibold text-slate-600">
                Đang kiểm tra lịch tái khám & Google Calendar chính...
              </p>
            </div>
          ) : needsCalendarPermission ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/80 p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-1 text-xs">
                  <p className="font-bold text-amber-950">Cần cấp quyền Google Calendar</p>
                  <p className="text-amber-900 leading-relaxed">
                    {errorMessage || 'Ứng dụng cần được phép xem và cập nhật lịch hẹn trên Google Calendar chính của bạn.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={isAuthorizing}
                onClick={() => void handleGrantPermission()}
                className="w-full min-h-[42px] rounded-xl bg-white hover:bg-slate-50 border border-slate-300 shadow-xs text-slate-800 font-bold text-xs flex items-center justify-center gap-2.5 px-4 transition-all active:scale-[0.98] disabled:opacity-50"
              >
                {isAuthorizing ? (
                  <LoaderCircle className="w-4 h-4 animate-spin text-emerald-600" />
                ) : (
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 48 48" aria-hidden="true">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                  </svg>
                )}
                <span>{isAuthorizing ? 'Đang kết nối Google...' : 'Cấp quyền Google Calendar'}</span>
              </button>
            </div>
          ) : errorMessage ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-2.5">
              <div className="flex items-start gap-2.5 text-xs text-rose-900">
                <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{errorMessage}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadPreview()}
                className="min-h-[36px] px-3 rounded-xl bg-white border border-rose-200 text-rose-800 font-bold text-xs inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Thử kiểm tra lại</span>
              </button>
            </div>
          ) : plan && !plan.member ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4 text-xs text-amber-950 space-y-1.5">
              <p className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                <span>Chưa liên kết tài khoản với hồ sơ thành viên</span>
              </p>
              <p className="text-amber-900 leading-relaxed">
                Tài khoản <span className="font-semibold">{plan.signedInEmail}</span> chưa trùng email với thành viên nào trong danh sách Gia đình. Hãy cập nhật đúng email cho hồ sơ thành viên tương ứng ở tab <strong>Gia đình</strong> trước khi đồng bộ.
              </p>
            </div>
          ) : plan && plan.member ? (
            <>
              <div className="rounded-2xl border border-emerald-200/80 bg-emerald-50/60 px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <div className="font-bold text-emerald-950 truncate">
                    Thành viên: {plan.member.name}
                  </div>
                  <div className="text-[11px] text-emerald-800 truncate">
                    Lịch đích: Google Calendar chính ({plan.signedInEmail})
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold text-[10px] shrink-0">
                  {totalFutureItems} lịch hẹn
                </span>
              </div>

              {totalFutureItems === 0 && plan.staleEvents.length === 0 ? (
                <div className="py-8 text-center space-y-1.5">
                  <Calendar className="w-9 h-9 text-slate-300 mx-auto" />
                  <p className="text-xs font-bold text-slate-700">
                    Không có lịch tái khám nào trong tương lai
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Các lịch hẹn có ngày từ {formatDateVN(plan.todayIso)} trở đi của {plan.member.name} sẽ xuất hiện tại đây.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {plan.toCreate.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-700 flex items-center gap-1">
                        <PlusCircle className="w-3.5 h-3.5" />
                        <span>Sẽ thêm mới ({plan.toCreate.length})</span>
                      </p>
                      <div className="space-y-1.5">
                        {plan.toCreate.map((item) => (
                          <div
                            key={item.appointmentKey}
                            className="rounded-xl border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold text-slate-900 truncate">{item.summary}</span>
                              <span className="text-[11px] font-bold text-emerald-800 whitespace-nowrap shrink-0">
                                {formatDateVN(item.followUpDate)}
                              </span>
                            </div>
                            {item.facility && (
                              <p className="mt-0.5 text-[11px] text-slate-600 flex items-center gap-1 truncate">
                                <MapPin className="w-3 h-3 shrink-0 text-slate-400" />
                                <span className="truncate">{item.facility}</span>
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {plan.toUpdate.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-blue-700 flex items-center gap-1">
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Sẽ cập nhật ({plan.toUpdate.length})</span>
                      </p>
                      <div className="space-y-1.5">
                        {plan.toUpdate.map(({ item, previousDate }) => (
                          <div
                            key={item.appointmentKey}
                            className="rounded-xl border border-blue-200 bg-blue-50/40 px-3 py-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-bold text-slate-900 truncate">{item.summary}</span>
                              <span className="text-[11px] font-bold text-blue-800 whitespace-nowrap shrink-0">
                                {previousDate && previousDate !== item.followUpDate
                                  ? `${formatDateVN(previousDate)} → ${formatDateVN(item.followUpDate)}`
                                  : formatDateVN(item.followUpDate)}
                              </span>
                            </div>
                            {item.facility && (
                              <p className="mt-0.5 text-[11px] text-slate-600 truncate">
                                {item.facility}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {plan.unchanged.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Đã đồng bộ sẵn ({plan.unchanged.length})</span>
                      </p>
                      <div className="space-y-1">
                        {plan.unchanged.map(({ item }) => (
                          <div
                            key={item.appointmentKey}
                            className="rounded-xl border border-slate-200/80 bg-slate-50/80 px-3 py-2 flex items-center justify-between gap-2 text-xs text-slate-600"
                          >
                            <span className="font-medium truncate">{item.summary}</span>
                            <span className="text-[11px] font-semibold text-slate-500 whitespace-nowrap shrink-0">
                              {formatDateVN(item.followUpDate)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {plan.staleEvents.length > 0 && (
                    <label className="flex items-start gap-2.5 rounded-xl border border-rose-200/80 bg-rose-50/50 p-3 cursor-pointer text-xs">
                      <input
                        type="checkbox"
                        checked={removeStaleEvents}
                        onChange={(e) => setRemoveStaleEvents(e.target.checked)}
                        className="mt-0.5 rounded border-rose-300 text-rose-600 focus:ring-rose-500"
                      />
                      <div className="min-w-0 space-y-0.5">
                        <span className="font-bold text-rose-900 flex items-center gap-1">
                          <Trash2 className="w-3.5 h-3.5 shrink-0" />
                          <span>Gỡ {plan.staleEvents.length} lịch hẹn cũ không còn trên hồ sơ</span>
                        </span>
                        <p className="text-[11px] text-rose-800 truncate">
                          {plan.staleEvents.map((s) => `${s.summary} (${formatDateVN(s.startDate)})`).join(' · ')}
                        </p>
                      </div>
                    </label>
                  )}
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSyncing || isAuthorizing}
            className="min-h-[40px] px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-bold disabled:opacity-50"
          >
            {pendingChangeCount === 0 ? 'Đóng' : 'Hủy'}
          </button>

          {plan?.member && !needsCalendarPermission && !isLoadingPreview && (
            <button
              type="button"
              disabled={isSyncing || pendingChangeCount === 0}
              onClick={() => void handleConfirmSync()}
              className="min-h-[40px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold inline-flex items-center gap-1.5 shadow-sm disabled:opacity-45 active:scale-95"
            >
              {isSyncing ? (
                <LoaderCircle className="w-4 h-4 animate-spin" />
              ) : (
                <CalendarCheck className="w-4 h-4" />
              )}
              <span>
                {isSyncing
                  ? 'Đang đồng bộ...'
                  : pendingChangeCount > 0
                    ? `Xác nhận đồng bộ (${pendingChangeCount})`
                    : 'Đã đồng bộ'}
              </span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
