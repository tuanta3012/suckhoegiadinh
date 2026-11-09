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

function normalizeMetricLabel(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const METRIC_STANDARDIZATION_MAP: Array<{
  standardKey: string;
  aliases: string[];
}> = [
  { standardKey: 'CREATININ', aliases: ['creatinin', 'creatinine', 'dinh luong creatinin', 'dinh luong creatinine', 'serum creatinine', 'creatinin huyet thanh', 'creatinine huyet thanh'] },
  { standardKey: 'ACID_URIC', aliases: ['acid uric', 'axit uric', 'uric acid', 'dinh luong acid uric', 'dinh luong axit uric', 'serum uric acid'] },
  { standardKey: 'TSH', aliases: ['tsh', 'hormone kich thich tuyen giap', 'thyroid stimulating hormone'] },
  { standardKey: 'WBC', aliases: ['wbc', 'bach cau', 'so luong bach cau', 'white blood cell', 'white blood cells', 'leukocyte count'] },
  { standardKey: 'RBC', aliases: ['rbc', 'hong cau', 'so luong hong cau', 'red blood cell', 'red blood cells', 'erythrocyte count'] },
  { standardKey: 'HGB', aliases: ['hgb', 'hb', 'hemoglobin', 'haemoglobin', 'huyet sac to'] },
  { standardKey: 'HCT', aliases: ['hct', 'hematocrit', 'haematocrit'] },
  { standardKey: 'PLT', aliases: ['plt', 'platelet', 'platelets', 'tieu cau'] },
  { standardKey: 'GLUCOSE', aliases: ['glucose', 'glu', 'glucoza', 'duong huyet', 'blood glucose', 'fasting blood glucose'] },
  { standardKey: 'HBA1C', aliases: ['hba1c', 'hemoglobin a1c', 'glycated hemoglobin', 'glycosylated hemoglobin'] },
  { standardKey: 'UREA', aliases: ['urea', 'bun', 'blood urea nitrogen', 'ure huyet'] },
  { standardKey: 'EGFR', aliases: ['egfr', 'estimated glomerular filtration rate', 'do loc cau than uoc tinh'] },
  { standardKey: 'CHOLESTEROL', aliases: ['cholesterol', 'total cholesterol', 'cholesterol toan phan'] },
  { standardKey: 'HDL_C', aliases: ['hdl', 'hdl c', 'hdl cholesterol', 'hdl cholesterol c'] },
  { standardKey: 'LDL_C', aliases: ['ldl', 'ldl c', 'ldl cholesterol', 'ldl cholesterol c'] },
  { standardKey: 'TRIGLYCERID', aliases: ['triglycerid', 'triglyceride', 'triglycerides', 'triglycerid toan phan'] },
  { standardKey: 'AST', aliases: ['ast', 'got', 'sgot', 'aspartate aminotransferase'] },
  { standardKey: 'ALT', aliases: ['alt', 'gpt', 'sgpt', 'alanine aminotransferase'] },
  { standardKey: 'GGT', aliases: ['ggt', 'gamma gt', 'gamma glutamyl transferase'] },
  { standardKey: 'FT4', aliases: ['ft4', 'free t4', 'free thyroxine', 'thyroxine tu do'] },
  { standardKey: 'FT3', aliases: ['ft3', 'free t3', 'free triiodothyronine', 'triiodothyronine tu do'] },
];

const METRIC_ALIAS_TO_KEY = new Map(
  METRIC_STANDARDIZATION_MAP.flatMap(({ standardKey, aliases }) =>
    aliases.map((alias) => [normalizeMetricLabel(alias), standardKey] as const),
  ),
);

function findCanonicalMetricKey(value: string): string | undefined {
  const normalized = normalizeMetricLabel(value);
  const exact = METRIC_ALIAS_TO_KEY.get(normalized);
  if (exact) return exact;

  for (const [alias, standardKey] of METRIC_ALIAS_TO_KEY) {
    if (normalized.startsWith(`${alias} `) || normalized.endsWith(` ${alias}`)) return standardKey;
  }
  return undefined;
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
    (a: any, b: any) =>
      new Date(a.date || a.recordedAt).getTime() -
      new Date(b.date || b.recordedAt).getTime()
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
  const normalizedName = normalizeMetricLabel(metricName || '');
  const lowerName = (metricName || '').trim().toLowerCase();
  const compactKey = key.replace(/[_\s-]+/g, ' ').trim();
  const canonicalAliases: Record<string, string> = {
    'BLOOD GLUCOSE': 'GLUCOSE',
    GLUCOZA: 'GLUCOSE',
    GLU: 'GLUCOSE',
    GLUCOSE: 'GLUCOSE',
    'FASTING BLOOD GLUCOSE': 'GLUCOSE',
    'HEMOGLOBIN A1C': 'HBA1C',
    'GLYCATED HEMOGLOBIN': 'HBA1C',
    CREATININE: 'CREATININ',
    'URIC ACID': 'ACID_URIC',
    'TOTAL CHOLESTEROL': 'CHOLESTEROL',
    TRIGLYCERIDES: 'TRIGLYCERIDE',
    'SGOT (AST)': 'AST',
    'SGPT (ALT)': 'ALT',
  };
  key = canonicalAliases[compactKey] || key;

  const isUrineContext =
    key.startsWith('URINE_') ||
    normalizedName.includes('nuoc tieu') ||
    normalizedName.includes('urine') ||
    normalizedName.includes('can lang') ||
    lowerUnit.includes('/hpf') ||
    lowerUnit.includes('ery/ul') ||
    lowerUnit.includes('leu/ul');

  if (!isUrineContext) {
    const canonicalNameKey = findCanonicalMetricKey(metricName);
    const canonicalRawKey = findCanonicalMetricKey(rawKey);
    const canonicalKey = canonicalNameKey || canonicalRawKey;
    if (canonicalKey) return canonicalKey;
  }

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
        digitizationLogger.log('error', 'parser', 'Không thể cứu vãn JSON payload');
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
