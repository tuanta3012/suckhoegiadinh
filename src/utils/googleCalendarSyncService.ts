import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { FamilyMember, HealthEvent, HealthProfile } from '../types';
import { getVietnamDateISO } from './date';
import { formatDateVN } from './formatters';
import {
  getValidGoogleAccessToken,
  trySilentRefresh,
} from './googleDriveService';
import { calculateCycleMetrics, DEFAULT_REMIND_BEFORE_DAYS } from './menstrualCycleService';
import { findMemberForEmail } from './memberOrdering';

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
export const FAMILY_HEALTH_CALENDAR_APP_TAG = 'com.suckhoegiadinh.app';

export class CalendarPermissionError extends Error {
  readonly needsConsent = true;

  constructor(message = 'Tài khoản Google chưa cấp quyền Google Calendar.') {
    super(message);
    this.name = 'CalendarPermissionError';
  }
}

export class CalendarApiDisabledError extends Error {
  readonly isApiDisabled = true;

  constructor(
    message = 'Google Calendar API chưa được kích hoạt trên dự án Google Cloud.',
    readonly activationUrl?: string,
  ) {
    super(message);
    this.name = 'CalendarApiDisabledError';
  }
}

export interface GoogleCalendarEventResource {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

export interface FutureFollowUpItem {
  appointmentKey: string;
  kind: 'follow_up' | 'vaccination' | 'menstrual_cycle';
  member: FamilyMember;
  event?: HealthEvent;
  followUpDate: string; // YYYY-MM-DD
  summary: string;
  facility?: string;
  description: string;
  reminderMinutesBefore?: number;
  contentHash: string;
}

export interface CalendarSyncUpdateItem {
  item: FutureFollowUpItem;
  calendarEventId: string;
  previousDate?: string;
  previousSummary?: string;
}

export interface CalendarSyncUnchangedItem {
  item: FutureFollowUpItem;
  calendarEventId: string;
  htmlLink?: string;
}

export interface StaleCalendarEventItem {
  calendarEventId: string;
  appointmentKey: string;
  summary: string;
  startDate: string;
}

export interface CalendarSyncPreviewPlan {
  signedInEmail: string;
  member: FamilyMember | null;
  todayIso: string;
  toCreate: FutureFollowUpItem[];
  toUpdate: CalendarSyncUpdateItem[];
  unchanged: CalendarSyncUnchangedItem[];
  staleEvents: StaleCalendarEventItem[];
}

export interface CalendarSyncExecutionResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  failed: number;
  errors: string[];
}

export function normalizeFollowUpDateISO(value?: string | null): string | null {
  if (!value || !value.trim()) return null;
  const trimmed = value.trim();

  let year: number;
  let month: number;
  let day: number;

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    const vnMatch = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (vnMatch) {
      day = Number(vnMatch[1]);
      month = Number(vnMatch[2]);
      year = Number(vnMatch[3]);
    } else {
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) return null;
      year = parsed.getFullYear();
      month = parsed.getMonth() + 1;
      day = parsed.getDate();
    }
  }

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDaysToIsoDate(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')}`;
}

