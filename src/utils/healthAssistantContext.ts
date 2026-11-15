import { normalizeVietnamese } from './formatters';

export interface HealthAssistantHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface HealthAssistantCitation {
  title: string;
  url: string;
}

const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_LENGTH = 1_200;
const MAX_REFERENCED_MEMBERS = 4;
const MEDICAL_SOURCE_DOMAINS = [
  'who.int',
  'moh.gov.vn',
  'cdc.gov',
  'nhs.uk',
  'medlineplus.gov',
  'pubmed.ncbi.nlm.nih.gov',
  'ncbi.nlm.nih.gov',
  'fda.gov',
  'ema.europa.eu',
  'cancer.gov',
  'mayoclinic.org',
  'clevelandclinic.org',
  'heart.org',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSelfReferenceQuery(normalizedQuestion: string): boolean {
  return /\b(?:cua toi|cua minh|ban than|ho so toi|ho so minh|toi dang|toi bi|toi co|toi uong|toi kham|minh dang|minh bi|minh co)\b/.test(
    normalizedQuestion,
  );
}

function hasSingleTokenPersonContext(
  originalText: string,
  normalizedText: string,
  normalizedToken: string,
  originalLastWord: string,
): boolean {
  if (!normalizedToken || normalizedToken.length < 2) return false;
  const escapedToken = escapeRegExp(normalizedToken);
  const haystack = ` ${normalizedText} `;
  if (!haystack.includes(` ${normalizedToken} `)) return false;

  // Exclude obvious common Vietnamese phrases that collide with given names (e.g., "binh thuong", "an uong", "ăn")
  if (
    normalizedToken === 'binh' &&
    /(?:^|\s)binh\s+thuong(?:\s|$)/i.test(normalizedText) &&
    !new RegExp(`(?:^|\\s)(?:cua|cho|ho so|suc khoe|ket qua)\\s+${escapedToken}(?:\\s|$)`, 'i').test(normalizedText)
  ) {
    return false;
  }
  if (
    normalizedToken === 'an' &&
    (/(?<!\p{L})ăn(?!\p{L})/iu.test(originalText) || /(?:^|\s)an\s+uong(?:\s|$)/i.test(normalizedText)) &&
    !new RegExp(`(?:^|\\s)(?:cua|cho|ho so|suc khoe|ket qua)\\s+${escapedToken}(?:\\s|$)`, 'i').test(normalizedText)
  ) {
    return false;
  }

  // If the member's original last word has no 'ă'/'â', reject when the matched word in originalText uses 'ă'/'â' (e.g. "ăn" != "An")
  if (!/[ăâ]/i.test(originalLastWord)) {
    const wordsInOriginal = originalText.trim().split(/[^\p{L}\p{M}0-9]+/u).filter(Boolean);
    const matchingOriginalWords = wordsInOriginal.filter(
      (word) => normalizeVietnamese(word) === normalizedToken,
    );
    if (
      matchingOriginalWords.length > 0 &&
      matchingOriginalWords.every((word) => /[ăâ]/i.test(word))
    ) {
      return false;
    }
  }

  const precededPattern = new RegExp(
    `(?:^|\\s)(?:cua|cho|ve|ho so(?: cua)?|ket qua(?: cua)?|suc khoe(?: cua)?|benh an(?: cua)?|don thuoc(?: cua)?|chi so(?: cua)?|huyet ap(?: cua)?|duong huyet(?: cua)?|bo|me|vo|chong|con|anh|chi|em|ong|ba|co|chu|bac|be|chau)\\s+${escapedToken}(?:\\s|$)`,
    'i',
  );
  if (precededPattern.test(normalizedText)) return true;

  const followedPattern = new RegExp(
    `(?:^|\\s)${escapedToken}\\s+(?:co|bi|dang|da|vua|se|uong|kham|xet nghiem|thi sao|the nao|nhu the nao|bao nhieu|la bao nhieu|khong)(?:\\s|$)`,
    'i',
  );
  if (followedPattern.test(normalizedText)) return true;

  // Check mid-sentence capitalized exact token (with or without diacritics)
  const words = originalText.trim().split(/[^\p{L}\p{M}0-9]+/u).filter(Boolean);
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const firstChar = word.charAt(0);
    if (
      firstChar === firstChar.toLocaleUpperCase() &&
      firstChar !== firstChar.toLocaleLowerCase() &&
      (normalizeVietnamese(word) === normalizedToken ||
        word.toLocaleLowerCase() === originalLastWord.toLocaleLowerCase())
    ) {
      return true;
    }
  }

  return false;
}

