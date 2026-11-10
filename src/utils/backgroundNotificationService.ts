import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App } from '@capacitor/app';

const NOTIFICATION_ID_BATCH_PROGRESS = 99001;
const FOLLOW_UP_NOTIFICATION_STORAGE_KEY = 'health_follow_up_notification_ids_v1';
const FOLLOW_UP_NOTIFICATION_ID_BASE = 200000000;
const MAX_SCHEDULED_FOLLOW_UPS = 30;

let isPermissionGranted = false;
let lastBatchProgressKey = '';
let lastBatchProgressAt = 0;
let lastBatchProgressPhase = '';
let lastBatchProgressCurrent = 0;

export interface FollowUpNotificationInput {
  eventId: string;
  eventTitle: string;
  followUpDate: string;
  memberName: string;
}

interface FollowUpNotificationPlan {
  id: number;
  title: string;
  body: string;
  at: Date;
}

export function buildBatchProgressNotificationContent(options: {
  current: number;
  total: number;
  fileName: string;
  phase?: string;
  progressPercent?: number;
}): { title: string; body: string } {
  const fileName = Array.from(options.fileName).slice(0, 48).join('');
  const percentage = options.progressPercent === undefined
    ? ''
    : ` · ${Math.round(Math.max(0, Math.min(100, options.progressPercent)))}%`;
  const phase = options.phase ? ` · ${options.phase}` : '';
  return {
    title: `Đang số hóa ${options.current}/${options.total}`,
    body: `${fileName}${phase}${percentage}`,
  };
}

function parseLocalDate(value: string): Date | undefined {
  const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) {
    const date = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
    if (
      date.getFullYear() !== Number(isoDate[1]) ||
      date.getMonth() !== Number(isoDate[2]) - 1 ||
      date.getDate() !== Number(isoDate[3])
    ) return undefined;
    return date;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function createNotificationId(value: string, usedIds: Set<number>): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let id = FOLLOW_UP_NOTIFICATION_ID_BASE + ((hash >>> 0) % 1000000000);
  while (usedIds.has(id)) id += 1;
  usedIds.add(id);
  return id;
}

export function buildFollowUpNotificationPlan(
  reminders: FollowUpNotificationInput[],
  now = new Date(),
): FollowUpNotificationPlan[] {
  const plans: FollowUpNotificationPlan[] = [];
  const usedIds = new Set<number>();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const reminder of reminders) {
    const appointmentDate = parseLocalDate(reminder.followUpDate);
    if (!appointmentDate || appointmentDate < today) continue;

    for (const daysBefore of [3, 0]) {
      const notifyAt = new Date(
        appointmentDate.getFullYear(),
        appointmentDate.getMonth(),
        appointmentDate.getDate() - daysBefore,
        9,
      );
      if (notifyAt <= now) continue;

      const id = createNotificationId(
        `${reminder.eventId}:${reminder.followUpDate}:${daysBefore}`,
        usedIds,
      );
      plans.push({
        id,
        title: daysBefore === 0 ? 'Lịch tái khám hôm nay' : 'Nhắc lịch tái khám',
        body: `${reminder.memberName}: ${reminder.eventTitle} · ${daysBefore === 0 ? 'hẹn hôm nay' : 'còn 3 ngày'}.`,
        at: notifyAt,
      });
    }
  }

  return plans
    .sort((left, right) => left.at.getTime() - right.at.getTime())
    .slice(0, MAX_SCHEDULED_FOLLOW_UPS * 2);
}

function readScheduledFollowUpNotificationIds(): number[] {
  try {
    const raw = localStorage.getItem(FOLLOW_UP_NOTIFICATION_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => Number.isInteger(id) && id >= FOLLOW_UP_NOTIFICATION_ID_BASE)
      : [];
  } catch (error) {
    console.warn('[NotificationService] Could not read scheduled follow-up notification IDs:', error);
    return [];
  }
}

