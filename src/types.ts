/**
 * Types and interfaces for Savings Portfolio & Loan Optimizer
 */

export type OwnerType = string;

export type DepositType = 'online' | 'counter';

export type RolloverOption = 'principal_and_interest' | 'principal_only' | 'none';

export type BookStatus = 'active' | 'matured' | 'settled';

export interface BankInfo {
  id: string;
  name: string;
  shortName: string;
  code: string;
  primaryColor: string; // Hex color
  textColor: string;
  bgLight: string;
  borderColor: string;
  defaultLoanMargin: number; // Biên độ vay cầm cố thông thường (+%/năm)
  maxLTV: number; // Tỷ lệ cho vay tối đa (0.90 - 1.0)
  worksOnSaturday?: boolean; // Ngân hàng có chi nhánh làm việc vào thứ 7 hay không
}

export interface SavingsBook {
  id: string;
  bookCode: string; // Số sổ / Số hợp đồng
  bankId: string;
  owner: OwnerType;
  depositType: DepositType;
  principal: number; // Số tiền gốc (VND)
  interestRate: number; // Lãi suất (%/năm, ví dụ 5.8)
  termMonths: number; // Kỳ hạn (tháng)
  startDate: string; // YYYY-MM-DD
  maturityDate: string; // YYYY-MM-DD
  rolloverOption: RolloverOption;
  status: BookStatus;
  customLoanMargin?: number; // Biên độ vay riêng của ngân hàng này cho sổ này (nếu có)
  expectedTermInterest?: number; // Tiền lãi theo sổ (tính theo kỳ hạn trong file Excel)
  annualInterestEquivalent?: number; // Tiền lãi quy đổi 1 năm (VND)
  maturityMonthYear?: string; // Tháng đáo hạn (e.g. "09/26")
  note?: string;
  tag?: string; // e.g. "Tiền mua nhà", "Quỹ sinh con", "Quỹ khẩn cấp"
  settlementDate?: string; // Ngày tất toán thực tế (YYYY-MM-DD)
  isEarlySettled?: boolean; // Đánh dấu tất toán trước hạn
  actualInterestVND?: number; // Tiền lãi thực nhận (VNĐ)
}

/**
 * Bản ghi điều chỉnh tất toán (khi sổ đã tất toán và không còn trong danh mục sổ)
 * Dùng để ghi nhận điều chỉnh Lãi năm hiện hành, Lãi năm tiếp theo tạm tính, Số cuối năm hiện hành
 */
export interface SettlementAdjustment {
  id: string;
  businessId?: string;
  bookCode: string;
  bankId: string;
  owner: OwnerType;
  principal: number; // Tiền gốc đã tất toán (VND)
  settlementDate: string; // Ngày tất toán (YYYY-MM-DD)
  settlementYear: number; // Năm tất toán (ví dụ 2026)
  settlementType: 'maturity' | 'early'; // 'maturity': đúng/quá hạn, 'early': trước hạn
  actualInterestVND: number; // Tiền lãi thực nhận ghi nhận vào năm hiện hành
  expectedTermInterest?: number; // Tiền lãi cả kỳ ban đầu
  lostInterestVND?: number; // Phần lãi bị mất nếu tất toán trước hạn
  reinvested?: boolean; // Đã tái tục thành sổ mới hay rút về
  note?: string;
  timestamp: number;
  originalMaturityYear?: number; // Năm đáo hạn ban đầu của sổ (ví dụ: 2027)
}

export interface AnnualInterestRecord {
  year: number;
  interestEarnedMillion: number; // Triệu đồng
  interestEarnedVND: number; // VND
}

export interface BalanceGrowthRecord {
  year: number;
  balanceMillion: number; // Triệu đồng
  balanceVND: number; // VND
  annualIncomeMillion?: number; // Thu nhập tăng thêm trong năm
  annualIncomeVND?: number;
}

