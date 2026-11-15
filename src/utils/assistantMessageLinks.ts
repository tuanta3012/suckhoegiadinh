export type AssistantMessagePart =
  | { type: 'text'; text: string }
  | { type: 'url'; text: string; href: string }
  | { type: 'phone'; text: string; href: string };

const LINK_OR_PHONE_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"']+|(?:112|113|114|115|911|999)(?!\d)|\+?[\d][\d(). -]{6,}\d/giu;
const TRAILING_URL_PUNCTUATION = /[.,;:!?)}\]]+$/;
const DATE_PATTERN = /^\d{4}-\d{1,2}-\d{1,2}$/;

export function parseAssistantMessageLinks(text: string): AssistantMessagePart[] {
  const parts: AssistantMessagePart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(LINK_OR_PHONE_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    if (start === undefined) continue;

    const isUrl = /^(?:https?:\/\/|www\.)/i.test(raw);
    if (isUrl) {
      const urlText = raw.replace(TRAILING_URL_PUNCTUATION, '');
      const trailingText = raw.slice(urlText.length);
      if (urlText.length === 0) continue;
      const href = urlText.startsWith('www.') ? `https://${urlText}` : urlText;
      try {
        const parsedUrl = new URL(href);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;
      } catch {
        continue;
      }

      if (start > cursor) parts.push({ type: 'text', text: text.slice(cursor, start) });
      parts.push({ type: 'url', text: urlText, href });
      if (trailingText) parts.push({ type: 'text', text: trailingText });
      cursor = start + raw.length;
      continue;
    }

    const previousCharacter = text[start - 1] || '';
    const nextCharacter = text[start + raw.length] || '';
    const digits = raw.replace(/\D/g, '');
    const isEmergencyNumber = /^(?:112|113|114|115|911|999)$/.test(digits);
    if (
      /[\p{L}\d]/u.test(previousCharacter) ||
      /[\p{L}\d]/u.test(nextCharacter) ||
      (!isEmergencyNumber && digits.length < 8) ||
      digits.length > 15 ||
      DATE_PATTERN.test(raw.trim())
    ) {
      continue;
    }

    if (start > cursor) parts.push({ type: 'text', text: text.slice(cursor, start) });
    const internationalPrefix = raw.trimStart().startsWith('+') ? '+' : '';
    parts.push({ type: 'phone', text: raw, href: `tel:${internationalPrefix}${digits}` });
    cursor = start + raw.length;
  }

  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}
