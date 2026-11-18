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

function normalizeConditionCompareKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatConciseDiagnosis(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw
    .trim()
    .replace(/^[-*•+]\s*/, '')
    .replace(/^\d+[\.\/\)]\s*/, '')
    // Strip parenthetical ICD-10 codes such as (I10), (E11.9), (E78.2)
    .replace(/\s*[-–:,]?\s*\(\s*[A-Z]\d{2}(?:\.\d{1,3})?(?:\s*[-–,;]\s*[A-Z]\d{2}(?:\.\d{1,3})?)*\s*\)/gi, '')
    // Strip trailing bare ICD-10 codes such as " - I10" or " I10"
    .replace(/\s*[-–:,]\s*[A-Z]\d{2}(?:\.\d{1,3})?(?=$|\s|[,;)])/gi, '')
    .replace(/\s+[A-Z]\d{2}(?:\.\d{1,3})?$/g, '')
    // Strip verbose parenthetical modifiers
    .replace(/\s*\(\s*(?:nguyên phát|thứ phát|vô căn|không đặc hiệu|khác|chưa xác định|không biến chứng|chưa có biến chứng|mạn tính|cấp tính)\s*\)/gi, '')
    // Condense common overly verbose ICD-10 Vietnamese phrases (avoid ASCII \b around Vietnamese diacritics)
    .replace(/(^|[\s,;(\-])đái tháo đường\s+(?:không phụ thuộc|phụ thuộc)\s+insuline?(?=$|[\s,;).])/gi, '$1Đái tháo đường')
    .replace(/(^|[\s,;(\-])tăng huyết áp\s+vô căn(?=$|[\s,;).])/gi, '$1Tăng huyết áp')
    .replace(/(^|[\s,;(\-])rối loạn chuyển hóa lipoprotein(?:\s+và\s+(?:các\s+)?tình trạng\s+tăng\s+lipid\s+máu\s+khác)?(?=$|[\s,;).])/gi, '$1Rối loạn lipid máu')
    .replace(/(^|[\s,;(\-])rối loạn chuyển hóa lipid(?:\s+máu)?(?=$|[\s,;).])/gi, '$1Rối loạn lipid máu')
    // Strip redundant leading "Bệnh " for common conditions so cards stay concise
    .replace(/^bệnh\s+(tăng huyết áp|đái tháo đường|tiểu đường|rối loạn|mỡ máu|gout|gút|suy tim|suy thận|viêm\s)/i, '$1')
    .replace(/\s*\(\s*\)\s*/g, ' ')
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatFollowUpConditions(
  diagnoses?: string[],
  fallbackTitle?: string,
  maxItems = 3,
): string {
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const item of diagnoses || []) {
    const concise = formatConciseDiagnosis(item);
    if (!concise) continue;
    const key = normalizeConditionCompareKey(concise);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(concise);
  }

  if (cleaned.length === 0) {
    return formatConciseDiagnosis(fallbackTitle || '') || fallbackTitle?.trim() || 'Tái khám';
  }

  if (cleaned.length <= maxItems) {
    return cleaned.join(', ');
  }

  const head = cleaned.slice(0, maxItems).join(', ');
  return `${head} (+${cleaned.length - maxItems} khác)`;
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

