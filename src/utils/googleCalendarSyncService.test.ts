import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FamilyMember, HealthEvent, HealthProfile } from '../types';

vi.mock('./googleDriveService', () => ({
  getValidGoogleAccessToken: vi.fn(async () => 'mock-google-token'),
  trySilentRefresh: vi.fn(async () => null),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
  CapacitorHttp: {
    request: vi.fn(),
  },
}));

import {
  addDaysToIsoDate,
  buildCalendarSyncPreviewPlan,
  buildGoogleCalendarEventPayload,
  CalendarApiDisabledError,
  CalendarPermissionError,
  collectFutureFollowUpsForMember,
  FAMILY_HEALTH_CALENDAR_APP_TAG,
  normalizeFollowUpDateISO,
  previewPrimaryCalendarSync,
} from './googleCalendarSyncService';

function makeMember(id: string, name: string, email?: string): FamilyMember {
  return {
    id,
    name,
    email,
    driveFolderId: `folder-${id}`,
    profileFileId: `profile-${id}`,
  };
}

function makeEvent(overrides: Partial<HealthEvent> & { id: string }): HealthEvent {
  return {
    sourceFileId: `src-${overrides.id}`,
    sourceFileName: 'ket-qua-kham.pdf',
    type: 'medical_report',
    title: 'Khám định kỳ',
    date: '2026-11-10',
    diagnoses: [],
    medications: [],
    metrics: [],
    recordedAt: '2026-11-10T08:00:00.000Z',
    ...overrides,
  };
}

function makeProfile(member: FamilyMember, timeline: HealthEvent[]): HealthProfile {
  return {
    schemaVersion: 2,
    member,
    timeline,
    sources: [],
    summary: { latestDiagnoses: [], latestMetrics: {} },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z',
  };
}

