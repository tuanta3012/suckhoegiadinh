import { describe, expect, it } from 'vitest';
import { compareDocumentContainment, createDocumentContentIndex } from './documentContainment';

const pageA = 'Kết quả khám tổng quát bệnh nhân Nguyễn Văn An ngày 10 tháng 3 năm 2026. ' +
  'Bạch cầu hồng cầu tiểu cầu đường huyết cholesterol creatinine men gan huyết áp nhịp tim. ' +
  'Bác sĩ kết luận sức khỏe ổn định và hướng dẫn tái khám định kỳ sau ba tháng. ' +
  'Tài liệu ghi rõ thông tin cơ sở y tế, thời điểm lấy mẫu, kết quả xét nghiệm máu, nước tiểu, ' +
  'khoảng tham chiếu của các chỉ số, tình trạng sức khỏe hiện tại, lời dặn bác sĩ và ngày hẹn.';
const pageB = 'Kết quả khám tổng quát bệnh nhân Nguyễn Văn An ngày 10 tháng 3 năm 2026. ' +
  'Bạch cầu hồng cầu tiểu cầu đường huyết cholesterol creatinine men gan huyết áp nhịp tim. ' +
  'Bác sĩ kết luận sức khỏe ổn định và hướng dẫn tái khám định kỳ sau ba tháng. ' +
  'Tài liệu ghi rõ thông tin cơ sở y tế, thời điểm lấy mẫu, kết quả xét nghiệm máu, nước tiểu, ' +
  'khoảng tham chiếu của các chỉ số, tình trạng sức khỏe hiện tại, lời dặn bác sĩ và ngày hẹn. ' +
  'Đơn thuốc bổ sung vitamin và hướng dẫn uống sau khi ăn sáng.';

describe('document containment', () => {
  it('identifies a complete document that includes every page of another', () => {
    const result = compareDocumentContainment(
      createDocumentContentIndex([pageA]),
      createDocumentContentIndex([pageA, pageB]),
    );

    expect(result.relation).toBe('right_contains_left');
  });

  it('does not claim containment when documents only overlap partially', () => {
    const result = compareDocumentContainment(
      createDocumentContentIndex([pageA]),
      createDocumentContentIndex([pageA, 'Chỉ số nước tiểu và nội dung xét nghiệm bổ sung khác hoàn toàn']),
    );

    expect(result.relation).not.toBe('left_contains_right');
  });

  it('returns unknown for incomplete OCR indexes', () => {
    const result = compareDocumentContainment(
      createDocumentContentIndex([pageA]),
      { pages: [], complete: false },
    );

    expect(result.relation).toBe('unknown');
  });

  it('marks empty or oversized OCR indexes incomplete', () => {
    expect(createDocumentContentIndex(['']).complete).toBe(false);
    expect(createDocumentContentIndex(['x'.repeat(120_001)]).complete).toBe(false);
  });
});
