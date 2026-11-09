# Tối ưu hóa Tốc độ "Siêu tốc" (Sheets-like Performance)

Dự án Sổ tiết kiệm nhanh hơn vì nó chỉ quản lý **duy nhất 1 tệp ID** (Google Sheet). Dự án Sức khỏe hiện tại chậm hơn vì đang phải "quét" cả một hệ thống thư mục và nhiều tệp JSON riêng lẻ. 

Kế hoạch này sẽ thay đổi cách tiếp cận: Thay vì để app đi "tìm" folder trên Drive, chúng ta sẽ dùng Firestore làm một **"Sổ đăng ký" (Registry)**. Khi đó, việc liên kết kho dữ liệu sẽ diễn ra tức thì giống hệt như cách Google Sheets hoạt động.

### Đánh giá & Quyết định quan trọng

> [!IMPORTANT]
> **Tại sao Sheets nhanh hơn?** Vì app chỉ cần lưu 1 cái "Pointer" (ID tệp).
> **Giải pháp cho chúng ta**: Biến hệ thống Folder/JSON phức tạp thành một "Ảo ảnh" đơn giản bằng cách dùng Firestore Registry để lưu ID gốc.

- **Cải tiến 1: Firestore Registry (Bộ nhớ chỉ mục)**: Lưu cặp `{ userEmail: rootFolderId }` lên Firestore. Khi login, app lấy ID này và truy cập thẳng Drive, bỏ qua hoàn toàn bước "Quét Drive" (vốn là bước chậm nhất).
- **Cải tiến 2: Atomic Creation (Khởi tạo gộp)**: Sử dụng kỹ thuật xử lý song song hoàn toàn để tạo thư mục và tệp cấu trúc. Người dùng sẽ thấy kho dữ liệu hiện ra sau 1-2 giây thay vì 10 giây.
- **Cải tiến 3: Background Deletion (Xóa ảo)**: Khi bấm xóa, app xóa thông tin trong Firestore Registry ngay lập tức (phản hồi 0.1 giây). Việc xóa hàng nghìn tệp trên Drive sẽ được Server/Client dọn dẹp âm thầm, không bắt người dùng đứng chờ.

---

### 1. Tổng quan & Mục tiêu

- **Mục tiêu**: Đưa tốc độ kết nối và khởi tạo về mức **dưới 2 giây**, tương đương với trải nghiệm của các dự án dùng Google Sheets.
- **Giá trị**: Xóa bỏ hoàn toàn cảm giác "lag" khi chuyển đổi giữa các tài khoản hoặc dọn dẹp dữ liệu.

---

### 2. Trải nghiệm Người dùng & Giao diện

- **Kết nối kho**: Vừa đăng nhập xong, danh sách thành viên hiện ra ngay (không còn vòng xoay "Đang quét Drive").
- **Tạo kho mới**: Chỉ một hiệu ứng rung nhẹ (haptic) và thông báo "Kho dữ liệu đã sẵn sàng", trong khi Drive vẫn đang thực hiện các bước tạo folder ở nền.
- **Xóa kho**: Biến mất ngay lập tức khỏi màn hình. App trở về trạng thái trắng như mới mua máy.

---

### 3. Các Quyết định Kỹ thuật & Đánh đổi

- **Quyết định 1: Firestore là "Thư ký" tin cậy**
    - *Cách làm*: Thay vì Drive Search API (rất chậm), ta dùng Firestore Query (rất nhanh).
    - *Lợi ích*: Tốc độ tìm kiếm kho dữ liệu tăng 100 lần.
- **Quyết định 2: Chấp nhận "Dữ liệu rác" tạm thời trên Drive**
    - *Đánh đổi*: Nếu người dùng xóa kho rồi tắt app ngay, folder trên Drive có thể vẫn còn đó một lúc.
    - *Xử lý*: Hệ thống Registry sẽ đánh dấu ID đó là "đã xóa", app sẽ không bao giờ nhìn thấy nó nữa. Việc dọn dẹp vật lý sẽ chạy khi app rảnh rỗi.

---

### 4. Kiến trúc Kỹ thuật & Chiến lược Dữ liệu

```unicode
┌─────────────────────────────────────────────────────────┐
│                    HealthDashboard UI                   │
│         (Thao tác tức thì với Registry ảo)              │
└───────────────┬───────────────────────────────▲─────────┘
                │                               │
        [Registry Update]               [Registry Lookup]
                │                               │
┌───────────────▼───────────────────────────────┴─────────┐
│                 Firestore Registry Service              │
│      (Lưu trữ ID gốc: email -> folder_id, file_id)      │
└───────────────┬───────────────────────────────┬─────────┘
                │                               │
    ┌───────────▼───────────┐       ┌───────────▼───────────┐
    │   Background Worker   │       │   Google Drive API    │
    │ (Dọn dẹp tệp vật lý)  │       │ (Lưu trữ nội dung y tế)│
    └───────────────────────┘       └───────────────────────┘
```

**Các bước thực hiện cụ thể**:
1.  **Chỉnh sửa `workspaceShareRelay.ts`**: Thêm hàm `findAdminWorkspace(email)` để lấy ID kho từ Firestore.
2.  **Cập nhật `findExistingHealthWorkspace`**: Ưu tiên gọi `findAdminWorkspace` trước. Chỉ quét Drive nếu không tìm thấy trên Firestore.
3.  **Tối ưu `handleCreateWorkspace`**: Gọi các lệnh tạo folder Drive song song (`Promise.all`) và đăng ký ID vào Firestore ngay sau khi có ID thư mục gốc.
4.  **Tối ưu `handleFactoryReset`**: Xóa bản ghi Firestore trước, sau đó mới gọi lệnh xóa Drive ở chế độ "không chờ đợi" (`non-blocking`).