function hashSyncPayload(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function buildFollowUpDescription(
  member: FamilyMember,
  event: HealthEvent,
  extraNote?: string,
): string {
  const lines: string[] = [
    `🏥 LỊCH TÁI KHÁM & HẸN Y TẾ GIA ĐÌNH`,
    `--------------------------------`,
    `• Thành viên: ${member.name}`,
    `• Hồ sơ khám: ${event.title}`,
    `• Ngày khám trước: ${event.date || 'Không rõ'}`,
    `• Cơ sở y tế: ${event.facility || 'Không rõ'}`,
  ];
  if (event.doctorName) {
    lines.push(`• Bác sĩ điều trị: ${event.doctorName}`);
  }
  if (event.diagnoses?.length) {
    lines.push(`• Chẩn đoán: ${event.diagnoses.join(', ')}`);
  }
  if (event.medications?.length) {
    lines.push(`• Đơn thuốc gần nhất: ${event.medications.map(m => `${m.name} (${m.dosage || 'liều chuẩn'}, ${m.frequency || ''})`).join('; ')}`);
  }
  if (event.metrics?.length) {
    lines.push(`• Chỉ số y tế: ${event.metrics.map(m => `${m.name}: ${m.value} ${m.unit || ''}`).join(' · ')}`);
  }
  if (event.advice) {
    lines.push(`• Lời dặn bác sĩ: ${event.advice}`);
  }
  if (extraNote) {
    lines.push(`• Lưu ý: ${extraNote}`);
  }
  lines.push(`--------------------------------`);
  lines.push(`Nguồn: Tự động đồng bộ từ ứng dụng Sức Khỏe Gia Đình (${event.sourceFileName})`);
  return lines.join('\n');
}


export function collectFutureFollowUpsForMember(
  members: FamilyMember[],
  profiles: Record<string, HealthProfile>,
  userEmail: string | null,
  now = new Date(),
): { member: FamilyMember | null; todayIso: string; items: FutureFollowUpItem[] } {
  const todayIso = getVietnamDateISO(now);
  const member = findMemberForEmail(members, userEmail);
  if (!member) {
    return { member: null, todayIso, items: [] };
  }

  const profile = profiles[member.id];
  const items: FutureFollowUpItem[] = [];
  const seenKeys = new Set<string>();

  if (profile?.timeline?.length) {
    for (const event of profile.timeline) {
      const primaryFollowUpIso = normalizeFollowUpDateISO(event.nextFollowUp);
      if (primaryFollowUpIso && primaryFollowUpIso >= todayIso) {
        const appointmentKey = `followup:${event.id}`;
        if (!seenKeys.has(appointmentKey)) {
          seenKeys.add(appointmentKey);
          const summary = `[Tái khám] ${event.title.trim() || 'Lịch hẹn y tế'}`;
          const facility = event.facility?.trim() || undefined;
          const description = buildFollowUpDescription(member, event);
          const contentHash = hashSyncPayload(
            JSON.stringify({
              summary,
              facility: facility || '',
              description,
              followUpDate: primaryFollowUpIso,
            }),
          );
          items.push({
            appointmentKey,
            kind: 'follow_up',
            member,
            event,
            followUpDate: primaryFollowUpIso,
            summary,
            facility,
            description,
            contentHash,
          });
        }
      }

      if (Array.isArray(event.vaccinations)) {
        event.vaccinations.forEach((vac, idx) => {
          const nextDoseIso = normalizeFollowUpDateISO(vac.nextDoseDate);
          if (!nextDoseIso || nextDoseIso < todayIso) return;
          if (primaryFollowUpIso && nextDoseIso === primaryFollowUpIso) return;

          const cleanVaccine = vac.vaccineName.trim();
          const normalizedVac = cleanVaccine
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
          const appointmentKey = `vaccine:${event.id}:${normalizedVac || idx}`;
          if (seenKeys.has(appointmentKey)) return;
          seenKeys.add(appointmentKey);

          const summary = `[Tiêm nhắc] ${cleanVaccine || event.title.trim()}`;
          const facility = event.facility?.trim() || undefined;
          const extra = vac.targetDisease ? `Phòng bệnh: ${vac.targetDisease}` : undefined;
          const description = buildFollowUpDescription(member, event, extra);
          const contentHash = hashSyncPayload(
            JSON.stringify({
              summary,
              facility: facility || '',
              description,
              followUpDate: nextDoseIso,
            }),
          );
          items.push({
            appointmentKey,
            kind: 'vaccination',
            member,
            event,
            followUpDate: nextDoseIso,
            summary,
            facility,
            description,
            contentHash,
          });
        });
      }
    }
  }

  // Menstrual cycle predicted reminders for the signed-in member and female members without a separate email
  const cycleTargetMembers = [
    member,
    ...members.filter((m) => m.id !== member.id && !m.email?.trim() && m.gender === 'female'),
  ];

  for (const targetMember of cycleTargetMembers) {
    const targetProfile = profiles[targetMember.id];
    if (!targetProfile?.cycles?.length) continue;
    if (targetProfile.cycleSettings?.reminderEnabled === false) continue;

    const metrics = calculateCycleMetrics(
      targetProfile.cycles,
      targetProfile.cycleSettings,
      todayIso,
    );
    const upcoming = metrics.predictedCycles.find((p) => p.startDate >= todayIso);
    if (!upcoming) continue;

    const appointmentKey = `menstrual:next_period:${targetMember.id}`;
    if (seenKeys.has(appointmentKey)) continue;
    seenKeys.add(appointmentKey);

    const remindBeforeDays = Math.max(
      0,
      Math.min(7, targetProfile.cycleSettings?.remindBeforeDays ?? DEFAULT_REMIND_BEFORE_DAYS),
    );
    const reminderMinutesBefore = remindBeforeDays > 0 ? remindBeforeDays * 1440 - 480 : 0;
    const summary = `Chu kỳ dự kiến · ${targetMember.name}`;
    const reminderNote = remindBeforeDays > 0 ? ` · Nhắc trước ${remindBeforeDays} ngày` : '';
    const description = [
      `Dự kiến: ${formatDateVN(upcoming.startDate)} – ${formatDateVN(upcoming.endDate)} (${metrics.averagePeriodLength} ngày)`,
      `Chu kỳ TB: ${metrics.averageCycleLength} ngày${reminderNote}`,
    ].join('\n');
    const contentHash = hashSyncPayload(
      JSON.stringify({
        summary,
        description,
        followUpDate: upcoming.startDate,
        reminderMinutesBefore,
      }),
    );

    items.push({
      appointmentKey,
      kind: 'menstrual_cycle',
      member: targetMember,
      followUpDate: upcoming.startDate,
      summary,
      description,
      reminderMinutesBefore,
      contentHash,
    });
  }

  items.sort((a, b) => a.followUpDate.localeCompare(b.followUpDate) || a.summary.localeCompare(b.summary));
  return { member, todayIso, items };
}

export function buildGoogleCalendarEventPayload(item: FutureFollowUpItem) {
  return {
    summary: item.summary,
    ...(item.facility ? { location: item.facility } : {}),
    description: item.description,
    start: { date: item.followUpDate },
    end: { date: addDaysToIsoDate(item.followUpDate, 1) },
    reminders: {
      useDefault: false,
      // Default 900 minutes before 00:00 of the appointment date = 09:00 AM on the day before.
      overrides: [{ method: 'popup', minutes: item.reminderMinutesBefore ?? 900 }],
    },
    extendedProperties: {
      private: {
        familyHealthApp: FAMILY_HEALTH_CALENDAR_APP_TAG,
        appointmentKey: item.appointmentKey,
        memberId: item.member.id,
        healthEventId: item.event?.id || '',
        followUpDate: item.followUpDate,
        contentHash: item.contentHash,
      },
    },
  };
}

async function performCalendarHttp(
  url: string,
  init: RequestInit,
  headers: Headers,
): Promise<Response> {
  const canUseNativeHttp =
    Capacitor.isNativePlatform() &&
    (init.body === undefined || typeof init.body === 'string');
  if (!canUseNativeHttp) {
    return fetch(url, { ...init, headers });
  }

  const nativeResponse = await CapacitorHttp.request({
    url,
    method: init.method || 'GET',
    headers: Object.fromEntries(headers.entries()),
    data: typeof init.body === 'string' ? init.body : undefined,
    responseType: 'text',
    connectTimeout: 20000,
    readTimeout: 30000,
  });
  const body = typeof nativeResponse.data === 'string'
    ? nativeResponse.data
    : JSON.stringify(nativeResponse.data ?? '');
  const responseBody = [204, 205, 304].includes(nativeResponse.status) ? null : body;
  return new Response(responseBody, {
    status: nativeResponse.status,
    headers: nativeResponse.headers,
  });
}

function isCalendarApiDisabledResponse(status: number, text: string): boolean {
  if (status !== 403) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('calendar-json.googleapis.com') ||
    lower.includes('service_disabled') ||
    lower.includes('api has not been used in project') ||
    (lower.includes('google calendar api') && lower.includes('disabled'))
  );
}

