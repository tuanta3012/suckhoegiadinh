import React, { useState, useRef, useEffect } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { formatDateVN } from '../utils/formatters';
import { CustomSelect } from './CustomSelect';

interface DatePickerVNProps {
  value: string; // YYYY-MM-DD
  onChange: (val: string) => void;
  id?: string;
  className?: string;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
}

const MONTH_NAMES = [
  'Tháng 1',
  'Tháng 2',
  'Tháng 3',
  'Tháng 4',
  'Tháng 5',
  'Tháng 6',
  'Tháng 7',
  'Tháng 8',
  'Tháng 9',
  'Tháng 10',
  'Tháng 11',
  'Tháng 12',
];

const WEEKDAY_NAMES = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

export const DatePickerVN: React.FC<DatePickerVNProps> = ({
  value,
  onChange,
  id,
  className = '',
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse current value
  const parsed = React.useMemo(() => {
    if (!value || value.length < 10) {
      const now = new Date();
      return {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
      };
    }
    const [y, m, d] = value.split('-').map(Number);
    return {
      year: y || 2026,
      month: m || 1,
      day: d || 1,
    };
  }, [value]);

  const [viewYear, setViewYear] = useState<number>(parsed.year);
  const [viewMonth, setViewMonth] = useState<number>(parsed.month);

  // Sync view state when value changes externally
  useEffect(() => {
    setViewYear(parsed.year);
    setViewMonth(parsed.month);
  }, [parsed.year, parsed.month]);

  // Close on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isOpen]);

  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();

  // Calculate day of week of 1st day of month (Monday as 0)
  const firstDayOfWeek = (new Date(viewYear, viewMonth - 1, 1).getDay() + 6) % 7;

  const handleSelectDay = (day: number) => {
    const mStr = String(viewMonth).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    onChange(`${viewYear}-${mStr}-${dStr}`);
    setIsOpen(false);
  };

  const handlePrevMonth = () => {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = () => {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const setToday = () => {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    onChange(`${y}-${m}-${d}`);
    setViewYear(now.getFullYear());
    setViewMonth(now.getMonth() + 1);
    setIsOpen(false);
  };

  const handleDropdownChange = (newDay: number, newMonth: number, newYear: number) => {
    const maxDays = new Date(newYear, newMonth, 0).getDate();
    const clampedDay = Math.min(newDay, maxDays);
    const mStr = String(newMonth).padStart(2, '0');
    const dStr = String(clampedDay).padStart(2, '0');
    onChange(`${newYear}-${mStr}-${dStr}`);
    setViewYear(newYear);
    setViewMonth(newMonth);
  };

  // Generate years list 2020..2035
  const years = Array.from({ length: 16 }, (_, i) => 2020 + i);

  return (
    <div className={`relative ${className}`} ref={containerRef}>
      {/* Input button displaying strict Vietnamese Day/Month/Year format */}
      <button
        type="button"
        id={id}
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 border border-slate-300 rounded-xl bg-white hover:bg-slate-50/80 focus:ring-2 focus:ring-emerald-500 transition-colors text-left shadow-2xs"
      >
        <div className="flex items-center space-x-2 min-w-0">
          <Calendar className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-mono text-xs font-bold text-slate-900 tracking-wide truncate">
            {formatDateVN(value, false)}
          </span>
        </div>
        <span className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200/60 shrink-0">
          Chọn ngày
        </span>
      </button>

      {/* Interactive Vietnamese Date Picker Popover */}
      {isOpen && (
        <div className="absolute top-full left-0 mt-1.5 z-50 w-80 max-w-[calc(100vw-2rem)] p-3.5 bg-white border border-slate-200 rounded-2xl shadow-xl space-y-3 animate-in fade-in zoom-in-95 duration-150">
          {/* Header 3 Dropdowns: Ngày, Tháng, Năm */}
          <div className="flex items-center gap-1.5 bg-slate-50 p-2 rounded-xl border border-slate-200/70 text-xs font-medium">
            {/* Ngày */}
            <div className="flex-1 min-w-0">
              <label className="text-[10px] text-slate-500 font-bold block mb-0.5">Ngày</label>
              <CustomSelect
                value={parsed.day}
                onChange={(val) => handleDropdownChange(Number(val), parsed.month, parsed.year)}
                options={Array.from({ length: daysInMonth }, (_, i) => ({
                  value: i + 1,
                  label: `${i + 1}`,
                }))}
                size="sm"
                buttonClassName="px-1.5 py-1 text-[11px] font-bold"
              />
            </div>

            {/* Tháng */}
            <div className="flex-[1.4] min-w-0">
              <label className="text-[10px] text-slate-500 font-bold block mb-0.5">Tháng</label>
              <CustomSelect
                value={parsed.month}
                onChange={(val) => handleDropdownChange(parsed.day, Number(val), parsed.year)}
                options={MONTH_NAMES.map((name, i) => ({
                  value: i + 1,
                  label: name,
                }))}
                size="sm"
                buttonClassName="px-1.5 py-1 text-[11px] font-bold"
              />
            </div>

            {/* Năm */}
            <div className="flex-[1.2] min-w-0">
              <label className="text-[10px] text-slate-500 font-bold block mb-0.5">Năm</label>
              <CustomSelect
                value={parsed.year}
                onChange={(val) => handleDropdownChange(parsed.day, parsed.month, Number(val))}
                options={years.map((y) => ({
                  value: y,
                  label: `${y}`,
                }))}
                size="sm"
                buttonClassName="px-1.5 py-1 text-[11px] font-bold"
              />
            </div>
          </div>

          {/* Month Navigation & Grid */}
          <div>
            <div className="flex items-center justify-between mb-2 px-1">
              <button
                type="button"
                onClick={handlePrevMonth}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-600"
                title="Tháng trước"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-bold text-xs text-slate-800">
                Tháng {viewMonth} / {viewYear}
              </span>
              <button
                type="button"
                onClick={handleNextMonth}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-600"
                title="Tháng sau"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            {/* Weekday headers */}
            <div className="grid grid-cols-7 gap-1 text-center mb-1 text-[10px] font-bold text-slate-600">
              {WEEKDAY_NAMES.map((wd, i) => (
                <div key={wd} className={`py-0.5 ${i === 6 ? 'text-red-500' : ''}`}>
                  {wd}
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-1 text-center text-xs">
              {/* Empty leading cells */}
              {Array.from({ length: firstDayOfWeek }).map((_, i) => (
                <div key={`empty-${i}`} className="py-1.5" />
              ))}

              {/* Day cells */}
              {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((d) => {
                const isSelected =
                  d === parsed.day &&
                  viewMonth === parsed.month &&
                  viewYear === parsed.year;
                const isCurrentSunday = (firstDayOfWeek + d - 1) % 7 === 6;

                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => handleSelectDay(d)}
                    className={`py-1.5 rounded-lg font-medium transition-all text-xs ${
                      isSelected
                        ? 'bg-emerald-600 text-white font-bold shadow-xs'
                        : isCurrentSunday
                        ? 'text-red-600 hover:bg-red-50'
                        : 'text-slate-800 hover:bg-slate-100'
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quick Action Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-slate-100 text-xs">
            <button
              type="button"
              onClick={setToday}
              className="px-2.5 py-1 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg font-semibold text-[11px]"
            >
              Hôm nay
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="px-3 py-1 bg-slate-800 hover:bg-slate-900 text-white rounded-lg font-semibold text-[11px] flex items-center space-x-1"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Xong</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
