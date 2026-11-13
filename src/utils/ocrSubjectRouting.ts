import type { FamilyMember } from '../types';
import { normalizeVietnamese } from './formatters';

const UNKNOWN_SUBJECT_LABELS = new Set([
  'na',
  'n a',
  'n v',
  'unknown',
  'not identified',
  'chua ro',
  'chua ro ho ten',
  'khong ro',
  'khong ro ten',
  'khong xac dinh',
  'khong xac dinh duoc',
  'chua xac dinh',
  'khong doc duoc',
  'khong co thong tin',
  'benh nhan',
  'ten benh nhan',
  'nguoi benh',
  'nguoi kham',
  'khach hang',
  'nguoi lao dong',
  'ho ten',
  'ho va ten',
  'tre em',
  'em be',
  'patient',
  'patient name',
  'full name',
  'name',
]);

export function sanitizeOcrPatientName(value?: string): string {
  if (!value || typeof value !== 'string') return '';
  let cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Strip trailing parenthetical / hyphenated demographic annotations: "(Nam)", "(Nữ)", "- Nam", "(1986)", "(38 tuổi)"
  cleaned = cleaned
    .replace(/\s*\((?:nam|nữ|nu|male|female|m|f|\d{4}|\d{1,3}\s*(?:tuổi|tuoi|t))\)\s*$/i, '')
    .replace(/\s*[-–|]\s*(?:nam|nữ|nu|male|female|\d{4}|\d{1,3}\s*(?:tuổi|tuoi|t))\s*$/i, '')
    .trim();

  // Strip leading form labels / employee codes (including accented Vietnamese and ASCII forms)
  cleaned = cleaned
    .replace(
      /^(?:họ\s*(?:và\s*)?tên|ho\s*(?:va\s*)?ten|tên\s*(?:bệnh\s*nhân|bn|khách\s*hàng|người\s*(?:bệnh|khám|được\s*khám))|ten\s*(?:benh\s*nhan|bn|khach\s*hang|nguoi\s*(?:benh|kham))|bệnh\s*nhân|benh\s*nhan|người\s*(?:bệnh|khám|được\s*khám|lao\s*động)|nguoi\s*(?:benh|kham|lao\s*dong)|khách\s*hàng|khach\s*hang|nhân\s*viên|nhan\s*vien|nlđ|nld|bn|patient\s*name|full\s*name|patient|name)\s*[:\-–.]?\s*/i,
      '',
    )
    .replace(/^(?:mã\s*(?:nv|bn|kh)?\s*[:\-–]?\s*)?[a-z0-9_-]{2,12}\s*[-–|:]\s+/i, '')
    .trim();

  // Strip Vietnamese/English honorifics only when at least 2 words remain after stripping
  const honorificMatch = cleaned.match(
    /^(?:ông|ong|bà|ba|anh|chị|chi|em|cháu|chau|bé|be|cô|co|chú|chu|bác|bac|trẻ\s*em|tre\s*em|trẻ|tre|mr\.?|mrs\.?|ms\.?|miss)\s+(.+)$/i,
  );
  if (honorificMatch && honorificMatch[1].trim().split(/\s+/).length >= 2) {
    cleaned = honorificMatch[1].trim();
  }

  // Final trailing cleanup if colon/brackets remain
  return cleaned.replace(/^[:\-–.,;\s]+|[:\-–.,;\s]+$/g, '').trim();
}

export function isRecognizablePatientName(value?: string): value is string {
  const sanitized = sanitizeOcrPatientName(value);
  if (!sanitized || sanitized.length < 3) return false;
  const normalized = sanitized
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalized || UNKNOWN_SUBJECT_LABELS.has(normalized)) return false;
  // Require at least two alphabetic characters (avoid pure codes/numbers)
  return /[a-z]{2,}/.test(normalized);
}

function normalizePatientName(value: string): string {
  const sanitized = sanitizeOcrPatientName(value);
  let normalized = normalizeVietnamese(sanitized)
    .replace(/^(ho va ten|ho ten|ten bn|ten benh nhan|benh nhan|bn|nguoi benh|nguoi kham|khach hang|nguoi lao dong|nld)\s+/, '')
    .trim();
  const honorificStripped = normalized
    .replace(/^(ong|ba|anh|chi|em|chau|be|co|chu|bac|tre em|tre)\s+/, '')
    .trim();
  if (honorificStripped.split(/\s+/).length >= 2) {
    normalized = honorificStripped;
  }
  return normalized;
}

