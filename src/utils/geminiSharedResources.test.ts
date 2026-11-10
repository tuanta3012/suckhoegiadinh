import { beforeEach, describe, expect, it } from 'vitest';
import {
  getSharedGeminiKeys,
  parseGeminiKeyInput,
  setSharedGeminiKeys,
} from './geminiSharedResources';

describe('shared Gemini resources', () => {
  beforeEach(() => {
    setSharedGeminiKeys([]);
  });

  it('parses comma- and newline-separated keys, trims, and removes duplicates', () => {
    expect(parseGeminiKeyInput(' first-key,\nsecond-key \r\nfirst-key,, ')).toEqual([
      'first-key',
      'second-key',
    ]);
  });

  it('keeps the active key list in memory without exposing the internal array', () => {
    const keys = ['key-one', 'key-two'];
    setSharedGeminiKeys(keys);
    keys.push('external-mutation');

    const loaded = getSharedGeminiKeys();
    expect(loaded).toEqual(['key-one', 'key-two']);
    loaded.push('caller-mutation');
    expect(getSharedGeminiKeys()).toEqual(['key-one', 'key-two']);
  });
});
