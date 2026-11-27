import type { HealthEvent, JsonValue } from '../types';
import { formatDateVN, normalizeVietnamese } from './formatters';
import { getHealthMetricRangeStatus } from './healthMetricService';

export interface TimelineFilterSegment {
  raw: string;
  normalized: string;
}

export interface TimelineFilterCorpus {
  segments: TimelineFilterSegment[];
  hasAbnormalMetric: boolean;
  hasFollowUp: boolean;
}

export interface TimelineFilterOptions {
  typeFilter?: string;
  keyword?: string;
  memberGender?: string;
  typeLabelMap?: Record<string, string>;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pushSegment(segments: TimelineFilterSegment[], ...values: Array<string | number | null | undefined>): void {
  const joined = values
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .filter(Boolean)
    .join(' ');
  if (!joined) return;
  const raw = joined.toLowerCase();
  const normalized = normalizeVietnamese(joined);
  segments.push({ raw, normalized });
}

function flattenJsonValues(value: JsonValue | undefined, segments: TimelineFilterSegment[], keyPrefixes: string[] = []): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const str = String(value).trim();
    if (!str) return;
    if (keyPrefixes.length > 0) {
      for (const prefix of keyPrefixes) {
        pushSegment(segments, prefix, str);
      }
    } else {
      pushSegment(segments, str);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenJsonValues(item, segments, keyPrefixes);
    }
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    const cleanedKey = key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .trim();
    const nextPrefixes = Array.from(new Set([cleanedKey, key.trim()].filter(Boolean)));
    flattenJsonValues(val, segments, nextPrefixes);
  }
}

