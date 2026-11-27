import React from 'react';
import { splitTextWithHighlights } from '../utils/healthTimelineFilter';

interface HighlightedKeywordTextProps {
  text?: string | null;
  keyword: string;
}

export function HighlightedKeywordText({ text, keyword }: HighlightedKeywordTextProps) {
  if (!text) return null;
  if (!keyword.trim()) return <>{text}</>;

  const segments = splitTextWithHighlights(text, keyword);
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <span
            key={index}
            className="underline decoration-emerald-400 decoration-2 underline-offset-[3px]"
          >
            {segment.text}
          </span>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  );
}
