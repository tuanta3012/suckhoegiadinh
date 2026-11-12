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

export function createMedicalSearchQuery(question: string, memberName?: string): string {
  let query = question;
  if (memberName?.trim()) {
    const escapedName = memberName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query = query.replace(new RegExp(escapedName, 'gi'), ' ');
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