function extractCalendarActivationUrl(parsed: unknown, fallbackText: string): string | undefined {
  if (parsed && typeof parsed === 'object') {
    const details = (parsed as { error?: { details?: Array<{ metadata?: { activationUrl?: unknown } }> } })
      ?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        const url = detail?.metadata?.activationUrl;
        if (typeof url === 'string' && url.startsWith('https://')) {
          return url;
        }
      }
    }
  }
  const match = fallbackText.match(/https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'<>]+/);
  return match?.[0];
}

function isInsufficientCalendarScopeResponse(status: number, message: string): boolean {
  if (status !== 403) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('insufficient') ||
    lower.includes('scope') ||
    lower.includes('permission') ||
    lower.includes('access_token_scope_insufficient')
  );
}

async function authenticatedCalendarFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  let token: string;
  try {
    token = await getValidGoogleAccessToken();
  } catch {
    throw new CalendarPermissionError(
      'Phiên Google đã hết hạn hoặc chưa đăng nhập. Hãy đăng nhập lại để đồng bộ Google Calendar.',
    );
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response = await performCalendarHttp(url, init, headers);
  if (response.status === 401) {
    const refreshed = await trySilentRefresh(true);
    if (!refreshed) {
      throw new CalendarPermissionError(
        'Phiên Google đã hết hạn. Vui lòng đăng nhập lại và cấp quyền Google Calendar.',
      );
    }
    headers.set('Authorization', `Bearer ${refreshed}`);
    response = await performCalendarHttp(url, init, headers);
    if (response.status === 401) {
      throw new CalendarPermissionError(
        'Google từ chối phiên hiện tại. Vui lòng cấp lại quyền Google Calendar.',
      );
    }
  }

  if (!response.ok) {
    const rawError = await response.text().catch(() => '');
    let message = rawError;
    let parsedError: unknown = null;
    try {
      parsedError = JSON.parse(rawError);
      const parsedMessage = (parsedError as { error?: { message?: string } })?.error?.message;
      if (parsedMessage) message = parsedMessage;
    } catch {
      // keep raw text
    }

    const combinedText = [message, rawError].filter(Boolean).join('\n');
    if (isCalendarApiDisabledResponse(response.status, combinedText)) {
      throw new CalendarApiDisabledError(
        'Google Calendar API chưa được kích hoạt trên dự án Google Cloud.',
        extractCalendarActivationUrl(parsedError, combinedText),
      );
    }

    if (isInsufficientCalendarScopeResponse(response.status, message || rawError)) {
      throw new CalendarPermissionError(
        'Tài khoản Google chưa cấp quyền đồng bộ Google Calendar. Nhấn "Cấp quyền Google Calendar" để tiếp tục.',
      );
    }

    const err = new Error(message || `Google Calendar trả về lỗi ${response.status}.`) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  return response;
}

async function listAppSyncedPrimaryCalendarEvents(): Promise<GoogleCalendarEventResource[]> {
  const collected: GoogleCalendarEventResource[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      privateExtendedProperty: `familyHealthApp=${FAMILY_HEALTH_CALENDAR_APP_TAG}`,
      singleEvents: 'true',
      maxResults: '250',
      showDeleted: 'false',
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const response = await authenticatedCalendarFetch(
      `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`,
      { method: 'GET' },
    );
    const data = (await response.json()) as {
      items?: GoogleCalendarEventResource[];
      nextPageToken?: string;
    };
    if (Array.isArray(data.items)) {
      collected.push(...data.items.filter((ev) => ev.status !== 'cancelled'));
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return collected;
}

export function buildCalendarSyncPreviewPlan(params: {
  signedInEmail: string;
  member: FamilyMember | null;
  todayIso: string;
  items: FutureFollowUpItem[];
  existingEvents: GoogleCalendarEventResource[];
}): CalendarSyncPreviewPlan {
  const { signedInEmail, member, todayIso, items, existingEvents } = params;
  if (!member) {
    return {
      signedInEmail,
      member: null,
      todayIso,
      toCreate: [],
      toUpdate: [],
      unchanged: [],
      staleEvents: [],
    };
  }

  const existingByKey = new Map<string, GoogleCalendarEventResource>();
  for (const ev of existingEvents) {
    const priv = ev.extendedProperties?.private;
    const key = priv?.appointmentKey;
    if (key) {
      existingByKey.set(key, ev);
    }
  }

  const toCreate: FutureFollowUpItem[] = [];
  const toUpdate: CalendarSyncUpdateItem[] = [];
  const unchanged: CalendarSyncUnchangedItem[] = [];
  const activeKeys = new Set<string>();

  for (const item of items) {
    activeKeys.add(item.appointmentKey);
    const matched = existingByKey.get(item.appointmentKey);
    if (!matched) {
      toCreate.push(item);
      continue;
    }

    const existingHash = matched.extendedProperties?.private?.contentHash;
    const existingStartDate = matched.start?.date || matched.start?.dateTime?.slice(0, 10);
    const needsUpdate =
      existingHash !== item.contentHash ||
      existingStartDate !== item.followUpDate ||
      (matched.summary || '') !== item.summary;

    if (needsUpdate) {
      toUpdate.push({
        item,
        calendarEventId: matched.id,
        previousDate: existingStartDate,
        previousSummary: matched.summary,
      });
    } else {
      unchanged.push({
        item,
        calendarEventId: matched.id,
        htmlLink: matched.htmlLink,
      });
    }
  }

  const staleEvents: StaleCalendarEventItem[] = [];
  for (const ev of existingEvents) {
    const priv = ev.extendedProperties?.private;
    const key = priv?.appointmentKey;
    const evMemberId = priv?.memberId;
    if (!key || activeKeys.has(key)) continue;
    if (evMemberId && evMemberId !== member.id && !key.startsWith('menstrual:')) continue;

    const startDate = ev.start?.date || ev.start?.dateTime?.slice(0, 10) || '';
    if (startDate && startDate >= todayIso) {
      staleEvents.push({
        calendarEventId: ev.id,
        appointmentKey: key,
        summary: ev.summary || 'Lịch hẹn cũ',
        startDate,
      });
    }
  }

  return {
    signedInEmail,
    member,
    todayIso,
    toCreate,
    toUpdate,
    unchanged,
    staleEvents,
  };
}

export async function previewPrimaryCalendarSync(
  members: FamilyMember[],
  profiles: Record<string, HealthProfile>,
  userEmail: string | null,
  now = new Date(),
): Promise<CalendarSyncPreviewPlan> {
  if (!userEmail?.trim()) {
    throw new CalendarPermissionError('Cần đăng nhập Google để đồng bộ với Google Calendar.');
  }

  const { member, todayIso, items } = collectFutureFollowUpsForMember(members, profiles, userEmail, now);
  if (!member) {
    return {
      signedInEmail: userEmail.trim().toLowerCase(),
      member: null,
      todayIso,
      toCreate: [],
      toUpdate: [],
      unchanged: [],
      staleEvents: [],
    };
  }

  const existingEvents = await listAppSyncedPrimaryCalendarEvents();
  return buildCalendarSyncPreviewPlan({
    signedInEmail: userEmail.trim().toLowerCase(),
    member,
    todayIso,
    items,
    existingEvents,
  });
}

export async function executePrimaryCalendarSync(
  plan: CalendarSyncPreviewPlan,
  options: { removeStaleEvents?: boolean } = {},
): Promise<CalendarSyncExecutionResult> {
  const result: CalendarSyncExecutionResult = {
    created: 0,
    updated: 0,
    unchanged: plan.unchanged.length,
    deleted: 0,
    failed: 0,
    errors: [],
  };

  for (const item of plan.toCreate) {
    try {
      await authenticatedCalendarFetch(`${CALENDAR_API_BASE}/calendars/primary/events`, {
        method: 'POST',
        body: JSON.stringify(buildGoogleCalendarEventPayload(item)),
      });
      result.created += 1;
    } catch (error) {
      if (error instanceof CalendarPermissionError || error instanceof CalendarApiDisabledError) throw error;
      result.failed += 1;
      result.errors.push(`${item.summary}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const update of plan.toUpdate) {
    try {
      await authenticatedCalendarFetch(
        `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(update.calendarEventId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(buildGoogleCalendarEventPayload(update.item)),
        },
      );
      result.updated += 1;
    } catch (error) {
      if (error instanceof CalendarPermissionError || error instanceof CalendarApiDisabledError) throw error;
      const status = (error as { status?: number })?.status;
      if (status === 404 || status === 410) {
        try {
          await authenticatedCalendarFetch(`${CALENDAR_API_BASE}/calendars/primary/events`, {
            method: 'POST',
            body: JSON.stringify(buildGoogleCalendarEventPayload(update.item)),
          });
          result.created += 1;
          continue;
        } catch (createErr) {
          if (createErr instanceof CalendarPermissionError || createErr instanceof CalendarApiDisabledError) {
            throw createErr;
          }
          result.failed += 1;
          result.errors.push(`${update.item.summary}: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
          continue;
        }
      }
      result.failed += 1;
      result.errors.push(`${update.item.summary}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.removeStaleEvents) {
    for (const stale of plan.staleEvents) {
      try {
        await authenticatedCalendarFetch(
          `${CALENDAR_API_BASE}/calendars/primary/events/${encodeURIComponent(stale.calendarEventId)}`,
          { method: 'DELETE' },
        );
        result.deleted += 1;
      } catch (error) {
        if (error instanceof CalendarPermissionError || error instanceof CalendarApiDisabledError) throw error;
        const status = (error as { status?: number })?.status;
        if (status === 404 || status === 410) continue;
        result.failed += 1;
        result.errors.push(`${stale.summary}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return result;
}