export interface MobilizationItemAnalysis {
  book: SavingsBook;
  projectedBook?: SavingsBook; // Sổ được chiếu trong chu kỳ tái tục tự động tại ngày huy động
  cycleIndex?: number; // Số lần tái tục tự động gối đầu (0 = chu kỳ gốc, 1 = tái tục 1 lần,...)
  accumulatedCompoundedInterest?: number; // Tổng lãi cộng dồn từ các chu kỳ tái tục trước đó
  isMatured: boolean;
  daysTotalTerm: number;
  daysPassed: number;
  daysRemaining: number;
  
  // Tiền lãi cả kỳ nếu giữ đến đáo hạn
  fullTermInterest: number;
  
  // Nếu rút trước hạn (Tất toán sớm)
  passedTermInterestLost: number; // Lãi kỳ hạn lẽ ra nhận được cho số ngày đã gửi
  passedDemandInterestEarned: number; // Lãi không kỳ hạn thực nhận (0.1 - 0.2%)
  lossFromEarlySettlement: number; // Thiệt hại thực tế = passedTermInterestLost - passedDemandInterestEarned
  cashFromEarlySettlement: number; // Tiền mặt cầm về = Gốc + Lãi không kỳ hạn
  
  // Nếu vay cầm cố sổ đến ngày đáo hạn
  loanRate: number; // Lãi suất vay = interestRate + loanMargin
  appliedLoanMargin: number; // Biên độ lãi vay áp dụng (%/năm)
  appliedLtv: number; // Tỷ lệ cho vay áp dụng (ví dụ 1.0 = 100% cho VIP)
  maxLoanAmount: number; // Hạn mức vay = principal * LTV (100% đối với VIP)
  loanInterestCost: number; // Tiền lãi vay phải trả cho số ngày còn lại đến đáo hạn
  
  // Cơ chế VIP: Bù trừ ngay tại thời điểm vay (Upfront Netting)
  // Ngân hàng giải ngân và bù trừ luôn: Lãi sổ cả kỳ nhận trước - Lãi vay phải trả
  netInterestOffset: number; // Bù trừ lãi = fullTermInterest - loanInterestCost (nếu dương là được cộng thêm, âm là phải bù)
  netCashDisbursedUpfront: number; // Thực nhận giải ngân 1 lần tại quầy = maxLoanAmount + (fullTermInterest - loanInterestCost)
  netCashFromLoan: number; // Tiền giải ngân
  
  // So sánh hơn thiệt
  netBenefitOfPledge: number; // Tiết kiệm được bao nhiêu nếu VAY CẦM CỐ thay vì RÚT TRƯỚC HẠN
  // Lợi nhuận cầm cố = lossFromEarlySettlement - loanInterestCost
  
  recommendedAction: 'PLEDGE' | 'EARLY_BREAK' | 'MATURED';
  recommendationReason: string;
  breakevenDays: number; // Số ngày còn lại tối đa mà vay cầm cố vẫn có lợi hơn rút sớm
}

export interface MobilizationScenarioResult {
  title: string;
  description: string;
  totalCashRaised: number;
  totalCostOrLoss: number; // Tổng thiệt hại (mất lãi hoặc lãi vay)
  netCashRealized: number; // Thực nhận sau bù trừ
  actions: {
    bookId: string;
    action: 'PLEDGE' | 'EARLY_BREAK' | 'MATURED';
    cashRaised: number;
    financialCost: number;
    note: string;
  }[];
  savingsComparedToWorst: number;
}

export type UserRole = 'ADMIN' | 'EDITOR' | 'VIEWER';

export interface WorkspaceMember {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  addedAt: string;
  addedBy?: string;
  avatarUrl?: string;
}

