import { describe, expect, it } from 'vitest';
import {
  createMedicalSearchQuery,
  filterMedicalAssistantCitations,
  findReferencedFamilyMembers,
  isPersonalHealthHistoryQuery,
  normalizeHealthAssistantHistory,
} from './healthAssistantContext';

describe('health assistant context', () => {
  const familyMembers = [
    { id: 'm1', name: 'Trương Anh Tuấn' },
    { id: 'm2', name: 'Vũ Thị Tú Anh' },
    { id: 'm3', name: 'Nguyễn Văn Bình' },
    { id: 'm4', name: 'Trương Minh An' },
  ];

  it('keeps only the latest ten valid conversation messages', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message ${index}`,
    }));

    expect(normalizeHealthAssistantHistory([...history, { role: 'system', text: 'ignore' }])).toEqual(
      history.slice(-10),
    );
  });

  it('resolves partial and accent-insensitive Vietnamese member names for cross-member queries', () => {
    expect(
      findReferencedFamilyMembers('Huyết áp của Tú Anh là bao nhiêu ', familyMembers).map((m) => m.id),
    ).toEqual(['m2']);
    expect(
      findReferencedFamilyMembers('huyet ap cua tu anh the nao', familyMembers).map((m) => m.id),
    ).toEqual(['m2']);
    expect(
      findReferencedFamilyMembers('Đơn thuốc của Vũ Thị Tú Anh gồm những gì?', familyMembers).map((m) => m.id),
    ).toEqual(['m2']);
    expect(
      findReferencedFamilyMembers('Huyết áp của Tuấn và Tú Anh là bao nhiêu?', familyMembers).map((m) => m.id),
    ).toEqual(['m2', 'm1']);
  });

  it('avoids false positives on common Vietnamese words colliding with given names', () => {
    expect(
      findReferencedFamilyMembers('Huyết áp bình thường là bao nhiêu?', familyMembers),
    ).toEqual([]);
    expect(
      findReferencedFamilyMembers('Ăn uống thế nào để giảm mỡ máu?', familyMembers),
    ).toEqual([]);
    expect(
      findReferencedFamilyMembers('Chỉ số của An gần đây thế nào?', familyMembers).map((m) => m.id),
    ).toEqual(['m4']);
  });

  it('carries over referenced member in follow-up turns unless self-referenced', () => {
    const history = [
      { role: 'user' as const, text: 'Huyết áp của Tú Anh là bao nhiêu?' },
      { role: 'assistant' as const, text: 'Huyết áp gần nhất của Vũ Thị Tú Anh là 115/75 mmHg.' },
    ];
    expect(
      findReferencedFamilyMembers('Vậy còn đường huyết thì sao?', familyMembers, history).map((m) => m.id),
    ).toEqual(['m2']);
    expect(
      findReferencedFamilyMembers('Huyết áp của tôi thì sao?', familyMembers, history),
    ).toEqual([]);
  });

  it('recognizes cross-member measurement queries as personal queries and strips all member names from search queries', () => {
    expect(
      isPersonalHealthHistoryQuery('Huyết áp của Tú Anh là bao nhiêu ', ['Trương Anh Tuấn', 'Vũ Thị Tú Anh']),
    ).toBe(true);
    expect(
      isPersonalHealthHistoryQuery('Nhóm máu của Tú Anh là gì?', ['Trương Anh Tuấn', 'Vũ Thị Tú Anh']),
    ).toBe(true);
    expect(
      createMedicalSearchQuery('Huyết áp của Tú Anh là bao nhiêu ', 'Trương Anh Tuấn', ['Vũ Thị Tú Anh']),
    ).toBe('');

    const medicalQuery = createMedicalSearchQuery(
      'Vũ Thị Tú Anh bị tăng huyết áp nên ăn gì?',
      'Trương Anh Tuấn',
      ['Vũ Thị Tú Anh'],
    );
    expect(medicalQuery).not.toContain('Tú Anh');
    expect(medicalQuery).not.toContain('Vũ Thị Tú Anh');
    expect(medicalQuery).toContain('tăng huyết áp');
  });

  it('removes member identifiers and numeric details from public search queries', () => {
    const query = createMedicalSearchQuery(
      'Email lan@example.com: Nguyễn An có huyết áp 150/90 và cần biết cách xử trí.',
      'Nguyễn An',
    );

    expect(query).not.toContain('Nguyễn An');
    expect(query).not.toContain('lan@example.com');
    expect(query).not.toMatch(/\d/);
    expect(query).toContain('huyết áp');
  });

  it('rejects a grounded answer if any cited source is outside the medical allowlist', () => {
    const result = filterMedicalAssistantCitations([
      { web: { title: 'WHO guidance', uri: 'https://www.who.int/health-topics/example' } },
      { web: { title: 'Unverified advice', uri: 'https://example.com/health' } },
    ]);

    expect(result).toEqual({ citations: [], trusted: false });
  });

  it('accepts and deduplicates citations from approved medical sources', () => {
    const result = filterMedicalAssistantCitations([
      { web: { title: 'WHO guidance', uri: 'https://www.who.int/health-topics/example' } },
      { web: { title: 'Duplicate', uri: 'https://www.who.int/health-topics/example' } },
      { web: { title: 'CDC guidance', uri: 'https://www.cdc.gov/example' } },
    ]);

    expect(result.trusted).toBe(true);
    expect(result.citations).toHaveLength(2);
  });
});
