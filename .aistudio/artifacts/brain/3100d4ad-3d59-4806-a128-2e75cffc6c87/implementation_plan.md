# Quy Hoạch Kiến Trúc Gemini API & Định Dạng JSON Mở Rộng Đa Tài Liệu (Bao Gồm Tài Liệu Tùy Biến / Khác)

Bản kế hoạch kiến trúc quy hoạch toàn diện cơ chế điều phối Gemini API, mô hình dữ liệu JSON mở rộng (Polymorphic HealthEvent Schema), và **cơ chế xử lý thích ứng linh hoạt (Adaptive Schema & Fallback)** cho mọi loại tài liệu y tế đặc thù không nằm trong danh mục định sẵn.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> Giải pháp xử lý thích ứng linh hoạt khi gặp tài liệu sức khỏe đặc thù / chưa được định danh trước:

1. **Cơ chế xử lý tài liệu không thuộc danh mục chuẩn (Adaptive & Dynamic Ingestion)**:
   - Khi người dùng tải lên các tài liệu đặc thù (như: *Hóa đơn / Bảng kê chi phí khám chữa bệnh BHYT, Giấy chuyển viện, Giấy chứng nhận thương tật, Giấy chứng sinh, Nhật ký tự đo đường huyết/huyết áp tại nhà, Kết quả đo thính lực, Đơn yêu cầu bồi thường bảo hiểm sức khỏe...*):
   - **Không bao giờ từ chối hay báo lỗi tệp**:
     - Trường `type` được gán linh hoạt là `'other'` kèm trường định danh động `customCategory` (VD: "Bảng kê viện phí BHYT", "Giấy chuyển tuyến", "Nhật ký theo dõi tại nhà").
     - Tiêu đề `title` được Gemini tự động đặt sát với mục đích của văn bản.
   - **Túi dữ liệu động (`extractedData: Record<string, JsonValue>`)**:
     - Mọi cặp thông tin quan trọng mang tính chất đặc thù của tài liệu (ví dụ: `soTheBHYT`, `tongChiPhi`, `mucHuongBHYT`, `benhVienChuyenDen`, `tinhTrangTruocChuyenVien`, `chiSoTheoDoiTaiNha`...) sẽ được tự động trích xuất dưới dạng Key-Value trong `extractedData`.
   - **Trường tổng thuật văn bản (`notes` & `advice`)**:
     - Lưu trữ toàn bộ nội dung tóm tắt chi tiết, diễn giải và các lưu ý pháp lý/y tế của văn bản để không bị sót bất kỳ chữ nào.

2. **Quy tắc Model Bất biến (Zero-Downgrade Policy)**:
   - **Luồng 1 (OCR & Số hóa đa tài liệu)**: Cố định DUY NHẤT `gemini-3.5-flash-lite`. (Cấm tuyệt đối việc rớt xuống 3.1 hay phiên bản cũ hơn).
   - **Luồng 2 (Phân tích chuyên sâu 4 lớp)**: Cố định DUY NHẤT `gemini-3.8-flash`.
   - **Luồng 3 (Trợ lý AI / Chat hỏi đáp)**: Cố định DUY NHẤT `gemini-3.5-flash-lite`.

3. **Cơ chế Hàng đợi 6 API Keys độc lập (Account Queue & Round-Robin)**:
   - Quản lý mảng 6 Key độc lập từ 6 tài khoản. Mỗi tài liệu dùng 1 Key độc lập theo vòng tròn. Khi gặp lỗi 429, tự động ghi log và nhảy sang Key kế tiếp ngay trên cùng model.

---

## 1. Chi Tiết Định Dạng JSON Mở Rộng Theo Từng Loại Tài Liệu

### 1.1. Cấu Trúc Tổng Thể Của `HealthEvent` Trong Timeline

