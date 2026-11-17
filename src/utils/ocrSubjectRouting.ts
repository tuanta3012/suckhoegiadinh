import type { FamilyMember, HealthProfile } from '../types';
import { formatDateVN, normalizeVietnamese } from './formatters';

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

export function normalizeNameTokens(value?: string): string[] {
  if (!value) return [];
  const normalized = normalizePatientName(value);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
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

export function normalizeBirthDate(value?: string): string | undefined {
  if (!value) return undefined;
  const iso = value.trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const vietnamese = value.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s.*)?$/);
  if (vietnamese) {
    return `${vietnamese[3]}-${vietnamese[2].padStart(2, '0')}-${vietnamese[1].padStart(2, '0')}`;
  }
  return undefined;
}

export function areBirthDatesEquivalent(left?: string, right?: string): boolean {
  const normLeft = normalizeBirthDate(left);
  const normRight = normalizeBirthDate(right);
  return Boolean(normLeft && normRight && normLeft === normRight);
}

function normalizeGender(value?: string): 'male' | 'female' | undefined {
  const normalized = normalizeVietnamese(value);
  if (['male', 'nam', 'm'].includes(normalized)) return 'male';
  if (['female', 'nu', 'f'].includes(normalized)) return 'female';
  return undefined;
}

export function areGendersCompatible(left?: string, right?: string): boolean {
  const normLeft = normalizeGender(left);
  const normRight = normalizeGender(right);
  if (!normLeft || !normRight) return true;
  return normLeft === normRight;
}

function tokensSubsetMatch(
  shorter: string[],
  longer: string[],
  allowInitials: boolean,
): boolean {
  if (shorter.length < 2 || longer.length < shorter.length) return false;
  const used = new Array<boolean>(longer.length).fill(false);
  let fullTokenMatches = 0;

  // Match exact full tokens first so initials cannot greedily consume a full token
  for (const token of shorter) {
    if (token.length < 2) continue;
    const exactIdx = longer.findIndex((candidate, idx) => !used[idx] && candidate === token);
    if (exactIdx === -1) return false;
    used[exactIdx] = true;
    fullTokenMatches++;
  }

  for (const token of shorter) {
    if (token.length >= 2) continue;
    if (!allowInitials) return false;
    const initialIdx = longer.findIndex(
      (candidate, idx) => !used[idx] && candidate.startsWith(token),
    );
    if (initialIdx === -1) return false;
    used[initialIdx] = true;
  }

  return fullTokenMatches >= 2;
}

export function areNamesProbablySamePerson(
  nameA: string,
  nameB: string,
  options?: { sameBirthDate?: boolean },
): boolean {
  const tokensA = normalizeNameTokens(nameA);
  const tokensB = normalizeNameTokens(nameB);
  if (tokensA.length === 0 || tokensB.length === 0) return false;
  if (tokensA.join(' ') === tokensB.join(' ')) return true;

  // Check exact bag-of-words reorder (e.g. "Minh Truong" vs "Truong Minh")
  if (tokensA.length === tokensB.length) {
    const sortedA = [...tokensA].sort().join(' ');
    const sortedB = [...tokensB].sort().join(' ');
    if (sortedA === sortedB && tokensA.length >= 2) {
      return true;
    }
  }

  const shorter = tokensA.length <= tokensB.length ? tokensA : tokensB;
  const longer = tokensA.length <= tokensB.length ? tokensB : tokensA;
  const allowInitials = Boolean(options?.sameBirthDate);

  return tokensSubsetMatch(shorter, longer, allowInitials);
}

export function findProbableDuplicateMembersForInput(
  input: { name: string; birthDate?: string; gender?: string; excludeMemberId?: string },
  members: FamilyMember[],
): FamilyMember[] {
  if (!isRecognizablePatientName(input.name)) return [];
  const normalizedInputName = normalizePatientName(input.name);
  const inputBirth = normalizeBirthDate(input.birthDate);
  const inputGender = normalizeGender(input.gender);

  return members.filter((member) => {
    if (input.excludeMemberId && member.id === input.excludeMemberId) return false;
    const memberBirth = normalizeBirthDate(member.birthDate);
    if (inputBirth && memberBirth && inputBirth !== memberBirth) return false;
    if (!areGendersCompatible(inputGender, member.gender)) return false;

    const normalizedMemberName = normalizePatientName(member.name);
    if (normalizedMemberName === normalizedInputName) return true;
    const sameBirthDate = Boolean(inputBirth && memberBirth && inputBirth === memberBirth);
    return areNamesProbablySamePerson(input.name, member.name, { sameBirthDate });
  });
}

