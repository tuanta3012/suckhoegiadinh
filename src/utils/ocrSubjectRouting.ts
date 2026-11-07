import type { FamilyMember } from '../types';
import { isSamePersonName } from './formatters';

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
  return !UNKNOWN_SUBJECT_LABELS.has(normalized);
}

export function findMemberByOcrPatientName(
  patientName: string,
  members: FamilyMember[],
): FamilyMember | undefined {
  if (!isRecognizablePatientName(patientName)) return undefined;
  return members.find((member) => isSamePersonName(patientName, member.name));
}