export function extractPatientNameFallbackFromText(
  extracted: Record<string, unknown>,
  rawPageTexts: string[] = [],
): string | undefined {
  const candidates: string[] = [];

  // 1. Check structured extractedData fields first
  const extractedData = extracted.extractedData;
  if (extractedData && typeof extractedData === 'object' && !Array.isArray(extractedData)) {
    for (const [key, val] of Object.entries(extractedData as Record<string, unknown>)) {
      if (typeof val !== 'string') continue;
      if (/patient|name|ho.?ten|benh.?nhan|khach.?hang|nguoi.?kham/i.test(key)) {
        candidates.push(val);
      }
    }
  }

  // 2. Scan notes, title, and OCR pageTexts for explicit Vietnamese/English patient-name labels
  const textSources: string[] = [];
  if (typeof extracted.notes === 'string') textSources.push(extracted.notes);
  if (typeof extracted.title === 'string') textSources.push(extracted.title);
  for (const page of rawPageTexts) {
    if (typeof page === 'string' && page.trim()) textSources.push(page);
  }

  const labelPattern =
    /(?:họ\s*(?:và\s*)?tên|họ\s*tên|tên\s*(?:bệnh\s*nhân|bn|khách\s*hàng|người\s*khám)|bệnh\s*nhân|khách\s*hàng|người\s*(?:được\s*khám|lao\s*động)|patient\s*name|full\s*name)\s*[:\-–]\s*([^\n\r,;(|/]{3,65})/gi;

  for (const sourceText of textSources) {
    for (const match of sourceText.matchAll(labelPattern)) {
      const rawCandidate = match[1]
        // Stop before inline secondary labels on the same line
        .split(/\s+(?:giới\s*tính|ngày\s*sinh|năm\s*sinh|namsinh|tuổi|mã\s*(?:bn|nv|hs|y\s*tế)|địa\s*chỉ|sđt|điện\s*thoại|dob|age|gender|sex)\b/i)[0]
        .trim();
      if (rawCandidate) candidates.push(rawCandidate);
    }
  }

  for (const candidate of candidates) {
    const sanitized = sanitizeOcrPatientName(candidate);
    if (isRecognizablePatientName(sanitized) && sanitized.split(/\s+/).length >= 2) {
      return sanitized;
    }
  }

  return undefined;
}

function normalizeBirthDate(value?: string): string | undefined {
  if (!value) return undefined;
  const iso = value.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const vietnamese = value.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (vietnamese) {
    return `${vietnamese[3]}-${vietnamese[2].padStart(2, '0')}-${vietnamese[1].padStart(2, '0')}`;
  }
  return undefined;
}

function normalizeGender(value?: string): 'male' | 'female' | undefined {
  const normalized = normalizeVietnamese(value);
  if (['male', 'nam', 'm'].includes(normalized)) return 'male';
  if (['female', 'nu', 'f'].includes(normalized)) return 'female';
  return undefined;
}

export function findMemberByOcrPatientName(
  patientName: string,
  members: FamilyMember[],
  patientBirthDate?: string,
  patientGender?: string,
): { matched?: FamilyMember; candidates: FamilyMember[] } {
  if (!isRecognizablePatientName(patientName)) return { candidates: [] };
  const normalizedName = normalizePatientName(patientName);
  if (!normalizedName) return { candidates: [] };

  const birthDate = normalizeBirthDate(patientBirthDate);
  const gender = normalizeGender(patientGender);
  const candidates = members.filter((member) => {
    if (normalizePatientName(member.name) !== normalizedName) return false;
    const memberBirthDate = normalizeBirthDate(member.birthDate);
    if (birthDate && memberBirthDate && birthDate !== memberBirthDate) return false;
    const memberGender = normalizeGender(member.gender);
    if (gender && memberGender && gender !== memberGender) return false;
    return true;
  });
  return {
    matched: candidates.length === 1 ? candidates[0] : undefined,
    candidates,
  };
}

export function hasSameNameMemberConflict(
  patientName: string,
  members: FamilyMember[],
): boolean {
  if (!isRecognizablePatientName(patientName)) return false;
  const normalizedName = normalizePatientName(patientName);
  if (!normalizedName) return false;
  return members.some((member) => normalizePatientName(member.name) === normalizedName);
}

export function isOcrSubjectMatchedToMember(
  patientName: string | undefined,
  member: FamilyMember,
  members: FamilyMember[],
  patientBirthDate?: string,
  patientGender?: string,
): boolean {
  if (!patientName) return false;
  const result = findMemberByOcrPatientName(
    patientName,
    members,
    patientBirthDate,
    patientGender,
  );
  return result.matched?.id === member.id;
}
