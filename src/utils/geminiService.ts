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
import { digitizationLogger } from './digitizationLogger';
import { classifyHealthEventType, isHealthEventType } from './healthEventType';
import { splitPdfIntoBatches, PdfPageBatchError } from './pdfPageBatches';
import { mergeExtractedBatches, type ExtractedPageBatch } from './healthDocumentExtraction';
import { getValidGoogleAccessToken } from './googleDriveService';
import { getSharedGeminiKeys } from './geminiSharedResources';

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

export function cleanErrorMessage(rawMessage?: string): string {
  if (!rawMessage) return 'Có lỗi xảy ra khi xử lý dịch vụ AI.';
  let msg = typeof rawMessage === 'string' ? rawMessage.trim() : String(rawMessage);

  for (let depth = 0; depth < 3; depth++) {
    if ((msg.startsWith('{') && msg.endsWith('}')) || (msg.startsWith('[') && msg.endsWith(']'))) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.error === 'string') msg = parsed.error;
          else if (typeof parsed.error?.message === 'string') msg = parsed.error.message;
          else if (typeof parsed.message === 'string') msg = parsed.message;
          else break;
        } else break;
      } catch {
        break;
      }
    } else break;
  }

  if (/DEADLINE_EXCEEDED|504|Deadline expired|deadline/i.test(msg)) {
    return 'Yêu cầu AI xử lý bị quá thời gian chờ từ máy chủ Google (504 Deadline Exceeded). Vui lòng thử lại.';
  }
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(msg)) {
    return 'Hạn ngạch AI tạm thời đạt giới hạn (429 Quota Exhausted). Vui lòng thử lại sau ít phút.';
  }
  if (/503|UNAVAILABLE|high demand|overloaded/i.test(msg)) {
    return 'Máy chủ AI Google hiện đang bận hoặc quá tải (503 Service Unavailable). Vui lòng thử lại sau ít giây.';
  }
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
    return 'Không thể kết nối đến máy chủ AI (Lỗi mạng hoặc kết nối). Vui lòng kiểm tra đường truyền và thử lại.';
  }

  return msg;
}

async function callGemini<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const getDuration = digitizationLogger.startTimer();
  const apiBase = (import.meta.env.VITE_BACKEND_URL || '').trim().replace(/\/+$/, '');
  const url = `${apiBase}/api/gemini/${endpoint}`;
  
  digitizationLogger.log('info', 'api', `Gọi Gemini server cho tác vụ ${endpoint}.`, { endpoint });

  const maxRetries = 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      let headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      try {
        const token = await getValidGoogleAccessToken().catch(() => null);
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } catch (e) {
        console.warn('[Gemini Service] Could not attach auth token:', e);
      }

      const clientGeminiKeys = getSharedGeminiKeys();

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, clientGeminiKeys }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const status = response.status;
        const msg = errorData.error || `Server Gemini trả về mã lỗi ${status}`;
        
        if ((status === 502 || status === 503 || status === 504) && attempt < maxRetries - 1) {
          const backoff = (attempt + 1) * 2000;
          digitizationLogger.log('warn', 'api', `Mã lỗi ${status} từ server ở tác vụ ${endpoint}; thử lại lần ${attempt + 1}/${maxRetries} sau ${backoff}ms...`);
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }
        throw new Error(msg);
      }

      const data = await response.json();
      const durationMs = getDuration();
      digitizationLogger.log(
        'info',
        'api',
        `Gemini hoàn tất tác vụ ${endpoint} qua server (${durationMs}ms).`,
        { endpoint },
        durationMs,
      );
      return data;
    } catch (error) {
      lastError = error;
      const isFetchError =
        error instanceof TypeError ||
        (error instanceof Error && /failed to fetch|networkerror|load failed|network request failed/i.test(error.message));

      if (isFetchError && attempt < maxRetries - 1) {
        const backoff = (attempt + 1) * 2000;
        digitizationLogger.log(
          'warn',
          'api',
          `Kết nối tới Gemini server ở tác vụ ${endpoint} bị gián đoạn (thử lại lần ${attempt + 1}/${maxRetries} sau ${backoff}ms)...`,
          { endpoint, attempt },
        );
        await new Promise((res) => setTimeout(res, backoff));
        continue;
      }
      break;
    }
  }

  const durationMs = getDuration();
  const errorMessage = cleanErrorMessage(lastError instanceof Error ? lastError.message : String(lastError));
  digitizationLogger.log(
    'error',
    'api',
    `Gemini server thất bại ở tác vụ ${endpoint}: ${errorMessage}`,
    { endpoint },
    durationMs,
  );
  throw lastError instanceof Error ? lastError : new Error(errorMessage);
}