function matchMemberPhraseInText<T extends { id: string; name: string }>(
  text: string,
  member: T,
): { score: number; matchedNormalizedPhrase?: string } {
  const normalizedText = normalizeVietnamese(text);
  if (!normalizedText) return { score: 0 };
  const haystack = ` ${normalizedText} `;

  const rawName = (member.name || '').trim();
  const normalizedFull = normalizeVietnamese(rawName);
  if (!normalizedFull) return { score: 0 };

  const tokens = normalizedFull.split(' ').filter(Boolean);
  const originalTokens = rawName.split(/\s+/).filter(Boolean);
  const originalLastWord = originalTokens[originalTokens.length - 1] || '';

  if (haystack.includes(` ${normalizedFull} `)) {
    return { score: 100 + tokens.length * 5, matchedNormalizedPhrase: normalizedFull };
  }

  // Trailing multi-word given names (e.g. "Vũ Thị Tú Anh" -> "Thị Tú Anh", "Tú Anh")
  for (let len = tokens.length - 1; len >= 2; len--) {
    const suffix = tokens.slice(-len).join(' ');
    if (suffix.length >= 3 && haystack.includes(` ${suffix} `)) {
      return { score: 70 + len * 5, matchedNormalizedPhrase: suffix };
    }
  }

  // First + last name (e.g. "Vũ Anh" for "Vũ Thị Tú Anh")
  if (tokens.length >= 3) {
    const firstAndLast = `${tokens[0]} ${tokens[tokens.length - 1]}`;
    if (haystack.includes(` ${firstAndLast} `)) {
      return { score: 65, matchedNormalizedPhrase: firstAndLast };
    }
  }

  // Single given name (last token) with person-reference disambiguation
  const lastToken = tokens[tokens.length - 1];
  if (
    lastToken &&
    hasSingleTokenPersonContext(text, normalizedText, lastToken, originalLastWord)
  ) {
    return { score: 45, matchedNormalizedPhrase: lastToken };
  }

  return { score: 0 };
}

function stripNormalizedPhraseFromText(text: string, normalizedPhrase: string): string {
  const phraseTokens = normalizedPhrase.split(' ').filter(Boolean);
  if (phraseTokens.length === 0) return text;
  const words = text.split(/\s+/).filter(Boolean);
  const normWords = words.map((w) => normalizeVietnamese(w));
  const kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    let matches = true;
    if (i + phraseTokens.length <= words.length) {
      for (let j = 0; j < phraseTokens.length; j++) {
        if (normWords[i + j] !== phraseTokens[j]) {
          matches = false;
          break;
        }
      }
    } else {
      matches = false;
    }
    if (matches) {
      i += phraseTokens.length - 1;
    } else {
      kept.push(words[i]);
    }
  }
  return kept.join(' ');
}

