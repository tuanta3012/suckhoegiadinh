import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  Building2,
  ChevronDown,
  Search,
  Check,
  Star,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { BankWithUsage, getBankById } from '../data/banks';
import { formatShortVND } from '../utils/formatters';

interface BankSelectDropdownProps {
  value: string;
  onChange: (bankId: string) => void;
  frequentBanks: BankWithUsage[];
  otherBanks: BankWithUsage[];
  onOpenManageBanks?: () => void;
  allowAll?: boolean;
  allLabel?: string;
  alignRight?: boolean;
  dropdownFullWidth?: boolean;
  className?: string;
}

export const BankSelectDropdown: React.FC<BankSelectDropdownProps> = ({
  value,
  onChange,
  frequentBanks,
  otherBanks,
  onOpenManageBanks,
  allowAll = false,
  allLabel = 'Tất cả ngân hàng',
  alignRight = false,
  dropdownFullWidth = false,
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'all' | 'frequent'>('all');

  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Lấy thông tin ngân hàng đang được chọn
  const selectedBank = useMemo(() => {
    if (allowAll && value === 'all') return null;
    return getBankById(value);
  }, [value, allowAll]);

  // Tìm trong danh sách hay gửi xem có số liệu thống kê không
  const selectedFrequentUsage = useMemo(() => {
    return frequentBanks.find((b) => b.id.toLowerCase() === value.toLowerCase());
  }, [frequentBanks, value]);

  // Đóng khi click ra ngoài
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  // Reset từ khóa khi đóng/mở dropdown (Không tự động focus ô tìm kiếm để tránh nảy bàn phím trên thiết bị di động)
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen]);

  // Lọc theo từ khóa tìm kiếm
  const query = searchQuery.trim().toLowerCase();

  const filteredFrequent = useMemo(() => {
    if (!query) return frequentBanks;
    return frequentBanks.filter(
      (b) =>
        b.shortName.toLowerCase().includes(query) ||
        b.name.toLowerCase().includes(query) ||
        b.code.toLowerCase().includes(query) ||
        b.id.toLowerCase().includes(query)
    );
  }, [frequentBanks, query]);

  const filteredOther = useMemo(() => {
    if (!query) return otherBanks;
    return otherBanks.filter(
      (b) =>
        b.shortName.toLowerCase().includes(query) ||
        b.name.toLowerCase().includes(query) ||
        b.code.toLowerCase().includes(query) ||
        b.id.toLowerCase().includes(query)
    );
  }, [otherBanks, query]);

  const handleSelect = (bankId: string) => {
    onChange(bankId);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Nút hiển thị ngân hàng đang chọn (Trigger Button) */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full min-h-[42px] px-3 py-2 bg-white hover:bg-slate-50 border border-slate-300 hover:border-slate-400 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 rounded-xl text-xs font-semibold text-slate-900 transition-all flex items-center justify-between gap-2 shadow-2xs text-left"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="flex items-center space-x-2.5 min-w-0 flex-1">
          {allowAll && value === 'all' ? (
            <>
              <span className="w-7 h-7 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center font-bold shrink-0 border border-slate-200">
                <Building2 className="w-4 h-4 text-slate-600" />
              </span>
              <span className="truncate font-bold text-slate-800">{allLabel}</span>
            </>
          ) : selectedBank ? (
            <>
              {/* Huy hiệu màu ngân hàng */}
              <span
                className="w-8 h-7 rounded-lg flex items-center justify-center font-mono font-bold text-[11px] shrink-0 shadow-2xs border"
                style={{
                  backgroundColor: selectedBank.primaryColor || '#059669',
                  color: selectedBank.textColor || '#ffffff',
                  borderColor: selectedBank.borderColor || 'transparent',
                }}
              >
                {selectedBank.code || selectedBank.shortName.slice(0, 3).toUpperCase()}
              </span>

              {/* Tên ngân hàng & thống kê sổ */}
              <div className="flex items-center space-x-2 min-w-0 truncate">
                <span className="font-bold text-slate-900 text-xs sm:text-[13px] truncate">
                  {selectedBank.shortName}
                </span>
                <span className="text-[10px] font-mono text-slate-500 font-medium shrink-0">
                  ({selectedBank.code})
                </span>
                {selectedFrequentUsage && selectedFrequentUsage.bookCount > 0 && (
                  <span className="hidden sm:inline-flex items-center text-[10px] font-bold text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200/80 shrink-0">
                    {selectedFrequentUsage.bookCount} sổ • {formatShortVND(selectedFrequentUsage.totalPrincipal)}
                  </span>
                )}
              </div>
            </>
          ) : (
            <span className="text-slate-400">Chọn ngân hàng gửi...</span>
          )}
        </div>

        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-180 text-emerald-600' : ''
          }`}
        />
      </button>

      {/* Popover / Dropdown Menu danh sách ngân hàng */}
      {isOpen && (
        <>
          {/* Backdrop mờ nhẹ trên mobile để tạo cảm giác tự nhiên */}
          <div
            className="fixed inset-0 bg-slate-950/40 backdrop-blur-[2px] z-40 sm:hidden"
            onClick={() => setIsOpen(false)}
          />

          <div
            className={`fixed sm:absolute z-50 bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden flex flex-col max-h-[75vh] sm:max-h-96 animate-in fade-in zoom-in-95 duration-150 ${
              dropdownFullWidth
                ? 'left-3 right-3 bottom-3 sm:bottom-auto sm:left-0 sm:right-0 sm:w-full sm:top-full sm:mt-1.5'
                : alignRight
                ? 'left-3 right-3 bottom-3 sm:bottom-auto sm:left-auto sm:right-0 sm:w-84 md:w-96 sm:top-full sm:mt-1.5'
                : 'left-3 right-3 bottom-3 sm:bottom-auto sm:left-0 sm:right-auto sm:w-84 md:w-96 sm:top-full sm:mt-1.5'
            }`}
          >
            {/* Header tìm kiếm */}
            <div className="p-3 border-b border-slate-100 bg-slate-50/80 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800 flex items-center space-x-1.5">
                  <Building2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Danh mục ngân hàng</span>
                </span>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-200/60 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Ô tìm kiếm */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Tìm nhanh: VCB, SeABank, MBB, SHB..."
                  className="w-full pl-8 pr-7 py-1.5 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 font-medium"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Tabs lọc nhanh nếu không đang tìm kiếm */}
              {!query && frequentBanks.length > 0 && (
                <div className="flex items-center space-x-1 pt-0.5">
                  <button
                    type="button"
                    onClick={() => setActiveTab('all')}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                      activeTab === 'all'
                        ? 'bg-emerald-600 text-white shadow-2xs'
                        : 'bg-white text-slate-600 hover:bg-slate-200/60 border border-slate-200'
                    }`}
                  >
                    Tất cả ({frequentBanks.length + otherBanks.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('frequent')}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-colors flex items-center space-x-1 ${
                      activeTab === 'frequent'
                        ? 'bg-amber-500 text-slate-950 shadow-2xs'
                        : 'bg-white text-slate-600 hover:bg-slate-200/60 border border-slate-200'
                    }`}
                  >
                    <Star className="w-3 h-3 fill-amber-400 text-amber-500" />
                    <span>Hay gửi nhất ({frequentBanks.length})</span>
                  </button>
                </div>
              )}
            </div>

            {/* Danh sách ngân hàng cuộn mượt mà */}
            <div className="overflow-y-auto divide-y divide-slate-100 p-1.5 flex-1">
              {/* Lựa chọn "Tất cả ngân hàng" cho bộ lọc */}
              {allowAll && !query && (
                <button
                  type="button"
                  onClick={() => handleSelect('all')}
                  className={`w-full p-2 rounded-xl flex items-center justify-between text-left transition-colors mb-1 ${
                    value === 'all'
                      ? 'bg-emerald-50 text-emerald-950 font-bold border border-emerald-200'
                      : 'hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <div className="flex items-center space-x-2.5">
                    <span className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center font-bold text-slate-600 text-xs border border-slate-200">
                      <Building2 className="w-4 h-4" />
                    </span>
                    <span className="text-xs font-bold">{allLabel}</span>
                  </div>
                  {value === 'all' && <Check className="w-4 h-4 text-emerald-600" />}
                </button>
              )}

              {/* Nhóm 1: Các ngân hàng hay gửi nhất */}
              {filteredFrequent.length > 0 && (activeTab === 'all' || activeTab === 'frequent') && (
                <div className="py-1">
                  <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-800 bg-amber-50/70 rounded-lg flex items-center justify-between mb-1">
                    <span className="flex items-center space-x-1">
                      <Star className="w-3 h-3 fill-amber-500 text-amber-600" />
                      <span>Ngân hàng hay gửi nhất ({filteredFrequent.length})</span>
                    </span>
                    <span className="text-[9px] font-medium text-amber-700">Có sổ hiện có</span>
                  </div>

                  <div className="space-y-0.5">
                    {filteredFrequent.map((bank) => {
                      const isSelected = bank.id.toLowerCase() === value.toLowerCase();
                      return (
                        <button
                          key={bank.id}
                          type="button"
                          onClick={() => handleSelect(bank.id)}
                          className={`w-full px-2.5 py-2 rounded-xl flex items-center justify-between text-left transition-all ${
                            isSelected
                              ? 'bg-emerald-50/90 text-emerald-950 border border-emerald-300/80 shadow-2xs font-bold'
                              : 'hover:bg-slate-50 text-slate-800'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0">
                            <span
                              className="w-8 h-7 rounded-lg flex items-center justify-center font-mono font-bold text-[11px] shrink-0 shadow-2xs border"
                              style={{
                                backgroundColor: bank.primaryColor || '#059669',
                                color: bank.textColor || '#ffffff',
                                borderColor: bank.borderColor || 'transparent',
                              }}
                            >
                              {bank.code}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center space-x-1.5">
                                <span className="font-bold text-xs truncate">{bank.shortName}</span>
                                <span className="text-[10px] font-mono text-slate-400 font-medium">
                                  ({bank.code})
                                </span>
                              </div>
                              <span className="text-[10px] font-semibold text-emerald-700">
                                {bank.bookCount} sổ • {formatShortVND(bank.totalPrincipal)}
                              </span>
                            </div>
                          </div>

                          {isSelected ? (
                            <span className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-2xs">
                              <Check className="w-3 h-3 stroke-[3]" />
                            </span>
                          ) : (
                            <span className="text-[11px] font-medium text-slate-400 group-hover:text-slate-600">
                              Chọn
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Nhóm 2: Các ngân hàng khác */}
              {filteredOther.length > 0 && activeTab === 'all' && (
                <div className="py-1">
                  <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500 flex items-center space-x-1 mb-1">
                    <Building2 className="w-3 h-3 text-slate-400" />
                    <span>Các ngân hàng khác ({filteredOther.length})</span>
                  </div>

                  <div className="space-y-0.5">
                    {filteredOther.map((bank) => {
                      const isSelected = bank.id.toLowerCase() === value.toLowerCase();
                      return (
                        <button
                          key={bank.id}
                          type="button"
                          onClick={() => handleSelect(bank.id)}
                          className={`w-full px-2.5 py-2 rounded-xl flex items-center justify-between text-left transition-all ${
                            isSelected
                              ? 'bg-emerald-50/90 text-emerald-950 border border-emerald-300/80 shadow-2xs font-bold'
                              : 'hover:bg-slate-50 text-slate-800'
                          }`}
                        >
                          <div className="flex items-center space-x-2.5 min-w-0">
                            <span
                              className="w-8 h-7 rounded-lg flex items-center justify-center font-mono font-bold text-[11px] shrink-0 shadow-2xs border"
                              style={{
                                backgroundColor: bank.primaryColor || '#059669',
                                color: bank.textColor || '#ffffff',
                                borderColor: bank.borderColor || 'transparent',
                              }}
                            >
                              {bank.code}
                            </span>
                            <div className="min-w-0">
                              <span className="font-bold text-xs truncate block">
                                {bank.shortName}
                              </span>
                              <span className="text-[10px] font-mono text-slate-400 font-medium">
                                Mã: {bank.code}
                              </span>
                            </div>
                          </div>

                          {isSelected ? (
                            <span className="w-5 h-5 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0 shadow-2xs">
                              <Check className="w-3 h-3 stroke-[3]" />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Trạng thái không tìm thấy */}
              {filteredFrequent.length === 0 && filteredOther.length === 0 && (
                <div className="p-6 text-center text-slate-400 space-y-1">
                  <p className="text-xs font-semibold">Không tìm thấy ngân hàng khớp &ldquo;{searchQuery}&rdquo;</p>
                  <p className="text-[11px]">Bạn có thể bấm bên dưới để thêm mới ngân hàng này vào danh sách</p>
                </div>
              )}
            </div>

            {/* Footer: Nút Sửa / Thêm / Bớt ngân hàng */}
            {onOpenManageBanks && (
              <div className="p-2 border-t border-slate-100 bg-slate-50/90">
                <button
                  type="button"
                  onClick={() => {
                    setIsOpen(false);
                    onOpenManageBanks();
                  }}
                  className="w-full py-2 px-3 bg-white hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 rounded-xl text-xs font-bold text-emerald-800 transition-colors flex items-center justify-center space-x-1.5 shadow-2xs"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Sửa / Thêm / Bớt ngân hàng</span>
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
