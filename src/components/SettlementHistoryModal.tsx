import React, { useMemo } from 'react';
import { X, History, Trash2 } from 'lucide-react';
import { SettlementAdjustment, AppSettings } from '../types';
import { formatMillionVND, formatDateVN } from '../utils/formatters';
import { deduplicateSettlementAdjustments } from '../utils/dataTranslator';
import { useConfirmDialog } from '../context/ConfirmDialogContext';

interface SettlementHistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  settlements: SettlementAdjustment[];
  settings: AppSettings;
  onDeleteSettlement?: (id: string) => void;
}

export const SettlementHistoryModal: React.FC<SettlementHistoryModalProps> = ({
  isOpen,
  onClose,
  settlements,
  settings,
  onDeleteSettlement,
}) => {
  const { confirm } = useConfirmDialog();
  // Sắp xếp danh sách biến động theo thời gian thực hiện (Mới nhất trên cùng)
  const sortedSettlements = useMemo(() => {
    const deduped = deduplicateSettlementAdjustments(settlements || []);
    return deduped.sort((a, b) => {
      const timeA = a.timestamp || (a.settlementDate ? new Date(a.settlementDate).getTime() : 0);
      const timeB = b.timestamp || (b.settlementDate ? new Date(b.settlementDate).getTime() : 0);
      return timeB - timeA;
    });
  }, [settlements]);

  const getOwnerLabel = (owner: string) => {
    if (owner === 'chong') return settings.husbandName || 'Chồng';
    if (owner === 'vo') return settings.wifeName || 'Vợ';
    if (owner === 'con') return 'Con';
    if (owner === 'chung') return 'Chung';
    return owner || 'Chung';
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/70 backdrop-blur-xs animate-in fade-in duration-200">
      <div className="bg-white w-full max-w-xl max-h-[85vh] rounded-2xl sm:rounded-3xl shadow-2xl border border-slate-200 flex flex-col overflow-hidden animate-in zoom-in-95 duration-150">
        {/* Header - Chỉ có Đề mục, Số biến động và Nút đóng */}
        <div className="bg-gradient-to-r from-amber-600 via-amber-700 to-amber-800 px-4 sm:px-5 py-3 text-white flex items-center justify-between shadow-xs shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-white/15 border border-white/25 flex items-center justify-center shadow-inner">
              <History className="w-4 h-4 text-amber-200" />
            </div>
            <div className="flex items-center space-x-2">
              <h3 className="font-bold text-base sm:text-lg leading-tight">
                Nhật Ký Biến Động
              </h3>
              <span className="text-xs bg-amber-500/60 border border-amber-300/40 text-white px-2 py-0.5 rounded-full font-bold">
                {sortedSettlements.length}
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 active:bg-white/30 flex items-center justify-center text-white transition-colors cursor-pointer"
            title="Đóng"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Danh sách thẻ biến động (Sắp xếp mới nhất trên cùng) */}
        <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-3 bg-slate-50/60">
          {sortedSettlements.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs sm:text-sm">
              <History className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              Chưa có lịch sử biến động nào được ghi nhận.
            </div>
          ) : (
            <div className="space-y-2.5">
              {sortedSettlements.map((adj) => (
                <div
                  key={adj.id}
                  className="bg-white p-3 rounded-xl border border-amber-200/90 shadow-2xs space-y-2 text-xs hover:border-amber-400 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center space-x-2 min-w-0">
                      <span className="font-bold text-slate-900 font-mono truncate">{adj.bookCode || 'SỔ TIẾT KIỆM'}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 font-medium shrink-0">
                        {adj.bankId.toUpperCase()} - {getOwnerLabel(adj.owner)}
                      </span>
                    </div>
                    <div className="flex items-center space-x-1.5 shrink-0">
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          adj.settlementType === 'early'
                            ? 'bg-rose-100 text-rose-800'
                            : adj.reinvested
                            ? 'bg-teal-100 text-teal-800'
                            : 'bg-emerald-100 text-emerald-800'
                        }`}
                      >
                        {adj.settlementType === 'early' ? 'Rút trước hạn' : (adj.reinvested ? 'Tái tục kỳ mới' : 'Tất toán đúng hạn')}
                      </span>
                      {onDeleteSettlement && (
                        <button
                          onClick={async () => {
                            if (await confirm({
                              title: 'Xóa bản ghi?',
                              message: `${adj.bookCode || 'Sổ'} · ${formatDateVN(adj.settlementDate)}`,
                            })) {
                              onDeleteSettlement(adj.id);
                            }
                          }}
                          className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer"
                          title="Xóa bản ghi này"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {(() => {
                    const isEarly = adj.settlementType === 'early';
                    const settleYear = adj.settlementYear || (adj.settlementDate ? parseInt(adj.settlementDate.slice(0, 4), 10) : new Date().getFullYear());
                    const maturityYear = adj.originalMaturityYear || settleYear;
                    const expectedInterest = adj.expectedTermInterest || (adj.lostInterestVND ? adj.actualInterestVND + adj.lostInterestVND : undefined);

                    // Nếu tất toán sớm cho sổ vốn đáo hạn ở năm tương lai (maturityYear > settleYear):
                    // Năm settleYear nhận lãi thực nhận: actualInterestVND
                    // Năm maturityYear bị mất toàn bộ lãi đúng hạn: expectedInterest
                    const isCrossYear = isEarly && maturityYear > settleYear;
                    const lostInterestInMaturityYear = isCrossYear
                      ? (expectedInterest || 0)
                      : (adj.lostInterestVND || (expectedInterest && expectedInterest > adj.actualInterestVND ? expectedInterest - adj.actualInterestVND : 0));

                    return (
                      <>
                        <div className="grid grid-cols-2 gap-2 bg-slate-50 p-2.5 rounded-lg text-[11px]">
                          {/* Dòng 1 */}
                          <div>
                            <span className="text-slate-400 block text-[10px]">Tiền gốc:</span>
                            <span className="font-bold text-slate-800 font-mono">
                              {formatMillionVND(adj.principal, settings.privacyMode)}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-400 block text-[10px]">Lãi thực nhận ({settleYear}):</span>
                            <span className="font-bold text-emerald-700 font-mono">
                              +{formatMillionVND(adj.actualInterestVND, settings.privacyMode)}
                            </span>
                          </div>

                          {/* Dòng 2: Lãi bị mất nằm ngay dưới Lãi thực nhận ở cột bên phải */}
                          <div>
                            <span className="text-slate-400 block text-[10px]">Ngày thực hiện:</span>
                            <span className="font-semibold text-slate-700">{formatDateVN(adj.settlementDate)}</span>
                          </div>
                          {isEarly && lostInterestInMaturityYear > 0 ? (
                            <div>
                              <span className="text-slate-400 block text-[10px]">Lãi bị mất ({maturityYear}):</span>
                              <span className="font-bold text-rose-600 font-mono">
                                -{formatMillionVND(lostInterestInMaturityYear, settings.privacyMode)}
                              </span>
                            </div>
                          ) : (
                            <div>
                              <span className="text-slate-400 block text-[10px]">Đáo hạn gốc:</span>
                              <span className="font-semibold text-slate-700">Năm {maturityYear}</span>
                            </div>
                          )}

                          {/* Dòng 3 */}
                          {isEarly && lostInterestInMaturityYear > 0 ? (
                            <>
                              <div>
                                <span className="text-slate-400 block text-[10px]">Đáo hạn gốc:</span>
                                <span className="font-semibold text-slate-700">Năm {maturityYear}</span>
                              </div>
                              {expectedInterest && expectedInterest > 0 ? (
                                <div>
                                  <span className="text-slate-400 block text-[10px]">Lãi đúng hạn ban đầu ({maturityYear}):</span>
                                  <span className="font-semibold text-slate-600 font-mono">
                                    {formatMillionVND(expectedInterest, settings.privacyMode)}
                                  </span>
                                </div>
                              ) : (
                                <div />
                              )}
                            </>
                          ) : null}
                        </div>

                        <div className="pt-1 text-[10.5px] text-slate-500 border-t border-slate-100 leading-snug">
                          {isEarly ? (
                            `Tất toán trước hạn ngày ${formatDateVN(adj.settlementDate)}. Lãi nhận: +${formatMillionVND(adj.actualInterestVND, settings.privacyMode)} (${settleYear}), mất: -${formatMillionVND(lostInterestInMaturityYear, settings.privacyMode)} (${maturityYear}).`
                          ) : adj.reinvested ? (
                            `Tái tục kỳ mới ngày ${formatDateVN(adj.settlementDate)}. Lãi chốt chu kỳ cũ: +${formatMillionVND(adj.actualInterestVND, settings.privacyMode)} (${settleYear}).`
                          ) : (
                            `Tất toán đúng hạn ngày ${formatDateVN(adj.settlementDate)}. Lãi nhận đủ: +${formatMillionVND(adj.actualInterestVND, settings.privacyMode)} (${settleYear}).`
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
