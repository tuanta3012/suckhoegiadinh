import type {
  HealthDeletionTombstone,
  MenstrualCycleEntry,
  MenstrualCycleSettings,
  MenstrualCycleSummary,
  MenstrualFlowLevel,
} from '../types';

export const DEFAULT_CYCLE_LENGTH = 28;
export const DEFAULT_PERIOD_LENGTH = 5;
export const DEFAULT_REMIND_BEFORE_DAYS = 2;

export const COMMON_CYCLE_SYMPTOMS: Array<{ key: string; label: string; icon: string }> = [
  { key: 'cramps', label: 'Đau bụng dưới', icon: '⚡' },
  { key: 'backache', label: 'Đau lưng', icon: '🦴' },
  { key: 'tender_breasts', label: 'Căng tức ngực', icon: '🌸' },
  { key: 'fatigue', label: 'Mệt mỏi', icon: '💤' },
  { key: 'headache', label: 'Đau đầu', icon: '🤕' },
  { key: 'acne', label: 'Nổi mụn', icon: '✨' },
  { key: 'mood_swings', label: 'Thay đổi tâm trạng', icon: '🎭' },
  { key: 'bloating', label: 'Đầy hơi', icon: '🎈' },
  { key: 'nausea', label: 'Buồn nôn', icon: '🤢' },
];

export const FLOW_LEVEL_LABELS: Record<MenstrualFlowLevel, { label: string; description: string }> = {
  spotting: { label: 'Đốm nhẹ', description: 'Vài giọt hoặc đốm nhỏ' },
  light: { label: 'Ít', description: 'Lượng kinh nhẹ, thay 1-2 băng/ngày' },
  medium: { label: 'Vừa', description: 'Mức trung bình, đều đặn' },
  heavy: { label: 'Nhiều', description: 'Lượng kinh nhiều, cần chú ý bổ sung sắt' },
};

/**
 * Format Date to YYYY-MM-DD in local time
 */
export function formatToIsoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Parse YYYY-MM-DD into a local Date object safely at midnight
 */
export function parseIsoDate(str: string): Date {
  const parts = str.split('-');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    return new Date(y, m, d, 0, 0, 0, 0);
  }
  return new Date(str);
}

/**
 * Add / subtract integer days from an ISO date string
 */
export function addDaysToIso(dateStr: string, days: number): string {
  const d = parseIsoDate(dateStr);
  d.setDate(d.getDate() + days);
  return formatToIsoDate(d);
}

/**
 * Difference in days between two ISO dates (dateA - dateB)
 */
export function diffDaysIso(dateA: string, dateB: string): number {
  const msA = parseIsoDate(dateA).getTime();
  const msB = parseIsoDate(dateB).getTime();
  return Math.round((msA - msB) / (1000 * 60 * 60 * 24));
}

export interface PredictedCycle {
  cycleIndex: number;
  startDate: string;
  endDate: string;
  ovulationDate: string;
  fertileWindowStart: string;
  fertileWindowEnd: string;
}

export interface CycleIntervalRecord {
  id: string;
  startDate: string;
  endDate?: string;
  periodLengthDays: number;
  isPeriodEndPredicted: boolean;
  cycleLengthDays?: number; // actual days until next recorded period start
}

export interface ComputedCycleMetrics {
  averageCycleLength: number;
  averagePeriodLength: number;
  lastPeriodStart?: string;
  lastPeriodEnd?: string;
  isLastPeriodEndPredicted?: boolean;
  currentCycleDay?: number;
  nextPredictedPeriod?: string;
  daysUntilNextPeriod?: number; // >0: days left, 0: today, <0: overdue by Math.abs(days)
  isOverdue: boolean;
  predictedOvulationDate?: string;
  fertileWindowStart?: string;
  fertileWindowEnd?: string;
  isInPeriodToday: boolean;
  isFertileToday: boolean;
  regularityStatus: 'regular' | 'irregular' | 'insufficient_data';
  healthAssessmentLabel: string;
  hasMenorrhagia: boolean;
  recentIntervals: number[];
  cycleRecords: CycleIntervalRecord[];
  predictedCycles: PredictedCycle[];
}

