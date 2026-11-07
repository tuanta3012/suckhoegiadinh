import { describe, expect, it } from 'vitest';
import type { FamilyMember } from '../types';
import { findMemberByOcrPatientName, isRecognizablePatientName } from './ocrSubjectRouting';

const member: FamilyMember = {
  id: 'member-1',
  name: 'Nguyễn Thị Mai',
  driveFolderId: 'raw-folder',
  profileFileId: 'profile-file',
};

describe('OCR subject routing', () => {
  it.each(['', 'N/A', 'Unknown', 'Chưa rõ họ tên', 'Không xác định', 'Tên bệnh nhân'])(
    'requires manual assignment for an unknown OCR subject label: %s',
    (name) => {
      expect(isRecognizablePatientName(name)).toBe(false);
    },
  );

  it('matches recognized names against existing members regardless of Vietnamese accents', () => {
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [member])).toEqual(member);
  });

  it('can match a member created by an earlier file in the same upload queue', () => {
    const earlierCreatedMember = { ...member, id: 'member-2', name: 'Trần Văn Minh' };
    expect(findMemberByOcrPatientName('Tran Van Minh', [member, earlierCreatedMember])).toEqual(
      earlierCreatedMember,
    );
  });

  it('does not assign a document when OCR did not identify a usable name', () => {
    expect(findMemberByOcrPatientName('Không rõ', [member])).toBeUndefined();
  });
});