export async function scheduleFollowUpNotifications(
  reminders: FollowUpNotificationInput[],
): Promise<{ scheduled: number; permissionGranted: boolean }> {
  if (!Capacitor.isNativePlatform()) return { scheduled: 0, permissionGranted: false };

  const plan = buildFollowUpNotificationPlan(reminders);
  const previousIds = readScheduledFollowUpNotificationIds();
  if (plan.length > 0) {
    const hasPermission = isPermissionGranted || (await requestNotificationPermission());
    if (!hasPermission) {
      console.info('[NotificationService] Follow-up notifications were not scheduled because permission is not granted.');
      try {
        if (previousIds.length > 0) {
          await LocalNotifications.cancel({
            notifications: previousIds.map((id) => ({ id })),
          });
        }
        localStorage.setItem(FOLLOW_UP_NOTIFICATION_STORAGE_KEY, '[]');
      } catch (error) {
        console.warn('[NotificationService] Could not clear reminders after permission denial:', error);
      }
      return { scheduled: 0, permissionGranted: false };
    }
  }

  try {
    if (plan.length > 0) {
      await LocalNotifications.schedule({
        notifications: plan.map(({ id, title, body, at }) => ({
          id,
          title,
          body,
          schedule: { at },
          smallIcon: 'ic_stat_savings',
          iconColor: '#f97316',
          autoCancel: true,
        })),
      });
    }
    const nextIds = new Set(plan.map(({ id }) => id));
    const staleIds = previousIds.filter((id) => !nextIds.has(id));
    if (staleIds.length > 0) {
      await LocalNotifications.cancel({
        notifications: staleIds.map((id) => ({ id })),
      });
    }
    localStorage.setItem(FOLLOW_UP_NOTIFICATION_STORAGE_KEY, JSON.stringify([...nextIds]));
    return { scheduled: plan.length, permissionGranted: plan.length > 0 || isPermissionGranted };
  } catch (error) {
    console.warn('[NotificationService] Failed to schedule follow-up notifications:', error);
    return { scheduled: 0, permissionGranted: isPermissionGranted };
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const status = await LocalNotifications.checkPermissions();
    if (status.display === 'granted') {
      isPermissionGranted = true;
      return true;
    }
    const requested = await LocalNotifications.requestPermissions();
    isPermissionGranted = requested.display === 'granted';
    return isPermissionGranted;
  } catch (error) {
    console.warn('[NotificationService] Permission check/request error:', error);
    return false;
  }
}

export async function updateBatchNotificationProgress(options: {
  current: number;
  total: number;
  fileName: string;
  memberName?: string;
  phase?: string;
  progressPercent?: number;
}): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const progressBucket = options.progressPercent === undefined
    ? ''
    : Math.floor(Math.max(0, Math.min(100, options.progressPercent)) / 10);
  const key = [
    options.current,
    options.total,
    options.fileName,
    options.phase || '',
    progressBucket,
  ].join(':');
  const now = Date.now();
  const isNewFile = lastBatchProgressCurrent !== options.current;
  const phaseChanged = lastBatchProgressPhase !== (options.phase || '');
  if (
    key === lastBatchProgressKey ||
    (now - lastBatchProgressAt < 2500 && !isNewFile && !phaseChanged)
  ) return;

  try {
    const hasPermission = isPermissionGranted || (await requestNotificationPermission());
    if (!hasPermission) return;

    const content = buildBatchProgressNotificationContent(options);
    lastBatchProgressKey = key;
    lastBatchProgressAt = now;
    lastBatchProgressPhase = options.phase || '';
    lastBatchProgressCurrent = options.current;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIFICATION_ID_BATCH_PROGRESS,
          ...content,
          schedule: { at: new Date(Date.now() + 50) },
          smallIcon: 'ic_stat_savings',
          iconColor: '#10b981',
          ongoing: true,
          autoCancel: false,
        },
      ],
    });
  } catch (error) {
    lastBatchProgressKey = '';
    lastBatchProgressAt = 0;
    console.warn('[NotificationService] Failed to schedule progress notification:', error);
  }
}

export async function updateBatchNotificationComplete(options: {
  total: number;
  memberName?: string;
  failedCount?: number;
}): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const hasPermission = isPermissionGranted || (await requestNotificationPermission());
    if (!hasPermission) return;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIFICATION_ID_BATCH_PROGRESS,
          title: options.failedCount
            ? `Đã xử lý ${options.total - options.failedCount}/${options.total} tài liệu`
            : `Đã xử lý ${options.total} tài liệu`,
          body: options.failedCount
            ? `${options.failedCount} tài liệu cần thử lại.`
            : `Đã lưu${options.memberName ? ` vào hồ sơ ${options.memberName}` : ''}.`,
          schedule: { at: new Date(Date.now() + 50) },
          smallIcon: 'ic_stat_savings',
          iconColor: '#10b981',
          ongoing: false,
          autoCancel: true,
        },
      ],
    });
    lastBatchProgressKey = '';
    lastBatchProgressAt = 0;
    lastBatchProgressPhase = '';
    lastBatchProgressCurrent = 0;
  } catch (error) {
    console.warn('[NotificationService] Failed to schedule complete notification:', error);
  }
}

export function setupBackgroundAppResumeListener(onResumeCallback: () => void): () => void {
  if (!Capacitor.isNativePlatform()) {
    return () => {};
  }
  const listener = App.addListener('appStateChange', (state) => {
    if (state.isActive) {
      onResumeCallback();
    }
  });

  return () => {
    void listener.then((h) => h.remove()).catch(() => undefined);
  };
}