/**
 * Clean & sort cycles strictly by startDate descending (newest first)
 */
export function sortCyclesDesc(cycles: MenstrualCycleEntry[]): MenstrualCycleEntry[] {
  return [...cycles].filter((c) => c && c.startDate).sort((a, b) => b.startDate.localeCompare(a.startDate));
}

/**
 * Clean & sort cycles strictly by startDate ascending (oldest first)
 */
export function sortCyclesAsc(cycles: MenstrualCycleEntry[]): MenstrualCycleEntry[] {
  return [...cycles].filter((c) => c && c.startDate).sort((a, b) => a.startDate.localeCompare(b.startDate));
}

/**
 * Calculate cycle metrics, adaptive predictions, and clinical indicators
 */
export function calculateCycleMetrics(
  rawCycles: MenstrualCycleEntry[] = [],
  settings?: MenstrualCycleSettings,
  referenceDate = formatToIsoDate(new Date()),
): ComputedCycleMetrics {
  const defaultCycle = settings?.defaultCycleLength || DEFAULT_CYCLE_LENGTH;
  const defaultPeriod = settings?.defaultPeriodLength || DEFAULT_PERIOD_LENGTH;

  const sortedAsc = sortCyclesAsc(rawCycles);

  if (sortedAsc.length === 0) {
    return {
      averageCycleLength: defaultCycle,
      averagePeriodLength: defaultPeriod,
      isInPeriodToday: false,
      isFertileToday: false,
      isOverdue: false,
      regularityStatus: 'insufficient_data',
      healthAssessmentLabel: 'Chưa đủ dữ liệu',
      hasMenorrhagia: false,
      recentIntervals: [],
      cycleRecords: [],
      predictedCycles: [],
    };
  }

  // 1. Calculate intervals between consecutive periods
  const allIntervals: number[] = [];
  const physiologicalIntervals: number[] = [];
  const periodDurations: number[] = [];
  let menorrhagiaDetected = false;

  for (let i = 0; i < sortedAsc.length; i++) {
    const current = sortedAsc[i];

    // Period duration
    if (current.endDate && current.endDate >= current.startDate) {
      const dur = diffDaysIso(current.endDate, current.startDate) + 1;
      if (dur >= 2 && dur <= 16) {
        periodDurations.push(dur);
        if (dur >= 8 || (dur >= 7 && current.flowLevel === 'heavy')) {
          menorrhagiaDetected = true;
        }
      }
    } else if (current.flowLevel === 'heavy') {
      menorrhagiaDetected = true;
    }

    // Interval to next cycle
    if (i < sortedAsc.length - 1) {
      const next = sortedAsc[i + 1];
      const interval = diffDaysIso(next.startDate, current.startDate);
      if (interval > 0) {
        allIntervals.push(interval);
        // Physiological range used for adaptive prediction weighting
        if (interval >= 18 && interval <= 65) {
          physiologicalIntervals.push(interval);
        }
      }
    }
  }

  // 2. Weighted average cycle length (higher weights to recent physiological cycles)
  let avgCycleLength = defaultCycle;
  if (physiologicalIntervals.length > 0) {
    const recentPhysiological = physiologicalIntervals.slice(-4);
    const weights = [1, 1.5, 2, 2.5].slice(-recentPhysiological.length);
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    const weightedSum = recentPhysiological.reduce((sum, intv, idx) => sum + intv * weights[idx], 0);
    avgCycleLength = Math.round(weightedSum / totalWeight);
    // Clamp to reasonable biological limits for calendar prediction
    avgCycleLength = Math.max(21, Math.min(45, avgCycleLength));
  }

  // 3. Average period duration
  let avgPeriodLength = defaultPeriod;
  if (periodDurations.length > 0) {
    const recentDurations = periodDurations.slice(-4);
    const sum = recentDurations.reduce((acc, d) => acc + d, 0);
    avgPeriodLength = Math.round(sum / recentDurations.length);
    avgPeriodLength = Math.max(3, Math.min(10, avgPeriodLength));
  }

  // 4. Regularity evaluation across ALL recorded consecutive intervals
  let regularityStatus: 'regular' | 'irregular' | 'insufficient_data' = 'insufficient_data';
  const minInterval = allIntervals.length > 0 ? Math.min(...allIntervals) : undefined;
  const maxInterval = allIntervals.length > 0 ? Math.max(...allIntervals) : undefined;
  const intervalSpread =
    minInterval !== undefined && maxInterval !== undefined ? maxInterval - minInterval : 0;
  const hasShortCycle = minInterval !== undefined && minInterval < 21;
  const hasLongCycle = maxInterval !== undefined && maxInterval > 35;

  if (allIntervals.length >= 2) {
    const mean = allIntervals.reduce((acc, v) => acc + v, 0) / allIntervals.length;
    const variance =
      allIntervals.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / allIntervals.length;
    const stdDev = Math.sqrt(variance);
    // Clinically regular: every cycle is 21-35 days, total spread <= 6 days, and stdDev <= 4
    const withinNormalRange = !hasShortCycle && !hasLongCycle;
    regularityStatus =
      withinNormalRange && intervalSpread <= 6 && stdDev <= 4 ? 'regular' : 'irregular';
  } else if (allIntervals.length === 1) {
    const only = allIntervals[0];
    const withinNormalRange = only >= 21 && only <= 35;
    regularityStatus =
      withinNormalRange && Math.abs(only - defaultCycle) <= 5 ? 'regular' : 'irregular';
  }

  // 5. Last cycle info and current day
  const latestCycle = sortedAsc[sortedAsc.length - 1];
  const lastPeriodStart = latestCycle.startDate;
  const lastPeriodEnd = latestCycle.endDate || addDaysToIso(lastPeriodStart, avgPeriodLength - 1);

  const daysSinceStart = diffDaysIso(referenceDate, lastPeriodStart);
  const currentCycleDay = daysSinceStart >= 0 ? daysSinceStart + 1 : undefined;

  // Is member actively in period today?
  const isInPeriodToday =
    referenceDate >= lastPeriodStart &&
    (latestCycle.endDate ? referenceDate <= latestCycle.endDate : diffDaysIso(referenceDate, lastPeriodStart) < avgPeriodLength);

  // 6. Next predicted periods (generate up to 3 cycles)
  const predictedCycles: PredictedCycle[] = [];
  let prevStart = lastPeriodStart;

  for (let idx = 1; idx <= 3; idx++) {
    const predStart = addDaysToIso(prevStart, avgCycleLength);
    const predEnd = addDaysToIso(predStart, avgPeriodLength - 1);
    // Ovulation is approximately 14 days before the next period starts
    const ovulationDate = addDaysToIso(predStart, Math.max(10, avgCycleLength - 14));
    const fertileStart = addDaysToIso(ovulationDate, -5);
    const fertileEnd = addDaysToIso(ovulationDate, 1);

    predictedCycles.push({
      cycleIndex: idx,
      startDate: predStart,
      endDate: predEnd,
      ovulationDate,
      fertileWindowStart: fertileStart,
      fertileWindowEnd: fertileEnd,
    });

    prevStart = predStart;
  }

  const primaryNext = predictedCycles[0];
  const daysUntilNextPeriod = primaryNext ? diffDaysIso(primaryNext.startDate, referenceDate) : undefined;
  const isOverdue = typeof daysUntilNextPeriod === 'number' && daysUntilNextPeriod < 0 && !isInPeriodToday;

  // Check if referenceDate is in current fertile window
  const currentOvulationDate = addDaysToIso(lastPeriodStart, Math.max(10, avgCycleLength - 14));
  const currentFertileStart = addDaysToIso(currentOvulationDate, -5);
  const currentFertileEnd = addDaysToIso(currentOvulationDate, 1);
  const isFertileToday = referenceDate >= currentFertileStart && referenceDate <= currentFertileEnd;

  const cycleRecords: CycleIntervalRecord[] = sortedAsc.map((c, idx) => {
    const effectiveEnd = c.endDate || addDaysToIso(c.startDate, avgPeriodLength - 1);
    const periodLengthDays = Math.max(1, diffDaysIso(effectiveEnd, c.startDate) + 1);
    const next = idx < sortedAsc.length - 1 ? sortedAsc[idx + 1] : undefined;
    const cycleLengthDays = next ? diffDaysIso(next.startDate, c.startDate) : undefined;
    return {
      id: c.id,
      startDate: c.startDate,
      endDate: effectiveEnd,
      periodLengthDays,
      isPeriodEndPredicted: !c.endDate,
      cycleLengthDays,
    };
  });

  let healthAssessmentLabel = 'Cần thêm kỳ tiếp theo để theo dõi';
  if (allIntervals.length > 0) {
    if (menorrhagiaDetected && regularityStatus === 'irregular') {
      healthAssessmentLabel = `Không đều (${minInterval}–${maxInterval}đ) · Kinh nhiều`;
    } else if (menorrhagiaDetected) {
      healthAssessmentLabel = 'Lượng kinh nhiều / kéo dài';
    } else if (hasShortCycle && intervalSpread > 6) {
      healthAssessmentLabel = `Biến động ${minInterval}–${maxInterval}đ · Có kỳ <21đ`;
    } else if (hasShortCycle) {
      healthAssessmentLabel = 'Chu kỳ ngắn (<21 ngày)';
    } else if (hasLongCycle && intervalSpread > 6) {
      healthAssessmentLabel = `Biến động ${minInterval}–${maxInterval}đ · Có kỳ >35đ`;
    } else if (hasLongCycle) {
      healthAssessmentLabel = 'Chu kỳ dài (>35 ngày)';
    } else if (regularityStatus === 'irregular') {
      healthAssessmentLabel =
        allIntervals.length >= 2
          ? `Chu kỳ không đều (${minInterval}–${maxInterval}đ)`
          : 'Chu kỳ dao động không đều';
    } else if (allIntervals.length === 1) {
      healthAssessmentLabel = 'Tạm ổn định (cần thêm mốc)';
    } else {
      healthAssessmentLabel = 'Chu kỳ đều, ổn định';
    }
  }

  return {
    averageCycleLength: avgCycleLength,
    averagePeriodLength: avgPeriodLength,
    lastPeriodStart,
    lastPeriodEnd,
    isLastPeriodEndPredicted: !latestCycle.endDate,
    currentCycleDay,
    nextPredictedPeriod: primaryNext?.startDate,
    daysUntilNextPeriod,
    isOverdue,
    predictedOvulationDate: currentOvulationDate,
    fertileWindowStart: currentFertileStart,
    fertileWindowEnd: currentFertileEnd,
    isInPeriodToday,
    isFertileToday,
    regularityStatus,
    healthAssessmentLabel,
    hasMenorrhagia: menorrhagiaDetected,
    recentIntervals: allIntervals.slice(-4),
    cycleRecords,
    predictedCycles,
  };
}

