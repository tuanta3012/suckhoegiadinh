import { describe, expect, it } from 'vitest';
import type { FamilyMember } from '../types';
import {
  findMemberForEmail,
  getWorkspaceMemberRole,
  isMemberForEmail,
  prioritizeMemberForEmail,
} from './memberOrdering';

const members = [
  { id: 'm1', name: 'Lan', email: 'lan@example.com' },
  { id: 'm2', name: 'Minh', email: 'minh@example.com' },
  { id: 'm3', name: 'Hà', email: '  HA@example.com ' },
] as FamilyMember[];

describe('member ordering by signed-in email', () => {
  it('finds the matching member without case or whitespace sensitivity', () => {
    expect(findMemberForEmail(members, ' ha@Example.com ')?.id).toBe('m3');
    expect(isMemberForEmail(members[2], 'ha@example.com')).toBe(true);
    expect(isMemberForEmail(members[0], 'ha@example.com')).toBe(false);
  });

  it('moves the matching member to the front without changing other members order', () => {
    expect(prioritizeMemberForEmail(members, 'minh@example.com').map(({ id }) => id))
      .toEqual(['m2', 'm1', 'm3']);
  });

  it('keeps the existing order when there is no matching email', () => {
    expect(prioritizeMemberForEmail(members, 'other@example.com')).toEqual(members);
    expect(prioritizeMemberForEmail(members, null)).toEqual(members);
  });
});

describe('workspace member role labels', () => {
  it('marks the profile matching the folder owner email as Admin', () => {
    expect(getWorkspaceMemberRole(members[2], ' ha@example.com ')).toBe('Admin');
  });

  it('marks other profiles as Member, including when owner metadata is missing', () => {
    expect(getWorkspaceMemberRole(members[0], 'admin@example.com')).toBe('Member');
    expect(getWorkspaceMemberRole(members[0])).toBe('Member');
  });
});