export interface AuditDevice {
  deviceId: string;
  deviceName: string;
  platform: string;
  userEmail?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MasterSyncState {
  schemaVersion?: number;
  status?: 'active' | 'unlinked';
  lastAction?: 'link' | 'switch' | 'unlink' | 'create_and_link';
  activeFileId?: string;
  activeFileName?: string;
  activeFileUrl?: string;
  mimeType?: string;
  linkedTimestamp?: string;
  auditSessionId?: string;
  auditSessionStartedAt?: string;
  auditSessionEndedAt?: string;
  linkedLocalTimeVi?: string;
  linkedAccountEmail?: string;
  adminEmail?: string;
  members?: WorkspaceMember[];
  auditDevices?: AuditDevice[];
  settlements?: SettlementAdjustment[];
  banksConfig?: BankInfo[];
  auditLogs?: any[];
  updatedAt?: string;
  updatedAtVi?: string;
  appVersion?: string;
}

export interface AuthUser {
  email: string;
  name: string;
  photoURL?: string;
  role: 'admin' | 'viewer'; // Backward compatibility
  userRole?: UserRole; // Enhanced granular role
  title: string;
  isOffline?: boolean;
}

export interface AppSettings {
  privacyMode: boolean; // Ẩn số tiền
  isVipMode: boolean; // Khách hàng VIP: Cho vay 100% giá trị sổ (LTV = 100%)
  upfrontNetting: boolean; // Bù trừ tức thì tại thời điểm vay (lãi tiết kiệm cả kỳ - lãi vay) giải ngân 1 lần
  defaultLoanMargin: number; // Biên độ vay cầm cố mặc định (%/năm, e.g. 1.5)
  bankLoanMargins: Record<string, number>; // Biên độ vay riêng từng ngân hàng (%/năm, e.g. VCB: 1.5, TCB: 1.8, VPB: 2.0...)
  bankLTVs?: Record<string, number>; // % Giá trị sổ được vay riêng từng ngân hàng (e.g. 95, 100...)
  bankSettlementTypes?: Record<string, 'UPFRONT' | 'MATURITY'>; // Hình thức quyết toán riêng từng ngân hàng ('UPFRONT' = Bù trừ 1 lần, 'MATURITY' = Lúc đáo hạn)
  defaultDemandRate: number; // Lãi suất không kỳ hạn (%/năm, e.g. 0.2)
  defaultLTV: number; // Tỷ lệ cho vay tối đa nếu không phải VIP (e.g. 0.95 = 95%)
  customOwnerTags?: string[]; // Danh sách các tag chủ sổ tùy chỉnh
  husbandName?: string;
  wifeName?: string;
  googleSheetUrl?: string;
  googleSheetName?: string;
  lastSyncTime?: string;
  lastLocalLinkTimestamp?: string; // Mốc thời gian liên kết file cục bộ gần nhất để tránh tranh chấp chỉ mục
  autoSync?: boolean;
  members?: WorkspaceMember[]; // Danh sách thành viên trong không gian chia sẻ
  currentRole?: UserRole; // Vai trò hiện tại của người dùng đang đăng nhập
  isPersonalWorkspace?: boolean; // Đang ở không gian cá nhân độc lập hay không gian chung
  workspaceOwnerEmail?: string; // Email của chủ sở hữu không gian
  notificationsEnabled?: boolean; // Cho phép lập lịch thông báo nhắc đáo hạn (Capacitor / Web)
  enableBiometricLogin?: boolean; // Bật mở khóa / đăng nhập bằng Vân tay / Face ID
  updateServerUrl?: string; // URL server kiểm tra và tải cập nhật APK (ví dụ: https://domain.com)
}

export function canEditData(role?: string | null): boolean {
  if (!role) return true; // Mặc định khi chưa phân quyền là Admin/chủ máy
  const normalized = String(role).toUpperCase();
  return normalized === 'ADMIN' || normalized === 'EDITOR';
}

export function canManageMembers(role?: string | null): boolean {
  if (!role) return true;
  const normalized = String(role).toUpperCase();
  return normalized === 'ADMIN';
}

export function canPushToDrive(role?: string | null): boolean {
  if (!role) return true;
  const normalized = String(role).toUpperCase();
  return normalized === 'ADMIN' || normalized === 'EDITOR';
}

export function canChangeDriveFile(role?: string | null): boolean {
  if (!role) return true;
  const normalized = String(role).toUpperCase();
  return normalized === 'ADMIN';
}