```typescript
export interface HealthEvent {
  id: string;
  sourceFileId: string;
  sourceFileName: string;
  date: string;
  type: 
    | 'comprehensive_exam'   // Khám sức khỏe tổng quát
    | 'test_result'          // Phiếu xét nghiệm độc lập
    | 'prescription'         // Đơn thuốc
    | 'vaccination'          // Phiếu / Sổ tiêm chủng
    | 'discharge'            // Giấy ra viện / Giấy phẫu thuật
    | 'medical_report'       // Báo cáo / Phiếu khám chuyên khoa
    | 'other';               // Tài liệu tùy biến / khác

  title: string;
  facility?: string;
  doctorName?: string;
  customCategory?: string;   // Danh mục tự động cho loại tài liệu đặc thù (VD: "Bảo hiểm y tế", "Giấy chuyển viện")

  // 1. Dành cho Khám tổng quát & Chuyên khoa
  physicalExam?: PhysicalExam;
  diagnoses: string[];
  metrics: HealthMetric[];
  imagingResults?: ImagingResult[];

  // 2. Dành cho Đơn thuốc
  medications: Medication[];

  // 3. Dành cho Tiêm chủng vắc xin
  vaccinations?: VaccinationRecord[];

  // 4. Dành cho Nằm viện / Ra viện
  hospitalization?: HospitalizationRecord;

  // 5. Túi dữ liệu động (Dynamic Data Bag) cho tài liệu loại 'other'
  extractedData?: Record<string, JsonValue>;

  advice?: string;
  nextFollowUp?: string;
  notes?: string;
  recordedAt: string;
}
```

---

### 1.2. Ví Dụ Cụ Thể Khi Xử Lý Tài Liệu Loại Khác (`type: 'other'`)

#### Ví dụ A: Bảng kê chi phí khám chữa bệnh / Hóa đơn viện phí BHYT
```json
{
  "type": "other",
  "customCategory": "Viện phí & BHYT",
  "title": "Bảng kê chi phí khám bệnh BHYT ngoại trú",
  "date": "2026-06-08",
  "facility": "Bệnh viện Đại học Y Dược 1",
  "diagnoses": ["Khám kiểm tra sức khỏe tổng quát định kỳ"],
  "extractedData": {
    "soTheBHYT": "DN4797931234567",
    "tongChiPhi": "3.850.000 VNĐ",
    "bhytThanhToan": "2.400.000 VNĐ",
    "nguoiBenhTra": "1.450.000 VNĐ",
    "soBienLai": "HD-2026-00982"
  },
  "notes": "Người bệnh đã hoàn tất thanh toán phần đồng chi trả. Hóa đơn điện tử đã xuất về email công ty."
}
```

#### Ví dụ B: Giấy chuyển tuyến khám chữa bệnh BHYT
```json
{
  "type": "other",
  "customCategory": "Thủ tục hành chính y tế",
  "title": "Giấy chuyển tuyến khám chữa bệnh BHYT",
  "date": "2026-06-10",
  "facility": "Bệnh viện Quận 7",
  "diagnoses": ["Theo dõi tăng Acid Uric cấp / Nghi ngờ tổn thương thận"],
  "extractedData": {
    "noiChuyenDen": "Bệnh viện Đại học Y Dược TP.HCM",
    "lyDoChuyen": "Vượt quá khả năng chuyên môn kỹ thuật của cơ sở",
    "phuongTienVanChuyen": "Tự túc",
    "thoiHanChuyenTuyen": "Từ ngày 10/06/2026 đến hết ngày 20/06/2026"
  },
  "advice": "Mang theo CCCD, thẻ BHYT và hồ sơ bệnh án gốc khi đến bệnh viện tuyến trên."
}
```

#### Ví dụ C: Nhật ký theo dõi đường huyết & huyết áp tại nhà
```json
{
  "type": "other",
  "customCategory": "Nhật ký theo dõi tại nhà",
  "title": "Nhật ký theo dõi Huyết áp & SpO2 tuần đầu tháng 07/2026",
  "date": "2026-07-07",
  "metrics": [
    { "name": "Huyết áp trung bình buổi sáng", "standardKey": "BLOOD_PRESSURE_SYS", "value": 118, "unit": "mmHg" },
    { "name": "Huyết áp trung bình buổi tối", "standardKey": "BLOOD_PRESSURE_DIA", "value": 76, "unit": "mmHg" },
    { "name": "SpO2 tại nhà", "standardKey": "SPO2", "value": 98, "unit": "%" }
  ],
  "notes": "Huyết áp ổn định quanh mức 115-120/75-80 mmHg. Không có cơn chóng mặt hay đau đầu."
}
```