export function findMemberByOcrPatientName(
  patientName: string,
  members: FamilyMember[],
  patientBirthDate?: string,
  patientGender?: string,
): { matched?: FamilyMember; candidates: FamilyMember[]; probableMatches: FamilyMember[] } {
  if (!isRecognizablePatientName(patientName)) {
    return { candidates: [], probableMatches: [] };
  }
  const normalizedName = normalizePatientName(patientName);
  if (!normalizedName) {
    return { candidates: [], probableMatches: [] };
  }

  const birthDate = normalizeBirthDate(patientBirthDate);
  const gender = normalizeGender(patientGender);

  const nameMatches = members.filter(
    (member) => normalizePatientName(member.name) === normalizedName,
  );
  if (nameMatches.length === 0) {
    const probableMatches = findProbableDuplicateMembersForInput(
      { name: patientName, birthDate: patientBirthDate, gender: patientGender },
      members,
    );
    return { candidates: [], probableMatches };
  }

  const candidates = nameMatches.filter((member) => {
    const memberBirthDate = normalizeBirthDate(member.birthDate);
    if (birthDate && memberBirthDate && birthDate !== memberBirthDate) return false;
    const memberGender = normalizeGender(member.gender);
    if (gender && memberGender && gender !== memberGender) return false;
    return true;
  });
  if (candidates.length === 1) {
    return { matched: candidates[0], candidates, probableMatches: [] };
  }

  // When multiple family members share the same name, try same-year + gender disambiguation
  if (candidates.length === 0 && nameMatches.length > 1 && birthDate) {
    const birthYear = birthDate.slice(0, 4);
    const softCandidates = nameMatches.filter((member) => {
      const memberBirthDate = normalizeBirthDate(member.birthDate);
      if (memberBirthDate && memberBirthDate.slice(0, 4) !== birthYear) return false;
      const memberGender = normalizeGender(member.gender);
      if (gender && memberGender && gender !== memberGender) return false;
      return true;
    });
    if (softCandidates.length === 1) {
      return { matched: softCandidates[0], candidates: softCandidates, probableMatches: [] };
    }
  }

  // If there is exactly ONE family member matching a full (2+ word) name,
  // still auto-assign when OCR/profile has a placeholder DOB (e.g. 01/01/YYYY),
  // a digit typo, or a default/mismatched gender flag.
  if (
    candidates.length === 0 &&
    nameMatches.length === 1 &&
    normalizedName.split(/\s+/).length >= 2
  ) {
    return { matched: nameMatches[0], candidates: nameMatches, probableMatches: [] };
  }

  return {
    matched: undefined,
    candidates,
    probableMatches: candidates.length > 0 ? candidates : nameMatches,
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

export interface DuplicateMemberPair {
  id: string;
  primary: FamilyMember;
  duplicate: FamilyMember;
  reason: string;
}

function hasVietnameseDiacritics(value: string): boolean {
  return value.normalize('NFC') !== normalizeVietnamese(value) && /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(value);
}

function scoreMemberCompleteness(
  member: FamilyMember,
  profile: HealthProfile | undefined,
  index: number,
): number {
  let score = 0;
  if (member.email && member.email.trim()) score += 100_000;
  score += (profile?.timeline?.length || 0) * 1_000;
  score += (profile?.sources?.length || 0) * 100;
  if (hasVietnameseDiacritics(member.name)) score += 40;
  score += Math.min(20, normalizeNameTokens(member.name).length * 5);
  if (member.gender === 'male' || member.gender === 'female') score += 10;
  if (normalizeBirthDate(member.birthDate)) score += 10;
  if (!member.driveFolderId.startsWith('local_')) score += 5;
  score -= index * 0.001;
  return score;
}

export function findDuplicateFamilyMemberPairs(
  members: FamilyMember[],
  profiles: Record<string, HealthProfile>,
): DuplicateMemberPair[] {
  const pairs: DuplicateMemberPair[] = [];
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      if (!areGendersCompatible(a.gender, b.gender)) continue;
      const birthA = normalizeBirthDate(a.birthDate);
      const birthB = normalizeBirthDate(b.birthDate);
      if (birthA && birthB && birthA !== birthB) continue;

      const sameBirthDate = Boolean(birthA && birthB && birthA === birthB);
      const exactSameName = normalizePatientName(a.name) === normalizePatientName(b.name);
      const similarName = areNamesProbablySamePerson(a.name, b.name, { sameBirthDate });
      if (!exactSameName && !similarName) continue;

      const scoreA = scoreMemberCompleteness(a, profiles[a.id], i);
      const scoreB = scoreMemberCompleteness(b, profiles[b.id], j);
      const [primary, duplicate] = scoreA >= scoreB ? [a, b] : [b, a];

      const reasons: string[] = [];
      if (sameBirthDate && birthA) {
        reasons.push(`Cùng ngày sinh ${formatDateVN(birthA) || birthA}`);
      }
      reasons.push(exactSameName ? 'trùng họ tên' : 'tên tương đồng / đảo thứ tự');

      pairs.push({
        id: [a.id, b.id].sort().join('::'),
        primary,
        duplicate,
        reason: reasons.join(' · '),
      });
    }
  }
  return pairs;
}

