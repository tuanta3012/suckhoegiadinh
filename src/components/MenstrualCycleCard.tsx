import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Droplet,
  Minus,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  FamilyMember,
  MenstrualCycleEntry,
  MenstrualCycleSettings,
  MenstrualFlowLevel,
} from '../types';
import { formatDateVN } from '../utils/formatters';
import {
  addDaysToIso,
  calculateCycleMetrics,
  COMMON_CYCLE_SYMPTOMS,
  DEFAULT_CYCLE_LENGTH,
  DEFAULT_PERIOD_LENGTH,
  DEFAULT_REMIND_BEFORE_DAYS,
  diffDaysIso,
  findNearbyCycle,
  FLOW_LEVEL_LABELS,
  formatToIsoDate,
  getCalendarDayInfo,
  parseIsoDate,
  sortCyclesDesc,
} from '../utils/menstrualCycleService';

interface MenstrualCycleCardProps {
  member: FamilyMember;
  cycles?: MenstrualCycleEntry[];
  settings?: MenstrualCycleSettings;
  onSaveCycles: (nextCycles: MenstrualCycleEntry[], nextSettings?: MenstrualCycleSettings) => void;
  onOpenCalendarSync?: () => void;
  readOnly?: boolean;
}

function formatShortVN(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}`;
}

export function MenstrualCycleCard({
  member,
  cycles = [],
  settings,
  onSaveCycles,
  onOpenCalendarSync,
  readOnly = false,
}: MenstrualCycleCardProps) {
  const todayStr = useMemo(() => formatToIsoDate(new Date()), []);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>(todayStr);
  const [editingCycleId, setEditingCycleId] = useState<string | null>(null);

  const [viewDate, setViewDate] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  const [detailDraft, setDetailDraft] = useState<{
    id: string;
    startDate: string;
    endDate?: string;
    flowLevel: MenstrualFlowLevel;
    symptoms: string[];
    notes: string;
  } | null>(null);

  const [cycleLengthInput, setCycleLengthInput] = useState<number>(
    settings?.defaultCycleLength || DEFAULT_CYCLE_LENGTH,
  );
  const [periodLengthInput, setPeriodLengthInput] = useState<number>(
    settings?.defaultPeriodLength || DEFAULT_PERIOD_LENGTH,
  );
  const [remindBeforeDaysInput, setRemindBeforeDaysInput] = useState<number>(
    settings?.remindBeforeDays ?? DEFAULT_REMIND_BEFORE_DAYS,
  );
  const [remindEnabled, setRemindEnabled] = useState<boolean>(settings?.reminderEnabled ?? true);

  useEffect(() => {
    setEditingCycleId(null);
    setDetailDraft(null);
    setShowSettings(false);
    setSelectedDate(todayStr);
  }, [member.id, todayStr]);

  useEffect(() => {
    setCycleLengthInput(settings?.defaultCycleLength || DEFAULT_CYCLE_LENGTH);
    setPeriodLengthInput(settings?.defaultPeriodLength || DEFAULT_PERIOD_LENGTH);
    setRemindBeforeDaysInput(settings?.remindBeforeDays ?? DEFAULT_REMIND_BEFORE_DAYS);
    setRemindEnabled(settings?.reminderEnabled ?? true);
  }, [
    settings?.defaultCycleLength,
    settings?.defaultPeriodLength,
    settings?.remindBeforeDays,
    settings?.reminderEnabled,
  ]);

  const sortedCycles = useMemo(() => sortCyclesDesc(cycles), [cycles]);

  const metrics = useMemo(() => {
    return calculateCycleMetrics(sortedCycles, settings, todayStr);
  }, [sortedCycles, settings, todayStr]);

  useEffect(() => {
    if (!editingCycleId) {
      setDetailDraft(null);
      return;
    }
    const found = sortedCycles.find((c) => c.id === editingCycleId);
    if (!found) {
      setEditingCycleId(null);
      setDetailDraft(null);
    }
  }, [editingCycleId, sortedCycles]);

  const calendarDays = useMemo(() => {
    const year = viewDate.getFullYear();
    const month = viewDate.getMonth();
    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const firstWeekday = (firstDayOfMonth.getDay() + 6) % 7;
    const totalDays = lastDayOfMonth.getDate();

    const days: Array<{
      dateStr: string;
      dayNumber: number;
      isCurrentMonth: boolean;
      isToday: boolean;
    }> = [];

    if (firstWeekday > 0) {
      const prevMonthLastDay = new Date(year, month, 0).getDate();
      for (let i = firstWeekday - 1; i >= 0; i--) {
        const d = new Date(year, month - 1, prevMonthLastDay - i);
        const dateStr = formatToIsoDate(d);
        days.push({
          dateStr,
          dayNumber: d.getDate(),
          isCurrentMonth: false,
          isToday: dateStr === todayStr,
        });
      }
    }

    for (let day = 1; day <= totalDays; day++) {
      const d = new Date(year, month, day);
      const dateStr = formatToIsoDate(d);
      days.push({
        dateStr,
        dayNumber: day,
        isCurrentMonth: true,
        isToday: dateStr === todayStr,
      });
    }

    const remaining = (7 - (days.length % 7)) % 7;
    for (let day = 1; day <= remaining; day++) {
      const d = new Date(year, month + 1, day);
      const dateStr = formatToIsoDate(d);
      days.push({
        dateStr,
        dayNumber: day,
        isCurrentMonth: false,
        isToday: dateStr === todayStr,
      });
    }

    return days;
  }, [viewDate, todayStr]);

  const selectedDayInfo = useMemo(() => {
    return getCalendarDayInfo(selectedDate, sortedCycles, metrics);
  }, [selectedDate, sortedCycles, metrics]);

  const nearbyCycle = useMemo(() => {
    if (selectedDayInfo.actualEntry) return null;
    return findNearbyCycle(sortedCycles, selectedDate, 13);
  }, [selectedDayInfo.actualEntry, sortedCycles, selectedDate]);

  const focusCalendarOnDate = (dateStr: string) => {
    const d = parseIsoDate(dateStr);
    if (!Number.isNaN(d.getTime())) {
      setViewDate(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    setSelectedDate(dateStr);
  };

  const handleSelectDayOnCalendar = (dateStr: string, isCurrentMonth: boolean) => {
    setSelectedDate(dateStr);
    setEditingCycleId(null);
    if (!isCurrentMonth) {
      const d = parseIsoDate(dateStr);
      setViewDate(new Date(d.getFullYear(), d.getMonth(), 1));
    }
  };

  const handleStartPeriodOnDate = (startDate: string) => {
    if (readOnly) return;
    const now = new Date().toISOString();
    const newId = `cycle_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newEntry: MenstrualCycleEntry = {
      id: newId,
      startDate,
      flowLevel: 'medium',
      source: 'logged',
      updatedAt: now,
    };
    const nextCycles = sortCyclesDesc([
      ...sortedCycles.filter((c) => c.startDate !== startDate),
      newEntry,
    ]);
    onSaveCycles(nextCycles, settings);
    setEditingCycleId(null);
  };

  const handleShiftCycleStart = (cycle: MenstrualCycleEntry, newStartDate: string) => {
    if (readOnly) return;
    const now = new Date().toISOString();
    const prevDuration = cycle.endDate ? Math.max(1, diffDaysIso(cycle.endDate, cycle.startDate) + 1) : null;
    const nextEndDate = prevDuration ? addDaysToIso(newStartDate, prevDuration - 1) : undefined;
    const nextCycles = sortCyclesDesc(
      sortedCycles.map((c) =>
        c.id === cycle.id
          ? { ...c, startDate: newStartDate, endDate: nextEndDate, updatedAt: now }
          : c,
      ),
    );
    onSaveCycles(nextCycles, settings);
    focusCalendarOnDate(newStartDate);
  };

  const handleSetCycleEndDate = (cycle: MenstrualCycleEntry, newEndDate?: string) => {
    if (readOnly) return;
    if (newEndDate && newEndDate < cycle.startDate) return;
    const now = new Date().toISOString();
    const nextCycles = sortCyclesDesc(
      sortedCycles.map((c) =>
        c.id === cycle.id
          ? { ...c, endDate: newEndDate, updatedAt: now }
          : c,
      ),
    );
    onSaveCycles(nextCycles, settings);
  };

  const handleAdjustCycleDuration = (cycle: MenstrualCycleEntry, deltaDays: number) => {
    if (readOnly) return;
    const currentEffectiveEnd =
      cycle.endDate || addDaysToIso(cycle.startDate, metrics.averagePeriodLength - 1);
    const currentDur = Math.max(2, diffDaysIso(currentEffectiveEnd, cycle.startDate) + 1);
    const nextDur = Math.max(2, Math.min(14, currentDur + deltaDays));
    const nextEndDate = addDaysToIso(cycle.startDate, nextDur - 1);
    handleSetCycleEndDate(cycle, nextEndDate);
  };

  const handleDeleteCycle = (cycleId: string) => {
    if (readOnly) return;
    const nextCycles = sortedCycles.filter((c) => c.id !== cycleId);
    onSaveCycles(nextCycles, settings);
    if (editingCycleId === cycleId) {
      setEditingCycleId(null);
      setDetailDraft(null);
    }
  };

  const openInlineEditorForCycle = (cycle: MenstrualCycleEntry) => {
    if (readOnly) return;
    focusCalendarOnDate(cycle.startDate);
    setEditingCycleId(cycle.id);
    setDetailDraft({
      id: cycle.id,
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      flowLevel: cycle.flowLevel || 'medium',
      symptoms: cycle.symptoms || [],
      notes: cycle.notes || '',
    });
  };

  const handleSaveDetailDraft = () => {
    if (!detailDraft || readOnly) return;
    const now = new Date().toISOString();
    const safeEnd =
      detailDraft.endDate && detailDraft.endDate >= detailDraft.startDate
        ? detailDraft.endDate
        : undefined;
    const nextCycles = sortCyclesDesc(
      sortedCycles.map((c) =>
        c.id === detailDraft.id
          ? {
              ...c,
              startDate: detailDraft.startDate,
              endDate: safeEnd,
              flowLevel: detailDraft.flowLevel,
              symptoms: detailDraft.symptoms,
              notes: detailDraft.notes.trim() || undefined,
              updatedAt: now,
            }
          : c,
      ),
    );
    onSaveCycles(nextCycles, settings);
    setSelectedDate(detailDraft.startDate);
    setEditingCycleId(null);
    setDetailDraft(null);
  };

  const handleSaveSettings = () => {
    const nextSettings: MenstrualCycleSettings = {
      defaultCycleLength: Math.max(20, Math.min(60, Math.round(cycleLengthInput) || DEFAULT_CYCLE_LENGTH)),
      defaultPeriodLength: Math.max(2, Math.min(14, Math.round(periodLengthInput) || DEFAULT_PERIOD_LENGTH)),
      remindBeforeDays: Math.max(0, Math.min(7, Math.round(remindBeforeDaysInput))),
      reminderEnabled: remindEnabled,
    };
    onSaveCycles(sortedCycles, nextSettings);
    setShowSettings(false);
  };

  const toggleDraftSymptom = (key: string) => {
    if (!detailDraft) return;
    const exists = detailDraft.symptoms.includes(key);
    setDetailDraft({
      ...detailDraft,
      symptoms: exists
        ? detailDraft.symptoms.filter((s) => s !== key)
        : [...detailDraft.symptoms, key],
    });
  };

  const latestCycle = sortedCycles[0];
  const latestCycleEffectiveEnd = latestCycle
    ? latestCycle.endDate || addDaysToIso(latestCycle.startDate, metrics.averagePeriodLength - 1)
    : undefined;
  const latestCycleDuration =
    latestCycle && latestCycleEffectiveEnd
      ? diffDaysIso(latestCycleEffectiveEnd, latestCycle.startDate) + 1
      : undefined;

  const headerStatusText = useMemo(() => {
    if (sortedCycles.length === 0) {
      return 'Chưa có dữ liệu';
    }
    if (metrics.isInPeriodToday && metrics.lastPeriodEnd) {
      const dayLabel = metrics.currentCycleDay ? `Ngày ${metrics.currentCycleDay}` : 'Đang hành kinh';
      return `${dayLabel} · Hết ${formatShortVN(metrics.lastPeriodEnd)}`;
    }
    if (metrics.isOverdue && typeof metrics.daysUntilNextPeriod === 'number') {
      return `Trễ ${Math.abs(metrics.daysUntilNextPeriod)} ngày`;
    }
    if (typeof metrics.daysUntilNextPeriod === 'number' && metrics.nextPredictedPeriod) {
      if (metrics.daysUntilNextPeriod === 0) {
        return 'Dự kiến kỳ mới hôm nay';
      }
      return `Còn ${metrics.daysUntilNextPeriod} ngày · ${formatShortVN(metrics.nextPredictedPeriod)}`;
    }
    return `TB ${metrics.averageCycleLength} ngày`;
  }, [metrics, sortedCycles.length]);

  const activeCycle = selectedDayInfo.actualEntry;
  const activeCycleEffectiveEnd = activeCycle
    ? activeCycle.endDate || addDaysToIso(activeCycle.startDate, metrics.averagePeriodLength - 1)
    : undefined;
  const activeCycleDuration =
    activeCycle && activeCycleEffectiveEnd
      ? diffDaysIso(activeCycleEffectiveEnd, activeCycle.startDate) + 1
      : undefined;

  return (
    <div className="rounded-2xl border border-slate-200/90 bg-white p-3.5 sm:p-4 shadow-xs space-y-3 overflow-hidden max-w-full">
      {/* 1. Compact Header */}
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div className="w-8 h-8 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center shrink-0 border border-rose-100">
            <Droplet className="w-4 h-4 text-rose-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h4 className="text-xs sm:text-sm font-bold text-slate-900 tracking-tight truncate">
              Chu kỳ kinh nguyệt
            </h4>
            <p
              className={`text-[11px] truncate mt-0.5 tabular-nums ${
                metrics.isOverdue
                  ? 'text-amber-700 font-semibold'
                  : metrics.isInPeriodToday
                    ? 'text-rose-700 font-semibold'
                    : 'text-slate-500'
              }`}
            >
              {headerStatusText}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          className="inline-flex items-center gap-1 min-h-[34px] px-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold transition-colors shrink-0 whitespace-nowrap active:scale-[0.98]"
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Thu gọn lịch chu kỳ' : 'Mở lịch chu kỳ'}
        >
          <span>{isExpanded ? 'Thu gọn' : 'Mở lịch'}</span>
          {isExpanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
        </button>
      </div>

      {/* 2. Compact 3-Column Overview Strip */}
      {sortedCycles.length > 0 && latestCycle && (
        <div className="grid grid-cols-3 divide-x divide-slate-100 pt-2.5 border-t border-slate-100 text-left">
          <div className="pr-2 min-w-0">
            <div className="text-[10px] font-medium text-slate-400 truncate">Kỳ gần nhất</div>
            <div className="text-xs font-bold text-slate-800 tabular-nums truncate mt-0.5">
              {formatShortVN(latestCycle.startDate)}–{metrics.lastPeriodEnd ? formatShortVN(metrics.lastPeriodEnd) : '—'}
            </div>
            <div className="text-[10px] text-slate-500 truncate">
              {metrics.isLastPeriodEndPredicted ? 'Dự kiến hết' : 'Đã ghi'}
            </div>
          </div>

          <div className="px-2 min-w-0">
            <div className="text-[10px] font-medium text-slate-400 truncate">Kỳ tiếp</div>
            <div
              className={`text-xs font-bold tabular-nums truncate mt-0.5 ${
                metrics.isOverdue ? 'text-amber-700' : 'text-rose-700'
              }`}
            >
              {metrics.nextPredictedPeriod ? formatShortVN(metrics.nextPredictedPeriod) : '—'}
            </div>
            <div className="text-[10px] text-slate-500 truncate tabular-nums">
              TB {metrics.averageCycleLength} ngày
            </div>
          </div>

          <div className="pl-2 min-w-0">
            <div className="text-[10px] font-medium text-slate-400 truncate">Rụng trứng</div>
            <div className="text-xs font-bold text-teal-700 tabular-nums truncate mt-0.5">
              {metrics.predictedOvulationDate ? formatShortVN(metrics.predictedOvulationDate) : '—'}
            </div>
            <div className="text-[10px] text-slate-500 truncate tabular-nums">
              {metrics.fertileWindowStart && metrics.fertileWindowEnd
                ? `${formatShortVN(metrics.fertileWindowStart)}–${formatShortVN(metrics.fertileWindowEnd)}`
                : '—'}
            </div>
          </div>
        </div>
      )}

      {/* Menorrhagia Advisory */}
      {metrics.hasMenorrhagia && (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50/50 px-3 py-2 text-[11px] text-amber-900 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
          <span className="leading-snug min-w-0">
            Kinh kéo dài hoặc ra nhiều: nên đối chiếu thêm chỉ số Sắt / Ferritin khi khám.
          </span>
        </div>
      )}

      {/* 3. Single-Page Expanded Calendar Workspace */}
      {isExpanded && (
        <div className="pt-2.5 border-t border-slate-100 space-y-3 text-xs min-w-0">
          {/* Calendar Toolbar (strictly fits within mobile width, icon-only settings button) */}
          <div className="flex items-center justify-between gap-1.5 min-w-0">
            <div className="flex items-center gap-1 min-w-0">
              <button
                type="button"
                onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))}
                className="w-8 h-8 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-600 transition-colors shrink-0"
                aria-label="Tháng trước"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-bold text-slate-900 px-1.5 text-xs sm:text-sm tabular-nums whitespace-nowrap truncate">
                Tháng {viewDate.getMonth() + 1}/{viewDate.getFullYear()}
              </span>
              <button
                type="button"
                onClick={() => setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))}
                className="w-8 h-8 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 flex items-center justify-center text-slate-600 transition-colors shrink-0"
                aria-label="Tháng sau"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => focusCalendarOnDate(todayStr)}
                className="h-8 px-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-[11px] whitespace-nowrap"
              >
                Hôm nay
              </button>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => setShowSettings((prev) => !prev)}
                  className={`w-8 h-8 rounded-xl border flex items-center justify-center transition-colors shrink-0 ${
                    showSettings
                      ? 'border-slate-800 bg-slate-800 text-white'
                      : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                  }`}
                  aria-expanded={showSettings}
                  aria-label="Cấu hình chu kỳ"
                  title="Cấu hình"
                >
                  <Settings2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>

          {/* Inline Cycle Configuration Drawer */}
          {showSettings && !readOnly && (
            <div className="py-2.5 border-y border-slate-100 space-y-2.5 bg-slate-50/50 rounded-xl px-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">Cấu hình chu kỳ</span>
                <button
                  type="button"
                  onClick={() => setShowSettings(false)}
                  className="p-1 text-slate-400 hover:text-slate-700"
                  aria-label="Đóng cấu hình"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="min-w-0">
                  <label className="block text-[10px] text-slate-500 mb-1 truncate">Chu kỳ (ngày)</label>
                  <input
                    type="number"
                    min={20}
                    max={60}
                    value={cycleLengthInput}
                    onChange={(e) => setCycleLengthInput(parseInt(e.target.value, 10) || DEFAULT_CYCLE_LENGTH)}
                    className="w-full h-9 px-2 rounded-xl border border-slate-200 bg-white font-bold text-slate-800 tabular-nums text-xs"
                  />
                </div>
                <div className="min-w-0">
                  <label className="block text-[10px] text-slate-500 mb-1 truncate">Hành kinh</label>
                  <input
                    type="number"
                    min={2}
                    max={14}
                    value={periodLengthInput}
                    onChange={(e) => setPeriodLengthInput(parseInt(e.target.value, 10) || DEFAULT_PERIOD_LENGTH)}
                    className="w-full h-9 px-2 rounded-xl border border-slate-200 bg-white font-bold text-slate-800 tabular-nums text-xs"
                  />
                </div>
                <div className="min-w-0">
                  <label className="block text-[10px] text-slate-500 mb-1 truncate">Nhắc trước</label>
                  <input
                    type="number"
                    min={0}
                    max={7}
                    value={remindBeforeDaysInput}
                    onChange={(e) => setRemindBeforeDaysInput(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-full h-9 px-2 rounded-xl border border-slate-200 bg-white font-bold text-slate-800 tabular-nums text-xs"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                <label className="flex items-center gap-2 text-[11px] text-slate-700 cursor-pointer select-none min-w-0">
                  <input
                    type="checkbox"
                    checked={remindEnabled}
                    onChange={(e) => setRemindEnabled(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500 shrink-0"
                  />
                  <span className="truncate">Nhắc lịch & Google Calendar</span>
                </label>
                <div className="flex items-center gap-1.5 shrink-0">
                  {onOpenCalendarSync && (
                    <button
                      type="button"
                      onClick={onOpenCalendarSync}
                      className="h-8 px-2.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-[11px] inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      <CalendarCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      <span>Calendar</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    className="h-8 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-[11px] whitespace-nowrap"
                  >
                    Lưu
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Monthly Calendar Grid — Soft, Calm, Zero-Glare Palette */}
          <div>
            <div className="grid grid-cols-7 gap-1 text-center mb-1">
              {['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((w, idx) => (
                <div
                  key={w}
                  className={`text-[10px] font-semibold py-0.5 ${idx >= 5 ? 'text-rose-500/80' : 'text-slate-400'}`}
                >
                  {w}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {calendarDays.map((day) => {
                const dayInfo = getCalendarDayInfo(day.dateStr, sortedCycles, metrics);
                const isSelected = day.dateStr === selectedDate;

                let cellStyle = day.isCurrentMonth
                  ? 'text-slate-700 hover:bg-slate-50'
                  : 'text-slate-300 hover:bg-slate-50/50';

                if (dayInfo.isActualPeriod) {
                  cellStyle = day.isCurrentMonth
                    ? 'bg-rose-100/85 text-rose-900 font-semibold hover:bg-rose-100'
                    : 'bg-rose-50/70 text-rose-400 font-medium';
                } else if (dayInfo.isPredictedPeriod) {
                  cellStyle = day.isCurrentMonth
                    ? 'bg-rose-50/45 text-rose-700 border border-dashed border-rose-300/80 font-medium hover:bg-rose-50'
                    : 'bg-rose-50/25 text-rose-300 border border-dashed border-rose-200/60';
                } else if (dayInfo.isPredictedOvulation) {
                  cellStyle = day.isCurrentMonth
                    ? 'bg-teal-50/80 text-teal-800 font-semibold hover:bg-teal-50'
                    : 'bg-teal-50/30 text-teal-400';
                } else if (dayInfo.isFertileWindow) {
                  cellStyle = day.isCurrentMonth
                    ? 'bg-teal-50/40 text-teal-700 hover:bg-teal-50/70'
                    : 'bg-teal-50/20 text-teal-300';
                }

                const todayRing = day.isToday
                  ? 'ring-1 ring-emerald-500/80 font-bold'
                  : '';
                const selectedRing = isSelected
                  ? 'ring-2 ring-slate-800 ring-offset-1 z-10'
                  : '';

                return (
                  <button
                    key={day.dateStr}
                    type="button"
                    onClick={() => handleSelectDayOnCalendar(day.dateStr, day.isCurrentMonth)}
                    className={`relative h-9 sm:h-10 rounded-xl flex flex-col items-center justify-center text-xs transition-colors ${cellStyle} ${todayRing} ${selectedRing}`}
                    aria-label={`Ngày ${formatDateVN(day.dateStr)}`}
                    aria-pressed={isSelected}
                  >
                    <span className="tabular-nums leading-none">{day.dayNumber}</span>
                    {dayInfo.isActualPeriod && dayInfo.isPeriodStart && (
                      <span
                        className="mt-1 w-1.5 h-1.5 rounded-full bg-rose-500"
                        aria-hidden="true"
                      />
                    )}
                    {dayInfo.isPredictedPeriod && dayInfo.isPredictedStart && !dayInfo.isActualPeriod && (
                      <span
                        className="mt-1 w-1.5 h-1.5 rounded-full border border-rose-400 bg-white"
                        aria-hidden="true"
                      />
                    )}
                    {!dayInfo.isActualPeriod && !dayInfo.isPredictedPeriod && dayInfo.isPredictedOvulation && (
                      <span
                        className="mt-1 w-1.5 h-1.5 rounded-full bg-teal-500"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Quiet Unboxed Legend */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2 text-[10px] text-slate-500">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-rose-100 border border-rose-200 inline-block" />
                Hành kinh
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm bg-rose-50 border border-dashed border-rose-300 inline-block" />
                Dự kiến
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-teal-500 inline-block" />
                Rụng trứng
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm border border-emerald-500 inline-block" />
                Hôm nay
              </span>
            </div>
          </div>

          {/* 4. Contextual Single-Page Action Bar for Selected Date */}
          <div className="pt-2.5 border-t border-slate-100 space-y-2 min-w-0">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 tabular-nums flex-wrap">
                <span>{formatDateVN(selectedDate)}</span>
                <span className="text-slate-300" aria-hidden="true">·</span>
                <span
                  className={
                    selectedDayInfo.isActualPeriod
                      ? 'text-rose-700 font-semibold'
                      : selectedDayInfo.isPredictedPeriod
                        ? 'text-rose-600 font-medium'
                        : selectedDayInfo.isPredictedOvulation
                          ? 'text-teal-700 font-medium'
                          : 'text-slate-500 font-normal'
                  }
                >
                  {selectedDayInfo.isActualPeriod
                    ? 'Hành kinh'
                    : selectedDayInfo.isPredictedPeriod
                      ? 'Dự kiến kỳ mới'
                      : selectedDayInfo.isPredictedOvulation
                        ? 'Rụng trứng'
                        : selectedDayInfo.isFertileWindow
                          ? 'Dễ thụ thai'
                          : 'Bình thường'}
                </span>
              </div>

              {activeCycle && activeCycleEffectiveEnd && (
                <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums truncate">
                  {formatShortVN(activeCycle.startDate)}–{formatShortVN(activeCycleEffectiveEnd)} · {activeCycleDuration} ngày
                  {!activeCycle.endDate ? ' (dự kiến)' : ''}
                  {activeCycle.flowLevel && activeCycle.flowLevel !== 'medium'
                    ? ` · ${FLOW_LEVEL_LABELS[activeCycle.flowLevel].label}`
                    : ''}
                </p>
              )}

              {!activeCycle && nearbyCycle && (
                <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums truncate">
                  Cách đầu kỳ {formatShortVN(nearbyCycle.cycle.startDate)} {Math.abs(nearbyCycle.dayDeltaFromStart)} ngày
                </p>
              )}

              {!activeCycle && !nearbyCycle && (
                <p className="text-[11px] text-slate-500 mt-0.5 tabular-nums truncate">
                  Hết {formatShortVN(addDaysToIso(selectedDate, metrics.averagePeriodLength - 1))} · Kỳ sau {formatDateVN(addDaysToIso(selectedDate, metrics.averageCycleLength))}
                </p>
              )}
            </div>

            {!readOnly && activeCycle && (
              <div className="flex flex-wrap items-center gap-1.5">
                {selectedDate > activeCycle.startDate && selectedDate !== activeCycle.endDate && (
                  <button
                    type="button"
                    onClick={() => handleSetCycleEndDate(activeCycle, selectedDate)}
                    className="h-9 px-2.5 rounded-xl bg-rose-50 hover:bg-rose-100 text-rose-800 border border-rose-200 font-semibold text-[11px] inline-flex items-center gap-1"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Hết {formatShortVN(selectedDate)}</span>
                  </button>
                )}

                <div className="inline-flex items-center rounded-xl border border-slate-200 bg-slate-50 h-9">
                  <button
                    type="button"
                    onClick={() => handleAdjustCycleDuration(activeCycle, -1)}
                    className="w-8 h-full flex items-center justify-center text-slate-600 hover:text-slate-900 rounded-l-xl hover:bg-slate-100"
                    aria-label="Giảm 1 ngày hành kinh"
                  >
                    <Minus className="w-3.5 h-3.5" />
                  </button>
                  <span className="px-2 text-[11px] font-semibold text-slate-700 tabular-nums whitespace-nowrap">
                    {activeCycleDuration} ngày
                  </span>
                  <button
                    type="button"
                    onClick={() => handleAdjustCycleDuration(activeCycle, 1)}
                    className="w-8 h-full flex items-center justify-center text-slate-600 hover:text-slate-900 rounded-r-xl hover:bg-slate-100"
                    aria-label="Tăng 1 ngày hành kinh"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    editingCycleId === activeCycle.id
                      ? setEditingCycleId(null)
                      : openInlineEditorForCycle(activeCycle)
                  }
                  className={`h-9 px-2.5 rounded-xl border font-semibold text-[11px] inline-flex items-center gap-1 ${
                    editingCycleId === activeCycle.id
                      ? 'border-slate-800 bg-slate-800 text-white'
                      : 'border-slate-200 bg-white hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <Pencil className="w-3 h-3" />
                  <span>Sửa</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleDeleteCycle(activeCycle.id)}
                  className="h-9 px-2.5 rounded-xl border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 font-semibold text-[11px] inline-flex items-center gap-1"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>Xóa</span>
                </button>
              </div>
            )}

            {!readOnly && !activeCycle && nearbyCycle && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleShiftCycleStart(nearbyCycle.cycle, selectedDate)}
                  className="h-9 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-[11px] inline-flex items-center gap-1.5"
                >
                  <span>Dời đầu kỳ → {formatShortVN(selectedDate)}</span>
                </button>
                {nearbyCycle.dayDeltaFromStart > 0 && (
                  <button
                    type="button"
                    onClick={() => handleSetCycleEndDate(nearbyCycle.cycle, selectedDate)}
                    className="h-9 px-3 rounded-xl border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 font-semibold text-[11px]"
                  >
                    Hết {formatShortVN(selectedDate)}
                  </button>
                )}
              </div>
            )}

            {!readOnly && !activeCycle && !nearbyCycle && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleStartPeriodOnDate(selectedDate)}
                  className="h-9 px-3.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs inline-flex items-center gap-1.5 transition-colors active:scale-[0.98] max-w-full"
                >
                  <Plus className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {selectedDayInfo.isPredictedPeriod
                      ? `Xác nhận đầu kỳ ${formatShortVN(selectedDate)}`
                      : `Đặt ${formatShortVN(selectedDate)} làm đầu kỳ`}
                  </span>
                </button>
              </div>
            )}

            {/* Inline Detail Editor (No nested DatePicker popup) */}
            {detailDraft && editingCycleId && !readOnly && (
              <div className="pt-2.5 border-t border-slate-100 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-slate-600">Đầu kỳ:</span>
                    <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 h-8">
                      <button
                        type="button"
                        onClick={() => {
                          const shifted = addDaysToIso(detailDraft.startDate, -1);
                          const shiftedEnd = detailDraft.endDate ? addDaysToIso(detailDraft.endDate, -1) : undefined;
                          setDetailDraft({ ...detailDraft, startDate: shifted, endDate: shiftedEnd });
                        }}
                        className="px-2 h-full text-slate-600 hover:text-slate-900"
                        aria-label="Lùi ngày bắt đầu 1 ngày"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <span className="px-2 text-[11px] font-bold text-slate-800 tabular-nums">
                        {formatDateVN(detailDraft.startDate)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const shifted = addDaysToIso(detailDraft.startDate, 1);
                          const shiftedEnd = detailDraft.endDate ? addDaysToIso(detailDraft.endDate, 1) : undefined;
                          setDetailDraft({ ...detailDraft, startDate: shifted, endDate: shiftedEnd });
                        }}
                        className="px-2 h-full text-slate-600 hover:text-slate-900"
                        aria-label="Tăng ngày bắt đầu 1 ngày"
                      >
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {detailDraft.endDate && (
                    <button
                      type="button"
                      onClick={() => setDetailDraft({ ...detailDraft, endDate: undefined })}
                      className="text-[11px] font-medium text-slate-500 hover:text-slate-800 underline"
                    >
                      Theo mặc định ({metrics.averagePeriodLength}đ)
                    </button>
                  )}
                </div>

                <div>
                  <span className="block text-[10px] text-slate-500 mb-1">Lượng kinh</span>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(Object.keys(FLOW_LEVEL_LABELS) as MenstrualFlowLevel[]).map((level) => {
                      const info = FLOW_LEVEL_LABELS[level];
                      const active = detailDraft.flowLevel === level;
                      return (
                        <button
                          key={level}
                          type="button"
                          onClick={() => setDetailDraft({ ...detailDraft, flowLevel: level })}
                          className={`h-8 px-1.5 rounded-xl border text-[11px] font-medium transition-colors truncate ${
                            active
                              ? 'border-rose-400 bg-rose-50 text-rose-900 font-semibold'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {info.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <span className="block text-[10px] text-slate-500 mb-1">Triệu chứng</span>
                  <div className="flex flex-wrap gap-1.5">
                    {COMMON_CYCLE_SYMPTOMS.map((sym) => {
                      const selected = detailDraft.symptoms.includes(sym.key);
                      return (
                        <button
                          key={sym.key}
                          type="button"
                          onClick={() => toggleDraftSymptom(sym.key)}
                          className={`h-7 px-2 rounded-lg text-[11px] font-medium border transition-colors ${
                            selected
                              ? 'border-rose-300 bg-rose-50 text-rose-900'
                              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          {sym.icon} {sym.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={() => handleDeleteCycle(detailDraft.id)}
                    className="h-8 px-2.5 rounded-xl text-rose-700 hover:bg-rose-50 font-semibold text-[11px] inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Xóa</span>
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingCycleId(null);
                        setDetailDraft(null);
                      }}
                      className="h-8 px-3 rounded-xl border border-slate-200 text-slate-600 text-[11px] font-semibold"
                    >
                      Đóng
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveDetailDraft}
                      className="h-8 px-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-[11px] font-semibold"
                    >
                      Lưu
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 5. Single Unified Cycle Tracking Row + Cycle Analytics (no growing multi-row list) */}
          {sortedCycles.length > 0 && latestCycle && latestCycleEffectiveEnd && (
            <div className="pt-2.5 border-t border-slate-100 space-y-2 min-w-0">
              {/* Single Current/Latest Cycle Row */}
              <div className="flex items-center justify-between gap-2 text-[11px] min-w-0">
                <button
                  type="button"
                  onClick={() => focusCalendarOnDate(latestCycle.startDate)}
                  className="text-left min-w-0 flex-1 hover:text-rose-700 transition-colors"
                >
                  <span className="font-semibold text-slate-800 tabular-nums block truncate">
                    Chu kỳ: {formatShortVN(latestCycle.startDate)}–{formatShortVN(latestCycleEffectiveEnd)} ({latestCycleDuration}đ)
                    {metrics.nextPredictedPeriod ? ` → Tiếp ${formatShortVN(metrics.nextPredictedPeriod)}` : ''}
                  </span>
                </button>

                {!readOnly && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => openInlineEditorForCycle(latestCycle)}
                      className="h-7 px-2 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 font-semibold"
                    >
                      Sửa
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteCycle(latestCycle.id)}
                      className="h-7 w-7 flex items-center justify-center rounded-lg text-rose-600 hover:bg-rose-50"
                      aria-label={`Xóa kỳ ${formatDateVN(latestCycle.startDate)}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>

              {/* Compact Recorded Cycle Intervals & Health Evaluation */}
              <div className="text-[11px] text-slate-600 space-y-1.5 min-w-0">
                <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500 min-w-0">
                  <span
                    className={`truncate font-medium ${
                      metrics.regularityStatus === 'irregular' || metrics.hasMenorrhagia
                        ? 'text-amber-700'
                        : 'text-slate-600'
                    }`}
                  >
                    {metrics.healthAssessmentLabel}
                  </span>
                  <span className="tabular-nums shrink-0">
                    {metrics.cycleRecords.length} mốc · TB {metrics.averageCycleLength}đ
                  </span>
                </div>

                {metrics.cycleRecords.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {metrics.cycleRecords.map((rec) => {
                      const isCurrentSelected = selectedDate === rec.startDate;
                      return (
                        <button
                          key={rec.id}
                          type="button"
                          onClick={() => focusCalendarOnDate(rec.startDate)}
                          className={`px-2 py-1 rounded-lg border text-[10px] tabular-nums transition-colors ${
                            isCurrentSelected
                              ? 'border-rose-300 bg-rose-50 text-rose-900 font-semibold'
                              : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                          }`}
                          title="Chạm để xem hoặc sửa/xóa trên lịch"
                        >
                          {formatShortVN(rec.startDate)}
                          {rec.cycleLengthDays !== undefined ? ` (${rec.cycleLengthDays}đ)` : ''}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
