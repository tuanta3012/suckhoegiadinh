import { describe, expect, it } from 'vitest';
import type { FamilyMember } from '../types';
import {
  findMemberByOcrPatientName,
  isOcrSubjectMatchedToMember,
  isRecognizablePatientName,
} from './ocrSubjectRouting';

const member: FamilyMember = {
  id: 'member-1',
  name: 'Nguyễn Thị Mai',
  driveFolderId: 'raw-folder',
  profileFileId: 'profile-file',
};

describe('OCR subject routing', () => {
  it.each(['', '!!!', 'N/A', 'Unknown', 'Chưa rõ họ tên', 'Không xác định', 'Tên bệnh nhân'])(
    'requires manual assignment for an unknown OCR subject label: %s',
    (name) => {
      expect(isRecognizablePatientName(name)).toBe(false);
    },
  );

  it('matches recognized names against existing members regardless of Vietnamese accents', () => {
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [member])).toEqual(member);
  });

  it('does not auto-match a partial name to a different full name', () => {
    expect(findMemberByOcrPatientName('Tu Anh', [
      { ...member, name: 'Vũ Thị Tú Anh' },
    ])).toBeUndefined();
  });

  it('requires manual confirmation when matching names are ambiguous', () => {
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [
      member,
      { ...member, id: 'member-2', profileFileId: 'profile-2' },
    ])).toBeUndefined();
  });

  it('rejects a name match when the OCR birth date or gender conflicts with the member', () => {
    expect(findMemberByOcrPatientName(
      'Nguyen Thi Mai',
      [{ ...member, birthDate: '1980-12-30', gender: 'female' }],
      '1981-12-30',
      'Nữ',
    )).toBeUndefined();
    expect(findMemberByOcrPatientName(
      'Nguyen Thi Mai',
      [{ ...member, birthDate: '1980-12-30', gender: 'female' }],
      '30/12/1980',
      'Nam',
    )).toBeUndefined();
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

  it('only confirms a target member when OCR has a matching subject', () => {
    expect(isOcrSubjectMatchedToMember('Nguyen Thi Mai', member, [member])).toBe(true);
    expect(isOcrSubjectMatchedToMember('Tran Van Minh', member, [member])).toBe(false);
    expect(isOcrSubjectMatchedToMember(undefined, member, [member])).toBe(false);
    expect(isOcrSubjectMatchedToMember('Nguyen Thi Mai', member, [
      member,
      { ...member, id: 'member-2', profileFileId: 'profile-2' },
    ])).toBe(false);
  });
});
