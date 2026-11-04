import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';

function getPort(): number {
  const portArgIndex = process.argv.indexOf('--port');
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    const parsed = parseInt(process.argv[portArgIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return Number(process.env.PORT) || 3000;
}

const PORT = getPort();

// 2 nhóm tác vụ được chia lần lượt theo thứ tự ưu tiên của mô hình:
// 1. Số hóa, OCR: gemini-3.5-flash-lite => gemini-3.1-flash-lite
// 2. Phân tích chuyên sâu, trợ lý sức khỏe: gemini-3.8-flash => gemini-3.6-flash => gemini-3-flash => gemini-flash-latest
const TASK_MODELS = {
  digitization: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  analysis: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash', 'gemini-flash-latest'],
};

function getAvailableKeys(clientKeys?: string[]): string[] {
  const keys: string[] = [];

  // 1. Check single GEMINI_API_KEY from environment
  const singleKey = process.env.GEMINI_API_KEY;
  if (singleKey && singleKey.trim().length > 10) {
    keys.push(singleKey.trim());
  }

  // 2. Check multi-key GEMINI_API_KEYS from environment
  const envKeys = process.env.GEMINI_API_KEYS;
  if (envKeys) {
    keys.push(...envKeys.split(/[,;\n]+/).map((k) => k.trim()).filter((k) => k.length > 10));
  }

  // 3. Fallback client-provided custom keys
  if (Array.isArray(clientKeys) && clientKeys.length > 0) {
    keys.push(...clientKeys.filter((k) => typeof k === 'string' && k.trim().length > 10));
  }

  return Array.from(new Set(keys));
}

function cleanJsonOutput(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  }
  return cleaned.trim();
}

function parseJsonSafely(text: string): Record<string, unknown> {
  const cleaned = cleanJsonOutput(text);
  try {
    return cleanExtractedJson(JSON.parse(cleaned));
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return cleanExtractedJson(JSON.parse(match[0]));
    }
    throw new Error('Không thể phân tích dữ liệu trả về từ mô hình AI.');
  }
}

function cleanExtractedJson(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;

  // 1. Khử trùng lặp chẩn đoán
  if (Array.isArray(obj.diagnoses)) {
    const seen = new Set<string>();
    obj.diagnoses = obj.diagnoses.filter((d: any) => {
      if (typeof d !== 'string') return false;
      const norm = d.trim().toLowerCase().replace(/[.,;]$/, '');
      if (!norm || seen.has(norm)) return false;
      seen.add(norm);
      return true;
    });
  }

  // 2. Khử trùng lặp đơn thuốc
  if (Array.isArray(obj.medications)) {
    const medMap = new Map<string, any>();
    for (const m of obj.medications) {
      if (!m || typeof m.name !== 'string' || !m.name.trim()) continue;
      const key = m.name
        .trim()
        .toLowerCase()
        .replace(/\b\d+(\.\d+)?\s*(mg|g|mcg|ml|l|iu|ui|viên|ống|gói|chai)\b/gi, '')
        .trim();
      const existing = medMap.get(key);
      if (!existing) {
        medMap.set(key, m);
      } else {
        medMap.set(key, {
          name: existing.name.length >= m.name.length ? existing.name : m.name,
          dosage: existing.dosage || m.dosage,
          frequency: existing.frequency || m.frequency,
          duration: existing.duration || m.duration,
        });
      }
    }
    obj.medications = Array.from(medMap.values());
  }

  // 3. Khử trùng lặp chỉ số đo
  if (Array.isArray(obj.metrics)) {
    const metricMap = new Map<string, any>();
    for (const metric of obj.metrics) {
      if (!metric || typeof metric.name !== 'string' || !metric.name.trim()) continue;
      const key = metric.name.trim().toLowerCase();
      metricMap.set(key, metric);
    }
    obj.metrics = Array.from(metricMap.values());
  }

  return obj;
}

interface ExecuteOptions {
  task: 'digitization' | 'analysis';
  clientKeys?: string[];
  contents: unknown;
  systemInstruction?: string;
  responseMimeType?: string;
  temperature?: number;
}

