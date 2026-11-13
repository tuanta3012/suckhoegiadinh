import { useEffect, useRef } from 'react';

export const BackPriority = {
  TAB: 10,
  SHEET: 20,
  MODAL: 30,
  TOP_MODAL: 40,
  DROPDOWN: 50,
} as const;

export type BackPriorityLevel = (typeof BackPriority)[keyof typeof BackPriority] | number;

export type BackHandler = () => boolean | void;

interface RegisteredBackEntry {
  id: symbol;
  priority: number;
  seq: number;
  handler: BackHandler;
}

const backStack: RegisteredBackEntry[] = [];
let registrationSeq = 0;

export function registerBackHandler(priority: number, handler: BackHandler): () => void {
  const entry: RegisteredBackEntry = {
    id: Symbol('back-handler'),
    priority,
    seq: ++registrationSeq,
    handler,
  };
  backStack.push(entry);

  return () => {
    const index = backStack.findIndex((item) => item.id === entry.id);
    if (index !== -1) {
      backStack.splice(index, 1);
    }
  };
}

export function dispatchBackAction(): boolean {
  const ordered = [...backStack].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return b.seq - a.seq;
  });

  for (const entry of ordered) {
    const result = entry.handler();
    if (result !== false) {
      return true;
    }
  }
  return false;
}

export function hasActiveBackHandlers(minPriority = 0): boolean {
  return backStack.some((entry) => entry.priority >= minPriority);
}

export function clearBackHandlersForTests(): void {
  backStack.length = 0;
  registrationSeq = 0;
}

export function useBackHandler(
  enabled: boolean,
  handler: BackHandler,
  priority: BackPriorityLevel = BackPriority.MODAL,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    return registerBackHandler(priority, () => handlerRef.current());
  }, [enabled, priority]);
}

export interface HorizontalGestureInput {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  durationMs: number;
  viewportWidth: number;
  allowTabSwipe: boolean;
  ignoredByTarget?: boolean;
}

export type HorizontalGestureOutcome = 'edge_back' | 'swipe_next_tab' | 'swipe_prev_tab' | null;

const EDGE_ZONE_PX = 28;
const EDGE_BACK_MIN_DX = 64;
const TAB_SWIPE_MIN_DX = 72;
const MAX_VERTICAL_DRIFT_PX = 68;
const MAX_SWIPE_DURATION_MS = 550;

export function evaluateHorizontalGesture(input: HorizontalGestureInput): HorizontalGestureOutcome {
  const {
    startX,
    startY,
    endX,
    endY,
    durationMs,
    viewportWidth,
    allowTabSwipe,
    ignoredByTarget = false,
  } = input;

  if (durationMs < 0 || durationMs > MAX_SWIPE_DURATION_MS) {
    return null;
  }

  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);

  if (absY > MAX_VERTICAL_DRIFT_PX) {
    return null;
  }

  // Fallback edge-swipe back when WebView receives touch near the left edge
  if (startX <= EDGE_ZONE_PX && deltaX >= EDGE_BACK_MIN_DX && absX >= absY * 1.5) {
    return 'edge_back';
  }

  if (!allowTabSwipe || ignoredByTarget) {
    return null;
  }

  // Keep both left and right OS gesture-navigation edges clear of tab switching
  if (viewportWidth > 0 && (startX <= EDGE_ZONE_PX || startX >= viewportWidth - EDGE_ZONE_PX)) {
    return null;
  }

  if (absX < TAB_SWIPE_MIN_DX || absX < absY * 1.65) {
    return null;
  }

  return deltaX < 0 ? 'swipe_next_tab' : 'swipe_prev_tab';
}

export function shouldIgnoreHorizontalSwipeStart(
  target: EventTarget | null,
  boundaryEl: HTMLElement | null,
): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (
    target.closest(
      'input, textarea, select, option, [contenteditable="true"], [data-no-swipe="true"], .recharts-wrapper',
    )
  ) {
    return true;
  }

  let current: HTMLElement | null = target;
  while (current && current !== boundaryEl) {
    const style = window.getComputedStyle(current);
    const canScrollX =
      (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
      current.scrollWidth > current.clientWidth + 4;
    if (canScrollX) {
      return true;
    }
    current = current.parentElement;
  }

  return false;
}
