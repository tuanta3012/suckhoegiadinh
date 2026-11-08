import type { FamilyMember } from '../types';

function normalizeEmail(email?: string | null): string {
  return email?.trim().toLowerCase() || '';
}

export function findMemberForEmail(
  members: FamilyMember[],
  email?: string | null,
): FamilyMember | undefined {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return undefined;
  return members.find((member) => normalizeEmail(member.email) === normalizedEmail);
}

export function prioritizeMemberForEmail(
  members: FamilyMember[],
  email?: string | null,
): FamilyMember[] {
  const preferredMember = findMemberForEmail(members, email);
  if (!preferredMember) return members;
  return [preferredMember, ...members.filter((member) => member.id !== preferredMember.id)];
}
