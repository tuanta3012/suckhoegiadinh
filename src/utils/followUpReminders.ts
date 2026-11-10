import type { FamilyMember, HealthEvent, HealthProfile } from '../types';
import { findMemberForEmail } from './memberOrdering';

export interface FollowUpReminder {
  member: FamilyMember;
  event: HealthEvent;
  followUpDate: string;
  daysRemaining: number;
}

function parseLocalDate(value: string): Date | undefined {
  const isoDate = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!isoDate) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime())
      ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
      : undefined;
  }

  const year = Number(isoDate[1]);
  const month = Number(isoDate[2]) - 1;
  const day = Number(isoDate[3]);
  const parsed = new Date(year, month, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month ||
    parsed.getDate() !== day
  ) return undefined;
  return parsed;
}

export function getFollowUpRemindersForSignedInMember(
  members: FamilyMember[],
  profiles: Record<string, HealthProfile>,
  userEmail: string | null,
  now = new Date(),
): FollowUpReminder[] {
  const member = findMemberForEmail(members, userEmail);
  if (!member) return [];

  const profile = profiles[member.id];
  if (!profile?.timeline) return [];

  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return profile.timeline
    .filter((event) => Boolean(event.nextFollowUp))
    .flatMap((event) => {
      const followUpDate = parseLocalDate(event.nextFollowUp!);
      if (!followUpDate) return [];
      const eventDay = Date.UTC(
        followUpDate.getFullYear(),
        followUpDate.getMonth(),
        followUpDate.getDate(),
      );
      const daysRemaining = Math.round((eventDay - today) / 86400000);
      return daysRemaining >= -14
        ? [{ member, event, followUpDate: event.nextFollowUp!, daysRemaining }]
        : [];
    })
    .sort((left, right) => left.daysRemaining - right.daysRemaining);
}
