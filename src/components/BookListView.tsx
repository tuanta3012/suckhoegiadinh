import React, { useState } from 'react';
import {
  SavingsBook,
  AppSettings,
  AuthUser,
  SettlementAdjustment,
  canEditData,
} from '../types';
import { ExcelSheetView } from './ExcelSheetView';
import { SettlementHistoryModal } from './SettlementHistoryModal';
import {
  FileSpreadsheet,
  Cloud,
  Plus,
  History,
} from 'lucide-react';

interface BookListViewProps {
  books: SavingsBook[];
  filteredBooks: SavingsBook[];
  settings: AppSettings;
  currentDateStr: string;
  settlementAdjustments: SettlementAdjustment[];
  currentUser: AuthUser | null;
  sheetSubView?: 'excel' | 'cards';
  setSheetSubView?: (view: 'excel' | 'cards') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  ownerFilter: string;
  setOwnerFilter: (owner: string) => void;
  bankFilter: string;
  setBankFilter: (bank: string) => void;
  sortBy: 'maturity' | 'principal' | 'rate';
  setSortBy: (sort: 'maturity' | 'principal' | 'rate') => void;
  banksVersion?: number;
  sortedBanksInfo: {
    frequentBanks: any[];
    otherBanks: any[];
  };
  isSyncingDrive: boolean;
  needsDriveAuth?: boolean;
  isOnline?: boolean;
  onOpenSyncModal: () => void;
  onOpenAddModal: () => void;
  onOpenManageBanks: () => void;
  onSelectForAnalysis: (book: SavingsBook) => void;
  onOpenEdit: (book: SavingsBook) => void;
  onUpdateBook?: (book: SavingsBook) => void;
  onSettleBook?: (bookId: string, extra?: { isEarlySettled: boolean; settlementDate: string; actualInterestVND: number }) => void;
  onRolloverBook?: (oldBookId: string, rolloverConfig: { newPrincipal: number; newInterestRate: number; newTermMonths: number; newStartDate: string; newMaturityDate: string }) => void;
  onDeleteBook: (bookId: string) => void;
  onOpenOptimizer: () => void;
  onOpenInterestCalc: () => void;
  onSyncDrive: () => Promise<void>;
  onResetData?: () => void;
  onImportBooks?: (books: SavingsBook[], mode: 'replace' | 'merge') => void;
  onDeleteSettlement?: (id: string) => void;
}

