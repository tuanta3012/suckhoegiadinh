import type { FamilyMember, HealthEvent, HealthMetric, HealthProfile, JsonValue, Medication } from '../types';
import { auth } from './googleDriveService';

interface ImportMetaEnv {
  GEMINI_API_KEYS?: string;
}

interface GeminiResponse {
  event?: unknown;
  answer?: string;
  narrative?: string;
}

const EVENT_TYPES = new Set<HealthEvent['type']>([
  'medical_report',
  'prescription',
  'test_result',
  'vaccination',
  'discharge',
  'other',
]);

function getEndpoint(): string {
  const endpoint = (import.meta as ImportMeta & { env: ImportMetaEnv }).env.GEMINI_API_KEYS?.trim();
  if (!endpoint) {
    throw new Error('Chưa cấu hình GEMINI_API_KEYS. Tài liệu đã lưu an toàn trên Drive; có thể nhập thông tin thủ công.');
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('GEMINI_API_KEYS không phải URL hợp lệ.');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error('Endpoint Gemini phải dùng HTTPS.');
  }
  return url.toString().replace(/\/$/, '');
}

async function requestGemini<T>(
  payload: Record<string, unknown>,
  endpoint = getEndpoint(),
): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error('Đăng nhập Google trước khi sử dụng Gemini.');
  const idToken = await user.getIdToken();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(error?.error || `Dịch vụ Gemini trả về lỗi ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export async function extractHealthEvent(
  file: File,
  member: FamilyMember,
): Promise<Partial<HealthEvent>> {
  const endpoint = getEndpoint();
  const dataUrl = await fileToDataUrl(file);
  const result = await requestGemini<GeminiResponse>({
    action: 'extract',
    member: { id: member.id, name: member.name },
    document: {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      dataUrl,
    },
  }, endpoint);
  if (!isRecord(result.event)) {
    throw new Error('Phản hồi Gemini thiếu trường event; tài liệu vẫn được giữ trên Drive để nhập thủ công.');
  }
  return normalizeExtractedEvent(result.event);
}

export async function askHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile,
): Promise<string> {
  const result = await requestGemini<GeminiResponse>({
    action: 'chat',
    question,
    member: { id: member.id, name: member.name },
    profile,
  });
  if (!result.answer?.trim()) throw new Error('Phản hồi Gemini không có câu trả lời.');
  return result.answer.trim();
}

export async function summarizeHealthProfile(
  member: FamilyMember,
  profile: HealthProfile,
): Promise<string> {
  const result = await requestGemini<GeminiResponse>({
    action: 'summarize',
    member: { id: member.id, name: member.name },
    profile,
  });
  if (!result.narrative?.trim()) throw new Error('Phản hồi Gemini không có nội dung tổng kết.');
  return result.narrative.trim();
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Không thể đọc nội dung tài liệu để gửi Gemini.'));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(new Error('Không thể đọc nội dung tài liệu để gửi Gemini.'));
    reader.readAsDataURL(file);
  });
}

function normalizeExtractedEvent(value: Record<string, unknown>): Partial<HealthEvent> {
  const medications: Medication[] = Array.isArray(value.medications)
    ? value.medications.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
        return [{
          name: item.name.trim(),
          dosage: optionalString(item.dosage),
          frequency: optionalString(item.frequency),
          duration: optionalString(item.duration),
        }];
      })
    : [];
  const metrics: HealthMetric[] = Array.isArray(value.metrics)
    ? value.metrics.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
        const numericValue = typeof item.value === 'number' ? item.value : Number(item.value);
        if (!Number.isFinite(numericValue)) return [];
        return [{ name: item.name.trim(), value: numericValue, unit: optionalString(item.unit) || '' }];
      })
    : [];

  return {
    title: optionalString(value.title),
    date: isIsoDate(value.date) ? value.date : undefined,
    type: typeof value.type === 'string' && EVENT_TYPES.has(value.type as HealthEvent['type'])
      ? value.type as HealthEvent['type']
      : undefined,
    facility: optionalString(value.facility),
    diagnoses: Array.isArray(value.diagnoses)
      ? value.diagnoses.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
      : [],
    medications,
    metrics,
    advice: optionalString(value.advice),
    nextFollowUp: isIsoDate(value.nextFollowUp) ? value.nextFollowUp : undefined,
    notes: optionalString(value.notes),
    extractedData: isRecord(value.extractedData) && isJsonRecord(value.extractedData)
      ? value.extractedData as Record<string, JsonValue>
      : undefined,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isJsonRecord(value: Record<string, unknown>): boolean {
  const isJson = (item: unknown): item is JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(isJson);
    if (isRecord(item)) return Object.values(item).every(isJson);
    return false;
  };
  return Object.values(value).every(isJson);
}
