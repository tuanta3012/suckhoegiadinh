import { describe, expect, it } from 'vitest';
import type { FamilyMember } from '../types';
import {
  extractPatientNameFallbackFromText,
  findMemberByOcrPatientName,
  hasSameNameMemberConflict,
  isOcrSubjectMatchedToMember,
  isRecognizablePatientName,
  sanitizeOcrPatientName,
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
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [member]).matched).toEqual(member);
  });

  it('does not auto-match a partial name to a different full name', () => {
    expect(findMemberByOcrPatientName('Tu Anh', [
      { ...member, name: 'Vũ Thị Tú Anh' },
    ]).matched).toBeUndefined();
  });

  it('requires manual confirmation when matching names are ambiguous', () => {
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [
      member,
      { ...member, id: 'member-2', profileFileId: 'profile-2' },
    ]).matched).toBeUndefined();
  });

  it('rejects a name match when the OCR birth date or gender conflicts with the member', () => {
    expect(findMemberByOcrPatientName(
      'Nguyen Thi Mai',
      [{ ...member, birthDate: '1980-12-30', gender: 'female' }],
      '1981-12-30',
      'Nữ',
    ).matched).toBeUndefined();
    expect(findMemberByOcrPatientName(
      'Nguyen Thi Mai',
      [{ ...member, birthDate: '1980-12-30', gender: 'female' }],
      '30/12/1980',
      'Nam',
    ).matched).toBeUndefined();
  });

  it('can match a member created by an earlier file in the same upload queue', () => {
    const earlierCreatedMember = { ...member, id: 'member-2', name: 'Trần Văn Minh' };
    expect(findMemberByOcrPatientName('Tran Van Minh', [member, earlierCreatedMember]).matched).toEqual(
      earlierCreatedMember,
    );
  });

  it('does not assign a document when OCR did not identify a usable name', () => {
    expect(findMemberByOcrPatientName('Không rõ', [member]).matched).toBeUndefined();
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

  it('matches names preceded by Vietnamese honorifics and labels', () => {
    const family: FamilyMember[] = [
      { ...member, id: 'm1', name: 'Trương Anh Tuấn' },
      { ...member, id: 'm2', name: 'Vũ Thị Tú Anh' },
      { ...member, id: 'm3', name: 'Trương Khánh Chi' },
    ];
    expect(findMemberByOcrPatientName('Ông Trương Anh Tuấn', family).matched?.id).toBe('m1');
    expect(findMemberByOcrPatientName('Bà Vũ Thị Tú Anh', family).matched?.id).toBe('m2');
    expect(findMemberByOcrPatientName('Bé Trương Khánh Chi', family).matched?.id).toBe('m3');
    expect(findMemberByOcrPatientName('Họ tên Trương Anh Tuấn', family).matched?.id).toBe('m1');
  });

  it('sanitizes prefixes, employee codes, honorifics, and trailing gender/year tags', () => {
    expect(sanitizeOcrPatientName('Ông TRƯƠNG ANH TUẤN (Nam)')).toBe('TRƯƠNG ANH TUẤN');
    expect(sanitizeOcrPatientName('NLĐ: Vũ Thị Tú Anh - 1986')).toBe('Vũ Thị Tú Anh');
    expect(sanitizeOcrPatientName('NV001 - Bé Trương Khánh Chi (Nữ)')).toBe('Trương Khánh Chi');
  });

  it('recovers patient name from pageTexts or notes when Gemini leaves patientName blank', () => {
    const recovered = extractPatientNameFallbackFromText(
      { notes: 'Bệnh nhân khám sức khỏe định kỳ.' },
      ['BỆNH VIỆN ĐẠI HỌC Y HÀ NỘI\nHọ và tên: Ông TRƯƠNG ANH TUẤN  Giới tính: Nam\nNăm sinh: 1984'],
    );
    expect(recovered).toBe('TRƯƠNG ANH TUẤN');
  });

  it('flags same-name conflicts so duplicate profiles are not auto-created on DOB/gender mismatch', () => {
    const existing = [{ ...member, birthDate: '1980-12-30', gender: 'female' as const }];
    expect(hasSameNameMemberConflict('Chị Nguyễn Thị Mai (Nữ)', existing)).toBe(true);
    expect(hasSameNameMemberConflict('Trần Văn Minh', existing)).toBe(false);
  });

  it.each(['Khách hàng', 'Người bệnh', 'Họ và tên', 'Trẻ em'])(
    'treats generic placeholder labels as unrecognized: %s',
    (label) => {
      expect(isRecognizablePatientName(label)).toBe(false);
    },
  );
});