/**
 * Determine display status for a specific calendar date
 */
export function getCalendarDayInfo(
  dateStr: string,
  cycles: MenstrualCycleEntry[],
  metrics: ComputedCycleMetrics,
): {
  isActualPeriod: boolean;
  isPeriodStart: boolean;
  isPeriodEnd: boolean;
  isPredictedEnd?: boolean;
  actualEntry?: MenstrualCycleEntry;
  flowLevel?: MenstrualFlowLevel;
  isPredictedPeriod: boolean;
  isPredictedStart?: boolean;
  isPredictedOvulation: boolean;
  isFertileWindow: boolean;
} {
  // Check actual recorded cycles (newest first for deterministic matching)
  const orderedCycles = sortCyclesDesc(cycles);
  for (const c of orderedCycles) {
    if (!c.startDate) continue;
    const start = c.startDate;
    const end = c.endDate || addDaysToIso(start, metrics.averagePeriodLength - 1);

    if (dateStr >= start && dateStr <= end) {
      return {
        isActualPeriod: true,
        isPeriodStart: dateStr === start,
        isPeriodEnd: dateStr === end,
        isPredictedEnd: !c.endDate && dateStr === end,
        actualEntry: c,
        flowLevel: c.flowLevel,
        isPredictedPeriod: false,
        isPredictedOvulation: false,
        isFertileWindow: false,
      };
    }
  }

  // Check future predicted cycles
  for (const p of metrics.predictedCycles) {
    if (dateStr >= p.startDate && dateStr <= p.endDate) {
      return {
        isActualPeriod: false,
        isPeriodStart: false,
        isPeriodEnd: false,
        isPredictedPeriod: true,
        isPredictedStart: dateStr === p.startDate,
        isPredictedOvulation: dateStr === p.ovulationDate,
        isFertileWindow: dateStr >= p.fertileWindowStart && dateStr <= p.fertileWindowEnd,
      };
    }
    if (dateStr === p.ovulationDate) {
      return {
        isActualPeriod: false,
        isPeriodStart: false,
        isPeriodEnd: false,
        isPredictedPeriod: false,
        isPredictedOvulation: true,
        isFertileWindow: true,
      };
    }
    if (dateStr >= p.fertileWindowStart && dateStr <= p.fertileWindowEnd) {
      return {
        isActualPeriod: false,
        isPeriodStart: false,
        isPeriodEnd: false,
        isPredictedPeriod: false,
        isPredictedOvulation: false,
        isFertileWindow: true,
      };
    }
  }

  // Also check fertile window for current ongoing cycle
  if (metrics.predictedOvulationDate && dateStr === metrics.predictedOvulationDate) {
    return {
      isActualPeriod: false,
      isPeriodStart: false,
      isPeriodEnd: false,
      isPredictedPeriod: false,
      isPredictedOvulation: true,
      isFertileWindow: true,
    };
  }
  if (
    metrics.fertileWindowStart &&
    metrics.fertileWindowEnd &&
    dateStr >= metrics.fertileWindowStart &&
    dateStr <= metrics.fertileWindowEnd
  ) {
    return {
      isActualPeriod: false,
      isPeriodStart: false,
      isPeriodEnd: false,
      isPredictedPeriod: false,
      isPredictedOvulation: false,
      isFertileWindow: true,
    };
  }

  return {
    isActualPeriod: false,
    isPeriodStart: false,
    isPeriodEnd: false,
    isPredictedPeriod: false,
    isPredictedOvulation: false,
    isFertileWindow: false,
  };
}

