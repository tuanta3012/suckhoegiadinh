import type {
  AiAnalysisBlock,
  AiDeepAnalysisResult,
  FamilyMember,
  HealthEvent,
  HealthMetric,
  HealthProfile,
  ImagingResult,
  JsonValue,
  Medication,
  VaccinationRecord,
  HospitalizationRecord,
} from '../types';
import { ensureGeminiAuthUser } from './googleDriveService';
import { buildApiUrl } from './apiConfig';
import { digitizationLogger } from './digitizationLogger';
import { classifyHealthEventType, isHealthEventType } from './healthEventType';

const GEMINI_REQUEST_TIMEOUT_MS = 300_000;
const OCR_REQUEST_TIMEOUT_MS = 600_000;
const OCR_IDLE_TIMEOUT_MS = 240_000;
const ASSISTANT_REQUEST_TIMEOUT_MS = 120_000;

export interface ExtractionProgressUpdate {
  stage:
    | 'preparing'
    | 'reading_document'
    | 'waiting_for_model'
    | 'retrying_model'
    | 'extracting_content'
    | 'matching_patient'
    | 'completed';
  progressPercent: number;
  message: string;
  modelUsed?: string;
  partialEvent?: Partial<HealthEvent>;
  rawChunk?: string;
  totalPages?: number;
  processedPages?: number;
}

async function getAuthenticatedUserToken(): Promise<string> {
  const user = await ensureGeminiAuthUser();
  return user.getIdToken();
}

/**
 * Server-side Gemini API invocation helper with logging & execution duration tracking
 */
