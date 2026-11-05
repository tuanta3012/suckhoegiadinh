import React from 'react';

interface AppLogoProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showText?: boolean;
  className?: string;
}

export const AppLogo: React.FC<AppLogoProps> = ({
  size = 'md',
  showText = false,
  className = '',
}) => {
  const sizeMap = {
    sm: 'w-8 h-8 rounded-xl',
    md: 'w-10 h-10 rounded-2xl',
    lg: 'w-12 h-12 rounded-2xl',
    xl: 'w-16 h-16 rounded-3xl',
  };

  const iconSizeMap = {
    sm: 32,
    md: 40,
    lg: 48,
    xl: 64,
  };

  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <div
        className={`relative overflow-hidden shrink-0 shadow-sm border border-emerald-500/30 bg-slate-900 flex items-center justify-center ${sizeMap[size]}`}
      >
        <img
          src="/src/assets/images/app_health_logo_1793877965288.jpg"
          alt="Logo Sức Khỏe Gia Đình"
          className="w-full h-full object-cover"
          onError={(e) => {
            // Elegant SVG fallback if image cannot be loaded
            e.currentTarget.style.display = 'none';
            const fallback = e.currentTarget.parentElement?.querySelector('.logo-fallback');
            if (fallback) (fallback as HTMLElement).style.display = 'flex';
          }}
        />
        <div
          className="logo-fallback hidden w-full h-full bg-gradient-to-br from-emerald-500 to-teal-700 items-center justify-center text-white font-bold"
        >
          <svg
            width={iconSizeMap[size] * 0.6}
            height={iconSizeMap[size] * 0.6}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            <path d="M12 7v6" />
            <path d="M9 10h6" />
          </svg>
        </div>
      </div>
      {showText && (
        <div className="flex flex-col min-w-0">
          <span className="text-base font-extrabold tracking-tight text-slate-900 truncate">
            Sức Khỏe Gia Đình
          </span>
          <span className="text-[11px] text-slate-500 truncate">
            Hồ sơ y tế & Đồng bộ Google Drive
          </span>
        </div>
      )}
    </div>
  );
};