// ============================================================================
// NHÓM NHIỆM VỤ 1: SỐ HÓA, OCR, NHẬN DẠNG TÀI LIỆU, HIỆU CHỈNH & SẮP XẾP DỮ LIỆU
// OCR uses gemini-3.5-flash-lite directly from both web and native clients.
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

async function extractServerHealthEvent(
  file: File,
  member: FamilyMember,
  mimeType: string,
  base64Data: string,
  onProgress: ((update: ExtractionProgressUpdate) => void) | undefined,
  getDuration: () => number,
  options?: { isAutoDetect?: boolean },
): Promise<{ extracted: Partial<HealthEvent>; modelUsed?: string; totalPages?: number; processedPages?: number }> {
  const apiBase = (import.meta.env.VITE_BACKEND_URL || '').trim().replace(/\/+$/, '');
  const url = `${apiBase}/api/gemini/extract-health-event`;

  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  try {
    const token = await getValidGoogleAccessToken().catch(() => null);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } catch (e) {
    console.warn('[Gemini Service] Could not attach auth token for extraction:', e);
  }

  const clientGeminiKeys = getSharedGeminiKeys();

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base64Data,
      mimeType,
      member,
      fileName: file.name,
      stream: true,
      clientGeminiKeys,
      isAutoDetect: options?.isAutoDetect ?? false,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Server Gemini trả về mã lỗi ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Không thể khởi tạo luồng dữ liệu từ server AI.');

  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: { extracted: Partial<HealthEvent>; modelUsed?: string; totalPages?: number; processedPages?: number } | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const json = JSON.parse(line.slice(6));
        if (json.type === 'progress') {
          onProgress?.({
            stage: 'extracting_content',
            progressPercent: json.progressPercent || 50,
            message: json.message || 'AI đang xử lý...',
            modelUsed: json.modelUsed,
            totalPages: json.totalPages,
            processedPages: json.processedPages,
            partialEvent: json.extracted ? normalizeExtractedEvent(json.extracted, file.name) : undefined,
          });
        } else if (json.type === 'complete') {
          finalResult = {
            extracted: normalizeExtractedEvent(json.extracted, file.name),
            modelUsed: json.modelUsed,
            totalPages: json.totalPages,
            processedPages: json.processedPages,
          };
        } else if (json.type === 'error') {
          throw new Error(json.error || 'Lỗi xử lý từ server AI.');
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Lỗi xử lý từ server AI')) throw e;
        console.warn('[Gemini Service] Failed to parse SSE line:', line, e);
      }
    }
  }

  if (!finalResult) throw new Error('AI không trả về kết quả cuối cùng.');

  const durationMs = getDuration();
  digitizationLogger.log('info', 'ocr_complete', `OCR qua server hoàn tất trong ${durationMs}ms bằng ${finalResult.modelUsed}.`, {
    durationMs,
    modelUsed: finalResult.modelUsed,
    totalPages: finalResult.totalPages,
    processedPages: finalResult.processedPages,
  }, durationMs);

  onProgress?.({
    stage: 'completed',
    progressPercent: 100,
    message: 'Hoàn tất số hóa tài liệu y tế!',
    modelUsed: finalResult.modelUsed,
    partialEvent: finalResult.extracted,
    totalPages: finalResult.totalPages,
    processedPages: finalResult.processedPages,
  });

  return finalResult;
}

/**
 * Trích xuất sự kiện y tế từ tệp tài liệu / ảnh chụp kèm theo luồng cập nhật tiến trình và nội dung trực tiếp
 */