async function callServerGemini<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log('info', 'api', `Bắt đầu gọi API server: /api/gemini/${endpoint}`, { endpoint });
  const token = await getAuthenticatedUserToken();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(buildApiUrl(`/api/gemini/${endpoint}`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch (error) {
    const durationMs = getDuration();
    if (controller.signal.aborted) {
      digitizationLogger.log(
        'error',
        'api',
        `API /api/gemini/${endpoint} quá thời gian chờ (${durationMs}ms)`,
        undefined,
        durationMs,
      );
      throw new Error('Yêu cầu Gemini quá thời gian chờ. Hãy thử lại với tài liệu nhỏ hơn.');
    }
    digitizationLogger.log(
      'error',
      'api',
      `Lỗi kết nối khi gọi /api/gemini/${endpoint}: ${error instanceof Error ? error.message : 'Unknown'}`,
      undefined,
      durationMs,
    );
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  const durationMs = getDuration();
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) {
    const errorMsg = data?.error || `Máy chủ Gemini trả về mã lỗi ${response.status}.`;
    digitizationLogger.log(
      'error',
      'api',
      `API /api/gemini/${endpoint} thất bại (HTTP ${response.status}): ${errorMsg}`,
      { status: response.status },
      durationMs,
    );
    throw new Error(errorMsg);
  }

  digitizationLogger.log(
    'info',
    'api',
    `API /api/gemini/${endpoint} phản hồi thành công (${durationMs}ms)`,
    undefined,
    durationMs,
  );
  return data as T;
}

// ============================================================================
// NHÓM NHIỆM VỤ 1: SỐ HÓA, OCR, NHẬN DẠNG TÀI LIỆU, HIỆU CHỈNH & SẮP XẾP DỮ LIỆU
// Sử dụng CỐ ĐỊNH Server-Side Gemini API: gemini-3.5-flash-lite (Không rớt model)
// ============================================================================

/**
 * Bóc tách một phần JSON đang stream về để hiển thị trực tiếp cho người dùng
 */
export function extractPartialJson(text: string, fileName?: string): Partial<HealthEvent> {
  const result: Partial<HealthEvent> = {};
  if (!text || typeof text !== 'string') return result;

  // 1. Thử parse JSON hoàn chỉnh nếu khả thi
  try {
    const cleaned = text.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') {
        return normalizeExtractedEvent(parsed, fileName);
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
  if (typeMatch && isHealthEventType(typeMatch[1].trim())) {
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

  return {
    ...result,
    type: classifyHealthEventType(result, fileName) || result.type,
  };
}

/**
 * Trích xuất sự kiện y tế từ tệp tài liệu / ảnh chụp kèm theo luồng cập nhật tiến trình và nội dung trực tiếp
 */
export async function extractHealthEventWithProgress(
  file: File,
  member: FamilyMember,
  onProgress?: (update: ExtractionProgressUpdate) => void
): Promise<{ extracted: Partial<HealthEvent>; modelUsed?: string; totalPages?: number; processedPages?: number }> {
  const getDuration = digitizationLogger.startTimer();
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  digitizationLogger.log(
    'info',
    'ocr_start',
    `Bắt đầu số hóa OCR tài liệu: "${file.name}" (${(file.size / 1024).toFixed(1)} KB, MIME: ${mimeType}) cho hồ sơ ${member.name}`,
    { fileName: file.name, fileSize: file.size, mimeType, memberId: member.id, memberName: member.name }
  );

  onProgress?.({
    stage: 'preparing',
    progressPercent: 25,
    message: 'Đang chuẩn bị dữ liệu và mã hóa tệp...',
  });

  const base64Data = await fileToBase64(file);

  onProgress?.({
    stage: 'reading_document',
    progressPercent: 45,
    message: 'Khởi động AI Vision đọc tài liệu...',
    modelUsed: 'gemini-3.5-flash-lite',
  });

  const user = await ensureGeminiAuthUser();
  const controller = new AbortController();
  let abortReason: 'idle' | 'total' | null = null;
  const totalTimeout = window.setTimeout(() => {
    abortReason = 'total';
    controller.abort();
  }, OCR_REQUEST_TIMEOUT_MS);
  let idleTimeout: number | undefined;
  const renewIdleTimeout = () => {
    window.clearTimeout(idleTimeout);
    idleTimeout = window.setTimeout(() => {
      abortReason = 'idle';
      controller.abort();
    }, OCR_IDLE_TIMEOUT_MS);
  };
  renewIdleTimeout();
  try {
    const response = await fetch(buildApiUrl('/api/gemini/extract-health-event'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await user.getIdToken()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        base64Data,
        mimeType,
        member,
        fileName: file.name,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(errorBody?.error || `Máy chủ OCR trả về mã lỗi ${response.status}.`);
    }
    if (!response.body) throw new Error('Máy chủ OCR không trả về luồng tiến trình.');

    renewIdleTimeout();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';
    let activeModel = 'gemini-3.5-flash-lite';
    let finalExtracted: Record<string, unknown> | null = null;
    let docTotalPages: number | undefined;
    let docProcessedPages: number | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      renewIdleTimeout();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;
        let data: {
          type: 'progress' | 'chunk' | 'complete' | 'error';
          message?: string;
          error?: string;
          text?: string;
          extracted?: Record<string, unknown>;
          modelUsed?: string;
          progressPercent?: number;
          totalPages?: number;
          processedPages?: number;
        };
        try {
          data = JSON.parse(payload) as typeof data;
        } catch {
          continue;
        }

        if (data.modelUsed) activeModel = data.modelUsed;
        if (typeof data.totalPages === 'number') docTotalPages = data.totalPages;
        if (typeof data.processedPages === 'number') docProcessedPages = data.processedPages;

        if (data.type === 'error') throw new Error(data.error || 'Máy chủ OCR không thể xử lý tài liệu.');
        if (data.type === 'progress') {
          const isRetry = data.message?.includes('phương án dự phòng') || data.message?.includes('Đang thử mô hình');
          if (isRetry) {
            digitizationLogger.log('warn', 'ocr_retry', `Thử lại hoặc chuyển khóa dự phòng: ${data.message}`, { modelUsed: activeModel });
          }
          onProgress?.({
            stage: isRetry ? 'retrying_model' : 'waiting_for_model',
            progressPercent: data.progressPercent ?? 48,
            message: data.message || 'Đang chờ mô hình đọc tài liệu...',
            modelUsed: activeModel,
            partialEvent: data.extracted ? normalizeExtractedEvent(data.extracted, file.name) : undefined,
            totalPages: docTotalPages,
            processedPages: docProcessedPages,
          });
        } else if (data.type === 'chunk' && data.text) {
          accumulated += data.text;
          const partial = extractPartialJson(accumulated, file.name);
          onProgress?.({
            stage: 'extracting_content',
            progressPercent: Math.min(88, 48 + Math.floor(accumulated.length / 25)),
            message: 'AI đang bóc tách chẩn đoán, thuốc và chỉ số...',
            modelUsed: activeModel,
            partialEvent: partial,
            rawChunk: data.text,
            totalPages: docTotalPages,
            processedPages: docProcessedPages,
          });
        } else if (data.type === 'complete' && data.extracted) {
          finalExtracted = data.extracted;
          if (typeof data.totalPages === 'number') docTotalPages = data.totalPages;
          if (typeof data.processedPages === 'number') docProcessedPages = data.processedPages;
        }
      }
    }

    if (!finalExtracted) {
      throw new Error('Luồng OCR kết thúc nhưng không có kết quả hoàn chỉnh. Tài liệu vẫn được lưu trên Google Drive.');
    }

    const normalized = normalizeExtractedEvent(finalExtracted, file.name);
    if (
      !normalized.title &&
      !normalized.patientName &&
      !normalized.diagnoses?.length &&
      !normalized.medications?.length &&
      !normalized.metrics?.length &&
      !normalized.advice &&
      !normalized.notes
    ) {
      throw new Error('AI không trích xuất được thông tin có thể xác nhận từ tài liệu. Hãy nhập thủ công hoặc thử lại.');
    }

    const durationMs = getDuration();
    digitizationLogger.log(
      'info',
      'ocr_complete',
      `Số hóa OCR hoàn tất trong ${durationMs}ms (${(durationMs / 1000).toFixed(1)}s) bằng model ${activeModel}. Trích xuất: tiêu đề="${normalized.title || 'N/A'}", người bệnh="${normalized.patientName || 'N/A'}", ${normalized.diagnoses?.length || 0} chẩn đoán, ${normalized.medications?.length || 0} thuốc, ${normalized.metrics?.length || 0} chỉ số đo.`,
      {
        durationMs,
        modelUsed: activeModel,
        totalPages: docTotalPages,
        processedPages: docProcessedPages,
        patientName: normalized.patientName,
        title: normalized.title,
        diagnosesCount: normalized.diagnoses?.length || 0,
        medicationsCount: normalized.medications?.length || 0,
        metricsCount: normalized.metrics?.length || 0,
      },
      durationMs,
    );

    onProgress?.({
      stage: 'matching_patient',
      progressPercent: 96,
      message: 'Đang đối chiếu người bệnh với thành viên gia đình...',
      modelUsed: activeModel,
      partialEvent: normalized,
      totalPages: docTotalPages,
      processedPages: docProcessedPages,
    });
    onProgress?.({
      stage: 'completed',
      progressPercent: 100,
      message: 'Hoàn tất số hóa tài liệu y tế!',
      modelUsed: activeModel,
      partialEvent: normalized,
      totalPages: docTotalPages,
      processedPages: docProcessedPages,
    });
    return {
      extracted: normalized,
      modelUsed: activeModel,
      totalPages: docTotalPages,
      processedPages: docProcessedPages || docTotalPages,
    };
  } catch (error) {
    const durationMs = getDuration();
    const errorMsg = controller.signal.aborted
      ? abortReason === 'idle'
        ? 'Không nhận được dữ liệu phản hồi từ AI trong 4 phút. Hãy kiểm tra kết nối mạng hoặc thử lại.'
        : 'Quá thời gian OCR tối đa (10 phút). Tệp vẫn được lưu an toàn trên Google Drive; bạn có thể bấm "Chạy lại OCR" hoặc nhập thủ công.'
      : error instanceof Error
        ? error.message
        : 'Lỗi OCR không xác định';
    digitizationLogger.log(
      'error',
      'ocr_error',
      `Lỗi xử lý OCR tài liệu "${file.name}": ${errorMsg}`,
      { error: errorMsg, abortReason },
      durationMs,
    );
    if (controller.signal.aborted) {
      throw new Error(errorMsg);
    }
    throw error;
  } finally {
    window.clearTimeout(totalTimeout);
    window.clearTimeout(idleTimeout);
  }
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

  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log(
    'info',
    'refine_start',
    `Bắt đầu chuẩn hóa danh pháp y tế tự động cho ${member.name} (${events.length} sự kiện)`,
    { memberId: member.id, eventCount: events.length }
  );

  try {
    const data = await callServerGemini<{
      success: boolean;
      organizedTimeline: HealthEvent[];
      refinementNotes: string[];
    }>('refine-and-organize', {
      member,
      events,
    });

    const durationMs = getDuration();
    const finalTimeline = Array.isArray(data.organizedTimeline) ? data.organizedTimeline : events;
    const notes = Array.isArray(data.refinementNotes) ? data.refinementNotes : ['Đã chuẩn hóa dữ liệu.'];
    digitizationLogger.log(
      'info',
      'refine_complete',
      `Chuẩn hóa danh pháp y tế hoàn tất trong ${durationMs}ms (${finalTimeline.length} sự kiện đã xử lý)`,
      { durationMs, organizedCount: finalTimeline.length, notesCount: notes.length },
      durationMs
    );

    return {
      organizedTimeline: finalTimeline,
      refinementNotes: notes,
    };
  } catch (error) {
    const durationMs = getDuration();
    digitizationLogger.log(
      'error',
      'refine_error',
      `Lỗi khi chuẩn hóa danh pháp y tế: ${error instanceof Error ? error.message : 'Unknown'}`,
      undefined,
      durationMs
    );
    throw error;
  }
}

// ============================================================================
// NHÓM NHIỆM VỤ 2: PHÂN TÍCH, ĐÁNH GIÁ TOÀN DIỆN HỒ SƠ Y TẾ & TƯ VẤN LỜI KHUYÊN (DEEP INSIGHT)
// Sử dụng CỐ ĐỊNH Server-Side Gemini API: gemini-3.6-flash (Phân tích 4 lớp y khoa)
// ============================================================================

/**
 * Phân tích, đánh giá toàn diện hồ sơ y tế và đưa ra tổng kết tình hình sức khỏe
 */
export async function summarizeHealthProfile(
  member: FamilyMember,
  profile: HealthProfile
): Promise<string> {
  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log(
    'info',
    'summary_start',
    `Bắt đầu tổng kết hồ sơ sức khỏe cho ${member.name} (${profile.timeline.length} sự kiện)`,
    { memberId: member.id, eventCount: profile.timeline.length }
  );
  try {
    const data = await callServerGemini<{ success: boolean; summary: string }>('summarize', {
      member,
      profile,
    });
    if (typeof data.summary !== 'string' || !data.summary.trim()) {
      throw new Error('AI chưa trả về bản tóm tắt hợp lệ. Vui lòng thử lại sau.');
    }
    const durationMs = getDuration();
    digitizationLogger.log(
      'info',
      'summary_complete',
      `Tổng kết hồ sơ sức khỏe hoàn tất trong ${durationMs}ms (${data.summary.length} ký tự)`,
      { durationMs, length: data.summary.length },
      durationMs
    );
    return data.summary.trim();
  } catch (error) {
    const durationMs = getDuration();
    digitizationLogger.log(
      'error',
      'summary_error',
      `Lỗi tổng kết hồ sơ cho ${member.name}: ${error instanceof Error ? error.message : 'Unknown'}`,
      undefined,
      durationMs
    );
    throw error;
  }
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
  if (typeof data.answer !== 'string' || !data.answer.trim()) {
    throw new Error('Trợ lý AI chưa trả về câu trả lời hợp lệ. Vui lòng thử lại.');
  }
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
  const token = await getAuthenticatedUserToken();
  const response = await fetch(buildApiUrl('/api/gemini/ask-assistant'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(ASSISTANT_REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ question, member, profile, stream: true }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(errorBody?.error || `Máy chủ trợ lý AI trả về mã lỗi ${response.status}.`);
  }
  if (!response.body) {
    throw new Error('Máy chủ trợ lý AI không trả về luồng phản hồi. Vui lòng thử lại.');
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
          const parsed = JSON.parse(payload) as { text?: string; type?: string; error?: string };
          if (parsed.type === 'error') {
            throw new Error(parsed.error || 'Trợ lý Gemini không thể trả lời.');
          }
          if (parsed.text) {
            fullText += parsed.text;
            onChunk(parsed.text);
          }
        } catch (error) {
          if (error instanceof SyntaxError) continue;
          throw error;
        }
      }
    }
  }
  return fullText;
}