/**
 * Build concise summary for AI Assistant and 4-layer health deep analysis
 */
export function buildCycleSummaryForAi(
  cycles: MenstrualCycleEntry[] = [],
  settings?: MenstrualCycleSettings,
  referenceDate = formatToIsoDate(new Date()),
): MenstrualCycleSummary {
  const metrics = calculateCycleMetrics(cycles, settings, referenceDate);

  const notesList: string[] = [];
  if (metrics.isInPeriodToday) {
    notesList.push('Đang trong kỳ kinh nguyệt');
  } else if (metrics.isOverdue && typeof metrics.daysUntilNextPeriod === 'number') {
    notesList.push(`Kỳ kinh đang trễ ${Math.abs(metrics.daysUntilNextPeriod)} ngày so với dự kiến`);
  } else if (typeof metrics.daysUntilNextPeriod === 'number' && metrics.daysUntilNextPeriod <= 3) {
    notesList.push(`Dự kiến kỳ kinh tiếp theo trong ${metrics.daysUntilNextPeriod} ngày tới`);
  }

  if (metrics.hasMenorrhagia) {
    notesList.push('Có dấu hiệu rong kinh hoặc lượng kinh nhiều (cần đối chiếu với chỉ số Sắt/Ferritin/Hemoglobin)');
  }
  if (metrics.regularityStatus === 'irregular') {
    notesList.push('Chu kỳ dao động không đều (cần chú ý đối chiếu với chức năng tuyến giáp TSH, nội tiết hoặc stress/chuyển hóa)');
  }

  return {
    lastPeriodStart: metrics.lastPeriodStart,
    currentCycleDay: metrics.currentCycleDay,
    averageCycleLength: metrics.averageCycleLength,
    averagePeriodLength: metrics.averagePeriodLength,
    nextPredictedPeriod: metrics.nextPredictedPeriod,
    daysUntilNextPeriod: metrics.daysUntilNextPeriod,
    fertileWindowStart: metrics.fertileWindowStart,
    fertileWindowEnd: metrics.fertileWindowEnd,
    predictedOvulationDate: metrics.predictedOvulationDate,
    regularityStatus: metrics.regularityStatus,
    recentCycleCount: cycles.length,
    hasMenorrhagia: metrics.hasMenorrhagia,
    notes: notesList.join('; ') || undefined,
  };
}