export async function extractHealthEventWithProgress(
  file: File,
  member: FamilyMember,
  onProgress?: (update: ExtractionProgressUpdate) => void,
  options?: { isAutoDetect?: boolean },
): Promise<{ extracted: Partial<HealthEvent>; modelUsed?: string; totalPages?: number; processedPages?: number }> {
  const getDuration = digitizationLogger.startTimer();
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  digitizationLogger.log(
    'info',
    'ocr_start',
    `Bắt đầu OCR trực tiếp với Gemini cho "${file.name}" (${(file.size / 1024).toFixed(1)} KB, ${mimeType})`,
    { fileName: file.name, fileSize: file.size, mimeType, memberId: member.id, memberName: member.name, isAutoDetect: options?.isAutoDetect },
  );
  onProgress?.({ stage: 'preparing', progressPercent: 25, message: 'Đang chuẩn bị dữ liệu và mã hóa tệp...' });

  try {
    const base64Data = await fileToBase64(file);
    onProgress?.({
      stage: 'reading_document',
      progressPercent: 45,
      message: 'Gemini đang đọc tài liệu...',
      modelUsed: 'gemini-3.5-flash-lite',
    });
    return await extractServerHealthEvent(file, member, mimeType, base64Data, onProgress, getDuration, options);
  } catch (error) {
    const durationMs = getDuration();
    const errorMessage = cleanErrorMessage(error instanceof Error ? error.message : String(error));
    digitizationLogger.log(
      'error',
      'ocr_error',
      `Lỗi OCR tài liệu "${file.name}": ${errorMessage}`,
      { fileName: file.name, error: errorMessage },
      durationMs,
    );
    if (error instanceof Error && error.message === errorMessage) throw error;
    throw new Error(errorMessage, { cause: error });
  }
}

export async function extractHealthEvent(
  file: File,
  member: FamilyMember
): Promise<Partial<HealthEvent>> {
  const result = await extractHealthEventWithProgress(file, member);
  return result.extracted;
}

/**
 * Hiệu chỉnh và sắp xếp thông minh toàn bộ dữ liệu thu thập được cho từng thành viên
 * Uses the configured refinement model for web and native requests.
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
    const data = await callGemini<{
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
// Comprehensive analysis uses gemini-3.6-flash.
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
    const data = await callGemini<{ success: boolean; summary: string }>('summarize', {
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
  const data = await callGemini<{ success: boolean; answer: string }>('ask-assistant', {
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

async function callGeminiStream(
  endpoint: string,
  body: Record<string, unknown>,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const apiBase = (import.meta.env.VITE_BACKEND_URL || '').trim().replace(/\/+$/, '');
  const url = `${apiBase}/api/gemini/${endpoint}`;
  
  let headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  try {
    const token = await getValidGoogleAccessToken().catch(() => null);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  } catch (e) {
    console.warn('[Gemini Service] Could not attach auth token for stream:', e);
  }

  const clientGeminiKeys = getSharedGeminiKeys();

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true, clientGeminiKeys }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Server Gemini trả về mã lỗi ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Không thể khởi tạo luồng dữ liệu từ server AI.');

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      
      // Handle both "data: {...}" and raw text if the server sends it directly
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.text) {
            onChunk(json.text);
            fullText += json.text;
          } else if (json.type === 'error') {
            throw new Error(json.error || 'Lỗi xử lý từ server AI.');
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('Lỗi xử lý từ server AI')) throw e;
          // If not valid JSON, maybe it's just raw text chunk
          onChunk(line.slice(6));
          fullText += line.slice(6);
        }
      } else {
        // Raw line (might happen depending on server implementation)
        onChunk(line);
        fullText += line;
      }
    }
  }

  return fullText;
}

/**
 * Hỏi đáp trợ lý sức khỏe với phản hồi truyền phát trực tiếp (Streaming SSE)
 */
export async function streamHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile,
  onChunk: (chunk: string) => void,
): Promise<string> {
  return callGeminiStream('ask-assistant', { question, member, profile }, onChunk);
}

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
    const data = await callGemini<{
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
 * Tải log hệ thống từ server (web only).
 */
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