export function buildTimelineEventSearchCorpus(
  event: HealthEvent,
  options?: { memberGender?: string; typeLabel?: string },
): TimelineFilterCorpus {
  const segments: TimelineFilterSegment[] = [];

  if (event.title) pushSegment(segments, event.title);
  if (options?.typeLabel) pushSegment(segments, options.typeLabel);
  if (event.customCategory) pushSegment(segments, event.customCategory);
  if (event.date) {
    pushSegment(segments, event.date, formatDateVN(event.date));
  }
  if (event.facility) pushSegment(segments, event.facility);
  if (event.doctorName) pushSegment(segments, event.doctorName);

  if (Array.isArray(event.diagnoses)) {
    for (const diag of event.diagnoses) {
      if (diag) pushSegment(segments, diag);
    }
  }

  if (Array.isArray(event.medications)) {
    for (const med of event.medications) {
      if (!med) continue;
      pushSegment(
        segments,
        med.name,
        med.dosage,
        med.quantity,
        med.frequency,
        med.timing,
        med.duration,
        med.instructions,
      );
    }
    if (event.medications.length > 0) {
      pushSegment(segments, 'don thuoc');
    }
  }

  let hasAbnormalMetric = false;
  let hasHighMetric = false;
  let hasLowMetric = false;
  let hasCriticalMetric = false;
  if (Array.isArray(event.metrics)) {
    const memberGender =
      options?.memberGender === 'male' ||
      options?.memberGender === 'female' ||
      options?.memberGender === 'other'
        ? options.memberGender
        : undefined;

    for (const metric of event.metrics) {
      if (!metric) continue;
      pushSegment(
        segments,
        metric.name,
        metric.value,
        metric.unit,
        metric.refRange,
        metric.standardKey ? metric.standardKey.replace(/[_-]+/g, ' ') : undefined,
      );

      const rangeStatus = getHealthMetricRangeStatus(metric, memberGender);
      if (
        rangeStatus === 'warning_high' ||
        rangeStatus === 'warning_low' ||
        rangeStatus === 'critical_high' ||
        rangeStatus === 'critical_low'
      ) {
        hasAbnormalMetric = true;
        if (rangeStatus === 'warning_high' || rangeStatus === 'critical_high') {
          hasHighMetric = true;
        } else {
          hasLowMetric = true;
        }
        if (rangeStatus === 'critical_high' || rangeStatus === 'critical_low') {
          hasCriticalMetric = true;
        }
      }
    }
  }

  if (hasAbnormalMetric) {
    pushSegment(segments, 'bat thuong');
    pushSegment(segments, 'canh bao');
    pushSegment(segments, 'vuot nguong');
  }
  if (hasHighMetric) {
    pushSegment(segments, 'chi so cao');
  }
  if (hasLowMetric) {
    pushSegment(segments, 'chi so thap');
  }
  if (hasCriticalMetric) {
    pushSegment(segments, 'nghiem trong');
    pushSegment(segments, 'nguy hiem');
  }

  if (Array.isArray(event.imagingResults)) {
    for (const img of event.imagingResults) {
      if (!img) continue;
      pushSegment(segments, img.modality, img.findings, img.conclusion);
    }
  }

  let hasVaccinationNextDose = false;
  if (Array.isArray(event.vaccinations)) {
    for (const vac of event.vaccinations) {
      if (!vac) continue;
      if (vac.nextDoseDate) hasVaccinationNextDose = true;
      pushSegment(
        segments,
        vac.vaccineName,
        vac.targetDisease,
        vac.manufacturer,
        vac.lotNumber,
        vac.injectionSite,
        vac.reactionNotes,
        vac.nextDoseDate,
        vac.nextDoseDate ? formatDateVN(vac.nextDoseDate) : undefined,
      );
    }
    if (event.vaccinations.length > 0) {
      pushSegment(segments, 'tiem chung', 'vaccine');
    }
  }

  if (event.hospitalization) {
    const h = event.hospitalization;
    pushSegment(
      segments,
      h.department,
      h.treatmentSummary,
      h.surgicalNotes,
      h.admissionDate,
      h.admissionDate ? formatDateVN(h.admissionDate) : undefined,
      h.dischargeDate,
      h.dischargeDate ? formatDateVN(h.dischargeDate) : undefined,
    );
  }

  if (event.physicalExam) {
    const p = event.physicalExam;
    if (p.bp_mmHg) pushSegment(segments, 'huyet ap', p.bp_mmHg);
    if (p.bmi !== undefined) pushSegment(segments, 'bmi', p.bmi);
    if (p.height_cm !== undefined) pushSegment(segments, 'chieu cao', p.height_cm);
    if (p.weight_kg !== undefined) pushSegment(segments, 'can nang', p.weight_kg);
    if (p.pulse_bpm !== undefined) pushSegment(segments, 'mach nhip tim', p.pulse_bpm);
    if (p.classification) pushSegment(segments, p.classification);
  }

  if (event.extractedData) {
    flattenJsonValues(event.extractedData, segments);
  }

  if (event.advice) pushSegment(segments, event.advice);
  if (event.nextFollowUp) {
    pushSegment(segments, event.nextFollowUp, formatDateVN(event.nextFollowUp));
    pushSegment(segments, 'tai kham');
    pushSegment(segments, 'lich hen');
  } else if (hasVaccinationNextDose) {
    pushSegment(segments, 'tai kham');
    pushSegment(segments, 'lich hen');
  }
  if (event.notes) pushSegment(segments, event.notes);
  if (event.sourceFileName) pushSegment(segments, event.sourceFileName);
  if (Array.isArray(event.additionalSources)) {
    for (const src of event.additionalSources) {
      if (src?.fileName) pushSegment(segments, src.fileName);
    }
  }

  return {
    segments,
    hasAbnormalMetric,
    hasFollowUp: Boolean(event.nextFollowUp || hasVaccinationNextDose),
  };
}

function segmentMatchesRawToken(segment: TimelineFilterSegment, rawToken: string): boolean {
  const candidates = [rawToken];
  if (/^\d+[,.]\d+$/.test(rawToken)) {
    candidates.push(rawToken.includes(',') ? rawToken.replace(/,/g, '.') : rawToken.replace(/\./g, ','));
  }

  return candidates.some((candidate) => {
    const escaped = escapeRegExp(candidate);
    const pattern = new RegExp(`(?:^|[^a-z0-9àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ])${escaped}(?=$|[^a-z0-9àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ])`);
    return pattern.test(segment.raw);
  });
}