async function executeGeminiWithFailover(options: ExecuteOptions): Promise<{ text: string; modelUsed: string }> {
  const keys = getAvailableKeys(options.clientKeys);
  if (keys.length === 0) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trên máy chủ. Hãy thiết lập biến môi trường GEMINI_API_KEY hoặc bổ sung kho API Key.');
  }

  const models = TASK_MODELS[options.task];
  let lastError: Error | null = null;

  for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
    const key = keys[keyIdx];
    const ai = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    for (const model of models) {
      try {
        const config: Record<string, unknown> = {};
        if (options.systemInstruction) {
          config.systemInstruction = options.systemInstruction;
        }
        if (options.responseMimeType) {
          config.responseMimeType = options.responseMimeType;
        }
        // Only set temperature for models that support it (do not pass to gemini-3.8-flash)
        if (model.includes('flash-lite') && typeof options.temperature === 'number') {
          config.temperature = options.temperature;
        }

        const response = await ai.models.generateContent({
          model,
          contents: options.contents as any,
          config,
        });

        const text = response.text || '';
        if (text) {
          return { text, modelUsed: model };
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[Gemini Server] Thử nghiệm model ${model} với key #${keyIdx + 1} không thành công:`, lastError.message);
      }
    }
  }

  throw lastError || new Error('Tất cả các tài khoản Gemini và model đều không phản hồi.');
}

