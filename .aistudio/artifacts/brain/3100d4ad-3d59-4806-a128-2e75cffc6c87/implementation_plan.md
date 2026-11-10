# Kế Hoạch Khai Thác & Nâng Cấp Module Sẵn Có Cho Tự Động Liên Kết Kho Dữ Liệu & Đồng Bộ 2 Chiều

Kế hoạch này tập trung **khai thác 100% các module có sẵn trong dự án** (`src/utils/workspaceShareRelay.ts`, `src/utils/healthDriveService.ts`, `src/utils/googleDriveService.ts`), nâng cấp để tự động gắn nhãn nhận diện ứng dụng (`appProperties: { app: 'com.suckhoegiadinh.app' }`) trên Google Drive và thực hiện đồng bộ 2 chiều thời gian thực (real-time 2-way sync) cho thành viên gia đình khi đăng nhập bằng Gmail.

---

## Phản Hồi & Khẳng Định Tái Sử Dụng Code Sẵn Có (Codebase Reuse & Enhancement Strategy)

> [!IMPORTANT]
> **Khẳng định**: Chúng ta **tái sử dụng và nâng cấp mở rộng trực tiếp mã nguồn sẵn có**, hoàn toàn KHÔNG tạo mới các dịch vụ lặp lại hay phá vỡ cấu trúc hiện tại.

### Các Module Sẵn Có Sẽ Được Khai Thác & Mở Rộng:

1. **`src/utils/workspaceShareRelay.ts`** (Đã có sẵn):
   - Đã có các hàm quản lý Firestore Relay: `registerHealthWorkspaceRelay`, `publishHealthWorkspaceAssignments`, `listHealthWorkspaceAssignments`, `findAdminWorkspaceRelay`.
   - *Nâng cấp*: Bổ sung cơ chế tự động kích hoạt tra cứu thông tin phân quyền `health_workspace_invites` khi tài khoản thành viên vừa đăng nhập thành công.
2. **`src/utils/healthDriveService.ts`** (Đã có sẵn):
   - Đã có các hàm xử lý Drive & Manifest: `findExistingHealthWorkspace`, `openHealthWorkspace`, `resolveSingleFamilyManifestFile`, `saveHealthFamily`.
   - *Nâng cấp*: Bổ sung thuộc tính `appProperties: { app: 'com.suckhoegiadinh.app' }` khi thao tác trên thư mục kho và tệp `family.json`, giúp việc quét nhận diện kho đạt tốc độ tối đa.
3. **`src/utils/googleDriveService.ts`** (Đã có sẵn):
   - Đã có quản lý phiên đăng nhập Google Auth (`ensureGoogleAuthInitialized`, `getValidGoogleAccessToken`).
   - *Nâng cấp*: Kích hoạt tự động quét ngầm kho gia đình ngay khi khôi phục hoặc thiết lập xong phiên Google Auth.

---

## Quyết Định Đã Xác Nhận Qua Phỏng Vấn (User Review & Confirmed Decisions)

- **Xác Nhận 1 (Folder ID & App Tagging)**: Không cần lưu `folderId` thủ công ở phía client. Hệ thống tự động ghi nhãn định danh ứng dụng (`appProperties: { app: 'com.suckhoegiadinh.app' }`) vào thư mục kho và tệp `family.json`. Khi thành viên đăng nhập, ứng dụng tự động quét thông minh trên Google Drive của người dùng theo nhãn ứng dụng kết hợp tra cứu Firestore.
- **Xác Nhận 2 (Tự Động Kết Nối Đăng Nhập)**: Khi thành viên đăng nhập bằng Gmail, ứng dụng tự động gọi `listHealthWorkspaceAssignments` và quét Drive ngầm để mở kho dữ liệu ngay lập tức mà không cần nhập mã thủ công.
- **Xác Nhận 3 (Đồng Bộ 2 Chiều Thời Gian Thực)**: Kết hợp bộ lắng nghe Firestore Snapshot (`workspaceShareRelay.ts`) với cơ chế kiểm tra dữ liệu thay đổi trên Drive để đồng bộ 2 chiều tức thì giữa Admin và các Thành viên.

---

## 1. Tổng Quan Kiến Trúc Tái Sử Dụng (Architecture Overview)

