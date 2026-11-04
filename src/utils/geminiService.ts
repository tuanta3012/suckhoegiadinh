import type { FamilyMember, HealthEvent, HealthMetric, HealthProfile, JsonValue, Medication } from '../types';
import { geminiPool } from './geminiPoolManager';

const EVENT_TYPES = new Set<HealthEvent['type']>([
  'medical_report',
  'prescription',
  'test_result',
  'vaccination',
  'discharge',
  'other',
]);

export interface ExtractionProgressUpdate {
  stage: 'preparing' | 'reading_document' | 'extracting_content' | 'matching_patient' | 'completed';
  progressPercent: number;
  message: string;
  modelUsed?: string;
  partialEvent?: Partial<HealthEvent>;
  rawChunk?: string;
}

/**
 * Server-side Gemini API invocation helper
 */
async function callServerGemini<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const customKeys = geminiPool.getAllKeys();
  const response = await fetch(`/api/gemini/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...body,
      customKeys: customKeys.length > 0 ? customKeys : undefined,
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    const errorMsg = data?.error || `Máy chủ Gemini trả về mã lỗi ${response.status}.`;
    throw new Error(errorMsg);
  }

  return data as T;
}

// ============================================================================
// NHÓM NHIỆM VỤ 1: SỐ HÓA, OCR, NHẬN DẠNG TÀI LIỆU, HIỆU CHỈNH & SẮP XẾP DỮ LIỆU
// Sử dụng Server-Side Gemini API: gemini-3.5-flash-lite => gemini-3.1-flash-lite
// ============================================================================

/**
 * Bóc tách một phần JSON đang stream về để hiển thị trực tiếp cho người dùng
 */
export function extractPartialJson(text: string): Partial<HealthEvent> {
  const result: Partial<HealthEvent> = {};
  if (!text || typeof text !== 'string') return result;

  // 1. Thử parse JSON hoàn chỉnh nếu khả thi
  try {
    const cleaned = text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        return normalizeExtractedEvent(parsed);
      }
    }
  } catch {
    // Không parse được toàn bộ, tiếp tục regex trích xuất từng trường
  }

  // 2. Trích xuất thông tin người bệnh
  const nameMatch = text.match(/"patientName"\s*:\s*"([^"]+)"/i);
  if (nameMatch) result.patientName = nameMatch[1].trim();

  const birthMatch = text.match(/"patientBirthDate"\s*:\s*"([^"]+)"/i);
  if (birthMatch) result.patientBirthDate = birthMatch[1].trim();

  const genderMatch = text.match(/"patientGender"\s*:\s*"([^"]+)"/i);
  if (genderMatch) result.patientGender = genderMatch[1].trim();

  // 3. Cơ sở y tế & Tiêu đề
  const titleMatch = text.match(/"title"\s*:\s*"([^"]+)"/i);
  if (titleMatch) result.title = titleMatch[1].trim();

  const facilityMatch = text.match(/"facility"\s*:\s*"([^"]+)"/i);
  if (facilityMatch) result.facility = facilityMatch[1].trim();

  const typeMatch = text.match(/"type"\s*:\s*"([^"]+)"/i);
  if (typeMatch && EVENT_TYPES.has(typeMatch[1].trim() as HealthEvent['type'])) {
    result.type = typeMatch[1].trim() as HealthEvent['type'];
  }

  const dateMatch = text.match(/"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/i);
  if (dateMatch) result.date = dateMatch[1];

  // 4. Chẩn đoán
  const diagMatch = text.match(/"diagnoses"\s*:\s*\[([\s\S]*?)\]/i);
  if (diagMatch) {
    const items = diagMatch[1].match(/"([^"]+)"/g);
    if (items) {
      result.diagnoses = items.map((s) => s.replace(/"/g, '').trim()).filter(Boolean);
    }
  }

  // 5. Đơn thuốc
  const medsMatch = text.match(/"medications"\s*:\s*\[([\s\S]*?)\]/i);
  if (medsMatch) {
    const medBlocks = medsMatch[1].match(/\{[\s\S]*?\}/g);
    if (medBlocks) {
      const parsedMeds: Medication[] = [];
      for (const block of medBlocks) {
        const medName = block.match(/"name"\s*:\s*"([^"]+)"/i);
        if (medName) {
          const dosage = block.match(/"dosage"\s*:\s*"([^"]+)"/i);
          const freq = block.match(/"frequency"\s*:\s*"([^"]+)"/i);
          const dur = block.match(/"duration"\s*:\s*"([^"]+)"/i);
          parsedMeds.push({
            name: medName[1].trim(),
            dosage: dosage ? dosage[1].trim() : undefined,
            frequency: freq ? freq[1].trim() : undefined,
            duration: dur ? dur[1].trim() : undefined,
          });
        }
      }
      if (parsedMeds.length > 0) {
        result.medications = parsedMeds;
      }
    }
  }

  // 6. Chỉ số đo sinh tồn
  const metricsMatch = text.match(/"metrics"\s*:\s*\[([\s\S]*?)\]/i);
  if (metricsMatch) {
    const metricBlocks = metricsMatch[1].match(/\{[\s\S]*?\}/g);
    if (metricBlocks) {
      const parsedMetrics: HealthMetric[] = [];
      for (const block of metricBlocks) {
        const mName = block.match(/"name"\s*:\s*"([^"]+)"/i);
        const mVal = block.match(/"value"\s*:\s*([0-9.]+)/i);
        const mUnit = block.match(/"unit"\s*:\s*"([^"]+)"/i);
        if (mName && mVal) {
          const num = parseFloat(mVal[1]);
          if (!isNaN(num)) {
            parsedMetrics.push({
              name: mName[1].trim(),
              value: num,
              unit: mUnit ? mUnit[1].trim() : '',
            });
          }
        }
      }
      if (parsedMetrics.length > 0) {
        result.metrics = parsedMetrics;
      }
    }
  }

  // 7. Lời dặn
  const adviceMatch = text.match(/"advice"\s*:\s*"([^"]+)"/i);
  if (adviceMatch) result.advice = adviceMatch[1].trim();

  return result;
}

/**
 * Trích xuất sự kiện y tế từ tệp tài liệu / ảnh chụp kèm theo luồng cập nhật tiến trình và nội dung trực tiếp
 */
export async function extractHealthEventWithProgress(
  file: File,
  member: FamilyMember,
  onProgress?: (update: ExtractionProgressUpdate) => void
): Promise<{ extracted: Partial<HealthEvent>; modelUsed?: string }> {
  onProgress?.({
    stage: 'preparing',
    progressPercent: 25,
    message: 'Đang chuẩn bị dữ liệu và mã hóa tệp...',
  });

  const base64Data = await fileToBase64(file);
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  const customKeys = geminiPool.getAllKeys();

  onProgress?.({
    stage: 'reading_document',
    progressPercent: 45,
    message: 'Khởi động AI Vision (gemini-3.5-flash-lite) đọc tài liệu...',
    modelUsed: 'gemini-3.5-flash-lite',
  });

  try {
    // 1. Thử gọi qua Server-Sent Events (SSE) để truyền dữ liệu thời gian thực
    const response = await fetch('/api/gemini/extract-health-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64Data,
        mimeType,
        member,
        stream: true,
        customKeys: customKeys.length > 0 ? customKeys : undefined,
      }),
    });

    if (response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      let buffer = '';
      let activeModel = 'gemini-3.5-flash-lite';
      let finalExtracted: Record<string, unknown> | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') break;
            try {
              const data = JSON.parse(payload) as {
                type: 'chunk' | 'complete';
                text?: string;
                accumulated?: string;
                extracted?: Record<string, unknown>;
                modelUsed?: string;
              };

              if (data.modelUsed) activeModel = data.modelUsed;

              if (data.type === 'chunk' && data.accumulated) {
                accumulated = data.accumulated;
                const partial = extractPartialJson(accumulated);
                const progressScore = Math.min(88, 48 + Math.floor(accumulated.length / 25));

                onProgress?.({
                  stage: 'extracting_content',
                  progressPercent: progressScore,
                  message: 'AI đang bóc tách chẩn đoán, thuốc & chỉ số...',
                  modelUsed: activeModel,
                  partialEvent: partial,
                  rawChunk: data.text,
                });
              } else if (data.type === 'complete' && data.extracted) {
                finalExtracted = data.extracted;
              }
            } catch {
              // Bỏ qua lỗi parsing chunk SSE lẻ
            }
          }
        }
      }

      const finalObj = finalExtracted || extractPartialJson(accumulated);
      const normalized = normalizeExtractedEvent(finalObj);

      onProgress?.({
        stage: 'matching_patient',
        progressPercent: 96,
        message: 'Đang đối chiếu người bệnh với thành viên gia đình...',
        modelUsed: activeModel,
        partialEvent: normalized,
      });

      onProgress?.({
        stage: 'completed',
        progressPercent: 100,
        message: 'Hoàn tất số hóa tài liệu y tế!',
        modelUsed: activeModel,
        partialEvent: normalized,
      });

      return { extracted: normalized, modelUsed: activeModel };
    }
  } catch (err) {
    console.warn('[Gemini Service] SSE stream không khả dụng, chuyển sang chế độ chuẩn:', err);
  }

  // 2. Chế độ dự phòng gọi tiêu chuẩn nếu SSE gặp trục trặc
  onProgress?.({
    stage: 'extracting_content',
    progressPercent: 65,
    message: 'Đang trích xuất nội dung y tế...',
  });

  const data = await callServerGemini<{ success: boolean; extracted: Record<string, unknown>; modelUsed?: string }>(
    'extract-health-event',
    {
      base64Data,
      mimeType,
      member,
    }
  );

  const normalized = normalizeExtractedEvent(data.extracted);

  onProgress?.({
    stage: 'completed',
    progressPercent: 100,
    message: 'Hoàn tất số hóa tài liệu y tế!',
    modelUsed: data.modelUsed,
    partialEvent: normalized,
  });

  return { extracted: normalized, modelUsed: data.modelUsed };
}

/**
 * Trích xuất sự kiện y tế tương thích ngược cho các màn hình hiện tại
 */
export async function extractHealthEvent(
  file: File,
  member: FamilyMember
): Promise<Partial<HealthEvent>> {
  const result = await extractHealthEventWithProgress(file, member);
  return result.extracted;
}

/**
 * Hiệu chỉnh và sắp xếp thông minh toàn bộ dữ liệu thu thập được cho từng thành viên
 * Sử dụng tier digitization (3.5/3.1 flash lite trên server)
 */
export async function refineAndOrganizeMemberData(
  member: FamilyMember,
  events: HealthEvent[]
): Promise<{
  organizedTimeline: HealthEvent[];
  refinementNotes: string[];
}> {
  if (events.length === 0) {
    return { organizedTimeline: [], refinementNotes: ['Chưa có sự kiện y tế nào để hiệu chỉnh.'] };
  }

  const data = await callServerGemini<{
    success: boolean;
    organizedTimeline: HealthEvent[];
    refinementNotes: string[];
  }>('refine-and-organize', {
    member,
    events,
  });

  return {
    organizedTimeline: Array.isArray(data.organizedTimeline) ? data.organizedTimeline : events,
    refinementNotes: Array.isArray(data.refinementNotes) ? data.refinementNotes : ['Đã chuẩn hóa dữ liệu.'],
  };
}

// ============================================================================
// NHÓM NHIỆM VỤ 2: PHÂN TÍCH, ĐÁNH GIÁ TOÀN DIỆN HỒ SƠ Y TẾ & TƯ VẤN LỜI KHUYÊN
// Sử dụng Server-Side Gemini API: gemini-3.8-flash => gemini-3.6-flash => gemini-3-flash
// ============================================================================

/**
 * Phân tích, đánh giá toàn diện hồ sơ y tế và đưa ra tổng kết tình hình sức khỏe
 */
export async function summarizeHealthProfile(
  member: FamilyMember,
  profile: HealthProfile
): Promise<string> {
  const data = await callServerGemini<{ success: boolean; summary: string }>('summarize', {
    member,
    profile,
  });
  return data.summary;
}

/**
 * Hỏi đáp tương tác với trợ lý sức khỏe dựa trên toàn bộ hồ sơ y tế
 */
export async function askHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile
): Promise<string> {
  const data = await callServerGemini<{ success: boolean; answer: string }>('ask-assistant', {
    question,
    member,
    profile,
    stream: false,
  });
  return data.answer;
}

/**
 * Hỏi đáp trợ lý sức khỏe với phản hồi truyền phát trực tiếp (Streaming SSE)
 */
export async function streamHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile,
  onChunk: (chunk: string) => void
): Promise<string> {
  const customKeys = geminiPool.getAllKeys();
  const response = await fetch('/api/gemini/ask-assistant', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, member, profile, stream: true, customKeys }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Lỗi kết nối máy chủ (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') break;
        try {
          const parsed = JSON.parse(payload) as { text?: string };
          if (parsed.text) {
            fullText += parsed.text;
            onChunk(parsed.text);
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return fullText;
}

/**
 * Đưa ra phân tích chuyên sâu đa chiều và cảnh báo rủi ro sức khỏe
 */
export async function analyzeComprehensiveHealth(
  member: FamilyMember,
  profile: HealthProfile
): Promise<{
  healthScore: number;
  overallAssessment: string;
  keyRisks: string[];
  recommendations: string[];
  vitalTrendAnalysis: string;
}> {
  const data = await callServerGemini<{
    success: boolean;
    result: {
      healthScore: number;
      overallAssessment: string;
      keyRisks: string[];
      recommendations: string[];
      vitalTrendAnalysis: string;
    };
  }>('analyze-comprehensive', {
    member,
    profile,
  });

  return data.result;
}

// ============================================================================
// CÁC HÀM TIỆN ÍCH CHUYỂN ĐỔI & CHUẨN HÓA DỮ LIỆU
// ============================================================================

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Không thể đọc dữ liệu tệp.'));
        return;
      }
      const base64 = reader.result.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Lỗi khi đọc tệp dữ liệu.'));
    reader.readAsDataURL(file);
  });
}

function normalizeExtractedEvent(value: Record<string, unknown>): Partial<HealthEvent> {
  const medications: Medication[] = Array.isArray(value.medications)
    ? value.medications.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
        return [
          {
            name: item.name.trim(),
            dosage: optionalString(item.dosage),
            frequency: optionalString(item.frequency),
            duration: optionalString(item.duration),
          },
        ];
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
    type:
      typeof value.type === 'string' && EVENT_TYPES.has(value.type as HealthEvent['type'])
        ? (value.type as HealthEvent['type'])
        : undefined,
    facility: optionalString(value.facility),
    diagnoses: Array.isArray(value.diagnoses)
      ? value.diagnoses
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : [],
    medications,
    metrics,
    advice: optionalString(value.advice),
    nextFollowUp: isIsoDate(value.nextFollowUp) ? value.nextFollowUp : undefined,
    notes: optionalString(value.notes),
    patientName: optionalString(value.patientName),
    patientBirthDate: optionalString(value.patientBirthDate),
    patientGender: optionalString(value.patientGender),
    extractedData:
      isRecord(value.extractedData) && isJsonRecord(value.extractedData)
        ? (value.extractedData as Record<string, JsonValue>)
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
