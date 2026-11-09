import type { HealthEvent } from '../types';

export const HEALTH_EVENT_TYPES: HealthEvent['type'][] = [
  'comprehensive_exam',
  'medical_report',
  'prescription',
  'test_result',
  'vaccination',
  'discharge',
  'imaging',
  'other',
];

export function isHealthEventType(value: unknown): value is HealthEvent['type'] {
  return typeof value === 'string' && HEALTH_EVENT_TYPES.includes(value as HealthEvent['type']);
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function classifyHealthEventType(
  value: Partial<HealthEvent> & Record<string, unknown>,
  fileName?: string,
): HealthEvent['type'] | undefined {
  const fileLabel = normalizeText(fileName || '');
  const titleLabel = normalizeText(
    [value.title, value.customCategory].filter((item): item is string => typeof item === 'string').join(' '),
  );
  const labels = `${fileLabel} ${titleLabel}`.trim();
  const content = normalizeText(JSON.stringify(value));

  const comprehensiveExam = [
    /\bkham suc khoe\b/,
    /\bkham tong quat\b/,
    /\bkham dinh ky\b/,
    /\bkham doan\b/,
    /\bkiem tra suc khoe\b/,
    /\bhealth check(?:up)?\b/,
    /\bannual physical\b/,
  ];
  if (matchesAny(labels, comprehensiveExam)) return 'comprehensive_exam';

  if (matchesAny(labels, [
    /\bphieu tiem(?: chung)?\b/,
    /\bso tiem(?: chung| ngua)?\b/,
    /\btiem chung\b/,
    /\btiem ngua\b/,
    /\bvaccin(?:ation|e|es)\b/,
    /\blich tiem\b/,
  ]) || (Array.isArray(value.vaccinations) && value.vaccinations.length > 0)) {
    return 'vaccination';
  }

  if (matchesAny(labels, [
    /\bdon thuoc\b/,
    /\btoa thuoc\b/,
    /\bke don\b/,
    /\bphieu linh thuoc\b/,
    /\bprescription\b/,
  ])) {
    return 'prescription';
  }

  if (matchesAny(labels, [
    /\bgiay ra vien\b/,
    /\bphieu xuat vien\b/,
    /\btom tat benh an\b/,
    /\bdischarge summary\b/,
  ]) || Boolean(value.hospitalization && typeof value.hospitalization === 'object')) {
    return 'discharge';
  }

  if (matchesAny(labels, [
    /\bsieu am\b/,
    /\bx quang\b/,
    /\bchup x quang\b/,
    /\bdien tam do\b/,
    /\becg\b/,
    /\bct scan\b/,
    /\bchup ct\b/,
    /\bmri\b/,
    /\bchup mri\b/,
    /\bchan doan hinh anh\b/,
  ]) || (Array.isArray(value.imagingResults) && value.imagingResults.length > 0)) {
    return 'imaging';
  }

  if (matchesAny(labels, [
    /\bxet nghiem\b/,
    /\bket qua xn\b/,
    /\bphieu xn\b/,
    /\blab(?:oratory)? result\b/,
    /\bblood test\b/,
    /\burine test\b/,
  ])) {
    return 'test_result';
  }

  if (matchesAny(labels, [
    /\bkham benh\b/,
    /\bphieu kham\b/,
    /\bso kham benh\b/,
    /\bmedical report\b/,
    /\bclinical note\b/,
  ])) {
    return 'medical_report';
  }

  if (isHealthEventType(value.type)) return value.type;

  if (matchesAny(content, [
    /\bphieu tiem(?: chung)?\b/,
    /\bso tiem(?: chung| ngua)?\b/,
    /\btiem chung\b/,
    /\btiem ngua\b/,
    /\bvaccin(?:ation|e|es)\b/,
  ])) {
    return 'vaccination';
  }
  if (matchesAny(content, [
    /\bdon thuoc\b/,
    /\btoa thuoc\b/,
    /\bke don\b/,
    /\bprescription\b/,
  ])) {
    return 'prescription';
  }
  if (matchesAny(content, [
    /\bgiay ra vien\b/,
    /\bphieu xuat vien\b/,
    /\btom tat benh an\b/,
    /\bdischarge summary\b/,
  ])) {
    return 'discharge';
  }
  if (matchesAny(content, [
    /\bsieu am\b/,
    /\bx quang\b/,
    /\bdien tam do\b/,
    /\becg\b/,
    /\bct scan\b/,
    /\bmri\b/,
    /\bchan doan hinh anh\b/,
  ])) {
    return 'imaging';
  }
  if (matchesAny(content, [
    /\bxet nghiem\b/,
    /\bket qua xn\b/,
    /\blab(?:oratory)? result\b/,
    /\bblood test\b/,
    /\burine test\b/,
  ])) {
    return 'test_result';
  }

  return undefined;
}
