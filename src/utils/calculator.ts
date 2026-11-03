import { BankInfo, MobilizationItemAnalysis, SavingsBook } from '../types';
import { getBankById } from '../data/banks';

/**
 * Tính số ngày giữa 2 ngày (YYYY-MM-DD)
 */
export function getDaysBetween(startDateStr: string, endDateStr: string): number {
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);
  // Set to noon to avoid daylight saving or timezone shifts
  start.setHours(12, 0, 0, 0);
  end.setHours(12, 0, 0, 0);
  const diffMs = end.getTime() - start.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export function doesBankWorkOnSaturday(bankId: string): boolean {
  if (!bankId) return false;
  try {
    const bank = getBankById(bankId);
    if (bank && bank.worksOnSaturday !== undefined) {
      return !!bank.worksOnSaturday;
    }
  } catch (e) {
    // ignore
  }

  // Mặc định an toàn dòng tiền: Ngân hàng thương mại không phải bên nào cũng làm việc Thứ 7.
  // Không tự động giả định làm Thứ 7 để tránh tính sai ngày tất toán tiền mặt tại quầy.
  // Người dùng chủ động bật trong Quản lý ngân hàng nếu chi nhánh của mình có mở cửa Thứ 7.
  return false;
}

/**
 * Tính ngày tất toán thực tế (kế hoạch) chuẩn ngân hàng Việt Nam:
 * - Với sổ Online: Tất toán tự động 24/7 kể cả cuối tuần/ngày lễ (giữ nguyên ngày đáo hạn).
 * - Với sổ Tại quầy:
 *   + Nếu rơi vào Chủ Nhật -> dời sang Thứ Hai tuần sau (+1 ngày).
 *   + Nếu rơi vào Thứ Bảy:
 *     * Nếu ngân hàng có làm việc Thứ Bảy (khối TMCP tư nhân) -> giữ nguyên Thứ Bảy.
 *     * Nếu ngân hàng KHÔNG làm việc Thứ Bảy (khối quốc doanh VCB, BIDV, Agribank, VietinBank) -> dời sang Thứ Hai tuần sau (+2 ngày).
 */