describe('googleCalendarSyncService', () => {
  it('normalizes valid ISO and DD/MM/YYYY dates and rejects invalid calendar dates', () => {
    expect(normalizeFollowUpDateISO('2026-12-25')).toBe('2026-12-25');
    expect(normalizeFollowUpDateISO('25/12/2026')).toBe('2026-12-25');
    expect(normalizeFollowUpDateISO('2026-02-30')).toBeNull();
    expect(normalizeFollowUpDateISO('not-a-date')).toBeNull();
  });

  it('adds days accurately across month and year boundaries', () => {
    expect(addDaysToIsoDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysToIsoDate('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('collects only future/today follow-ups for the signed-in member email', () => {
    const memberA = makeMember('m-a', 'Tuấn', 'Tuan@Example.com');
    const memberB = makeMember('m-b', 'Lan', 'lan@example.com');

    const profiles: Record<string, HealthProfile> = {
      [memberA.id]: makeProfile(memberA, [
        makeEvent({
          id: 'ev-past',
          title: 'Khám cũ đã qua',
          nextFollowUp: '2026-11-15',
        }),
        makeEvent({
          id: 'ev-today',
          title: 'Khám nội tiết',
          facility: 'BV Bạch Mai',
          nextFollowUp: '2026-11-16',
        }),
        makeEvent({
          id: 'ev-future',
          title: 'Siêu âm tuyến giáp',
          facility: 'BV Đại học Y',
          nextFollowUp: '2026-12-20',
          advice: 'Nhịn ăn sáng trước khi xét nghiệm máu.',
        }),
        makeEvent({
          id: 'ev-vac',
          title: 'Tiêm chủng VNVC',
          nextFollowUp: '2026-12-01',
          vaccinations: [
            { vaccineName: 'Cúm mùa', administeredDate: '2026-11-01', nextDoseDate: '2026-12-01' }, // same date -> deduped
            { vaccineName: 'HPV mũi 2', administeredDate: '2026-11-01', nextDoseDate: '2027-01-15' },
          ],
        }),
      ]),
      [memberB.id]: makeProfile(memberB, [
        makeEvent({
          id: 'ev-other-member',
          title: 'Khám sản phụ khoa',
          nextFollowUp: '2026-12-30',
        }),
      ]),
    };

    // Mock 2026-11-16 15:00 Vietnam time (UTC+7 = 08:00Z)
    const now = new Date('2026-11-16T08:00:00.000Z');
    const result = collectFutureFollowUpsForMember([memberA, memberB], profiles, 'tuan@example.com', now);

    expect(result.member?.id).toBe('m-a');
    expect(result.todayIso).toBe('2026-11-16');
    expect(result.items.map((item) => [item.appointmentKey, item.followUpDate, item.summary])).toEqual([
      ['followup:ev-today', '2026-11-16', '[Tái khám] Khám nội tiết'],
      ['followup:ev-vac', '2026-12-01', '[Tái khám] Tiêm chủng VNVC'],
      ['followup:ev-future', '2026-12-20', '[Tái khám] Siêu âm tuyến giáp'],
      ['vaccine:ev-vac:hpv_mui_2', '2027-01-15', '[Tiêm nhắc] HPV mũi 2'],
    ]);
  });

  it('returns null member and zero items if signed-in account has no matching member', () => {
    const memberA = makeMember('m-a', 'Tuấn', 'tuan@example.com');
    const profiles = {
      [memberA.id]: makeProfile(memberA, [
        makeEvent({ id: 'ev-1', nextFollowUp: '2026-12-20' }),
      ]),
    };

    const result = collectFutureFollowUpsForMember(
      [memberA],
      profiles,
      'stranger@example.com',
      new Date('2026-11-16T08:00:00.000Z'),
    );

    expect(result.member).toBeNull();
    expect(result.items).toEqual([]);
  });

  it('classifies create, update, unchanged, and stale calendar events idempotently', () => {
    const member = makeMember('m-1', 'Tuấn', 'tuan@example.com');
    const now = new Date('2026-11-16T08:00:00.000Z');
    const collected = collectFutureFollowUpsForMember(
      [member],
      {
        [member.id]: makeProfile(member, [
          makeEvent({ id: 'ev-unchanged', title: 'Khám mắt', nextFollowUp: '2026-12-05' }),
          makeEvent({ id: 'ev-changed', title: 'Khám tim mạch mới', nextFollowUp: '2026-12-12' }),
          makeEvent({ id: 'ev-new', title: 'Xét nghiệm máu', nextFollowUp: '2026-12-28' }),
        ]),
      },
      'tuan@example.com',
      now,
    );

    const unchangedItem = collected.items.find((i) => i.event.id === 'ev-unchanged')!;
    const unchangedPayload = buildGoogleCalendarEventPayload(unchangedItem);

    const plan = buildCalendarSyncPreviewPlan({
      signedInEmail: 'tuan@example.com',
      member,
      todayIso: collected.todayIso,
      items: collected.items,
      existingEvents: [
        {
          id: 'gcal-1',
          summary: unchangedPayload.summary,
          start: unchangedPayload.start,
          end: unchangedPayload.end,
          extendedProperties: unchangedPayload.extendedProperties,
        },
        {
          id: 'gcal-2',
          summary: '[Tái khám] Khám tim mạch cũ',
          start: { date: '2026-12-10' },
          end: { date: '2026-12-11' },
          extendedProperties: {
            private: {
              familyHealthApp: FAMILY_HEALTH_CALENDAR_APP_TAG,
              appointmentKey: 'followup:ev-changed',
              memberId: 'm-1',
              contentHash: 'oldhash',
            },
          },
        },
        {
          id: 'gcal-stale',
          summary: '[Tái khám] Lịch đã hủy trên app',
          start: { date: '2026-12-22' },
          end: { date: '2026-12-23' },
          extendedProperties: {
            private: {
              familyHealthApp: FAMILY_HEALTH_CALENDAR_APP_TAG,
              appointmentKey: 'followup:deleted-event',
              memberId: 'm-1',
            },
          },
        },
      ],
    });

    expect(plan.unchanged.map((u) => u.item.event.id)).toEqual(['ev-unchanged']);
    expect(plan.toUpdate.map((u) => u.item.event.id)).toEqual(['ev-changed']);
    expect(plan.toCreate.map((c) => c.event.id)).toEqual(['ev-new']);
    expect(plan.staleEvents.map((s) => s.calendarEventId)).toEqual(['gcal-stale']);
  });

  describe('API error classification', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    });

    it('throws CalendarApiDisabledError with activationUrl when Google Calendar API is disabled on GCP project', async () => {
      const member = makeMember('m-1', 'Tuấn', 'tuan@example.com');
      const profiles = {
        [member.id]: makeProfile(member, [
          makeEvent({ id: 'ev-1', nextFollowUp: '2026-12-20' }),
        ]),
      };

      const gcpErrorBody = JSON.stringify({
        error: {
          code: 403,
          message:
            'Google Calendar API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456 then retry.',
          status: 'PERMISSION_DENIED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'SERVICE_DISABLED',
              metadata: {
                service: 'calendar-json.googleapis.com',
                activationUrl:
                  'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456',
              },
            },
          ],
        },
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(gcpErrorBody, { status: 403 })),
      );

      let caught: unknown;
      try {
        await previewPrimaryCalendarSync(
          [member],
          profiles,
          'tuan@example.com',
          new Date('2026-11-16T08:00:00.000Z'),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(CalendarApiDisabledError);
      expect(caught).not.toBeInstanceOf(CalendarPermissionError);
      expect((caught as CalendarApiDisabledError).activationUrl).toBe(
        'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456',
      );
    });

    it('throws CalendarPermissionError when Google token lacks Calendar OAuth scope', async () => {
      const member = makeMember('m-1', 'Tuấn', 'tuan@example.com');
      const profiles = {
        [member.id]: makeProfile(member, [
          makeEvent({ id: 'ev-1', nextFollowUp: '2026-12-20' }),
        ]),
      };

      const scopeErrorBody = JSON.stringify({
        error: {
          code: 403,
          message: 'Request had insufficient authentication scopes.',
          status: 'PERMISSION_DENIED',
          details: [
            {
              reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
            },
          ],
        },
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(scopeErrorBody, { status: 403 })),
      );

      await expect(
        previewPrimaryCalendarSync(
          [member],
          profiles,
          'tuan@example.com',
          new Date('2026-11-16T08:00:00.000Z'),
        ),
      ).rejects.toBeInstanceOf(CalendarPermissionError);
    });
  });
});
