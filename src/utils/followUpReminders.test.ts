import { describe, expect, it } from 'vitest';
import type { FamilyMember, HealthEvent, HealthProfile } from '../types';
import { getFollowUpRemindersForSignedInMember } from './followUpReminders';

function makeMember(id: string, email: string): FamilyMember {
  return {
    id,
    name: id,
    email,
    driveFolderId: `folder-${id}`,
    profileFileId: `profile-${id}`,
  };
}

function makeEvent(id: string, nextFollowUp: string): HealthEvent {
  return {
    id,
    sourceFileId: `source-${id}`,
    sourceFileName: 'report.pdf',
    type: 'medical_report',
    title: `Event ${id}`,
    date: '2026-01-01',
    diagnoses: [],
    medications: [],
    metrics: [],
    nextFollowUp,
    recordedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeProfile(member: FamilyMember, nextFollowUp: string): HealthProfile {
  return {
    schemaVersion: 2,
    member,
    timeline: [makeEvent(member.id, nextFollowUp)],
    sources: [],
    summary: { latestDiagnoses: [], latestMetrics: {} },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('getFollowUpRemindersForSignedInMember', () => {
  const memberA = makeMember('member-a', 'a@example.com');
  const memberB = makeMember('member-b', 'b@example.com');
  const profiles = {
    [memberA.id]: makeProfile(memberA, '2026-12-14'),
    [memberB.id]: makeProfile(memberB, '2026-12-15'),
  };

  it('returns reminders only from the profile linked to the signed-in email', () => {
    const reminders = getFollowUpRemindersForSignedInMember(
      [memberA, memberB],
      profiles,
      'A@example.com',
      new Date(2026, 11, 10, 12),
    );

    expect(reminders).toHaveLength(1);
    expect(reminders[0].member.id).toBe('member-a');
    expect(reminders[0].event.id).toBe('member-a');
    expect(reminders[0].daysRemaining).toBe(4);
  });

  it('returns no reminders if the signed-in account has no linked member profile', () => {
    expect(getFollowUpRemindersForSignedInMember(
      [memberA, memberB],
      profiles,
      'unknown@example.com',
      new Date(2026, 11, 10, 12),
    )).toEqual([]);
  });

  it('ignores malformed dates and dates more than 14 days in the past', () => {
    const member = makeMember('member-c', 'c@example.com');
    const profile = makeProfile(member, '2026-11-01');
    profile.timeline.push(makeEvent('invalid', '2026-02-30'));
    profile.timeline.push(makeEvent('old', '2026-11-20'));

    expect(getFollowUpRemindersForSignedInMember(
      [member],
      { [member.id]: profile },
      member.email || null,
      new Date(2026, 11, 10, 12),
    )).toEqual([]);
  });
});
