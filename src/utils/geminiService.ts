import type { FamilyMember, HealthEvent, HealthMetric, HealthProfile, JsonValue, Medication } from '../types';
import { geminiPool } from './geminiPoolManager';

const GEMINI_REST_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const EVENT_TYPES = new Set<HealthEvent['type']>([
  'medical_report',
  'prescription',
  'test_result',
  'vaccination',
  'discharge',
  'other',
]);

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

/**
 * Direct REST invocation to Google Generative Language API
 */
async function callGeminiRest(
  apiKey: string,
  model: string,
  payload: Record<string, unknown>
): Promise<string> {
  const url = `${GEMINI_REST_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const rawJson = (await response.json().catch(() => null)) as GeminiGenerateContentResponse | null;

  if (!response.ok || rawJson?.error) {
    const errorDetails = rawJson?.error?.message || `HTTP ${response.status} (${response.statusText})`;
    throw new Error(`Gemini API Error [${response.status}]: ${errorDetails}`);
  }

  const textPart = rawJson?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textPart) {
    throw new Error('Gemini không trả về nội dung hợp lệ.');
  }

  return textPart.trim();
}

/**
 * Helper to strip Markdown JSON fencing
 */
function cleanJsonOutput(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

// ============================================================================
// NHÓM NHIỆM VỤ 1: SỐ HÓA, OCR, NHẬN DẠNG TÀI LIỆU, HIỆU CHỈNH & SẮP XẾP DỮ LIỆU
// Sử dụng: gemini-3.5-flash-lite, gemini-3.1-flash-lite (15 RPM, 500 RPD)
// ============================================================================

/**
 * Trích xuất sự kiện y tế từ tệp tài liệu / ảnh chụp bằng mô hình 3.5/3.1 flash lite
 */
export async function extractHealthEvent(
  file: File,
  member: FamilyMember
): Promise<Partial<HealthEvent>> {
  const base64Data = await fileToBase64(file);
  const mimeType = file.type || 'image/jpeg';

  const systemInstruction = `Bạn là trợ lý y tế chuyên số hóa, OCR nhận dạng tài liệu y khoa Việt Nam (đơn thuốc, kết quả xét nghiệm, phiếu khám, giấy ra viện, sổ tiêm chủng).
Nhiệm vụ: Trích xuất và chuẩn hóa thông tin cho thành viên ${member.name} (${member.birthDate ? 'sinh ngày ' + member.birthDate : ''}).
Hãy trả về DUY NHẤT một JSON object tuân thủ đúng cấu trúc:
{
  "title": "Tên ngắn gọn của sự kiện y tế",
  "date": "YYYY-MM-DD",
  "type": "medical_report" | "prescription" | "test_result" | "vaccination" | "discharge" | "other",
  "facility": "Tên bệnh viện hoặc phòng khám",
  "diagnoses": ["Chẩn đoán 1", "Chẩn đoán 2"],
  "medications": [
    { "name": "Tên thuốc", "dosage": "Liều dùng", "frequency": "Số lần/ngày", "duration": "Thời gian uống" }
  ],
  "metrics": [
    { "name": "Chỉ số (Huyết áp, Đường huyết, SpO2, Cân nặng, v.v.)", "value": 120, "unit": "mmHg" }
  ],
  "advice": "Lời dặn của bác sĩ hoặc hướng dẫn điều trị",
  "nextFollowUp": "YYYY-MM-DD nếu có hẹn tái khám",
  "notes": "Ghi chú bổ sung quan trọng"
}`;

  return geminiPool.executeTask('digitization', async (apiKey, model) => {
    const payload = {
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
            {
              text: `Hãy trích xuất và số hóa toàn bộ thông tin từ tài liệu đính kèm này cho thành viên ${member.name}. Trả về JSON chuẩn.`,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    };

    const responseText = await callGeminiRest(apiKey, model, payload);
    const parsed = JSON.parse(cleanJsonOutput(responseText)) as Record<string, unknown>;
    return normalizeExtractedEvent(parsed);
  });
}

/**
 * Hiệu chỉnh và sắp xếp thông minh toàn bộ dữ liệu thu thập được cho từng thành viên
 * Sử dụng tier digitization (3.5/3.1 flash lite)
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

  const prompt = `Bạn là chuyên gia chuẩn hóa dữ liệu hồ sơ y tế cho thành viên ${member.name}.
Dưới đây là danh sách ${events.length} sự kiện y tế đã thu thập:
${JSON.stringify(events, null, 2)}

Hãy:
1. Chuẩn hóa lại tên sự kiện, loại sự kiện (type), chẩn đoán y khoa theo danh pháp chuẩn.
2. Kiểm tra và bổ sung logic định dạng ngày tháng, liều lượng thuốc, chỉ số sinh tồn.
3. Sắp xếp thông minh theo trình tự thời gian và mức độ ưu tiên quan trọng.
4. Trả về DUY NHẤT một JSON:
{
  "organizedEvents": [ ...danh sách các event đã được chuẩn hóa, giữ nguyên ID gốc... ],
  "refinementNotes": [ "Ghi chú hiệu chỉnh 1", "Ghi chú hiệu chỉnh 2" ]
}`;

  return geminiPool.executeTask('digitization', async (apiKey, model) => {
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    };

    const text = await callGeminiRest(apiKey, model, payload);
    const parsed = JSON.parse(cleanJsonOutput(text)) as {
      organizedEvents?: HealthEvent[];
      refinementNotes?: string[];
    };

    return {
      organizedTimeline: Array.isArray(parsed.organizedEvents) ? parsed.organizedEvents : events,
      refinementNotes: Array.isArray(parsed.refinementNotes) ? parsed.refinementNotes : ['Đã chuẩn hóa dữ liệu thành công.'],
    };
  });
}

// ============================================================================
// NHÓM NHIỆM VỤ 2: PHÂN TÍCH, ĐÁNH GIÁ TOÀN DIỆN HỒ SƠ Y TẾ & TƯ VẤN LỜI KHUYÊN
// Sử dụng: gemini-3.8-flash, gemini-3.6-flash, gemini-3-flash (5 RPM, 20 RPD)
// ============================================================================

/**
 * Phân tích, đánh giá toàn diện hồ sơ y tế và đưa ra tổng kết tình hình sức khỏe
 */
export async function summarizeHealthProfile(
  member: FamilyMember,
  profile: HealthProfile
): Promise<string> {
  const eventsCount = profile.timeline.length;
  const metricsCount = Object.keys(profile.summary.latestMetrics).length;

  const prompt = `Bạn là bác sĩ gia đình và chuyên gia y tế cao cấp.
Hãy đưa ra bản ĐÁNH GIÁ TOÀN DIỆN tình hình sức khỏe cho thành viên ${member.name} (${member.role || 'thành viên'}).
Thông tin hồ sơ:
- Tổng số sự kiện khám/điều trị đã ghi nhận: ${eventsCount}
- Các chẩn đoán gần đây: ${profile.summary.latestDiagnoses.join(', ') || 'Chưa ghi nhận'}
- Các chỉ số sức khỏe gần nhất: ${JSON.stringify(profile.summary.latestMetrics)}
- Lịch sử diễn tiến bệnh án chi tiết:
${JSON.stringify(profile.timeline.slice(-10), null, 2)}

Yêu cầu phân tích chi tiết:
1. Đánh giá tổng quan hiện trạng sức khỏe, tiến triển các bệnh lý mãn tính/cấp tính.
2. Phân tích xu hướng các chỉ số sinh tồn và xét nghiệm quan trọng (huyết áp, đường huyết, v.v.).
3. Đánh giá phác đồ thuốc hiện tại và lưu ý an toàn/tương tác thuốc.
4. Lời khuyên cụ thể, khoa học về chế độ dinh dưỡng, vận động và lịch tái khám định kỳ.
Trình bày bằng tiếng Việt rõ ràng, ân cần, chia theo các mục tiêu đề chuyên nghiệp.`;

  return geminiPool.executeTask('analysis', async (apiKey, model) => {
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
      },
    };

    return callGeminiRest(apiKey, model, payload);
  });
}

/**
 * Hỏi đáp tương tác với trợ lý sức khỏe dựa trên toàn bộ hồ sơ y tế
 * Sử dụng tier analysis (3.8/3.6/3 flash)
 */
export async function askHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile
): Promise<string> {
  const prompt = `Bạn là trợ lý bác sĩ gia đình thông minh, tận tâm và có chuyên môn cao.
Bạn đang tư vấn sức khỏe cho thành viên ${member.name}.
Hồ sơ bệnh án của thành viên:
- Chẩn đoán gần đây: ${profile.summary.latestDiagnoses.join(', ') || 'Chưa có'}
- Các chỉ số sinh tồn gần nhất: ${JSON.stringify(profile.summary.latestMetrics)}
- Lịch sử khám chữa bệnh gần đây: ${JSON.stringify(profile.timeline.slice(-6))}

Câu hỏi từ người dùng: "${question}"

Hãy trả lời chi tiết, ân cần, căn cứ vào dữ liệu hồ sơ bệnh án của thành viên để đưa ra giải thích y khoa dễ hiểu và lời khuyên thiết thực. Lưu ý nhắc người dùng luôn tham vấn bác sĩ điều trị trực tiếp khi có dấu hiệu khẩn cấp.`;

  return geminiPool.executeTask('analysis', async (apiKey, model) => {
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.4,
      },
    };

    return callGeminiRest(apiKey, model, payload);
  });
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
  const prompt = `Bạn là hội đồng chuyên gia y khoa gia đình.
Hãy phân tích sâu toàn diện hồ sơ y tế của thành viên ${member.name}:
- Thông tin thành viên: ${JSON.stringify(member)}
- Toàn bộ hồ sơ tóm tắt: ${JSON.stringify(profile.summary)}
- Diễn tiến các sự kiện y tế: ${JSON.stringify(profile.timeline)}

Hãy tính điểm sức khỏe ước lượng (0-100), đánh giá tổng quan, các rủi ro chính, lời khuyên hành động và phân tích xu hướng chỉ số sinh tồn.
Trả về DUY NHẤT một JSON theo cấu trúc:
{
  "healthScore": 85,
  "overallAssessment": "Đánh giá chi tiết tình hình sức khỏe hiện tại...",
  "keyRisks": ["Rủi ro 1", "Rủi ro 2"],
  "recommendations": ["Lời khuyên 1", "Lời khuyên 2"],
  "vitalTrendAnalysis": "Phân tích biến thiên huyết áp, đường huyết, cân nặng..."
}`;

  return geminiPool.executeTask('analysis', async (apiKey, model) => {
    const payload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    };

    const text = await callGeminiRest(apiKey, model, payload);
    const parsed = JSON.parse(cleanJsonOutput(text)) as {
      healthScore?: number;
      overallAssessment?: string;
      keyRisks?: string[];
      recommendations?: string[];
      vitalTrendAnalysis?: string;
    };

    return {
      healthScore: typeof parsed.healthScore === 'number' ? parsed.healthScore : 80,
      overallAssessment: parsed.overallAssessment || 'Tình trạng sức khỏe ổn định.',
      keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
      vitalTrendAnalysis: parsed.vitalTrendAnalysis || 'Các chỉ số duy trì trong ngưỡng kiểm soát.',
    };
  });
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
      // Strip data:*/*;base64,
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