function segmentMatchesSingleToken(segment: TimelineFilterSegment, rawToken: string): boolean {
  if (/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/.test(rawToken)) {
    if (segmentMatchesRawToken(segment, rawToken)) return true;
  }

  const normToken = normalizeVietnamese(rawToken);
  if (!normToken) return false;

  const escaped = escapeRegExp(normToken);
  const regex =
    normToken.length <= 3
      ? new RegExp(`(?:^|\\s)${escaped}(?=$|\\s)`)
      : new RegExp(`(?:^|\\s)${escaped}`);
  return regex.test(segment.normalized);
}

function segmentMatchesContiguousPhrase(segment: TimelineFilterSegment, rawTokens: string[]): boolean {
  if (rawTokens.length === 1) {
    return segmentMatchesSingleToken(segment, rawTokens[0]);
  }

  const rawJoined = rawTokens.join(' ');
  if (/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s]/.test(rawJoined)) {
    const escapedRaw = escapeRegExp(rawJoined);
    const rawRegex = new RegExp(`(?:^|[^a-z0-9])${escapedRaw}(?=$|[^a-z0-9])`);
    if (rawRegex.test(segment.raw)) return true;
  }

  const normTokens = rawTokens.map((t) => normalizeVietnamese(t)).filter(Boolean);
  if (normTokens.length === 0) return false;
  if (normTokens.length === 1) {
    return segmentMatchesSingleToken(segment, rawTokens[0]);
  }

  const normPhrase = normTokens.map(escapeRegExp).join('\\s+');
  const lastToken = normTokens[normTokens.length - 1];
  const phraseRegex =
    lastToken.length <= 3
      ? new RegExp(`(?:^|\\s)${normPhrase}(?=$|\\s)`)
      : new RegExp(`(?:^|\\s)${normPhrase}`);

  return phraseRegex.test(segment.normalized);
}

function isStandaloneMultiWordToken(rawToken: string): boolean {
  if (/\d/.test(rawToken)) return true;
  const norm = normalizeVietnamese(rawToken);
  return norm.length >= 5;
}

function corpusMatchesClause(corpus: TimelineFilterCorpus, clause: string): boolean {
  const rawTokens = clause.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) return true;

  const { segments } = corpus;
  if (segments.length === 0) return false;

  if (rawTokens.length === 1) {
    return segments.some((seg) => segmentMatchesSingleToken(seg, rawTokens[0]));
  }

  // Fast path: full contiguous phrase matches inside at least one field segment.
  if (segments.some((seg) => segmentMatchesContiguousPhrase(seg, rawTokens))) {
    return true;
  }

  // For multi-word queries without explicit delimiters (e.g. "acid uric 2026" or "tuyen giap bach mai"),
  // require every token to be covered either by a >=2-word contiguous phrase in the event
  // or by a distinct standalone token (numeric/date/code or >=5-char term).
  // This ensures 2-word Vietnamese names/terms like "tam anh" NEVER match scattered unrelated words
  // such as "tâm trương" + "hình ảnh".
  const n = rawTokens.length;
  const canCoverFrom = new Array<boolean>(n + 1).fill(false);
  canCoverFrom[n] = true;

  for (let i = n - 1; i >= 0; i--) {
    if (canCoverFrom[i + 1] && isStandaloneMultiWordToken(rawTokens[i])) {
      if (segments.some((seg) => segmentMatchesSingleToken(seg, rawTokens[i]))) {
        canCoverFrom[i] = true;
        continue;
      }
    }

    for (let j = i + 2; j <= n; j++) {
      if (!canCoverFrom[j]) continue;
      const slice = rawTokens.slice(i, j);
      if (segments.some((seg) => segmentMatchesContiguousPhrase(seg, slice))) {
        canCoverFrom[i] = true;
        break;
      }
    }
  }

  return canCoverFrom[0];
}