---

### 1.3. Khả Năng Thích Ứng Của Giao Diện Người Dùng (Adaptive UI Rendering)

- **Nguyên tắc "Có gì hiển thị đó"**:
  - Nếu sự kiện có `metrics`: Hiển thị khối bảng chỉ số xét nghiệm.
  - Nếu sự kiện có `medications`: Hiển thị khối đơn thuốc với liều lượng, số lượng, cách dùng.
  - Nếu sự kiện có `vaccinations`: Hiển thị thẻ chứng nhận tiêm chủng với tên vắc xin, số lô và ngày hẹn nhắc.
  - Nếu sự kiện có `extractedData`: Tự động render lưới Key-Value thanh lịch hiển thị các cặp thông tin tùy biến (VD: Số thẻ BHYT, Tổng chi phí, Nơi chuyển đến...).
  - Trường `notes` và `advice` luôn hiển thị dưới dạng văn bản trực quan, dễ đọc trên di động.

---

### 1.4. Tương Tác Của Tài Liệu Loại 'Other' Với Tab Chat AI (Luồng 3)

- Dù tài liệu thuộc loại nào, khi đã nằm trong JSON profile:
  - Người dùng hỏi: *"Chi phí khám BHYT đợt tháng 6 hết bao nhiêu tiền?"* -> AI trả lời chính xác: *"Theo Bảng kê chi phí ngày 08/06/2026 tại ĐHYD 1, tổng chi phí là 3.850.000 VNĐ, trong đó BHYT chi trả 2.400.000 VNĐ và bạn thanh toán 1.450.000 VNĐ."*
  - Người dùng hỏi: *"Giấy chuyển tuyến của tôi có hiệu lực đến ngày nào?"* -> AI trả lời: *"Giấy chuyển tuyến có giá trị đến hết ngày 20/06/2026 để khám tại BV Đại học Y Dược TP.HCM."*
- Toàn bộ câu trả lời được xử lý tức thì bằng `gemini-3.5-flash-lite` thông qua context JSON, không tốn thời gian đọc lại tài liệu gốc.

---

## 2. Kế Hoạch Triển Khai Kỹ Thuật (Refactoring Steps)

1. **Cập nhật Interface TypeScript (`src/types.ts`)**:
   - Khai báo đầy đủ `VaccinationRecord`, `HospitalizationRecord`, `Medication` mở rộng.
   - Thêm `customCategory?: string;` và `extractedData?: Record<string, JsonValue>;` vào `HealthEvent`.
2. **Quy hoạch Model Bất Biến trong `server.ts`**:
   - Luồng 1 (OCR): Cố định duy nhất `gemini-3.5-flash-lite`.
   - Luồng 2 (Deep Insight): Cố định duy nhất `gemini-3.8-flash`.
   - Luồng 3 (Chat Trợ lý): Cố định duy nhất `gemini-3.5-flash-lite`.
3. **Cập nhật System Instruction OCR (`server.ts`)**:
   - Huấn luyện Gemini tự động nhận dạng chính xác phân loại tài liệu: nếu là đơn thuốc trích xuất `medications`, nếu là tiêm chủng trích xuất `vaccinations`, nếu là tài liệu hành chính/khác thì thu thập các cặp thông số vào `extractedData` và tóm tắt vào `notes`.
4. **Vận hành Hồ chứa 6 API Keys độc lập**:
   - Xoay vòng Round-Robin tuần tự từng tài liệu và failover tức thì khi gặp lỗi 429 trên cùng model.
5. **Kiểm tra biên dịch & Test Suite**:
   - Đảm bảo `npm test -- --run` và `tsc --noEmit` vượt qua 100%.