/**
 * Đưa ra phân tích chuyên sâu đa chiều và cảnh báo rủi ro sức khỏe bằng gemini-3.6-flash
 */
export async function analyzeComprehensiveHealth(
  member: FamilyMember,
  profile: HealthProfile,
  model: string = 'gemini-3.6-flash'
): Promise<{ result: AiDeepAnalysisResult; aiAnalysis: AiAnalysisBlock; modelUsed?: string }> {
  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log(
    'info',
    'deep_analysis_start',
    `Bắt đầu phân tích y khoa chuyên sâu 4 lớp (${model}) cho ${member.name} (${profile.timeline.length} sự kiện)`,
    { memberId: member.id, model, eventCount: profile.timeline.length }
  );

  try {
    const data = await callServerGemini<{
      success: boolean;
      result: AiDeepAnalysisResult;
      aiAnalysis?: AiAnalysisBlock;
      modelUsed?: string;
    }>('analyze-comprehensive', {
      member,
      profile,
      model,
    });

    const rawResult = isRecord(data?.result) ? (data.result as Record<string, any>) : {};
    const rawRoadmap = isRecord(rawResult.roadmap) ? (rawResult.roadmap as Record<string, any>) : {};
    const rawTimePlan = isRecord(rawRoadmap.timeBoundPlan) ? (rawRoadmap.timeBoundPlan as Record<string, any>) : {};

    const result: AiDeepAnalysisResult = {
      analyzedAt: typeof rawResult.analyzedAt === 'string' ? rawResult.analyzedAt : new Date().toISOString(),
      healthScore: typeof rawResult.healthScore === 'number' && Number.isFinite(rawResult.healthScore) ? rawResult.healthScore : 80,
      overallAssessment: typeof rawResult.overallAssessment === 'string' && rawResult.overallAssessment.trim()
        ? rawResult.overallAssessment
        : `Dựa trên hồ sơ y tế của ${member.name}, hệ thống đã ghi nhận và phân tích dữ liệu sức khỏe.`,
      crossCorrelations: Array.isArray(rawResult.crossCorrelations) ? rawResult.crossCorrelations : [],
      velocityTrends: Array.isArray(rawResult.velocityTrends) ? rawResult.velocityTrends : [],
      chronicSurveillance: Array.isArray(rawResult.chronicSurveillance) ? rawResult.chronicSurveillance : [],
      roadmap: {
        criticalAlerts: Array.isArray(rawRoadmap.criticalAlerts) ? rawRoadmap.criticalAlerts : [],
        specialistReferrals: Array.isArray(rawRoadmap.specialistReferrals) ? rawRoadmap.specialistReferrals : [],
        timeBoundPlan: {
          next3Months: Array.isArray(rawTimePlan.next3Months) ? rawTimePlan.next3Months : [],
          next6Months: Array.isArray(rawTimePlan.next6Months) ? rawTimePlan.next6Months : [],
          next12Months: Array.isArray(rawTimePlan.next12Months) ? rawTimePlan.next12Months : [],
        },
      },
    };

    const aiAnalysisFallback: AiAnalysisBlock = {
      lastAnalyzedDate: new Date().toISOString().slice(0, 10),
      overviewSummary: result.overallAssessment,
      criticalAlerts: result.roadmap.criticalAlerts,
      chronicConditionsTracking: result.chronicSurveillance.map(
        (c) => `${c.conditionName}: ${c.comparisonOverTime || c.recommendation}`
      ),
      actionRoadmap: {
        specialistConsultation: result.roadmap.specialistReferrals.map((s) => s.specialty),
        dietaryModifications: result.roadmap.timeBoundPlan.next3Months.filter((i) =>
          /chế độ ăn|kiêng|purin|rượu|nước|dinh dưỡng/i.test(i)
        ),
        followUpSchedule: result.roadmap.timeBoundPlan.next3Months.find((i) =>
          /tái khám|kiểm tra lại|xét nghiệm/i.test(i)
        ) || 'Tái khám kiểm tra lại sau 3 tháng.',
      },
    };

    const durationMs = getDuration();
    const finalModel = data.modelUsed || model;
    digitizationLogger.log(
      'info',
      'deep_analysis_complete',
      `Phân tích y khoa 4 lớp hoàn tất trong ${durationMs}ms bằng ${finalModel}. Cảnh báo: ${result.roadmap.criticalAlerts.length}, Chuyên khoa: ${result.roadmap.specialistReferrals.length}, Xu hướng: ${result.velocityTrends.length}`,
      {
        durationMs,
        modelUsed: finalModel,
        criticalAlertsCount: result.roadmap.criticalAlerts.length,
        specialistCount: result.roadmap.specialistReferrals.length,
        velocityTrendsCount: result.velocityTrends.length,
      },
      durationMs
    );

    return {
      result,
      aiAnalysis: data.aiAnalysis || aiAnalysisFallback,
      modelUsed: finalModel,
    };
  } catch (error) {
    const durationMs = getDuration();
    digitizationLogger.log(
      'error',
      'deep_analysis_error',
      `Lỗi phân tích chuyên sâu cho ${member.name}: ${error instanceof Error ? error.message : 'Unknown'}`,
      undefined,
      durationMs
    );
    throw error;
  }
}

