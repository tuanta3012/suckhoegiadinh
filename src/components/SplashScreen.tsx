import React, { useEffect, useState } from 'react';
import { AppLogo } from './AppLogo';

interface SplashScreenProps {
  onFinished: () => void;
  durationMs?: number;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({
  onFinished,
  durationMs = 1000,
}) => {
  const [isFading, setIsFading] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => {
      setIsFading(true);
    }, durationMs - 250);

    const finishTimer = setTimeout(() => {
      onFinished();
    }, durationMs);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(finishTimer);
    };
  }, [durationMs, onFinished]);

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-emerald-950 text-white transition-opacity duration-300 ${
        isFading ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className="flex flex-col items-center space-y-4 animate-in fade-in zoom-in-95 duration-500">
        <div className="relative">
          <AppLogo size="xl" />
        </div>
        <div className="text-center space-y-1.5 px-4">
          <h1 className="text-2xl font-black tracking-tight text-white">
            Sức Khỏe Gia Đình
          </h1>
          <p className="text-xs text-emerald-400 font-medium tracking-wide">
            Bảo vệ sức khỏe người thân yêu trọn đời
          </p>
        </div>
        <div className="pt-6">
          <div className="w-8 h-8 rounded-full border-2 border-emerald-500/30 border-t-emerald-400 animate-spin" />
        </div>
      </div>
      <div className="absolute bottom-6 text-[10px] text-slate-500 font-mono">
        Local-First · Google Drive Sync · v1.0.0
      </div>
    </div>
  );
};
