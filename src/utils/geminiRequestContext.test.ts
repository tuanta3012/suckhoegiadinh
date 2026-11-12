import { describe, expect, it } from 'vitest';
import { createGeminiRequestContext } from './geminiRequestContext';

describe('createGeminiRequestContext', () => {
  it('creates a quota pool only from the provided AI resource keys', () => {
    const context = createGeminiRequestContext([
      'workspace-api-key-1',
      'workspace-api-key-2',
      'workspace-api-key-1',
      null,
    ]);

    expect(context.projects.map(({ apiKey }) => apiKey)).toEqual([
      'workspace-api-key-1',
      'workspace-api-key-2',
    ]);
  });

  it('rejects missing or invalid workspace keys', () => {
    expect(() => createGeminiRequestContext(undefined)).toThrow('Tài nguyên AI');
    expect(() => createGeminiRequestContext(['', 'short'])).toThrow('Tài nguyên AI');
  });
});
