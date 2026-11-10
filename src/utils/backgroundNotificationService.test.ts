import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
    schedule: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn() },
}));

import {
  buildBatchProgressNotificationContent,
  buildFollowUpNotificationPlan,
} from './backgroundNotificationService';

describe('buildBatchProgressNotificationContent', () => {
  it('shows the file count, current stage, and rounded progress concisely', () => {
    expect(buildBatchProgressNotificationContent({
      current: 2,
      total: 5,
      fileName: 'ket-qua-xet-nghiem.pdf',
      phase: 'Nhận dạng',
      progressPercent: 43.6,
    })).toEqual({
      title: 'Đang số hóa 2/5',
      body: 'ket-qua-xet-nghiem.pdf · Nhận dạng · 44%',
    });
  });

  it('clamps progress and keeps long filenames within the notification body limit', () => {
    const content = buildBatchProgressNotificationContent({
      current: 1,
      total: 1,
      fileName: `${'a'.repeat(60)}.pdf`,
      progressPercent: 120,
    });

    expect(content.body).toBe(`${'a'.repeat(48)} · 100%`);
  });
});

describe('buildFollowUpNotificationPlan', () => {
  it('schedules notifications at 9 AM three days before and on the appointment date', () => {
    const now = new Date(2026, 10, 10, 8);
    const plan = buildFollowUpNotificationPlan([{
      eventId: 'event-1',
      eventTitle: 'Tái khám',
      followUpDate: '2026-11-20',
      memberName: 'Lan',
    }], now);

    expect(plan).toHaveLength(2);
    expect(plan.map(({ at }) => at)).toEqual([
      new Date(2026, 10, 17, 9),
      new Date(2026, 10, 20, 9),
    ]);
    expect(plan.map(({ title }) => title)).toEqual([
      'Nhắc lịch tái khám',
      'Lịch tái khám hôm nay',
    ]);
    expect(plan[0].body).toContain('Lan: Tái khám');
  });

  it('does not schedule past times, past appointments, or invalid dates', () => {
    const now = new Date(2026, 10, 17, 10);
    const plan = buildFollowUpNotificationPlan([
      {
        eventId: 'today',
        eventTitle: 'Hôm nay',
        followUpDate: '2026-11-17',
        memberName: 'Lan',
      },
      {
        eventId: 'past',
        eventTitle: 'Đã qua',
        followUpDate: '2026-11-16',
        memberName: 'Lan',
      },
      {
        eventId: 'invalid',
        eventTitle: 'Sai ngày',
        followUpDate: '2026-02-30',
        memberName: 'Lan',
      },
    ], now);

    expect(plan).toHaveLength(0);
  });

  it('assigns unique IDs to multiple reminders for the same date', () => {
    const plan = buildFollowUpNotificationPlan([
      { eventId: 'one', eventTitle: 'Khám 1', followUpDate: '2026-11-20', memberName: 'Lan' },
      { eventId: 'two', eventTitle: 'Khám 2', followUpDate: '2026-11-20', memberName: 'Lan' },
    ], new Date(2026, 10, 10, 8));

    expect(new Set(plan.map(({ id }) => id)).size).toBe(4);
  });
});
