import { digitizationLogger } from './digitizationLogger';

/**
 * Làm sạch tên chỉ số: Loại bỏ dấu sao (*), ký tự rác, khoảng trắng thừa
 * Ví dụ: "Creatinin* [Huyết Thanh]" -> "Creatinin [Huyết Thanh]"
 */
export function sanitizeMetricName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[*#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tiền xử lý dữ liệu trước khi gửi cho Phân tích Chuyên sâu (AI Deep-Dive):
 * 1. Lọc chỉ số thông minh:
 *    - Chỉ giữ các chỉ số bất thường (status !== 'normal').
 *    - Hoặc nhóm chỉ số cốt lõi theo dõi định kỳ (Glucose, HbA1c, Creatinin, Acid Uric, TSH, Lipid máu, Men gan).
 *    - Loại bỏ chỉ số bình thường lặp lại không cần thiết để tối ưu token & thời gian xử lý.
 * 2. Rút gọn kết quả hình ảnh:
 *    - Đối với siêu âm, X-quang: CHỈ giữ lại phần 'conclusion' (kết luận), loại bỏ 'findings' dài dòng.
 * 3. Chuẩn hóa tên chỉ số:
 *    - Tự động gọi sanitizeMetricName để loại bỏ dấu sao (*), ký tự thừa.
 */
export function prepareDataForDeepDive(member: any, profile: any) {
  const memberName = member?.name || profile?.member?.name || 'Thành viên';
  const gender = member?.gender || profile?.member?.gender || 'N/A';
  const birthDate = member?.birthDate || profile?.member?.birthDate || 'N/A';
  const medicalHistory = profile?.medicalHistory || { surgeries: [], chronicConditions: [] };

  const timeline = Array.isArray(profile?.timeline) ? profile.timeline : [];
  // Sắp xếp theo ngày tăng dần và lấy tối đa 15 mốc khám gần nhất
  const sortedEvents = [...timeline].sort(
    (a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );
  const relevantEvents = sortedEvents.slice(-15);

  // Danh mục từ khóa các nhóm chỉ số cốt lõi theo dõi định kỳ
  const coreKeywords = [
    'GLUCOSE', 'GLU', 'HBA1C',
    'CREATININ', 'CREATININE', 'EGFR', 'UREA',
    'ACID_URIC', 'URIC_ACID', 'URIC',
    'TSH', 'FT4', 'FT3',
    'CHOLESTEROL', 'TRIGLYCERID', 'TRIGLYCERIDE', 'HDL_C', 'HDL', 'LDL_C', 'LDL',
    'AST', 'ALT', 'GGT', 'SGOT', 'SGPT',
  ];

  const isCoreIndicator = (key: string, name: string): boolean => {
    const normKey = key.toUpperCase();
    const normName = name.toUpperCase();
    return coreKeywords.some((kw) => normKey.includes(kw) || normName.includes(kw));
  };

  const prunedEvents = relevantEvents.map((evt: any, index: number) => {
    // 3 mốc khám mới nhất giữ thêm chỉ số để so sánh xu hướng
    const isRecent = index >= Math.max(0, relevantEvents.length - 3);

    const metrics = Array.isArray(evt.metrics)
      ? evt.metrics
          .map((m: any) => {
            const cleanName = sanitizeMetricName(String(m.name || ''));
            const standardKey = String(m.standardKey || cleanName).toUpperCase();
            const status = String(m.status || '').toLowerCase();
            const isAbnormal =
              status === 'high' ||
              status === 'low' ||
              status === 'abnormal' ||
              status === 'critical' ||
              (status !== 'normal' && status !== '');
            const isCore = isCoreIndicator(standardKey, cleanName);

            // Giữ nếu: bất thường HOẶC thuộc nhóm chỉ số cốt lõi
            if (isAbnormal || isCore || (isRecent && status !== 'normal')) {
              return {
                name: cleanName,
                key: standardKey,
                val: m.value,
                unit: m.unit || '',
                st: isAbnormal ? (status || 'abnormal') : 'normal',
                ref: m.refRange,
              };
            }
            return null;
          })
          .filter((m: any): m is NonNullable<typeof m> => m !== null)
      : [];

    // Rút gọn kết luận hình ảnh (siêu âm, X-quang, CT...): CHỈ giữ conclusion, bỏ findings
    const imagingResults = Array.isArray(evt.imagingResults)
      ? evt.imagingResults
          .map((img: any) => {
            const conclusion = String(img.conclusion || img.findings || '').trim();
            if (!conclusion) return null;
            return {
              mod: img.modality || 'Chẩn đoán hình ảnh',
              con: conclusion.substring(0, 300), // Rút gọn súc tích
            };
          })
          .filter((img: any): img is NonNullable<typeof img> => img !== null)
      : [];

    return {
      d: evt.date,
      t: evt.title,
      type: evt.type,
      facility: evt.facility,
      diag: Array.isArray(evt.diagnoses) ? evt.diagnoses.slice(0, 10) : [],
      metrics: metrics.slice(0, 40),
      img: imagingResults.slice(0, 10),
      phys: evt.physicalExam
        ? {
            bp: evt.physicalExam.bp_mmHg,
            bmi: evt.physicalExam.bmi,
            pulse: evt.physicalExam.pulse_bpm,
          }
        : undefined,
    };
  });

  return {
    p: { n: memberName, g: gender, b: birthDate },
    h: medicalHistory,
    tm: prunedEvents,
  };
}

/**
 * Chuẩn hóa Key chỉ số xét nghiệm (StandardKey Normalization)
 * Giải quyết các biến thể hậu tố số đếm (NEU_1, LYM_1...) và phân định Máu vs Nước tiểu.
 */
export function standardizeMetricKey(rawKey: string, unit: string, metricName: string = ''): string {
  let key = rawKey.trim().toUpperCase();
  const lowerUnit = (unit || '').trim().toLowerCase();
  const lowerName = (metricName || '').trim().toLowerCase();

  // 1. Xử lý lỗi hậu tố số đếm từ LLM (VD: NEU_1, LYM_2, MONO_#)
  if (/^(NEU|LYM|MONO|EOS|BASO)(_|\s)*\d+$/.test(key)) {
    key = key.replace(/(_|\s)*\d+$/, '_#');
  } else if (/^(NEU|LYM|MONO|EOS|BASO)$/.test(key)) {
    if (!lowerUnit.includes('%') && (lowerUnit.includes('g/l') || lowerUnit.includes('10^9') || !lowerUnit)) {
       key = `${key}_#`;
    } else if (lowerUnit.includes('%')) {
       key = `${key}_PCT`;
    }
  }

  // 2. Phân định Máu vs Nước tiểu
  const isUrineContext = 
    lowerName.includes('nước tiểu') || 
    lowerName.includes('urine') || 
    lowerName.includes('cặn lắng') ||
    lowerUnit.includes('/ul') || 
    lowerUnit.includes('/µl') ||
    lowerUnit.includes('ery/ul') ||
    lowerUnit.includes('leu/ul');

  if (isUrineContext) {
    // Chuẩn hóa các key phổ biến trong nước tiểu
    if (key === 'WBC' || key === 'LEU' || lowerName.includes('bạch cầu')) return 'URINE_LEU';
    if (key === 'RBC' || key === 'ERY' || lowerName.includes('hồng cầu')) return 'URINE_RBC_SED';
    if (key === 'PRO' || key === 'PROTEIN' || lowerName.includes('đạm')) return 'URINE_PRO';
    if (key === 'GLUCOSE' || key === 'GLU' || lowerName.includes('đường')) return 'URINE_GLU';
    if (key === 'BIL' || lowerName.includes('sắc tố mật')) return 'URINE_BIL';
    if (key === 'NIT' || lowerName.includes('nitrit')) return 'URINE_NIT';
    if (key === 'KET' || lowerName.includes('xeton')) return 'URINE_KET';
    if (key === 'SG' || lowerName.includes('tỷ trọng')) return 'URINE_SG';
    if (key === 'PH' || lowerName.includes('độ ph')) return 'URINE_PH';
    
    // Xử lý cụ thể lỗi AST vs Trụ (Casts)
    if ((key === 'AST' || key === 'TRỤ' || key === 'CASTS') && (lowerName.includes('trụ') || lowerName.includes('cast'))) {
      return 'URINE_CASTS';
    }
    
    // Thêm tiền tố URINE_ cho các chỉ số khác trong nước tiểu
    if (!key.startsWith('URINE_') && !['PH', 'SG', 'NIT', 'KET', 'BIL', 'UBG'].includes(key)) {
      return `URINE_${key}`;
    }
  }

  return key;
}

/**
 * Làm sạch và Parse JSON từ LLM một cách an toàn (Robust Parsing)
 * Hỗ trợ bóc tách khối JSON từ Markdown và xử lý lỗi cắt cụt.
 */
export function parseRobustJson(text: string): Record<string, any> {
  let cleaned = text.trim();
  
  // 1. Loại bỏ Markdown code blocks
  if (cleaned.includes('```json')) {
    cleaned = cleaned.split('```json')[1].split('```')[0].trim();
  } else if (cleaned.includes('```')) {
    cleaned = cleaned.split('```')[1].split('```')[0].trim();
  }

  try {
    // 2. Thử parse trực tiếp
    return JSON.parse(cleaned);
  } catch (e) {
    // 3. Xử lý lỗi cắt cụt (Truncated JSON) - Thử tìm khối JSON hợp lệ cuối cùng
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace !== -1) {
      try {
        return JSON.parse(cleaned.substring(0, lastBrace + 1));
      } catch {
        // Tiếp tục fallback bên dưới
      }
    }

    // 4. Regex fallback để tìm cặp { ... } cân bằng nhất
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (innerErr) {
        digitizationLogger.log('error', 'parser', 'Không thể cứu vãn JSON payload', { text: cleaned.substring(0, 200) });
        throw new Error('Dữ liệu AI trả về không đúng định dạng JSON.');
      }
    }
    
    throw new Error('Không tìm thấy khối dữ liệu JSON hợp lệ trong phản hồi.');
  }
}

/**
 * Cơ chế delay xử lý (Sleep)
 */
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
