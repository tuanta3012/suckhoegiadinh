import { describe, expect, it } from 'vitest';
import {
  createMedicalSearchQuery,
  filterMedicalAssistantCitations,
  normalizeHealthAssistantHistory,
} from './healthAssistantContext';

describe('health assistant context', () => {
  it('keeps only the latest ten valid conversation messages', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message ${index}`,
    }));

    expect(normalizeHealthAssistantHistory([...history, { role: 'system', text: 'ignore' }])).toEqual(
      history.slice(-10),
    );
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
