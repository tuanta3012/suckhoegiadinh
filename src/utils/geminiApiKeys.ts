export function parseGeminiApiKeys(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];

  const trimmed = raw.trim();
  let candidates: unknown[];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error('GEMINI_API_KEYS must be a JSON array or a delimited string.');
      }
      candidates = parsed;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('GEMINI_API_KEYS contains invalid JSON.', { cause: error });
      }
      throw error;
    }
  } else {
    candidates = trimmed.split(/[,;\n]+/);
  }

  return Array.from(
    new Set(
      candidates
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter((value) => value.length > 10),
    ),
  );
}