```
┌────────────────────────────────────────────────────────────────────────┐
│                     APP CLIENT LAYER (React / Zustand)                 │
│                                                                        │
│  ┌───────────────────────┐             ┌────────────────────────────┐  │
│  │ googleDriveService.ts │             │   Family Workspace Context │  │
│  │ (Google Auth Session) │             │ (State & UI Auto-re-render)│  │
│  └───────────┬───────────┘             └─────────────▲──────────────┘  │
│              │                                       │                 │
└──────────────┼───────────────────────────────────────┼─────────────────┘
               │ (1) Gmail Logged In                   │ (4) Bind Workspace
               ▼                                       │
┌──────────────────────────────────────────────────────┴─────────────────┐
│                    AUTO DISCOVERY & SYNC ENGINE                        │
│                                                                        │
│  1. workspaceShareRelay.ts -> listHealthWorkspaceAssignments(email)    │
│  2. healthDriveService.ts  -> findExistingHealthWorkspace()           │
│     (Filtered by appProperties: app = 'com.suckhoegiadinh.app')        │
│  3. healthDriveService.ts  -> resolveSingleFamilyManifestFile()       │
└──────────────┬───────────────────────────────────────▲─────────────────┘
               │ (2) Query & Tag                       │ (3) Push Live Data
               ▼                                       │
┌──────────────────────────────┐        ┌────────────────────────────────┐
│   GOOGLE DRIVE API (v3)      │        │   FIRESTORE DATABASE (Relay)   │
│  - healthDriveService.ts     │        │  - workspaceShareRelay.ts      │
│  - appProperties Tagging     │        │  - health_workspace_relays     │
│  - family.json Manifest      │        │  - health_workspace_invites    │
└──────────────────────────────┘        └────────────────────────────────┘
```

---

## 2. Các Bước Nâng Cấp Chi Tiết Cho Codebase

### Bước 1: Nâng Cấp `src/utils/healthDriveService.ts`
- Bổ sung tham số `appProperties: { app: 'com.suckhoegiadinh.app' }` trong các lệnh tạo / cập nhật thư mục `createHealthWorkspace` và tệp `family.json`.
- Cập nhật hàm `findExistingHealthWorkspace` để ưu tiên tìm kiếm theo `appProperties has { key='app' and value='com.suckhoegiadinh.app' }`, giúp tốc độ truy vấn Drive cực nhanh và không bị nhầm lẫn với các thư mục trùng tên khác.

### Bước 2: Nâng Cấp `src/utils/workspaceShareRelay.ts`
- Khai thác hàm `listHealthWorkspaceAssignments(memberEmail)` có sẵn để khi thành viên đăng nhập với `memberEmail`, hệ thống tự động tìm thấy thông tin `rootFolderId` và `familyFileId` do Admin chia sẻ.
- Lắng nghe sự thay đổi trên tập tài liệu `health_workspace_invites/{memberEmail}` bằng `onSnapshot` để nếu Admin vừa thêm thành viên hoặc phân quyền mới, ứng dụng của thành viên sẽ lập tức nhận được thông báo và đồng bộ dữ liệu.

### Bước 3: Tích Hợp Luồng Tự Động Đăng Nhập Vẫn Giữ Nguyên UI
- Trong màn hình khởi chạy hoặc khi đăng nhập thành công (`ensureGoogleAuthInitialized`), tự động gọi chuỗi tìm kiếm:
  1. Thử `workspaceShareRelay.ts` -> tìm phân quyền của email hiện tại.
  2. Thử `healthDriveService.ts` -> tìm thư mục chứa nhãn `com.suckhoegiadinh.app` trên Drive.
  3. Mở và tải `family.json` qua `resolveSingleFamilyManifestFile`.
- Khi kết nối thành công, tự động cập nhật state giao diện người dùng mà không yêu cầu thêm thao tác thủ công.

---

## 3. Kiểm Thử & Bảo Đảm Chất Lượng (Testing & Verification Plan)

- **Unit Tests**: Chạy toàn bộ 19 file test hiện có (`npm test -- --run`) để đảm bảo không làm gián đoạn các test case của `workspaceShareRelay.test.ts` và `healthDriveService.test.ts`.
- **Biên dịch & Lint**: Chạy `compile_applet` và `lint_applet` đồng thời để xác nhận không phát sinh lỗi TypeScript.
- **Khử trùng lặp**: Giữ nguyên cơ chế khóa đồng thời `resolveSingleFamilyManifestFile` đã xây dựng trước đó để ngăn ngừa việc tạo nhiều file `family.json`.

---

## Tóm Tắt Tiến Độ (Next Steps)
Sau khi bạn duyệt kế hoạch điều chỉnh này, tôi sẽ tiến hành cập nhật trực tiếp vào `workspaceShareRelay.ts` và `healthDriveService.ts` để hoàn thiện tính năng.
