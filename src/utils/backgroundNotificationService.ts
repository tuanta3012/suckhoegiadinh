import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { App } from '@capacitor/app';

const NOTIFICATION_ID_BATCH_PROGRESS = 99001;

let isPermissionGranted = false;

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
}): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const hasPermission = isPermissionGranted || (await requestNotificationPermission());
    if (!hasPermission) return;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIFICATION_ID_BATCH_PROGRESS,
          title: `Đang số hóa tài liệu y tế (${options.current}/${options.total})`,
          body: `Đang xử lý tệp: "${options.fileName}"${options.memberName ? ` (${options.memberName})` : ''}...`,
          schedule: { at: new Date(Date.now() + 50) },
          smallIcon: 'ic_stat_savings',
          iconColor: '#10b981',
          ongoing: options.current < options.total,
          autoCancel: false,
        },
      ],
    });
  } catch (error) {
    console.warn('[NotificationService] Failed to schedule progress notification:', error);
  }
}

export async function updateBatchNotificationComplete(options: {
  total: number;
  memberName?: string;
}): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    const hasPermission = isPermissionGranted || (await requestNotificationPermission());
    if (!hasPermission) return;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: NOTIFICATION_ID_BATCH_PROGRESS,
          title: `Đã hoàn tất số hóa ${options.total} tài liệu y tế!`,
          body: `Tất cả tài liệu y tế${options.memberName ? ` cho ${options.memberName}` : ''} đã được lưu trữ an toàn trên Google Drive.`,
          schedule: { at: new Date(Date.now() + 50) },
          smallIcon: 'ic_stat_savings',
          iconColor: '#10b981',
          ongoing: false,
          autoCancel: true,
        },
      ],
    });
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