/**
 * Tải log hệ thống từ server (bao gồm các bước xoay vòng key, retry OCR)
 */
export async function fetchServerLogs(): Promise<any[]> {
  const token = await getAuthenticatedUserToken();
  const response = await fetch(buildApiUrl('/api/gemini/digitization-logs'), {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Không thể tải log từ server (Mã lỗi: ${response.status}).`);
  }
  const data = await response.json();
  return Array.isArray(data.logs) ? data.logs : [];
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

function normalizeExtractedEvent(value: Record<string, unknown>, fileName?: string): Partial<HealthEvent> {
  const medications: Medication[] = Array.isArray(value.medications)
    ? value.medications.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
        return [
          {
            name: item.name.trim(),
            dosage: optionalString(item.dosage),
            quantity: optionalString(item.quantity),
            frequency: optionalString(item.frequency),
            timing: optionalString(item.timing),
            duration: optionalString(item.duration),
            instructions: optionalString(item.instructions),
          },
        ];
      })
    : [];

  const metrics: HealthMetric[] = Array.isArray(value.metrics)
    ? value.metrics.flatMap((item) => {
        if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
        const numericValue = typeof item.value === 'number' ? item.value : Number(item.value);
        if (!Number.isFinite(numericValue)) return [];
        return [
          {
            name: item.name.trim(),
            standardKey: optionalString(item.standardKey),
            value: numericValue,
            unit: optionalString(item.unit) || '',
            refRange: optionalString(item.refRange),
            status: optionalString(item.status),
          },
        ];
      })
    : [];

  const imagingResults: ImagingResult[] = Array.isArray(value.imagingResults)
    ? value.imagingResults.flatMap((item) => {
        if (!isRecord(item)) return [];
        const modality = optionalString(item.modality) || '';
        const findings = optionalString(item.findings) || '';
        const conclusion = optionalString(item.conclusion) || '';
        if (!modality && !findings && !conclusion) return [];
        return [{ modality, findings, conclusion }];
      })
    : [];

  const vaccinations: VaccinationRecord[] = Array.isArray(value.vaccinations)
    ? value.vaccinations.flatMap((item) => {
        if (!isRecord(item) || typeof item.vaccineName !== 'string' || !item.vaccineName.trim()) return [];
        return [{
          vaccineName: item.vaccineName.trim(),
          targetDisease: optionalString(item.targetDisease),
          doseNumber: typeof item.doseNumber === 'string' || typeof item.doseNumber === 'number'
            ? item.doseNumber
            : undefined,
          lotNumber: optionalString(item.lotNumber),
          manufacturer: optionalString(item.manufacturer),
          injectionSite: optionalString(item.injectionSite),
          administeredDate: optionalString(item.administeredDate) || '',
          nextDoseDate: optionalString(item.nextDoseDate) || null,
          reactionNotes: optionalString(item.reactionNotes),
        }];
      })
    : [];
  const hospitalization: HospitalizationRecord | undefined = isRecord(value.hospitalization)
    ? {
        admissionDate: optionalString(value.hospitalization.admissionDate),
        dischargeDate: optionalString(value.hospitalization.dischargeDate),
        department: optionalString(value.hospitalization.department),
        treatmentSummary: optionalString(value.hospitalization.treatmentSummary),
        surgicalNotes: optionalString(value.hospitalization.surgicalNotes),
      }
    : undefined;
  const physicalExam = isRecord(value.physicalExam)
    ? {
        height_cm: typeof value.physicalExam.height_cm === 'number' ? value.physicalExam.height_cm : undefined,
        weight_kg: typeof value.physicalExam.weight_kg === 'number' ? value.physicalExam.weight_kg : undefined,
        bmi: typeof value.physicalExam.bmi === 'number' ? value.physicalExam.bmi : undefined,
        bp_mmHg: optionalString(value.physicalExam.bp_mmHg),
        pulse_bpm: typeof value.physicalExam.pulse_bpm === 'number' ? value.physicalExam.pulse_bpm : undefined,
        classification: optionalString(value.physicalExam.classification),
      }
    : undefined;

  return {
    title: optionalString(value.title),
    date: isIsoDate(value.date) ? value.date : undefined,
    type: classifyHealthEventType(value as Partial<HealthEvent> & Record<string, unknown>, fileName),
    facility: optionalString(value.facility),
    doctorName: optionalString(value.doctorName),
    customCategory: optionalString(value.customCategory),
    physicalExam,
    diagnoses: Array.isArray(value.diagnoses)
      ? value.diagnoses
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .map((item) => item.trim())
      : [],
    medications,
    metrics,
    imagingResults,
    vaccinations,
    hospitalization,
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