export const BookListView: React.FC<BookListViewProps> = ({
  books,
  settings,
  currentDateStr,
  settlementAdjustments,
  banksVersion = 0,
  isSyncingDrive,
  needsDriveAuth = false,
  isOnline = true,
  onOpenSyncModal,
  onOpenAddModal,
  onSelectForAnalysis,
  onUpdateBook,
  onSettleBook,
  onRolloverBook,
  onDeleteBook,
  onOpenOptimizer,
  onOpenInterestCalc,
  onSyncDrive,
  onImportBooks,
  onDeleteSettlement,
}) => {
  const [isSettlementModalOpen, setIsSettlementModalOpen] = useState(false);

  return (
    <div className="space-y-4">
      {/* Action Bar: Bảng kê & Nhật ký Button + Drive Sync + Add Book */}
      <div className="bg-white p-2 sm:p-3 rounded-2xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 sm:gap-3">
        {/* Main Tabs: Bảng kê + Nhật ký */}
        <div className="flex flex-wrap items-center gap-1.5 w-full sm:w-auto">
          <div className="flex items-center bg-slate-100 p-1 rounded-xl w-full sm:w-auto overflow-x-auto">
            <div className="flex-1 sm:flex-none flex items-center justify-center space-x-1.5 px-3 sm:px-4 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white shadow-xs whitespace-nowrap">
              <FileSpreadsheet className="w-3.5 h-3.5 shrink-0" />
              <span>Bảng kê ({books.length} sổ)</span>
            </div>

            <button
              id="btn-open-activity-log"
              onClick={() => setIsSettlementModalOpen(true)}
              className="flex-1 sm:flex-none flex items-center justify-center space-x-1.5 px-3 sm:px-4 py-1.5 rounded-lg text-xs font-bold text-amber-900 bg-amber-100 hover:bg-amber-200 active:bg-amber-300 transition-all cursor-pointer whitespace-nowrap ml-1 border border-amber-300/80 shadow-2xs"
              title="Xem nhật ký biến động sổ, tất toán và tái tục"
            >
              <History className="w-3.5 h-3.5 text-amber-700 shrink-0" />
              <span>Nhật ký</span>
              <span className="bg-amber-500 text-slate-950 text-[10px] px-1.5 py-0.2 rounded-full font-extrabold shadow-2xs">
                {settlementAdjustments ? settlementAdjustments.length : 0}
              </span>
            </button>
          </div>
        </div>

        {/* Actions right beside switcher */}
        <div className="flex items-center space-x-2 w-full sm:w-auto">
          <button
            id="btn-subview-sync-drive"
            onClick={onOpenSyncModal}
            disabled={!isOnline || isSyncingDrive}
            className={`flex-1 sm:flex-none flex items-center justify-center space-x-1.5 px-3 py-1.5 rounded-xl border text-xs font-bold transition-colors cursor-pointer whitespace-nowrap disabled:opacity-60 ${
              isOnline && needsDriveAuth
                ? 'bg-amber-50 hover:bg-amber-100 active:bg-amber-200 text-amber-900 border-amber-300'
                : 'bg-emerald-50 hover:bg-emerald-100 active:bg-emerald-200 text-emerald-800 border-emerald-300'
            }`}
          >
            <Cloud className={`w-3.5 h-3.5 shrink-0 ${isOnline && needsDriveAuth ? 'text-amber-700' : 'text-emerald-600'}`} />
            <span>{isOnline && needsDriveAuth ? 'Đồng bộ ngay!' : 'Đồng bộ Google Drive'}</span>
          </button>

          <button
            id="btn-subview-add-book"
            onClick={() => {
              if (!canEditData(settings.currentRole)) {
                alert('Tài khoản của bạn ở vai trò "Chỉ xem (Viewer)". Bạn không có quyền thêm hoặc chỉnh sửa dữ liệu.');
                return;
              }
              onOpenAddModal();
            }}
            disabled={!canEditData(settings.currentRole)}
            className={`flex-1 sm:flex-none flex items-center justify-center space-x-1 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors whitespace-nowrap ${
              canEditData(settings.currentRole)
                ? 'bg-teal-700 hover:bg-teal-800 active:bg-teal-900 text-white cursor-pointer'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed opacity-70'
            }`}
            title={canEditData(settings.currentRole) ? 'Thêm sổ tiết kiệm' : 'Tài khoản chỉ xem - không thể thêm sổ'}
          >
            <Plus className={`w-3.5 h-3.5 shrink-0 ${canEditData(settings.currentRole) ? 'text-teal-100' : 'text-slate-400'}`} />
            <span>Thêm sổ</span>
          </button>
        </div>
      </div>

      {/* Main View: Excel Sheet View */}
      <ExcelSheetView
        books={books}
        settings={settings}
        currentDateStr={currentDateStr}
        banksVersion={banksVersion}
        settlements={settlementAdjustments}
        onOpenDetail={onSelectForAnalysis}
        onUpdateBook={onUpdateBook}
        onSettleBook={onSettleBook}
        onRolloverBook={onRolloverBook}
        onDeleteBook={onDeleteBook}
        onOpenOptimizer={onOpenOptimizer}
        onOpenSyncModal={onOpenSyncModal}
        onOpenInterestCalc={onOpenInterestCalc}
        onSyncDrive={onSyncDrive}
        isSyncingDrive={isSyncingDrive}
        onImportBooks={onImportBooks}
        onOpenAddModal={onOpenAddModal}
      />

      {/* Modal Nhật Ký Biến Động Sổ (Mobile-First Card View) */}
      <SettlementHistoryModal
        isOpen={isSettlementModalOpen}
        onClose={() => setIsSettlementModalOpen(false)}
        settlements={settlementAdjustments}
        settings={settings}
        onDeleteSettlement={onDeleteSettlement}
      />
    </div>
  );
};