export function matchesTimelineKeyword(
  event: HealthEvent,
  keyword: string,
  options?: { memberGender?: string; typeLabel?: string },
): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return true;

  const corpus = buildTimelineEventSearchCorpus(event, options);
  const clauses = trimmed
    .split(/(?<!\d),(?!\d)|[;+&]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (clauses.length === 0) return true;
  return clauses.every((clause) => corpusMatchesClause(corpus, clause));
}

export function filterTimelineEvents(
  events: HealthEvent[],
  options: TimelineFilterOptions,
): { keywordMatched: HealthEvent[]; filtered: HealthEvent[] } {
  const keyword = options.keyword?.trim() || '';
  const typeFilter = options.typeFilter || 'all';

  const keywordMatched = keyword
    ? events.filter((event) =>
        matchesTimelineKeyword(event, keyword, {
          memberGender: options.memberGender,
          typeLabel: options.typeLabelMap?.[event.type],
        }),
      )
    : events;

  const filtered =
    typeFilter === 'all'
      ? keywordMatched
      : keywordMatched.filter((event) => event.type === typeFilter);

  return { keywordMatched, filtered };
}

export function doesMetricMatchTimelineKeyword(
  metric: HealthEvent['metrics'][number],
  keyword: string,
  memberGender?: string,
): boolean {
  const trimmed = keyword.trim();
  if (!trimmed) return false;
  const syntheticEvent: HealthEvent = {
    id: '__metric_check__',
    sourceFileId: '',
    sourceFileName: '',
    type: 'test_result',
    title: '',
    date: '',
    diagnoses: [],
    medications: [],
    metrics: [metric],
    recordedAt: '',
  };
  return matchesTimelineKeyword(syntheticEvent, trimmed, { memberGender });
}

interface IndexedText {
  rawLower: string;
  normChars: string;
  origStarts: number[];
  origEnds: number[];
}

export interface HighlightRange {
  start: number;
  end: number;
}

export interface HighlightSegment {
  text: string;
  highlighted: boolean;
}

function buildIndexedText(text: string): IndexedText {
  let rawLower = '';
  let normChars = '';
  const origStarts: number[] = [];
  const origEnds: number[] = [];

  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? text.charCodeAt(i);
    const charLen = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + charLen);

    if (/^[\u0300-\u036f]+$/.test(ch)) {
      if (origEnds.length > 0) {
        origEnds[origEnds.length - 1] = i + charLen;
      }
      i += charLen;
      continue;
    }

    const lowerCh = ch.toLowerCase();
    const base = lowerCh
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd');
    const normCh = /^[a-z0-9]$/.test(base) ? base : ' ';

    rawLower += lowerCh;
    normChars += normCh;
    origStarts.push(i);
    origEnds.push(i + charLen);
    i += charLen;
  }

  return { rawLower, normChars, origStarts, origEnds };
}

function collectRegexRanges(
  haystack: string,
  regex: RegExp,
  indexed: IndexedText,
  out: HighlightRange[],
): void {
  let match: RegExpExecArray | null;
  while ((match = regex.exec(haystack)) !== null) {
    const captured = match[1];
    if (!captured) break;
    const prefixLen = match[0].length - captured.length;
    const startIdx = match.index + prefixLen;
    const endIdx = startIdx + captured.length - 1;
    if (startIdx >= 0 && endIdx < indexed.origEnds.length && startIdx <= endIdx) {
      out.push({
        start: indexed.origStarts[startIdx],
        end: indexed.origEnds[endIdx],
      });
    }
  }
}