export function getAdjustedMaturityDate(maturityDateStr: string, depositType: 'online' | 'counter', bankId: string): string {
  if (depositType === 'online') {
    return maturityDateStr;
  }

  const [year, month, day] = maturityDateStr.replace(/\//g, '-').split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const dayOfWeek = date.getDay(); // 0: Chủ Nhật, 6: Thứ Bảy

  if (dayOfWeek === 0) {
    // Chủ Nhật -> cộng thêm 1 ngày để sang Thứ Hai
    date.setDate(date.getDate() + 1);
  } else if (dayOfWeek === 6) {
    // Thứ Bảy -> kiểm tra xem ngân hàng có làm việc thứ 7 không
    if (!doesBankWorkOnSaturday(bankId)) {
      // Không làm việc -> cộng thêm 2 ngày để sang Thứ Hai
      date.setDate(date.getDate() + 2);
    }
  }

  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Tính ngày đáo hạn dựa trên ngày bắt đầu và kỳ hạn tháng
 * Xử lý quy tắc ngân hàng: Nếu ngày gửi là ngày cuối tháng hoặc tháng đáo hạn có ít ngày hơn ngày gửi
 * (ví dụ 31/01 gửi 1 tháng -> đáo hạn 28/02 hoặc 29/02 thay vì nhảy sang tháng 3).
 */
export function calculateMaturityDate(startDateStr: string, termMonths: number): string {
  const [year, month, day] = startDateStr.replace(/\//g, '-').split('-').map(Number);
  const targetMonth = month - 1 + termMonths;
  // Khởi tạo ngày 1 của tháng mục tiêu để tránh bị tự động overflow ngày trong tháng trung gian
  const date = new Date(year, targetMonth, 1);
  // Tìm số ngày tối đa của tháng mục tiêu (ngày 0 của tháng kế tiếp = ngày cuối của targetMonth)
  const daysInTargetMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  date.setDate(clampedDay);

  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Tiền lãi chuẩn ngân hàng Việt Nam:
 * Lãi = (Gốc * Lãi suất * Số ngày) / 365
 */
export function calculateInterest(principal: number, annualRatePercent: number, days: number): number {
  if (days <= 0 || principal <= 0 || annualRatePercent <= 0) return 0;
  return Math.round((principal * (annualRatePercent / 100) * days) / 365);
}

/**
 * Tính sổ tiết kiệm được chiếu tại ngày huy động mục tiêu (giả định tự động tái tục gối đầu)
 * Nếu ngày huy động nằm ở tương lai sau ngày tất toán ban đầu, sổ sẽ tự động tái tục gối đầu
 * cùng kỳ hạn, gộp gốc + lãi (lãi nhập gốc) để tiền tiếp tục sinh lời.
 */
export function getProjectedBookAtTargetDate(
  book: SavingsBook,
  targetDateStr: string,
  autoRollover = true
): {
  projectedBook: SavingsBook;
  cycleIndex: number;
  accumulatedCompoundedInterest: number;
} {
  if (!autoRollover) {
    return {
      projectedBook: book,
      cycleIndex: 0,
      accumulatedCompoundedInterest: 0,
    };
  }

  let currentStart = book.startDate;
  let currentMaturity = book.maturityDate;
  let currentPrincipal = book.principal;
  let cycleIndex = 0;
  let accumulatedCompoundedInterest = 0;
  const termMonths = book.termMonths || 12;

  // Lặp tái tục nếu ngày huy động vượt qua ngày tất toán của chu kỳ hiện tại
  while (getDaysBetween(targetDateStr, currentMaturity) < 0) {
    const daysInCycle = Math.max(1, getDaysBetween(currentStart, currentMaturity));
    const cycleInterest = calculateInterest(currentPrincipal, book.interestRate, daysInCycle);
    accumulatedCompoundedInterest += cycleInterest;

    // Tái tục gốc + lãi nhập gốc (hoặc chỉ gốc nếu rolloverOption là principal_only)
    if (book.rolloverOption !== 'principal_only') {
      currentPrincipal += cycleInterest;
    }

    currentStart = currentMaturity;
    currentMaturity = calculateMaturityDate(currentStart, termMonths);
    cycleIndex++;
  }

  const projectedBook: SavingsBook = {
    ...book,
    startDate: currentStart,
    maturityDate: currentMaturity,
    principal: currentPrincipal,
  };

  return {
    projectedBook,
    cycleIndex,
    accumulatedCompoundedInterest,
  };
}

/**
 * Phân tích hơn thiệt chi tiết cho từng sổ tiết kiệm tại một thời điểm cần huy động
 * Hỗ trợ Khách hàng VIP: Vay 100% giá trị sổ (LTV 100%), biên độ tùy biến theo từng ngân hàng,
 * và Cơ chế Bù trừ lãi ngay tại thời điểm vay (Upfront Netting) chỉ cần xử lý 1 lần duy nhất.
 */
export function analyzeBookMobilization(
  book: SavingsBook,
  targetDateStr: string,
  customLoanMargin?: number,
  customDemandRate = 0.2,
  customLTV?: number,
  bankLoanMargins?: Record<string, number>,
  isVipMode = false,
  autoRollover = true,
  bankLTVs?: Record<string, number>
): MobilizationItemAnalysis {
  const { projectedBook, cycleIndex, accumulatedCompoundedInterest } =
    getProjectedBookAtTargetDate(book, targetDateStr, autoRollover);

  const bank: BankInfo = getBankById(projectedBook.bankId);

  // Xác định biên độ lãi vay:
  let loanMargin: number;
  if (projectedBook.customLoanMargin !== undefined) {
    loanMargin = projectedBook.customLoanMargin;
  } else if (bankLoanMargins && bankLoanMargins[projectedBook.bankId] !== undefined) {
    loanMargin = bankLoanMargins[projectedBook.bankId];
  } else if (customLoanMargin !== undefined) {
    loanMargin = customLoanMargin;
  } else {
    loanMargin = bank.defaultLoanMargin;
  }

  // Tỷ lệ cho vay (LTV) theo cấu hình riêng từng ngân hàng (nếu có)
  let ltv: number;
  if (bankLTVs && bankLTVs[projectedBook.bankId] !== undefined) {
    ltv = bankLTVs[projectedBook.bankId] / 100;
  } else if (customLTV !== undefined) {
    ltv = customLTV;
  } else if (isVipMode) {
    ltv = 1.0;
  } else {
    ltv = bank.maxLTV ?? 0.95;
  }
  const demandRate = customDemandRate;

  const daysTotalTerm = Math.max(1, getDaysBetween(projectedBook.startDate, projectedBook.maturityDate));
  const daysPassed = getDaysBetween(projectedBook.startDate, targetDateStr);
  const daysRemaining = getDaysBetween(targetDateStr, projectedBook.maturityDate);

  const fullTermInterest = calculateInterest(projectedBook.principal, projectedBook.interestRate, daysTotalTerm);

  // Sổ đã đáo hạn đúng ngày hoặc đã qua hết chu kỳ
  if (daysRemaining <= 0) {
    const totalCash = projectedBook.principal + fullTermInterest;
    let reason = 'Sổ đã đến ngày đáo hạn. Rút trọn vẹn 100% gốc và lãi kỳ hạn, không bị thiệt hại đồng nào.';
    if (cycleIndex > 0) {
      reason = `Sổ đã tự động tái tục ${cycleIndex} kỳ gối đầu và vừa đáo hạn đúng mốc (${projectedBook.maturityDate}). Rút trọn 100% gốc gộp (${Math.round(projectedBook.principal).toLocaleString('vi-VN')} đ) + lãi 0đ phí!`;
    }

    return {
      book,
      projectedBook,
      cycleIndex,
      accumulatedCompoundedInterest,
      isMatured: true,
      daysTotalTerm,
      daysPassed: daysTotalTerm,
      daysRemaining: 0,
      fullTermInterest,
      passedTermInterestLost: 0,
      passedDemandInterestEarned: 0,
      lossFromEarlySettlement: 0,
      cashFromEarlySettlement: totalCash,
      loanRate: projectedBook.interestRate + loanMargin,
      appliedLoanMargin: loanMargin,
      appliedLtv: ltv,
      maxLoanAmount: Math.round(projectedBook.principal * ltv),
      loanInterestCost: 0,
      netInterestOffset: fullTermInterest,
      netCashDisbursedUpfront: totalCash,
      netCashFromLoan: Math.round(projectedBook.principal * ltv),
      netBenefitOfPledge: 0,
      recommendedAction: 'MATURED',
      recommendationReason: reason,
      breakevenDays: 0,
    };
  }

  // Sổ chưa đáo hạn trong chu kỳ chiếu: So sánh Rút trước hạn vs Vay cầm cố
  const safeDaysPassed = Math.max(0, daysPassed);

  // 1. Nếu rút trước hạn
  const passedTermInterestLost = calculateInterest(projectedBook.principal, projectedBook.interestRate, safeDaysPassed);
  const passedDemandInterestEarned = calculateInterest(projectedBook.principal, demandRate, safeDaysPassed);
  const lossFromEarlySettlement = Math.max(0, passedTermInterestLost - passedDemandInterestEarned);
  const cashFromEarlySettlement = projectedBook.principal + passedDemandInterestEarned;

  // 2. Nếu vay cầm cố sổ
  const loanRate = Number((projectedBook.interestRate + loanMargin).toFixed(2));
  const maxLoanAmount = Math.round(projectedBook.principal * ltv);
  const loanInterestCost = calculateInterest(maxLoanAmount, loanRate, daysRemaining);

  // 3. Upfront Netting VIP
  const netInterestOffset = fullTermInterest - loanInterestCost;
  const netCashDisbursedUpfront = maxLoanAmount + netInterestOffset;
  const netCashFromLoan = maxLoanAmount;

  // 4. So sánh hơn thiệt:
  const netBenefitOfPledge = lossFromEarlySettlement - loanInterestCost;

  const netSpreadLost = Math.max(0.1, projectedBook.interestRate - demandRate);
  const breakevenRemainingDays = Math.round(
    (daysTotalTerm * netSpreadLost) / (netSpreadLost + loanRate)
  );

  let recommendedAction: 'PLEDGE' | 'EARLY_BREAK' | 'MATURED';
  let recommendationReason = '';

  const cyclePrefix = cycleIndex > 0 ? ` [Giả định tái tục kỳ ${cycleIndex}]` : '';

  if (netBenefitOfPledge > 0) {
    recommendedAction = 'PLEDGE';
    recommendationReason = `NÊN VAY THẾ CHẤP${cyclePrefix}: Sổ chỉ còn ${daysRemaining} ngày là tất toán (${projectedBook.maturityDate}). Tiền lãi tiết kiệm cuối kỳ đủ bù đắp hoàn toàn chi phí lãi vay (${loanRate}%), mang lại chênh lệch dương +${Math.round(netBenefitOfPledge).toLocaleString('vi-VN')} đ so với rút sớm.`;
  } else {
    recommendedAction = 'EARLY_BREAK';
    recommendationReason = `NÊN TẤT TOÁN TRƯỚC HẠN${cyclePrefix}: Sổ mới ở đầu chu kỳ (mới qua ${safeDaysPassed} ngày), còn tận ${daysRemaining} ngày nữa mới đáo hạn. Chi phí phạt rút sớm rất nhỏ (${Math.round(lossFromEarlySettlement).toLocaleString('vi-VN')} đ), tiết kiệm hơn nhiều so với việc phải gánh lãi vay thế chấp trong ${daysRemaining} ngày (${Math.round(loanInterestCost).toLocaleString('vi-VN')} đ).`;
  }

  return {
    book,
    projectedBook,
    cycleIndex,
    accumulatedCompoundedInterest,
    isMatured: false,
    daysTotalTerm,
    daysPassed: safeDaysPassed,
    daysRemaining,
    fullTermInterest,
    passedTermInterestLost,
    passedDemandInterestEarned,
    lossFromEarlySettlement,
    cashFromEarlySettlement,
    loanRate,
    appliedLoanMargin: loanMargin,
    appliedLtv: ltv,
    maxLoanAmount,
    loanInterestCost,
    netInterestOffset,
    netCashDisbursedUpfront,
    netCashFromLoan,
    netBenefitOfPledge,
    recommendedAction,
    recommendationReason,
    breakevenDays: breakevenRemainingDays,
  };
}

/**
 * Thuật toán tối ưu hóa tổng thể:
 * Đưa ra phương án huy động số tiền mục tiêu Target Amount với tổng thiệt hại tài chính là THẤP NHẤT
 */
export function solveOptimalMobilizationPlan(
  books: SavingsBook[],
  targetAmount: number,
  targetDateStr: string,
  customLoanMargin?: number,
  customDemandRate = 0.2,
  customLTV?: number,
  bankLoanMargins?: Record<string, number>,
  isVipMode = false,
  upfrontNetting = false,
  autoRollover = true,
  bankLTVs?: Record<string, number>,
  bankSettlementTypes?: Record<string, 'UPFRONT' | 'MATURITY'>
) {
  // Lọc các sổ đang active
  const activeBooks = books.filter((b) => b.status === 'active');
  
  // Phân tích từng sổ
  const analyses = activeBooks.map((book) =>
    analyzeBookMobilization(
      book,
      targetDateStr,
      customLoanMargin,
      customDemandRate,
      customLTV,
      bankLoanMargins,
      isVipMode,
      autoRollover,
      bankLTVs
    )
  );

  // Sắp xếp ưu tiên huy động:
  // 1. Sổ đã đáo hạn (chi phí = 0)
  // 2. Sổ có chi phí huy động thấp nhất trên mỗi triệu đồng vốn huy động được
  const scoredAnalyses = analyses.map((a) => {
    let optimalAction: 'PLEDGE' | 'EARLY_BREAK' | 'MATURED' = a.recommendedAction;
    let cost = 0;
    let cashProvided = 0;

    const bId = a.projectedBook.bankId;
    const isUpfront = bankSettlementTypes && bankSettlementTypes[bId] !== undefined
      ? bankSettlementTypes[bId] === 'UPFRONT'
      : upfrontNetting;

    if (a.isMatured) {
      cost = 0;
      cashProvided = a.cashFromEarlySettlement;
    } else if (a.recommendedAction === 'PLEDGE') {
      cost = a.loanInterestCost;
      cashProvided = isUpfront ? a.netCashDisbursedUpfront : a.maxLoanAmount;
    } else {
      cost = a.lossFromEarlySettlement;
      cashProvided = a.cashFromEarlySettlement;
    }

    const costRatio = cashProvided > 0 ? cost / cashProvided : 999;

    return {
      analysis: a,
      optimalAction,
      cost,
      cashProvided,
      costRatio,
    };
  });

  // Sắp xếp tăng dần theo costRatio
  scoredAnalyses.sort((a, b) => a.costRatio - b.costRatio);

  // Thu thập các sổ để đạt targetAmount
  let accumulatedCash = 0;
  const selectedItems: typeof scoredAnalyses = [];

  for (const item of scoredAnalyses) {
    if (accumulatedCash < targetAmount) {
      selectedItems.push(item);
      accumulatedCash += item.cashProvided;
    }
  }

  // Tính toán 3 kịch bản tổng thể để so sánh trực quan:
  // Kịch bản 1: Kịch bản Lai Tối ưu (Smart Hybrid Recommendation)
  const optimalTotalCost = selectedItems.reduce((sum, item) => sum + item.cost, 0);
  const optimalTotalCash = selectedItems.reduce((sum, item) => sum + item.cashProvided, 0);

  // Kịch bản 2: Tất toán trước hạn tất cả các sổ trong danh sách chọn
  const allBreakTotalCost = selectedItems.reduce(
    (sum, item) => sum + item.analysis.lossFromEarlySettlement,
    0
  );
  const allBreakTotalCash = selectedItems.reduce(
    (sum, item) => sum + item.analysis.cashFromEarlySettlement,
    0
  );

  // Kịch bản 3: Vay cầm cố tất cả các sổ trong danh sách chọn
  const allPledgeTotalCost = selectedItems.reduce(
    (sum, item) => sum + item.analysis.loanInterestCost,
    0
  );
  const allPledgeTotalCash = selectedItems.reduce(
    (sum, item) => sum + (upfrontNetting ? item.analysis.netCashDisbursedUpfront : item.analysis.maxLoanAmount),
    0
  );

  // Số tiền tiết kiệm được so với phương án rút trước hạn thông thường
  const savingsVsAllBreak = Math.max(0, allBreakTotalCost - optimalTotalCost);

  return {
    allAnalyses: analyses,
    selectedItems,
    optimalTotalCash,
    optimalTotalCost,
    allBreakTotalCost,
    allBreakTotalCash,
    allPledgeTotalCost,
    allPledgeTotalCash,
    savingsVsAllBreak,
    isTargetReached: optimalTotalCash >= targetAmount,
    totalPortfolioPrincipal: activeBooks.reduce((sum, b) => sum + b.principal, 0),
  };
}

export interface DayOptimizationResult {
  dayNumber: number;
  dateStr: string;
  dayOfWeekLabel: string;
  optimalTotalCost: number;
  optimalTotalCash: number;
  optimalLoanInterestCost: number;
  optimalEarlyLossCost: number;
  freeMaturedCash: number;
  maturedBooksCount: number;
  pledgeCount: number;
  earlyBreakCount: number;
  savingsVsAllBreak: number;
  isTargetReached: boolean;
  selectedItems: {
    analysis: MobilizationItemAnalysis;
    optimalAction: 'PLEDGE' | 'EARLY_BREAK' | 'MATURED';
    cost: number;
    cashProvided: number;
    costRatio: number;
  }[];
  allAnalyses: MobilizationItemAnalysis[];
  rationale: string;
}

export interface MonthOptimizationResult {
  year: number;
  month: number; // 1-12
  monthLabel: string; // e.g. "Tháng 10/2026"
  bestDay: DayOptimizationResult;
  allDays: DayOptimizationResult[];
  minCost: number;
  maxCost: number;
  avgCost: number;
}

const VN_DAY_NAMES = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

/**
 * Quét toàn bộ các ngày trong 1 tháng để tìm ngày tối ưu nhất với chi phí huy động vốn thấp nhất
 */
export function findOptimalDayInMonth(
  books: SavingsBook[],
  targetAmount: number,
  year: number,
  month: number, // 1-12
  bankLoanMargins?: Record<string, number>,
  bankLTVs?: Record<string, number>,
  bankSettlementTypes?: Record<string, 'UPFRONT' | 'MATURITY'>,
  demandRate = 0.2,
  autoRollover = true
): MonthOptimizationResult {
  const daysInMonth = new Date(year, month, 0).getDate();
  const allDays: DayOptimizationResult[] = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const jsDate = new Date(year, month - 1, d);
    const dayOfWeekLabel = VN_DAY_NAMES[jsDate.getDay()];

    const plan = solveOptimalMobilizationPlan(
      books,
      targetAmount,
      dStr,
      undefined,
      demandRate,
      undefined,
      bankLoanMargins,
      false,
      false,
      autoRollover,
      bankLTVs,
      bankSettlementTypes
    );

    const maturedAnalyses = plan.allAnalyses.filter((a) => a.isMatured);
    const freeMaturedCash = maturedAnalyses.reduce((sum, a) => sum + a.cashFromEarlySettlement, 0);
    const maturedBooksCount = maturedAnalyses.length;

    const pledgeItems = plan.selectedItems.filter((i) => i.optimalAction === 'PLEDGE');
    const earlyBreakItems = plan.selectedItems.filter((i) => i.optimalAction === 'EARLY_BREAK');
    const optimalLoanInterestCost = pledgeItems.reduce((sum, i) => sum + i.analysis.loanInterestCost, 0);
    const optimalEarlyLossCost = earlyBreakItems.reduce((sum, i) => sum + i.analysis.lossFromEarlySettlement, 0);

    let rationale = '';
    if (plan.optimalTotalCost === 0 && maturedBooksCount > 0) {
      rationale = `Tại ngày ${d}/${month}/${year} (${dayOfWeekLabel}), có ${maturedBooksCount} sổ đáo hạn đúng mốc mang lại ${Math.round(freeMaturedCash / 1_000_000).toLocaleString('vi-VN')} Tr tiền mặt tự do, chi phí huy động hoàn toàn 0 đồng.`;
    } else if (pledgeItems.length > 0 && earlyBreakItems.length === 0) {
      rationale = `Tại ngày ${d}/${month}/${year}, tối ưu bằng cách vay thế chấp ${pledgeItems.length} sổ gần ngày đáo hạn để bảo toàn lãi gốc, chi phí lãi vay chỉ ${Math.round(optimalLoanInterestCost / 1_000_000).toLocaleString('vi-VN')} Tr.`;
    } else if (pledgeItems.length > 0 && earlyBreakItems.length > 0) {
      rationale = `Tại ngày ${d}/${month}/${year}, phương án lai kết hợp vay ${pledgeItems.length} sổ sắp đến hạn và rút sớm ${earlyBreakItems.length} sổ mới gửi để đạt chi phí thấp nhất.`;
    } else {
      rationale = `Tại ngày ${d}/${month}/${year}, rút sớm các sổ mới gửi với chi phí mất lãi không đáng kể (${Math.round(plan.optimalTotalCost / 1_000_000).toLocaleString('vi-VN')} Tr).`;
    }

    allDays.push({
      dayNumber: d,
      dateStr: dStr,
      dayOfWeekLabel,
      optimalTotalCost: plan.optimalTotalCost,
      optimalTotalCash: plan.optimalTotalCash,
      optimalLoanInterestCost,
      optimalEarlyLossCost,
      freeMaturedCash,
      maturedBooksCount,
      pledgeCount: pledgeItems.length,
      earlyBreakCount: earlyBreakItems.length,
      savingsVsAllBreak: plan.savingsVsAllBreak,
      isTargetReached: plan.isTargetReached,
      selectedItems: plan.selectedItems,
      allAnalyses: plan.allAnalyses,
      rationale,
    });
  }

  // Tìm ngày tốt nhất trong tháng:
  // Ưu tiên:
  // 1. Đạt target (isTargetReached === true)
  // 2. Chi phí thấp nhất (optimalTotalCost min)
  // 3. Nếu cùng chi phí = 0, ưu tiên ngày có freeMaturedCash lớn nhất hoặc ngày sớm hơn
  let bestDay = allDays[0];
  for (let i = 1; i < allDays.length; i++) {
    const curr = allDays[i];
    if (curr.isTargetReached && !bestDay.isTargetReached) {
      bestDay = curr;
    } else if (curr.isTargetReached === bestDay.isTargetReached) {
      if (curr.optimalTotalCost < bestDay.optimalTotalCost) {
        bestDay = curr;
      } else if (curr.optimalTotalCost === bestDay.optimalTotalCost) {
        if (curr.freeMaturedCash > bestDay.freeMaturedCash) {
          bestDay = curr;
        }
      }
    }
  }

  const costs = allDays.map((d) => d.optimalTotalCost);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  const avgCost = Math.round(costs.reduce((a, b) => a + b, 0) / (costs.length || 1));

  return {
    year,
    month,
    monthLabel: `Tháng ${String(month).padStart(2, '0')}/${year}`,
    bestDay,
    allDays,
    minCost,
    maxCost,
    avgCost,
  };
}

/**
 * Quét nhiều tháng liên tục trong khoảng (Từ startYear/startMonth đến endYear/endMonth)
 */
export function findOptimalDaysInRange(
  books: SavingsBook[],
  targetAmount: number,
  startYear: number,
  startMonth: number,
  endYear: number,
  endMonth: number,
  bankLoanMargins?: Record<string, number>,
  bankLTVs?: Record<string, number>,
  bankSettlementTypes?: Record<string, 'UPFRONT' | 'MATURITY'>,
  demandRate = 0.2,
  autoRollover = true
): MonthOptimizationResult[] {
  const results: MonthOptimizationResult[] = [];
  let y = startYear;
  let m = startMonth;

  while (y < endYear || (y === endYear && m <= endMonth)) {
    const monthRes = findOptimalDayInMonth(
      books,
      targetAmount,
      y,
      m,
      bankLoanMargins,
      bankLTVs,
      bankSettlementTypes,
      demandRate,
      autoRollover
    );
    results.push(monthRes);

    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }

  return results;
}
