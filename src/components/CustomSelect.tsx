import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption<T = string | number> {
  value: T;
  label: string;
  subLabel?: string;
  icon?: React.ReactNode;
}

interface CustomSelectProps<T = string | number> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  className?: string;
  buttonClassName?: string;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
}

export function CustomSelect<T = string | number>({
  value,
  onChange,
  options,
  placeholder = 'Chọn một tùy chọn...',
  className = '',
  buttonClassName = '',
  size = 'md',
  disabled = false,
}: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent | TouchEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
    };
  }, []);

  const sizeClasses = {
    sm: 'px-2.5 py-1.5 text-xs rounded-lg',
    md: 'px-3 py-2 text-xs font-semibold rounded-xl',
    lg: 'px-3.5 py-2.5 text-sm font-bold rounded-xl',
  };

  return (
    <div ref={containerRef} className={`relative w-full ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        className={`w-full bg-white border border-slate-300 text-slate-800 flex items-center justify-between text-left transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500 ${
          sizeClasses[size]
        } ${disabled ? 'opacity-50 cursor-not-allowed bg-slate-50' : 'cursor-pointer hover:border-slate-400 hover:bg-slate-50/50'} ${
          isOpen ? 'ring-2 ring-emerald-500/30 border-emerald-500 shadow-2xs' : ''
        } ${buttonClassName}`}
      >
        <span className="truncate flex items-center gap-1.5">
          {selectedOption?.icon}
          <span>{selectedOption ? selectedOption.label : placeholder}</span>
        </span>
        <ChevronDown
          className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-200 ${
            isOpen ? 'rotate-180 text-emerald-600' : ''
          }`}
        />
      </button>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full mt-1.5 bg-white border border-slate-200/90 rounded-2xl shadow-xl py-1.5 z-50 max-h-60 overflow-y-auto animate-in fade-in zoom-in-95 duration-100">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={String(option.value)}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-3.5 py-2.5 text-xs flex items-center justify-between transition-colors cursor-pointer ${
                  isSelected
                    ? 'bg-emerald-50/80 text-emerald-900 font-bold'
                    : 'text-slate-700 hover:bg-slate-50 font-medium'
                }`}
              >
                <div className="flex items-center gap-2 pr-2 min-w-0">
                  {option.icon}
                  <div className="truncate">
                    <div className={isSelected ? 'text-emerald-950 font-bold' : 'text-slate-800'}>
                      {option.label}
                    </div>
                    {option.subLabel && (
                      <div className="text-[10.5px] text-slate-500 font-normal truncate mt-0.5">
                        {option.subLabel}
                      </div>
                    )}
                  </div>
                </div>
                {isSelected && (
                  <div className="w-4 h-4 rounded-full bg-emerald-600 text-white flex items-center justify-center shrink-0">
                    <Check className="w-2.5 h-2.5 stroke-[3]" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
