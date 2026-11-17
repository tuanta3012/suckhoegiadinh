import { describe, expect, it } from 'vitest';
import type { FamilyMember, HealthEvent } from '../types';
import {
  extractPatientNameFallbackFromText,
  findDuplicateFamilyMemberPairs,
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

const event: HealthEvent = {
  id: 'event-1',
  sourceFileId: 'source-1',
  sourceFileName: 'lab.pdf',
  type: 'test_result',
  title: 'Xét nghiệm máu',
  date: '2026-03-10',
  diagnoses: ['Thiếu máu'],
  medications: [],
  metrics: [{ name: 'Hemoglobin', standardKey: 'HGB', value: 12, unit: 'g/dL' }],
  recordedAt: '2026-03-10T09:00:00.000Z',
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

  it('auto-matches a unique full-name member despite DOB placeholder/typo or gender mismatch, while disambiguating duplicate names', () => {
    const tuAnh: FamilyMember = {
      ...member,
      id: 'm2',
      name: 'Vũ Thị Tú Anh',
      birthDate: '1988-06-15',
      gender: 'female',
    };
    // Clinic placeholder DOB 01/01/YYYY or OCR typo should still match unique Vũ Thị Tú Anh
    expect(findMemberByOcrPatientName('Vũ Thị Tú Anh', [member, tuAnh], '1988-01-01', 'Nữ').matched?.id).toBe('m2');
    // Profile with default 'male' or OCR gender misread should still match unique Vũ Thị Tú Anh
    expect(findMemberByOcrPatientName('Vũ Thị Tú Anh', [{ ...tuAnh, gender: 'male' }], '15/06/1988', 'Nữ').matched?.id).toBe('m2');
    expect(findMemberByOcrPatientName('Vũ Thị Tú Anh', [member, tuAnh], '1989-06-15', 'Nam').matched?.id).toBe('m2');

    // When two family members share the exact same name, DOB & gender must still disambiguate/reject ambiguity
    const olderMai: FamilyMember = { ...member, id: 'mai-1', birthDate: '1980-12-30', gender: 'female' };
    const youngerMai: FamilyMember = { ...member, id: 'mai-2', birthDate: '1995-04-10', gender: 'female' };
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [olderMai, youngerMai], '1980-12-30', 'Nữ').matched?.id).toBe('mai-1');
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [olderMai, youngerMai], '1980-01-01', 'Nữ').matched?.id).toBe('mai-1');
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [olderMai, youngerMai], '1981-12-30', 'Nữ').matched).toBeUndefined();
    expect(findMemberByOcrPatientName('Nguyen Thi Mai', [olderMai, { ...youngerMai, birthDate: '1980-12-30', gender: 'male' }], '30/12/1980', 'Nữ').matched?.id).toBe('mai-1');
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

  it('detects probable duplicate members when names are reordered and birth dates match', () => {
    const quangMinh: FamilyMember = {
      ...member,
      id: 'm-minh',
      name: 'Trương Quang Minh',
      email: 'minhtq411@gmail.com',
      birthDate: '2007-11-04',
      gender: 'male',
    };
    const khanhChi: FamilyMember = {
      ...member,
      id: 'm-chi',
      name: 'Trương Khánh Chi',
      birthDate: '2012-04-30',
      gender: 'female',
    };

    const result = findMemberByOcrPatientName(
      'Minh Truong',
      [quangMinh, khanhChi],
      '2007-11-04',
      'other',
    );

    // Automatically matches because names are reordered ("Minh Truong" vs "Trương Quang Minh") and birth dates match
    expect(result.matched?.id).toBe('m-minh');
    expect(result.probableMatches).toHaveLength(0);
  });

  it('detects duplicate family member pairs in workspace and prioritizes richer profile as primary', () => {
    const quangMinh: FamilyMember = {
      ...member,
      id: 'minh-1',
      name: 'Trương Quang Minh',
      email: 'minhtq411@gmail.com',
      birthDate: '2007-11-04',
      gender: 'male',
    };
    const minhTruong: FamilyMember = {
      ...member,
      id: 'minh-2',
      name: 'Minh Truong',
      birthDate: '2007-11-04',
      gender: 'other',
    };
    const khanhChi: FamilyMember = {
      ...member,
      id: 'chi-1',
      name: 'Trương Khánh Chi',
      birthDate: '2012-04-30',
      gender: 'female',
    };

    const mockProfiles = {
      'minh-1': {
        schemaVersion: 2,
        member: quangMinh,
        timeline: [
          { ...event, id: 'ev-1' },
          { ...event, id: 'ev-2' },
        ],
        sources: [],
        summary: { latestDiagnoses: [], latestMetrics: {} },
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
      },
      'minh-2': {
        schemaVersion: 2,
        member: minhTruong,
        timeline: [],
        sources: [],
        summary: { latestDiagnoses: [], latestMetrics: {} },
        createdAt: '2026-11-02T00:00:00Z',
        updatedAt: '2026-11-02T00:00:00Z',
      },
      'chi-1': {
        schemaVersion: 2,
        member: khanhChi,
        timeline: [{ ...event, id: 'ev-chi' }],
        sources: [],
        summary: { latestDiagnoses: [], latestMetrics: {} },
        createdAt: '2026-11-01T00:00:00Z',
        updatedAt: '2026-11-01T00:00:00Z',
      },
    };

    const pairs = findDuplicateFamilyMemberPairs([quangMinh, khanhChi, minhTruong], mockProfiles as any);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].primary.id).toBe('minh-1'); // Has email, diacritics, more timeline events
    expect(pairs[0].duplicate.id).toBe('minh-2');
    expect(pairs[0].reason).toContain('Cùng ngày sinh 04/11/2007');
  });

  it('does not flag family members with distinct given names sharing the same birthdate or surname', () => {
    const twinsA: FamilyMember = {
      ...member,
      id: 'twin-1',
      name: 'Trương Minh Anh',
      birthDate: '2015-05-20',
      gender: 'female',
    };
    const twinsB: FamilyMember = {
      ...member,
      id: 'twin-2',
      name: 'Trương Minh Khang',
      birthDate: '2015-05-20',
      gender: 'male',
    };
    const pairs = findDuplicateFamilyMemberPairs([twinsA, twinsB], {});
    expect(pairs).toHaveLength(0);
  });
});


