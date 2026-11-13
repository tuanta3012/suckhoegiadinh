export type DocumentContainment =
  | 'left_contains_right'
  | 'right_contains_left'
  | 'equivalent'
  | 'overlap'
  | 'unknown';

export interface DocumentContentIndex {
  pages: string[];
  complete: boolean;
}

export interface DocumentContainmentResult {
  relation: DocumentContainment;
  leftCoverage: number;
  rightCoverage: number;
}

const MIN_DOCUMENT_WORDS = 20;
const MIN_PAGE_WORDS = 8;
const MIN_SHINGLE_COUNT = 8;
const DOCUMENT_COVERAGE_THRESHOLD = 0.90;
const EQUIVALENT_COVERAGE_THRESHOLD = 0.92;
const PAGE_COVERAGE_THRESHOLD = 0.80;
const REFLOW_DOCUMENT_COVERAGE_THRESHOLD = 0.92;
const MAX_INDEX_CHARACTERS = 120_000;

export function createDocumentContentIndex(value: unknown): DocumentContentIndex {
  if (!Array.isArray(value) || value.length === 0) return { pages: [], complete: false };

  const pages = value.map((page) => typeof page === 'string' ? page.trim() : '');
  const totalCharacters = pages.reduce((total, page) => total + page.length, 0);
  const complete = pages.every((page) => page.length > 0) && totalCharacters <= MAX_INDEX_CHARACTERS;

  return {
    pages: complete ? pages : [],
    complete,
  };
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function getWords(pages: string[]): string[] {
  return pages.flatMap((page) => normalizeText(page).split(' ').filter(Boolean));
}

function getShingles(words: string[]): Set<string> {
  const shingles = new Set<string>();
  for (let index = 0; index <= words.length - 3; index++) {
    shingles.add(words.slice(index, index + 3).join(' '));
  }
  return shingles;
}

function coverage(candidate: Set<string>, container: Set<string>): number {
  if (candidate.size === 0) return 0;
  let matches = 0;
  for (const shingle of candidate) {
    if (container.has(shingle)) matches++;
  }
  return matches / candidate.size;
}

function isPageCovered(page: string, containerPages: string[]): boolean {
  const words = normalizeText(page).split(' ').filter(Boolean);
  if (words.length < MIN_PAGE_WORDS) return false;
  const pageShingles = getShingles(words);
  if (pageShingles.size < MIN_SHINGLE_COUNT) return false;
  return containerPages.some((containerPage) => {
    const containerWords = normalizeText(containerPage).split(' ').filter(Boolean);
    return coverage(pageShingles, getShingles(containerWords)) >= PAGE_COVERAGE_THRESHOLD;
  });
}

function documentCoverage(candidatePages: string[], containerPages: string[]): number {
  const candidateWords = getWords(candidatePages);
  const containerWords = getWords(containerPages);
  if (candidateWords.length < MIN_DOCUMENT_WORDS || containerWords.length < MIN_DOCUMENT_WORDS) return 0;
  const candidateShingles = getShingles(candidateWords);
  if (candidateShingles.size < MIN_SHINGLE_COUNT) return 0;
  return coverage(candidateShingles, getShingles(containerWords));
}

export function compareDocumentContainment(
  left: DocumentContentIndex,
  right: DocumentContentIndex,
): DocumentContainmentResult {
  if (!left.complete || !right.complete || left.pages.length === 0 || right.pages.length === 0) {
    return { relation: 'unknown', leftCoverage: 0, rightCoverage: 0 };
  }

  const leftCoverage = documentCoverage(left.pages, right.pages);
  const rightCoverage = documentCoverage(right.pages, left.pages);
  const leftPagesCovered = left.pages.every((page) => isPageCovered(page, right.pages));
  const rightPagesCovered = right.pages.every((page) => isPageCovered(page, left.pages));

  const leftContainedInRight =
    (leftCoverage >= DOCUMENT_COVERAGE_THRESHOLD && leftPagesCovered) ||
    (leftCoverage >= REFLOW_DOCUMENT_COVERAGE_THRESHOLD && right.pages.length >= left.pages.length);

  const rightContainedInLeft =
    (rightCoverage >= DOCUMENT_COVERAGE_THRESHOLD && rightPagesCovered) ||
    (rightCoverage >= REFLOW_DOCUMENT_COVERAGE_THRESHOLD && left.pages.length >= right.pages.length);

  if (
    leftContainedInRight &&
    rightContainedInLeft &&
    leftCoverage >= EQUIVALENT_COVERAGE_THRESHOLD &&
    rightCoverage >= EQUIVALENT_COVERAGE_THRESHOLD
  ) {
    return { relation: 'equivalent', leftCoverage, rightCoverage };
  }
  if (leftContainedInRight && (!rightContainedInLeft || leftCoverage > rightCoverage + 0.05)) {
    return { relation: 'right_contains_left', leftCoverage, rightCoverage };
  }
  if (rightContainedInLeft && (!leftContainedInRight || rightCoverage > leftCoverage + 0.05)) {
    return { relation: 'left_contains_right', leftCoverage, rightCoverage };
  }
  if (leftCoverage > 0 || rightCoverage > 0) {
    return { relation: 'overlap', leftCoverage, rightCoverage };
  }
  return { relation: 'unknown', leftCoverage, rightCoverage };
}