function isEntryStrictlyNewerThanDeletion(entryUpdatedAt?: string, deletedAt?: string): boolean {
  if (!deletedAt || !deletedAt.trim()) return true;
  if (!entryUpdatedAt || !entryUpdatedAt.trim()) return false;
  const entryEpoch = Date.parse(entryUpdatedAt);
  const deletedEpoch = Date.parse(deletedAt);
  if (Number.isFinite(entryEpoch) && Number.isFinite(deletedEpoch)) {
    return entryEpoch > deletedEpoch;
  }
  return entryUpdatedAt > deletedAt;
}

/**
 * Find the closest cycle within maxDistanceDays of a selected date's startDate.
 * Useful to avoid creating accidental overlapping duplicates when a user taps 1-2 days away.
 */
export function findNearbyCycle(
  cycles: MenstrualCycleEntry[],
  dateStr: string,
  maxDistanceDays = 13,
): { cycle: MenstrualCycleEntry; dayDeltaFromStart: number } | null {
  const ordered = sortCyclesDesc(cycles);
  let best: { cycle: MenstrualCycleEntry; dayDeltaFromStart: number } | null = null;
  for (const c of ordered) {
    if (!c.startDate) continue;
    const delta = diffDaysIso(dateStr, c.startDate);
    if (Math.abs(delta) <= maxDistanceDays) {
      if (!best || Math.abs(delta) < Math.abs(best.dayDeltaFromStart)) {
        best = { cycle: c, dayDeltaFromStart: delta };
      }
    }
  }
  return best;
}

