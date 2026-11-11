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
import { callGeminiEndpoint } from './geminiTasks';
import { generateGeminiContent } from './geminiSharedResources';
import { splitPdfIntoBatches, PdfPageBatchError } from './pdfPageBatches';
import { mergeExtractedBatches, type ExtractedPageBatch } from './healthDocumentExtraction';

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

  return msg;
}

async function callGemini<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const getDuration = digitizationLogger.startTimer();
  digitizationLogger.log('info', 'api', `Gọi trực tiếp Gemini cho tác vụ ${endpoint}.`, { endpoint });
  try {
    const data = await callGeminiEndpoint<T>(endpoint, body);
    const durationMs = getDuration();
    digitizationLogger.log(
      'info',
      'api',
      `Gemini hoàn tất tác vụ ${endpoint} trực tiếp (${durationMs}ms).`,
      { endpoint },
      durationMs,
    );
    return data;
  } catch (error) {
    const durationMs = getDuration();
    digitizationLogger.log(
      'error',
      'api',
      `Gemini thất bại ở tác vụ ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      { endpoint },
      durationMs,
    );
    throw error;
  }
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

async function extractDirectHealthEvent(
  file: File,
  member: FamilyMember,
  mimeType: string,
  base64Data: string,
  onProgress: ((update: ExtractionProgressUpdate) => void) | undefined,
  getDuration: () => number,
): Promise<{ extracted: Partial<HealthEvent>; modelUsed?: string; totalPages?: number; processedPages?: number }> {
  if (file.size > 25 * 1024 * 1024) throw new Error('Tệp vượt quá giới hạn 25 MB.');
  if (mimeType !== 'application/pdf' && !/^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(mimeType)) {
    throw new Error('Chỉ hỗ trợ tài liệu PDF hoặc ảnh JPEG, PNG, WebP, GIF, HEIC, HEIF.');
  }

  const batches = mimeType === 'application/pdf'
    ? await splitPdfIntoBatches(base64Data, 5, 60)
    : [{ firstPage: 1, lastPage: 1, base64Data }];
  const memberBirth = member.birthDate ? `sinh ngày ${member.birthDate}` : '';
  const fileYear = file.name.match(/\b(?:19|20)\d{2}\b/)?.[0];
  const systemInstruction = `Bạn là chuyên gia OCR tài liệu y khoa Việt Nam. Trích xuất chính xác, súc tích, không suy diễn thông tin từ tài liệu cho ${member.name} ${memberBirth}.
Ngày khám: ưu tiên ngày thực tế khám/xét nghiệm/ký bác sĩ; không dùng ngày sinh, ngày in phiếu hoặc ngày hẹn tái khám. ${fileYear ? `Tên tệp có năm ${fileYear}; ưu tiên ngày khám cùng năm nếu tài liệu xác nhận.` : ''}
Phân loại theo chủ đề chính: comprehensive_exam (khám tổng quát), test_result, imaging, prescription, vaccination, discharge hoặc other. Nếu other, ghi customCategory và dữ liệu dạng key-value vào extractedData.
Trích xuất facility, doctorName, physicalExam (height_cm, weight_kg, bmi, bp_mmHg, pulse_bpm, classification), diagnoses, medications, vaccinations, hospitalization, metrics (name, standardKey, value, unit, refRange, status), imagingResults (modality, findings ngắn gọn, conclusion), advice, nextFollowUp và notes nếu tài liệu có. Giữ nguyên giá trị, đơn vị, liều thuốc; không tự chẩn đoán hoặc bổ sung kết quả. Bỏ qua trang bìa, thủ tục hành chính và ảnh thô không có kết luận. Chỉ trả JSON object hợp lệ với các trường có căn cứ.`;
  const extractedBatches: ExtractedPageBatch[] = [];
  const modelNames = new Set<string>();

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const totalPages = batches[batches.length - 1].lastPage;
    onProgress?.({
      stage: 'waiting_for_model',
      progressPercent: 48 + Math.floor((index / batches.length) * 40),
      message: batches.length > 1
        ? `Đang xử lý trang ${batch.firstPage}-${batch.lastPage} (${index + 1}/${batches.length})...`
        : 'Gemini đang đọc tài liệu...',
      modelUsed: 'gemini-3.5-flash-lite',
      totalPages,
      processedPages: batch.firstPage - 1,
    });

    const prompt = `Đọc tài liệu của ${member.name}. ${batches.length > 1
      ? `Đây là các trang ${batch.firstPage}-${batch.lastPage}; chỉ trích xuất nội dung trong các trang này.`
      : 'Trích xuất các thông tin y tế có trong tài liệu.'}
Trả duy nhất JSON object chuẩn. Với chỉ số xét nghiệm, giữ tên, giá trị, đơn vị, khoảng tham chiếu và trạng thái nếu nhìn thấy. Với thuốc, giữ tên/liều/lần dùng/thời gian.`;
    const { text, modelUsed } = await generateGeminiContent(
      'gemini-3.5-flash-lite',
      [{ inlineData: { mimeType, data: batch.base64Data } }, { text: prompt }],
      { systemInstruction, responseMimeType: 'application/json' },
    );
    modelNames.add(modelUsed);
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('Gemini không trả về JSON OCR hợp lệ.');
    const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Gemini không trả về dữ liệu OCR hợp lệ.');
    }
    extractedBatches.push({
      firstPage: batch.firstPage,
      lastPage: batch.lastPage,
      extracted: parsed as Record<string, unknown>,
    });
    onProgress?.({
      stage: 'extracting_content',
      progressPercent: 50 + Math.floor(((index + 1) / batches.length) * 40),
      message: `Đã đọc ${batch.lastPage}/${totalPages} trang.`,
      modelUsed,
      partialEvent: normalizeExtractedEvent(
        mergeExtractedBatches(extractedBatches, undefined, file.name),
        file.name,
      ),
      totalPages,
      processedPages: batch.lastPage,
    });
  }

  const totalPages = batches[batches.length - 1].lastPage;
  const extracted = normalizeExtractedEvent(
    mergeExtractedBatches(extractedBatches, undefined, file.name),
    file.name,
  );
  if (
    !extracted.title &&
    !extracted.patientName &&
    !extracted.diagnoses?.length &&
    !extracted.medications?.length &&
    !extracted.metrics?.length &&
    !extracted.advice &&
    !extracted.notes
  ) {
    throw new Error('AI không trích xuất được thông tin có thể xác nhận từ tài liệu. Hãy nhập thủ công hoặc thử lại.');
  }

  const modelUsed = Array.from(modelNames).join(', ');
  const durationMs = getDuration();
  digitizationLogger.log('info', 'ocr_complete', `OCR trực tiếp hoàn tất trong ${durationMs}ms bằng ${modelUsed}.`, {
    durationMs,
    modelUsed,
    totalPages,
    processedPages: totalPages,
  }, durationMs);
  onProgress?.({
    stage: 'matching_patient',
    progressPercent: 96,
    message: 'Đang đối chiếu người bệnh với thành viên gia đình...',
    modelUsed,
    partialEvent: extracted,
    totalPages,
    processedPages: totalPages,
  });
  onProgress?.({
    stage: 'completed',
    progressPercent: 100,
    message: 'Hoàn tất số hóa tài liệu y tế!',
    modelUsed,
    partialEvent: extracted,
    totalPages,
    processedPages: totalPages,
  });
  return { extracted, modelUsed, totalPages, processedPages: totalPages };
}

/**
 * Trích xuất sự kiện y tế từ tệp tài liệu / ảnh chụp kèm theo luồng cập nhật tiến trình và nội dung trực tiếp
 */
export async function extractHealthEventWithProgress(
  file: File,
  member: FamilyMember,
  onProgress?: (update: ExtractionProgressUpdate) => void,
): Promise<{ extracted: Partial<HealthEvent>; modelUsed?: string; totalPages?: number; processedPages?: number }> {
  const getDuration = digitizationLogger.startTimer();
  const mimeType = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  digitizationLogger.log(
    'info',
    'ocr_start',
    `Bắt đầu OCR trực tiếp với Gemini cho "${file.name}" (${(file.size / 1024).toFixed(1)} KB, ${mimeType})`,
    { fileName: file.name, fileSize: file.size, mimeType, memberId: member.id, memberName: member.name },
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
    return await extractDirectHealthEvent(file, member, mimeType, base64Data, onProgress, getDuration);
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

/**
 * Hỏi đáp trợ lý sức khỏe với phản hồi truyền phát trực tiếp (Streaming SSE)
 */
export async function streamHealthAssistant(
  question: string,
  member: FamilyMember,
  profile: HealthProfile,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const data = await callGemini<{ answer: string }>('ask-assistant', { question, member, profile });
  if (typeof data.answer !== 'string' || !data.answer.trim()) {
    throw new Error('Trợ lý AI chưa trả về câu trả lời hợp lệ. Vui lòng thử lại.');
  }
  onChunk(data.answer);
  return data.answer;
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