async function startServer() {
  const app = express();

  // Allow up to 50MB for high-resolution medical PDFs / multi-page photos
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Status check endpoint
  app.get('/api/gemini/status', (_req: Request, res: Response) => {
    const serverKeys = getAvailableKeys();
    res.json({
      status: 'ok',
      hasDefaultServerKey: Boolean(process.env.GEMINI_API_KEY),
      hasEnvPoolKeys: Boolean(process.env.GEMINI_API_KEYS),
      totalServerKeys: serverKeys.length,
      supportedTasks: Object.keys(TASK_MODELS),
      taskModels: TASK_MODELS,
      architecture: 'server-side-secure',
    });
  });

  // 1. Trích xuất tài liệu (OCR PDF / ảnh chụp khám bệnh)
  app.post('/api/gemini/extract-health-event', async (req: Request, res: Response) => {
    try {
      const { base64Data, mimeType, member, customKeys } = req.body;
      if (!base64Data) {
        res.status(400).json({ error: 'Thiếu dữ liệu tệp đính kèm (base64).' });
        return;
      }

      const effectiveMime = mimeType || 'application/pdf';
      const memberName = member?.name || 'Thành viên gia đình';
      const memberBirth = member?.birthDate ? `sinh ngày ${member.birthDate}` : '';

      const systemInstruction = `Bạn là trợ lý y tế chuyên số hóa, OCR nhận dạng tài liệu y khoa Việt Nam (đơn thuốc, kết quả xét nghiệm, phiếu khám bệnh, giấy ra viện, sổ tiêm chủng).
Nhiệm vụ: Trích xuất và chuẩn hóa thông tin từ tài liệu đính kèm. Đồng thời phát hiện Họ và tên người bệnh, Ngày sinh/Năm sinh và Giới tính trên tài liệu để hệ thống đối chiếu ghép với thành viên gia đình (${memberName} ${memberBirth}).
QUY TẮC KHỬ TRÙNG LẶP DỮ LIỆU:
- Khử trùng lặp tuyệt đối các chẩn đoán, tên thuốc và chỉ số đo. Mỗi chẩn đoán, mỗi loại thuốc hoặc chỉ số chỉ xuất hiện một lần duy nhất với liều lượng và thông tin chi tiết nhất.
Hãy trả về DUY NHẤT một JSON object tuân thủ đúng cấu trúc:
{
  "title": "Tên ngắn gọn của sự kiện y tế (VD: Khám tổng quát, Đơn thuốc tai mũi họng)",
  "date": "YYYY-MM-DD (ngày khám trên tài liệu)",
  "type": "medical_report" | "prescription" | "test_result" | "vaccination" | "discharge" | "other",
  "patientName": "Họ và tên bệnh nhân ghi trên tài liệu (nếu có, VD: NGUYỄN VĂN A)",
  "patientBirthDate": "YYYY-MM-DD hoặc YYYY (ngày sinh hoặc năm sinh ghi trên tài liệu nếu có)",
  "patientGender": "Nam" | "Nữ" | "Khác" (giới tính ghi trên tài liệu nếu có),
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

      // 1.1 Hỗ trợ Streaming SSE để truyền tiến trình & bóc tách dữ liệu tức thì cho client
      if (req.body.stream) {
        const keys = getAvailableKeys(customKeys);
        if (keys.length === 0) {
          throw new Error('Chưa cấu hình API Key trên máy chủ.');
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let streamResult = null;
        let activeModel = '';

        for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
          const key = keys[keyIdx];
          const ai = new GoogleGenAI({
            apiKey: key,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              },
            },
          });

          for (const model of TASK_MODELS.digitization) {
            try {
              streamResult = await ai.models.generateContentStream({
                model,
                contents: [
                  {
                    inlineData: {
                      mimeType: effectiveMime,
                      data: base64Data,
                    },
                  },
                  {
                    text: `Hãy trích xuất và số hóa toàn bộ thông tin từ tài liệu đính kèm này cho thành viên ${memberName}. Trả về JSON chuẩn.`,
                  },
                ],
                config: {
                  systemInstruction,
                  responseMimeType: 'application/json',
                },
              });
              activeModel = model;
              break;
            } catch (err) {
              console.warn(
                `[Gemini Stream Extract] Model ${model} với key #${keyIdx + 1} không thành công:`,
                err instanceof Error ? err.message : err
              );
            }
          }
          if (streamResult) break;
        }

        if (!streamResult) {
          throw new Error('Tất cả các model số hóa và khóa API đều không thể tạo luồng phản hồi.');
        }

        let accumulated = '';
        for await (const chunk of streamResult) {
          if (chunk.text) {
            accumulated += chunk.text;
            res.write(
              `data: ${JSON.stringify({
                type: 'chunk',
                text: chunk.text,
                accumulated,
                modelUsed: activeModel,
              })}\n\n`
            );
          }
        }

        let parsed: Record<string, unknown> = {};
        try {
          parsed = parseJsonSafely(accumulated);
        } catch {
          // Fallback empty if malformed
        }

        res.write(
          `data: ${JSON.stringify({
            type: 'complete',
            extracted: parsed,
            modelUsed: activeModel,
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // 1.2 Phản hồi tiêu chuẩn dạng JSON
      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'digitization',
        clientKeys: customKeys,
        contents: [
          {
            inlineData: {
              mimeType: effectiveMime,
              data: base64Data,
            },
          },
          {
            text: `Hãy trích xuất và số hóa toàn bộ thông tin từ tài liệu đính kèm này cho thành viên ${memberName}. Trả về JSON chuẩn.`,
          },
        ],
        systemInstruction,
        responseMimeType: 'application/json',
      });

      const parsed = parseJsonSafely(text);
      res.json({ success: true, extracted: parsed, modelUsed });
    } catch (error) {
      console.error('[Gemini Server Extract Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi số hóa tài liệu y tế qua server Gemini API.',
      });
    }
  });

  // 2. Chuẩn hóa & sắp xếp thông minh (Tier flash-lite / flash)
  app.post('/api/gemini/refine-and-organize', async (req: Request, res: Response) => {
    try {
      const { member, events, customKeys } = req.body;
      if (!Array.isArray(events) || events.length === 0) {
        res.json({
          success: true,
          organizedTimeline: [],
          refinementNotes: ['Chưa có sự kiện y tế nào để hiệu chỉnh.'],
        });
        return;
      }

      const memberName = member?.name || 'Thành viên';
      const prompt = `Bạn là chuyên gia chuẩn hóa dữ liệu hồ sơ y tế cho thành viên ${memberName}.
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

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'digitization',
        clientKeys: customKeys,
        contents: [{ text: prompt }],
        responseMimeType: 'application/json',
      });

      const parsed = parseJsonSafely(text) as {
        organizedEvents?: unknown[];
        refinementNotes?: string[];
      };
      res.json({
        success: true,
        organizedTimeline: Array.isArray(parsed.organizedEvents) ? parsed.organizedEvents : events,
        refinementNotes: Array.isArray(parsed.refinementNotes) ? parsed.refinementNotes : ['Đã chuẩn hóa dữ liệu.'],
        modelUsed,
      });
    } catch (error) {
      console.error('[Gemini Server Refine Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi chuẩn hóa dữ liệu.',
      });
    }
  });

  // 3. Tóm tắt hồ sơ sức khỏe (Tier 3.8 flash)
  app.post('/api/gemini/summarize', async (req: Request, res: Response) => {
    try {
      const { member, profile, customKeys } = req.body;
      const memberName = member?.name || 'Thành viên';
      const eventsCount = profile?.timeline?.length || 0;

      const prompt = `Bạn là bác sĩ gia đình và chuyên gia y tế cao cấp.
Hãy đưa ra bản ĐÁNH GIÁ TOÀN DIỆN tình hình sức khỏe cho thành viên ${memberName}.
Thông tin hồ sơ:
- Tổng số sự kiện khám/điều trị đã ghi nhận: ${eventsCount}
- Các chẩn đoán gần đây: ${(profile?.summary?.latestDiagnoses || []).join(', ') || 'Chưa ghi nhận'}
- Các chỉ số sức khỏe gần nhất: ${JSON.stringify(profile?.summary?.latestMetrics || {})}
- Lịch sử diễn tiến bệnh án chi tiết:
${JSON.stringify((profile?.timeline || []).slice(-10), null, 2)}

Yêu cầu phân tích chi tiết:
1. Đánh giá tổng quan hiện trạng sức khỏe, tiến triển các bệnh lý mãn tính/cấp tính.
2. Phân tích xu hướng các chỉ số sinh tồn và xét nghiệm quan trọng (huyết áp, đường huyết, v.v.).
3. Đánh giá phác đồ thuốc hiện tại và lưu ý an toàn/tương tác thuốc.
4. Lời khuyên cụ thể, khoa học về chế độ dinh dưỡng, vận động và lịch tái khám định kỳ.
Trình bày bằng tiếng Việt rõ ràng, ân cần, chia theo các mục tiêu đề chuyên nghiệp.`;

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'analysis',
        clientKeys: customKeys,
        contents: [{ text: prompt }],
      });

      res.json({ success: true, summary: text, modelUsed });
    } catch (error) {
      console.error('[Gemini Server Summary Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi tổng kết hồ sơ y tế.',
      });
    }
  });

  // 4. Phân tích chuyên sâu đa chiều & điểm sức khỏe
  app.post('/api/gemini/analyze-comprehensive', async (req: Request, res: Response) => {
    try {
      const { member, profile, customKeys } = req.body;
      const memberName = member?.name || 'Thành viên';

      const prompt = `Bạn là hội đồng chuyên gia y khoa gia đình.
Hãy phân tích sâu toàn diện hồ sơ y tế của thành viên ${memberName}:
- Thông tin thành viên: ${JSON.stringify(member)}
- Toàn bộ hồ sơ tóm tắt: ${JSON.stringify(profile?.summary || {})}
- Diễn tiến các sự kiện y tế: ${JSON.stringify(profile?.timeline || [])}

Hãy tính điểm sức khỏe ước lượng (0-100), đánh giá tổng quan, các rủi ro chính, lời khuyên hành động và phân tích xu hướng chỉ số sinh tồn.
Trả về DUY NHẤT một JSON theo cấu trúc:
{
  "healthScore": 85,
  "overallAssessment": "Đánh giá chi tiết tình hình sức khỏe hiện tại...",
  "keyRisks": ["Rủi ro 1", "Rủi ro 2"],
  "recommendations": ["Lời khuyên 1", "Lời khuyên 2"],
  "vitalTrendAnalysis": "Phân tích biến thiên huyết áp, đường huyết, cân nặng..."
}`;

      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'analysis',
        clientKeys: customKeys,
        contents: [{ text: prompt }],
        responseMimeType: 'application/json',
      });

      const parsed = parseJsonSafely(text) as {
        healthScore?: number;
        overallAssessment?: string;
        keyRisks?: string[];
        recommendations?: string[];
        vitalTrendAnalysis?: string;
      };

      res.json({
        success: true,
        result: {
          healthScore: typeof parsed.healthScore === 'number' ? parsed.healthScore : 80,
          overallAssessment: parsed.overallAssessment || 'Tình trạng sức khỏe ổn định.',
          keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks : [],
          recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : [],
          vitalTrendAnalysis: parsed.vitalTrendAnalysis || 'Các chỉ số duy trì trong ngưỡng an toàn.',
        },
        modelUsed,
      });
    } catch (error) {
      console.error('[Gemini Server Analyze Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi phân tích hồ sơ y khoa.',
      });
    }
  });

  // 5. Trợ lý AI Hỏi đáp sức khỏe (Hỗ trợ cả Streaming SSE và Non-streaming)
  app.post('/api/gemini/ask-assistant', async (req: Request, res: Response) => {
    try {
      const { question, member, profile, stream, customKeys } = req.body;
      if (!question) {
        res.status(400).json({ error: 'Chưa có nội dung câu hỏi.' });
        return;
      }

      const memberName = member?.name || 'Thành viên';
      const prompt = `Bạn là trợ lý bác sĩ gia đình thông minh, tận tâm và có chuyên môn cao.
Bạn đang tư vấn sức khỏe cho thành viên ${memberName}.
Hồ sơ bệnh án của thành viên:
- Chẩn đoán gần đây: ${(profile?.summary?.latestDiagnoses || []).join(', ') || 'Chưa có'}
- Các chỉ số sinh tồn gần nhất: ${JSON.stringify(profile?.summary?.latestMetrics || {})}
- Lịch sử khám chữa bệnh gần đây: ${JSON.stringify((profile?.timeline || []).slice(-6))}

Câu hỏi từ người dùng: "${question}"

Hãy trả lời chi tiết, ân cần, căn cứ vào dữ liệu hồ sơ bệnh án của thành viên để đưa ra giải thích y khoa dễ hiểu và lời khuyên thiết thực. Lưu ý nhắc người dùng luôn tham vấn bác sĩ điều trị trực tiếp khi có dấu hiệu khẩn cấp.`;

      // Streaming SSE
      if (stream) {
        const keys = getAvailableKeys(customKeys);
        if (keys.length === 0) {
          throw new Error('Chưa cấu hình GEMINI_API_KEY trên máy chủ.');
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        let streamResult = null;
        let activeModel = '';

        for (let keyIdx = 0; keyIdx < keys.length; keyIdx++) {
          const key = keys[keyIdx];
          const ai = new GoogleGenAI({
            apiKey: key,
            httpOptions: {
              headers: {
                'User-Agent': 'aistudio-build',
              },
            },
          });

          for (const model of TASK_MODELS.analysis) {
            try {
              streamResult = await ai.models.generateContentStream({
                model,
                contents: prompt,
              });
              activeModel = model;
              break;
            } catch (err) {
              console.warn(`[Gemini Server Stream] Model ${model} với key #${keyIdx + 1} không thành công, thử model tiếp theo:`, err instanceof Error ? err.message : err);
            }
          }
          if (streamResult) break;
        }

        if (!streamResult) {
          throw new Error('Tất cả các model phân tích và khóa API đều không thể tạo luồng phản hồi.');
        }

        for await (const chunk of streamResult) {
          if (chunk.text) {
            res.write(`data: ${JSON.stringify({ text: chunk.text, modelUsed: activeModel })}\n\n`);
          }
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Non-streaming response
      const { text, modelUsed } = await executeGeminiWithFailover({
        task: 'analysis',
        clientKeys: customKeys,
        contents: [{ text: prompt }],
      });

      res.json({ success: true, answer: text, modelUsed });
    } catch (error) {
      console.error('[Gemini Server Assistant Error]:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Lỗi khi giao tiếp với trợ lý bác sĩ.',
      });
    }
  });

  // Front-end handling
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Health Server] Running on http://0.0.0.0:${PORT} (mode: ${isProd ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('[Fatal Server Startup Error]:', err);
  process.exit(1);
});
