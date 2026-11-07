import { digitizationLogger } from './digitizationLogger';

/**
 * Làm sạch tên chỉ số: Loại bỏ dấu sao, ký tự đặc biệt, khoảng trắng thừa
 */
export function sanitizeMetricName(name: string): string {
  return name.replace(/\*/g, '').trim();
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