function collectSingleTokenHighlightRanges(
  indexed: IndexedText,
  rawToken: string,
  out: HighlightRange[],
): void {
  if (/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF]/.test(rawToken)) {
    const candidates = [rawToken];
    if (/^\d+[,.]\d+$/.test(rawToken)) {
      candidates.push(rawToken.includes(',') ? rawToken.replace(/,/g, '.') : rawToken.replace(/\./g, ','));
    }
    const boundaryChars = 'a-z0-9àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ';
    for (const candidate of candidates) {
      const escaped = escapeRegExp(candidate);
      const regex = new RegExp(
        `(?:^|[^${boundaryChars}])(${escaped})(?=$|[^${boundaryChars}])`,
        'g',
      );
      collectRegexRanges(indexed.rawLower, regex, indexed, out);
    }
  }

  const normToken = normalizeVietnamese(rawToken);
  if (!normToken) return;

  const escaped = escapeRegExp(normToken);
  const regex =
    normToken.length <= 3
      ? new RegExp(`(?:^|\\s)(${escaped})(?=$|\\s)`, 'g')
      : new RegExp(`(?:^|\\s)(${escaped})`, 'g');
  collectRegexRanges(indexed.normChars, regex, indexed, out);
}

function collectPhraseHighlightRanges(
  indexed: IndexedText,
  rawTokens: string[],
  out: HighlightRange[],
): void {
  if (rawTokens.length === 1) {
    collectSingleTokenHighlightRanges(indexed, rawTokens[0], out);
    return;
  }

  const rawJoined = rawTokens.join(' ');
  if (/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s]/.test(rawJoined)) {
    const escapedRaw = rawTokens.map(escapeRegExp).join('\\s+');
    const rawRegex = new RegExp(`(?:^|[^a-z0-9])(${escapedRaw})(?=$|[^a-z0-9])`, 'g');
    collectRegexRanges(indexed.rawLower, rawRegex, indexed, out);
  }

  const normTokens = rawTokens.map((t) => normalizeVietnamese(t)).filter(Boolean);
  if (normTokens.length === 0) return;
  if (normTokens.length === 1) {
    collectSingleTokenHighlightRanges(indexed, rawTokens[0], out);
    return;
  }

  const normPhrase = normTokens.map(escapeRegExp).join('\\s+');
  const lastToken = normTokens[normTokens.length - 1];
  const regex =
    lastToken.length <= 3
      ? new RegExp(`(?:^|\\s)(${normPhrase})(?=$|\\s)`, 'g')
      : new RegExp(`(?:^|\\s)(${normPhrase})`, 'g');
  collectRegexRanges(indexed.normChars, regex, indexed, out);
}

export function findKeywordHighlightRanges(text: string, keyword: string): HighlightRange[] {
  const trimmed = keyword.trim();
  if (!text || !trimmed) return [];

  const indexed = buildIndexedText(text);
  const rawRanges: HighlightRange[] = [];

  const clauses = trimmed
    .split(/(?<!\d),(?!\d)|[;+&]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const clause of clauses) {
    const rawTokens = clause.toLowerCase().split(/\s+/).filter(Boolean);
    if (rawTokens.length === 0) continue;

    if (rawTokens.length === 1) {
      collectSingleTokenHighlightRanges(indexed, rawTokens[0], rawRanges);
      continue;
    }

    for (let i = 0; i < rawTokens.length; i++) {
      if (isStandaloneMultiWordToken(rawTokens[i])) {
        collectSingleTokenHighlightRanges(indexed, rawTokens[i], rawRanges);
      }
      for (let j = i + 2; j <= rawTokens.length; j++) {
        collectPhraseHighlightRanges(indexed, rawTokens.slice(i, j), rawRanges);
      }
    }
  }

  if (rawRanges.length === 0) return [];

  rawRanges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: HighlightRange[] = [];
  for (const r of rawRanges) {
    if (merged.length === 0 || r.start > merged[merged.length - 1].end) {
      merged.push({ ...r });
    } else if (r.end > merged[merged.length - 1].end) {
      merged[merged.length - 1].end = r.end;
    }
  }

  return merged;
}

export function splitTextWithHighlights(text: string, keyword: string): HighlightSegment[] {
  if (!text) return [];
  const ranges = findKeywordHighlightRanges(text, keyword);
  if (ranges.length === 0) {
    return [{ text, highlighted: false }];
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), highlighted: false });
    }
    if (range.end > range.start) {
      segments.push({ text: text.slice(range.start, range.end), highlighted: true });
    }
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false });
  }
  return segments;
}

