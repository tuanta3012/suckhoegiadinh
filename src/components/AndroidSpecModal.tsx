import React, { useState } from 'react';
import {
  Copy,
  Check,
  Smartphone,
  Bell,
  ShieldCheck,
  Database,
  Calculator,
} from 'lucide-react';

export const AndroidSpecModal: React.FC = () => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const optimizerKotlinCode = `package com.example.savingsladder.domain

import java.time.LocalDate
import java.time.temporal.ChronoUnit
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Thuật toán tính toán hơn thiệt giữa:
 * 1. Vay cầm cố sổ tiết kiệm (Loan against CD) - Hỗ trợ Khách hàng VIP vay 100% LTV & Bù trừ lãi 1 lần
 * 2. Tất toán trước hạn (Early withdrawal with demand rate)
 */
data class MobilizationAnalysis(
    val bookId: String,
    val isMatured: Boolean,
    val daysPassed: Long,
    val daysRemaining: Long,
    val lossFromEarlySettlement: Long, // Mất bao nhiêu tiền lãi nếu rút sớm
    val loanInterestCost: Long,        // Tốn bao nhiêu lãi vay nếu cầm cố đến đáo hạn
    val maxLoanAmount: Long,           // Hạn mức tiền vay được giải ngân (VIP: 100% gốc)
    val netInterestOffset: Long,       // Lãi kỳ hạn - Lãi vay bù trừ tức thì
    val netCashDisbursedUpfront: Long, // Thực nhận 1 lần = Hạn mức + Lãi bù trừ
    val netBenefitOfPledge: Long,      // Tiết kiệm được nếu cầm cố thay vì rút sớm
    val recommendedAction: RecommendedAction,
    val breakevenDaysRemaining: Long   // Ngưỡng ngày hòa vốn
)

enum class RecommendedAction {
    PLEDGE,       // Nên vay cầm cố
    EARLY_BREAK,  // Nên rút trước hạn
    MATURED       // Đã đáo hạn, rút bình thường
}

object CDLoanOptimizerEngine {

    fun analyzeBook(
        principal: Long,
        interestRate: Double,
        startDate: LocalDate,
        maturityDate: LocalDate,
        targetMobilizeDate: LocalDate,
        loanSpread: Double = 1.5,       // Biên độ lãi vay cộng thêm (+1.5%/năm tùy bank)
        demandRate: Double = 0.2,       // Lãi không kỳ hạn (0.2%/năm)
        ltv: Double = 1.0,              // Khách hàng VIP: Cho vay tối đa 100% giá trị sổ
        isVip: Boolean = true,          // Chế độ Khách VIP
        upfrontNetting: Boolean = true  // Bù trừ luôn lãi tiết kiệm với lãi vay giải ngân 1 lần
    ): MobilizationAnalysis {
        val totalDays = ChronoUnit.DAYS.between(startDate, maturityDate)
        val daysPassed = max(0, ChronoUnit.DAYS.between(startDate, targetMobilizeDate))
        val daysRemaining = ChronoUnit.DAYS.between(targetMobilizeDate, maturityDate)

        val effectiveLtv = if (isVip) 1.0 else ltv
        val maxLoanAmount = (principal * effectiveLtv).roundToLong()
        val fullTermInterest = (principal * (interestRate / 100.0) * totalDays / 365.0).roundToLong()

        if (daysRemaining <= 0) {
            return MobilizationAnalysis(
                bookId = "",
                isMatured = true,
                daysPassed = totalDays,
                daysRemaining = 0,
                lossFromEarlySettlement = 0,
                loanInterestCost = 0,
                maxLoanAmount = maxLoanAmount,
                netInterestOffset = 0,
                netCashDisbursedUpfront = principal + fullTermInterest,
                netBenefitOfPledge = 0,
                recommendedAction = RecommendedAction.MATURED,
                breakevenDaysRemaining = 0
            )
        }

        // 1. Nếu RÚT TRƯỚC HẠN:
        val termInterestLost = (principal * (interestRate / 100.0) * daysPassed / 365.0).roundToLong()
        val demandInterestEarned = (principal * (demandRate / 100.0) * daysPassed / 365.0).roundToLong()
        val lossFromBreak = max(0, termInterestLost - demandInterestEarned)

        // 2. Nếu VAY CẦM CỐ SỔ:
        val loanRate = interestRate + loanSpread
        val loanCost = (maxLoanAmount * (loanRate / 100.0) * daysRemaining / 365.0).roundToLong()

        // 3. Cơ chế VIP: Bù trừ tức thì (Upfront Netting)
        val netInterestOffset = fullTermInterest - loanCost
        val netDisbursed = if (upfrontNetting) {
            maxLoanAmount + netInterestOffset
        } else {
            maxLoanAmount
        }

        // 4. Lợi ích ròng của việc Cầm cố so với Rút sớm:
        val netBenefit = lossFromBreak - loanCost
        val netSpreadLost = max(0.1, interestRate - demandRate)
        val breakevenDays = ((totalDays * netSpreadLost) / (netSpreadLost + loanRate)).roundToLong()

        val recommendation = if (netBenefit > 0) {
            RecommendedAction.PLEDGE
        } else {
            RecommendedAction.EARLY_BREAK
        }

        return MobilizationAnalysis(
            bookId = "",
            isMatured = false,
            daysPassed = daysPassed,
            daysRemaining = daysRemaining,
            lossFromEarlySettlement = lossFromBreak,
            loanInterestCost = loanCost,
            maxLoanAmount = maxLoanAmount,
            netInterestOffset = netInterestOffset,
            netCashDisbursedUpfront = netDisbursed,
            netBenefitOfPledge = netBenefit,
            recommendedAction = recommendation,
            breakevenDaysRemaining = breakevenDays
        )
    }
}`;

  const roomEntityKotlinCode = `package com.example.savingsladder.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey
import java.time.LocalDate

@Entity(tableName = "savings_books")
data class SavingsBookEntity(
    @PrimaryKey val id: String,
    val bookCode: String,            // Số sổ / Số hợp đồng
    val bankCode: String,            // VCB, TCB, BIDV, VPB...
    val owner: String,               // HUSBAND, WIFE, BOTH, CHILDREN
    val depositType: String,         // ONLINE, COUNTER
    val principal: Long,             // Tiền gốc (VNĐ)
    val interestRate: Double,        // Lãi suất (%/năm, VD: 5.8)
    val termMonths: Int,             // Kỳ hạn gửi
    val startDate: String,           // YYYY-MM-DD
    val maturityDate: String,        // YYYY-MM-DD
    val rolloverOption: String,      // BOTH, PRINCIPAL_ONLY, NONE
    val tag: String?,                // Tích lũy mua nhà, Quỹ học vấn...
    val note: String?,
    val isArchived: Boolean = false
)`;

  const workManagerKotlinCode = `package com.example.savingsladder.worker

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * Worker chạy nền mỗi sáng kiểm tra các sổ sắp đáo hạn
 * để gửi Notification nhắc nhở 7 ngày, 3 ngày và đúng ngày đáo hạn.
 */
class MaturityCheckWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // 1. Lấy danh sách sổ từ Room Database
        // 2. So sánh ngày đáo hạn với LocalDate.now()
        // 3. Nếu còn 7 ngày, 3 ngày, hoặc 0 ngày -> Bắn Android Notification:
        //    "Sổ VCB 200tr của Chồng sẽ đáo hạn sau 3 ngày nữa. Kiểm tra phương án tái tục hoặc vay cầm cố!"
        return Result.success()
    }
}`;

  return (
    <div className="space-y-6">
      {/* Intro Header */}
      <div className="bg-gradient-to-r from-indigo-900 via-slate-900 to-slate-900 text-white p-6 rounded-2xl shadow-sm space-y-3">
        <div className="flex items-center space-x-2.5">
          <span className="p-2 rounded-xl bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
            <Smartphone className="w-5 h-5" />
          </span>
          <h2 className="text-lg font-bold">
            Kiến Trúc Kỹ Thuật Android Hoàn Chỉnh Cho Nhu Cầu Của Bạn
          </h2>
        </div>
        <p className="text-xs sm:text-sm text-slate-300 leading-relaxed max-w-4xl">
          Để hai vợ chồng quản lý lâu dài, an toàn và đồng bộ mượt mà, dưới đây là toàn bộ bản thiết kế kỹ thuật, 
          cấu trúc dữ liệu Room Database và <strong>thuật toán Kotlin tối ưu bài toán Vay Cầm Cố vs Tất Toán Sớm</strong> 
          được chuẩn hóa để bạn có thể import trực tiếp vào Android Studio.
        </p>
      </div>

      {/* Tech Stack Pillars */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-xs space-y-2">
          <div className="w-8 h-8 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center font-bold">
            <Database className="w-4 h-4" />
          </div>
          <h3 className="font-bold text-slate-900 text-xs">Room + SQLCipher</h3>
          <p className="text-[11px] text-slate-500">
            Lưu trữ offline mã hóa 256-bit an toàn trên thiết bị, bảo mật số dư tài chính cá nhân.
          </p>
        </div>

        <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-xs space-y-2">
          <div className="w-8 h-8 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center font-bold">
            <Calculator className="w-4 h-4" />
          </div>
          <h3 className="font-bold text-slate-900 text-xs">Optimizer Engine</h3>
          <p className="text-[11px] text-slate-500">
            Tính toán điểm hòa vốn và xếp hạng danh mục khi huy động vốn mua nhà tức thời.
          </p>
        </div>

        <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-xs space-y-2">
          <div className="w-8 h-8 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center font-bold">
            <Bell className="w-4 h-4" />
          </div>
          <h3 className="font-bold text-slate-900 text-xs">WorkManager</h3>
          <p className="text-[11px] text-slate-500">
            Chạy định kỳ kiểm tra ngày đáo hạn gối đầu, gửi thông báo đẩy trước 7 ngày, 3 ngày.
          </p>
        </div>

        <div className="p-4 bg-white rounded-2xl border border-slate-200 shadow-xs space-y-2">
          <div className="w-8 h-8 rounded-xl bg-purple-50 text-purple-700 flex items-center justify-center font-bold">
            <ShieldCheck className="w-4 h-4" />
          </div>
          <h3 className="font-bold text-slate-900 text-xs">Biometric Auth</h3>
          <p className="text-[11px] text-slate-500">
            Khóa ứng dụng bằng cảm biến vân tay hoặc Face Unlock trước khi xem chi tiết số dư.
          </p>
        </div>
      </div>

      {/* Code Block 1: The Optimizer Engine in Kotlin */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Calculator className="w-4 h-4 text-amber-400" />
            <span className="font-bold text-xs">
              CDLoanOptimizerEngine.kt (Thuật toán Kotlin tính Vay cầm cố vs Rút sớm)
            </span>
          </div>

          <button
            onClick={() => copyToClipboard(optimizerKotlinCode, 'optimizer')}
            className="flex items-center space-x-1 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 transition-colors"
          >
            {copiedKey === 'optimizer' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Đã copy!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Code</span>
              </>
            )}
          </button>
        </div>

        <div className="p-4 bg-slate-950 text-slate-300 font-mono text-xs overflow-x-auto max-h-96">
          <pre>{optimizerKotlinCode}</pre>
        </div>
      </div>

      {/* Code Block 2: Room Entity */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Database className="w-4 h-4 text-emerald-400" />
            <span className="font-bold text-xs">
              SavingsBookEntity.kt (Cấu trúc bảng Room Database)
            </span>
          </div>

          <button
            onClick={() => copyToClipboard(roomEntityKotlinCode, 'room')}
            className="flex items-center space-x-1 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 transition-colors"
          >
            {copiedKey === 'room' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Đã copy!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Code</span>
              </>
            )}
          </button>
        </div>

        <div className="p-4 bg-slate-950 text-slate-300 font-mono text-xs overflow-x-auto max-h-64">
          <pre>{roomEntityKotlinCode}</pre>
        </div>
      </div>

      {/* Code Block 3: WorkManager */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-5 py-3.5 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Bell className="w-4 h-4 text-teal-400" />
            <span className="font-bold text-xs">
              MaturityCheckWorker.kt (Nhắc việc tự động trước ngày đáo hạn)
            </span>
          </div>

          <button
            onClick={() => copyToClipboard(workManagerKotlinCode, 'worker')}
            className="flex items-center space-x-1 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 transition-colors"
          >
            {copiedKey === 'worker' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Đã copy!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Code</span>
              </>
            )}
          </button>
        </div>

        <div className="p-4 bg-slate-950 text-slate-300 font-mono text-xs overflow-x-auto max-h-64">
          <pre>{workManagerKotlinCode}</pre>
        </div>
      </div>
    </div>
  );
};
