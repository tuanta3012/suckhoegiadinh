import { describe, expect, it } from 'vitest';
import { parseGeminiApiKeys } from './geminiApiKeys';

describe('parseGeminiApiKeys', () => {
  it('parses JSON arrays without retaining JSON quotes', () => {
    expect(parseGeminiApiKeys('["first-valid-api-key","second-valid-api-key"]')).toEqual([
      'first-valid-api-key',
      'second-valid-api-key',
    ]);
  });

  it('parses delimited keys and removes duplicates', () => {
    expect(parseGeminiApiKeys(' first-valid-api-key ; second-valid-api-key\nfirst-valid-api-key ')).toEqual([
      'first-valid-api-key',
      'second-valid-api-key',
    ]);
  });

  it('rejects malformed JSON arrays instead of treating punctuation as part of keys', () => {
    expect(() => parseGeminiApiKeys('["first-valid-api-key",')).toThrow('invalid JSON');
  });

  it('ignores non-string and too-short entries', () => {
    expect(parseGeminiApiKeys('["first-valid-api-key", 4, "short"]')).toEqual([
      'first-valid-api-key',
    ]);
  });
});