/**
 * Merge menstrual cycles across offline devices / sync snapshots (Last-Write-Wins per entry + deletion tombstones)
 */
export function mergeCycleEntries(
  current: MenstrualCycleEntry[] = [],
  incoming: MenstrualCycleEntry[] = [],
  deletedCycles: HealthDeletionTombstone[] = [],
): MenstrualCycleEntry[] {
  const tombstoneById = new Map<string, string>();
  for (const item of deletedCycles) {
    if (!item?.id || !item.deletedAt) continue;
    const prev = tombstoneById.get(item.id);
    if (!prev || isEntryStrictlyNewerThanDeletion(item.deletedAt, prev)) {
      tombstoneById.set(item.id, item.deletedAt);
    }
  }

  const byId = new Map<string, MenstrualCycleEntry>();

  for (const item of [...current, ...incoming]) {
    if (!item || !item.id || !item.startDate) continue;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    // Newer updatedAt wins
    if ((item.updatedAt || '') >= (existing.updatedAt || '')) {
      byId.set(item.id, item);
    }
  }

  for (const [id, entry] of [...byId.entries()]) {
    const deletedAt = tombstoneById.get(id);
    if (!deletedAt) continue;
    if (!isEntryStrictlyNewerThanDeletion(entry.updatedAt, deletedAt)) {
      byId.delete(id);
    }
  }

  return sortCyclesDesc(Array.from(byId.values()));
}
