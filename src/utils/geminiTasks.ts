import { generateGeminiContent } from './geminiSharedResources';
import { prepareDataForDeepDive } from './healthRecordService';

type JsonRecord = Record<string, unknown>;

function parseJsonResponse(text: string): JsonRecord {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Gemini không trả về JSON hợp lệ.');
  const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Gemini không trả về một JSON object hợp lệ.');
  }
  return value as JsonRecord;
}

function stringify(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

export async function callGeminiEndpoint<T>(
  endpoint: string,
  body: JsonRecord,
): Promise<T> {
  const member = (body.member && typeof body.member === 'object' ? body.member : {}) as JsonRecord;
  const profile = body.profile && typeof body.profile === 'object' ? body.profile as JsonRecord : {};
  const memberName = typeof member.name === 'string' ? member.name : 'Thành viên';
  const analysisProfile = prepareDataForDeepDive(member, profile);
  let model = 'gemini-3.5-flash-lite';
  let prompt: string;
  let jsonResponse = false;

  switch (endpoint) {
    case 'refine-and-organize': {
      const events = Array.isArray(body.events) ? body.events : [];
      if (events.length === 0) {
        return {
          success: true,
          organizedTimeline: [],
          refinementNotes: ['Chưa có sự kiện y tế nào để hiệu chỉnh.'],
        } as T;
      }
      prompt = `Bạn là chuyên gia chuẩn hóa hồ sơ y tế cho ${memberName}.
Dữ liệu sự kiện:
${stringify(events)}

Chuẩn hóa tên sự kiện, loại sự kiện, chẩn đoán, ngày tháng, liều thuốc và chỉ số. Giữ nguyên ID của từng sự kiện, không tự tạo dữ liệu không có căn cứ. Trả duy nhất JSON:
{"organizedEvents":[...],"refinementNotes":["..."]}`;
      jsonResponse = true;
      break;
    }
    case 'summarize':
      prompt = `Bạn là trợ lý sức khỏe gia đình. Dựa trên hồ sơ sau, viết tóm tắt tiếng Việt ngắn gọn về hiện trạng, xu hướng chỉ số và lời khuyên dinh dưỡng/vận động/tái khám. Không chẩn đoán thay bác sĩ; thiếu dữ liệu phải nói rõ, không suy diễn bình thường.
Thành viên: ${memberName}
Hồ sơ đã tối ưu: ${stringify(analysisProfile)}
Trả duy nhất JSON: {"summary":"..."}`;
      jsonResponse = true;
      break;
    case 'ask-assistant':
      prompt = `Bạn là trợ lý sức khỏe gia đình, trả lời tiếng Việt rõ ràng, ân cần và căn cứ vào hồ sơ được cung cấp. Không chẩn đoán thay bác sĩ; nhắc người dùng liên hệ bác sĩ khi có dấu hiệu khẩn cấp.
Thành viên: ${memberName}
Câu hỏi: ${String(body.question || '')}
Tóm tắt hồ sơ: ${stringify(profile.summary)}
Lịch sử gần đây: ${stringify(Array.isArray(profile.timeline) ? profile.timeline.slice(-6) : [])}`;
      break;
    case 'analyze-comprehensive':
      model = typeof body.model === 'string' ? body.model : 'gemini-3.6-flash';
      prompt = `Bạn là hội đồng chuyên gia y khoa gia đình. Phân tích hồ sơ của ${memberName} theo 4 phần: tương quan chéo, xu hướng theo thời gian, theo dõi bệnh mạn tính, và lộ trình hành động. Chỉ kết luận dựa trên dữ liệu; thiếu dữ liệu không đồng nghĩa bình thường; không chẩn đoán hay suy diễn. Trả duy nhất JSON đúng cấu trúc:
{"healthScore":0,"overallAssessment":"...","crossCorrelations":[{"parameters":["..."],"findings":"...","severity":"critical|warning|info"}],"velocityTrends":[{"metricName":"...","trendDirection":"increasing|decreasing|stable|fluctuating","velocityDescription":"...","riskProjection":"..."}],"chronicSurveillance":[{"conditionName":"...","status":"stable_benign|monitored|progressing|resolved","comparisonOverTime":"...","recommendation":"..."}],"roadmap":{"criticalAlerts":["..."],"specialistReferrals":[{"specialty":"...","reason":"..."}],"timeBoundPlan":{"next3Months":["..."],"next6Months":["..."],"next12Months":["..."]}}}
HỒ SƠ ĐÃ TỐI ƯU: ${stringify(analysisProfile)}`;
      jsonResponse = true;
      break;
    default:
      throw new Error(`Tác vụ Gemini "${endpoint}" chưa được hỗ trợ trực tiếp trong ứng dụng.`);
  }

  const { text, modelUsed } = await generateGeminiContent(
    model,
    [{ text: prompt }],
    { responseMimeType: jsonResponse ? 'application/json' : undefined },
  );
  if (endpoint === 'ask-assistant') {
    return { success: true, answer: text, modelUsed } as T;
  }

  const parsed = parseJsonResponse(text);
  if (endpoint === 'refine-and-organize') {
    return {
      success: true,
      organizedTimeline: Array.isArray(parsed.organizedEvents) ? parsed.organizedEvents : body.events,
      refinementNotes: Array.isArray(parsed.refinementNotes) ? parsed.refinementNotes : ['Đã chuẩn hóa dữ liệu.'],
      modelUsed,
    } as T;
  }
  if (endpoint === 'summarize') {
    return {
      success: true,
      summary: typeof parsed.summary === 'string' ? parsed.summary : text,
      modelUsed,
    } as T;
  }
  return {
    success: true,
    result: { ...parsed, analyzedAt: new Date().toISOString() },
    modelUsed,
  } as T;
}
