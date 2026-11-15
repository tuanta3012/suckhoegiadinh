import { describe, expect, it } from 'vitest';
import { parseAssistantMessageLinks } from './assistantMessageLinks';

describe('parseAssistantMessageLinks', () => {
  it('creates web and telephone links while preserving surrounding text and punctuation', () => {
    expect(parseAssistantMessageLinks(
      'Gọi 115 hoặc 0912 345 678. Tham khảo https://example.org/health.',
    )).toEqual([
      { type: 'text', text: 'Gọi ' },
      { type: 'phone', text: '115', href: 'tel:115' },
      { type: 'text', text: ' hoặc ' },
      { type: 'phone', text: '0912 345 678', href: 'tel:0912345678' },
      { type: 'text', text: '. Tham khảo ' },
      { type: 'url', text: 'https://example.org/health', href: 'https://example.org/health' },
      { type: 'text', text: '.' },
    ]);
  });

  it('does not turn dates or embedded digit strings into phone links', () => {
    expect(parseAssistantMessageLinks('Ngày 2026-11-15, mã BN12345678.')).toEqual([
      { type: 'text', text: 'Ngày 2026-11-15, mã BN12345678.' },
    ]);
  });

  it('links www addresses using HTTPS', () => {
    expect(parseAssistantMessageLinks('Xem www.example.org')).toEqual([
      { type: 'text', text: 'Xem ' },
      { type: 'url', text: 'www.example.org', href: 'https://www.example.org' },
    ]);
  });
});