export function findReferencedFamilyMembers<T extends { id: string; name: string }>(
  question: string,
  members: readonly T[],
  history: HealthAssistantHistoryMessage[] = [],
): T[] {
  if (!Array.isArray(members) || members.length === 0 || !question?.trim()) {
    return [];
  }

  const scoreAndSort = (text: string): T[] => {
    const initial = members.map((member) => ({
      member,
      ...matchMemberPhraseInText(text, member),
    }));
    const multiWordMatches = initial
      .filter((entry) => entry.score >= 65)
      .sort((a, b) => b.score - a.score);

    let remainingText = text;
    for (const match of multiWordMatches) {
      if (match.matchedNormalizedPhrase) {
        remainingText = stripNormalizedPhraseFromText(remainingText, match.matchedNormalizedPhrase);
      }
    }

    const matchedIds = new Set(multiWordMatches.map((entry) => entry.member.id));
    const singleTokenMatches = members
      .filter((member) => !matchedIds.has(member.id))
      .map((member) => ({ member, ...matchMemberPhraseInText(remainingText, member) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    return [...multiWordMatches, ...singleTokenMatches]
      .slice(0, MAX_REFERENCED_MEMBERS)
      .map((entry) => entry.member);
  };

  const directMatches = scoreAndSort(question);
  if (directMatches.length > 0) {
    return directMatches;
  }

  const normalizedQuestion = normalizeVietnamese(question);
  if (isSelfReferenceQuery(normalizedQuestion)) {
    return [];
  }

  // Follow-up carry-over from the most recent user/assistant turn that named a member
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (!msg?.text) continue;
    const historyMatches = scoreAndSort(msg.text);
    if (historyMatches.length > 0) {
      return historyMatches;
    }
  }

  return [];
}

function buildNameAliasesToStrip(memberNames: string[]): string[] {
  const aliases = new Set<string>();
  for (const rawName of memberNames) {
    const trimmed = rawName?.trim();
    if (!trimmed) continue;
    aliases.add(trimmed);
    const normalized = normalizeVietnamese(trimmed);
    if (normalized) {
      aliases.add(normalized);
      const tokens = normalized.split(' ').filter(Boolean);
      for (let len = tokens.length - 1; len >= 2; len--) {
        aliases.add(tokens.slice(-len).join(' '));
      }
      if (tokens.length >= 1 && tokens[tokens.length - 1].length >= 2) {
        aliases.add(tokens[tokens.length - 1]);
      }
    }
    const rawTokens = trimmed.split(/\s+/).filter(Boolean);
    for (let len = rawTokens.length - 1; len >= 2; len--) {
      aliases.add(rawTokens.slice(-len).join(' '));
    }
    if (rawTokens.length >= 1 && rawTokens[rawTokens.length - 1].length >= 2) {
      aliases.add(rawTokens[rawTokens.length - 1]);
    }
  }
  return Array.from(aliases).sort((a, b) => b.length - a.length);
}

export function normalizeHealthAssistantHistory(value: unknown): HealthAssistantHistoryMessage[] {
  if (!Array.isArray(value)) return [];

  return value
    .flatMap((item): HealthAssistantHistoryMessage[] => {
      if (!isRecord(item) || (item.role !== 'user' && item.role !== 'assistant')) return [];
      if (typeof item.text !== 'string' || !item.text.trim()) return [];
      return [{
        role: item.role,
        text: item.text.trim().slice(0, MAX_HISTORY_MESSAGE_LENGTH),
      }];
    })
    .slice(-MAX_HISTORY_MESSAGES);
}

export function isPersonalHealthHistoryQuery(
  question: string,
  extraMemberNames: string[] = [],
): boolean {
  if (!question || !question.trim()) return false;
  const normalized = normalizeVietnamese(question);
  if (!normalized) return false;

  const timelinePatterns = [
    /lan gan nhat/,
    /moi nhat/,
    /gan day nhat/,
    /vua roi/,
    /truoc day/,
    /lan truoc/,
    /khi nao/,
    /ngay nao/,
    /hom nao/,
    /o dau/,
    /vien nao/,
    /phong kham nao/,
    /bac si nao/,
    /khoa nao/,
    /may lan/,
    /bao nhieu lan/,
    /lich su/,
    /tien su/,
    /ho so/,
    /don thuoc/,
    /uong thuoc gi/,
    /thuoc dang uong/,
    /thuoc da ke/,
    /ket qua xet nghiem/,
    /chi so/,
    /bac si dan/,
    /dan do/,
    /chuan doan/,
    /chan doan/,
    /kham o dau/,
    /kham khi nao/,
    /kham ngay/,
    /lan kham/,
    /dot kham/,
    /ket qua kham/,
    /so kham/,
    /benh an/,
    /tai kham/,
    /tiem chung/,
    /sieu am/,
    /cua toi/,
    /cua minh/,
    /toi dang/,
    /toi bi/,
    /toi co/,
    /co ket qua gi/,
    /co benh gi/,
    /bi benh gi/,
  ];

  if (timelinePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // Questions asking general medical guidance/treatment/diet should still allow medical search
  const generalMedicalAdvicePatterns = [
    /nen an/,
    /kieng/,
    /xu tri/,
    /luu y gi/,
    /dieu tri/,
    /phong ngua/,
    /nguyen nhan/,
    /trieu chung/,
    /la gi/,
  ];
  if (generalMedicalAdvicePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const pseudoMembers = extraMemberNames
    .map((name, index) => ({ id: String(index), name }))
    .filter((entry) => entry.name.trim().length > 0);
  const mentionsFamilyMember = pseudoMembers.some(
    (entry) => matchMemberPhraseInText(question, entry).score > 0,
  );
  if (!mentionsFamilyMember) {
    return false;
  }

  // When a specific family member is named AND the question asks about their measurements,
  // status, results, medications, or visits, treat it as a personal health record query.
  const personalMeasurementOrRecordPatterns = [
    /bao nhieu/,
    /huyet ap/,
    /duong huyet/,
    /nhip tim/,
    /can nang/,
    /chieu cao/,
    /\bbmi\b/,
    /mo mau/,
    /cholesterol/,
    /triglycerid/,
    /men gan/,
    /acid uric/,
    /tuyen giap/,
    /xet nghiem/,
    /ket qua/,
    /thuoc/,
    /kham/,
    /suc khoe/,
    /the nao/,
    /ra sao/,
    /thi sao/,
    /cao khong/,
    /thap khong/,
    /binh thuong khong/,
    /on khong/,
    /hien tai/,
    /gan day/,
  ];

  return personalMeasurementOrRecordPatterns.some((pattern) => pattern.test(normalized));
}

export function createMedicalSearchQuery(
  question: string,
  memberName?: string,
  extraMemberNames: string[] = [],
): string {
  const allMemberNames = [
    ...(memberName?.trim() ? [memberName.trim()] : []),
    ...extraMemberNames.map((n) => n?.trim()).filter((n): n is string => Boolean(n)),
  ];
  if (!question || !question.trim() || isPersonalHealthHistoryQuery(question, allMemberNames)) {
    return '';
  }

  let query = question;
  const aliasesToStrip = buildNameAliasesToStrip(allMemberNames);
  for (const alias of aliasesToStrip) {
    const escaped = escapeRegExp(alias);
    query = query.replace(new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, 'giu'), ' ');
    // Also strip normalized ASCII form if original had accents and query omitted accents
    const normAlias = normalizeVietnamese(alias);
    if (normAlias && normAlias !== alias.toLowerCase()) {
      const escapedNorm = escapeRegExp(normAlias);
      query = query.replace(new RegExp(`(?<!\\p{L})${escapedNorm}(?!\\p{L})`, 'giu'), ' ');
    }
  }

  return query
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\b(?:tôi|mình|em|anh|chị|ông|bà|bố|mẹ|con|của tôi|của mình|bệnh nhân)\b/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\p{M}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export function isApprovedMedicalCitationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase();
    return MEDICAL_SOURCE_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

export function filterMedicalAssistantCitations(chunks: unknown): {
  citations: HealthAssistantCitation[];
  trusted: boolean;
} {
  if (!Array.isArray(chunks)) return { citations: [], trusted: false };

  const webChunks = chunks.flatMap((chunk) => {
    if (!isRecord(chunk) || !isRecord(chunk.web)) return [];
    return [chunk.web];
  });
  if (webChunks.length === 0) return { citations: [], trusted: false };

  const citations: HealthAssistantCitation[] = [];
  let allSourcesApproved = true;

  for (const chunk of webChunks) {
    const url = typeof chunk.uri === 'string' ? chunk.uri : '';
    if (!url || !isApprovedMedicalCitationUrl(url)) {
      allSourcesApproved = false;
      continue;
    }

    if (citations.some((citation) => citation.url === url)) continue;
    citations.push({
      title: typeof chunk.title === 'string' && chunk.title.trim()
        ? chunk.title.trim().slice(0, 200)
        : new URL(url).hostname,
      url,
    });
  }

  const trusted = allSourcesApproved && citations.length > 0;
  return {
    citations: trusted ? citations.slice(0, 6) : [],
    trusted,
  };
}
