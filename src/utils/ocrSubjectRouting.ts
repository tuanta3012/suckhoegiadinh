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
  'patient',
  'patient name',
]);

export function isRecognizablePatientName(value?: string): value is string {
  const name = value?.trim();
  if (!name || name.length < 3) return false;
  const normalized = name
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return Boolean(normalized) && !UNKNOWN_SUBJECT_LABELS.has(normalized);
}

function normalizePatientName(value: string): string {
  return normalizeVietnamese(value)
    .replace(/^(ho va ten|ho ten|ten bn|ten benh nhan|benh nhan|bn|nguoi benh)\s+/, '')
    .trim();
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
