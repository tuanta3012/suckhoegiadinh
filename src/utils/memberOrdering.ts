import type { FamilyMember } from '../types';

function normalizeEmail(email?: string | null): string {
  return email?.trim().toLowerCase() || '';
}

export function isMemberForEmail(
  member: Pick<FamilyMember, 'email'>,
  email?: string | null,
): boolean {
  const normalizedEmail = normalizeEmail(email);
  return Boolean(normalizedEmail && normalizeEmail(member.email) === normalizedEmail);
}

export function findMemberForEmail(
  members: FamilyMember[],
  email?: string | null,
): FamilyMember | undefined {
  return members.find((member) => isMemberForEmail(member, email));
}

export function prioritizeMemberForEmail(
  members: FamilyMember[],
  email?: string | null,
): FamilyMember[] {
  const preferredMember = findMemberForEmail(members, email);
  if (!preferredMember) return members;
  return [preferredMember, ...members.filter((member) => member.id !== preferredMember.id)];
}
