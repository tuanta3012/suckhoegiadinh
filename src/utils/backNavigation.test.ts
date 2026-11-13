import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackPriority,
  clearBackHandlersForTests,
  dispatchBackAction,
  evaluateHorizontalGesture,
  hasActiveBackHandlers,
  registerBackHandler,
} from './backNavigation';

describe('backNavigation registry', () => {
  beforeEach(() => {
    clearBackHandlersForTests();
  });

  it('dispatches highest-priority handler first and falls back in LIFO order', () => {
    const events: string[] = [];

    const unsubTab = registerBackHandler(BackPriority.TAB, () => {
      events.push('tab');
    });
    const unsubModal = registerBackHandler(BackPriority.MODAL, () => {
      events.push('modal');
    });
    const unsubDropdown = registerBackHandler(BackPriority.DROPDOWN, () => {
      events.push('dropdown');
    });

    expect(hasActiveBackHandlers(BackPriority.MODAL)).toBe(true);

    expect(dispatchBackAction()).toBe(true);
    expect(events).toEqual(['dropdown']);
    unsubDropdown();

    expect(dispatchBackAction()).toBe(true);
    expect(events).toEqual(['dropdown', 'modal']);
    unsubModal();

    expect(hasActiveBackHandlers(BackPriority.SHEET)).toBe(false);

    expect(dispatchBackAction()).toBe(true);
    expect(events).toEqual(['dropdown', 'modal', 'tab']);
    unsubTab();

    expect(dispatchBackAction()).toBe(false);
  });

  it('breaks priority ties using most recently registered handler and skips handlers returning false', () => {
    const first = vi.fn(() => true);
    const secondReturningFalse = vi.fn(() => false);

    registerBackHandler(BackPriority.MODAL, first);
    registerBackHandler(BackPriority.MODAL, secondReturningFalse);

    expect(dispatchBackAction()).toBe(true);
    expect(secondReturningFalse).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
  });
});

describe('evaluateHorizontalGesture', () => {
  it('recognizes left-edge swipe right as edge_back even when tab swipe is disabled', () => {
    expect(
      evaluateHorizontalGesture({
        startX: 16,
        startY: 320,
        endX: 98,
        endY: 332,
        durationMs: 210,
        viewportWidth: 400,
        allowTabSwipe: false,
      }),
    ).toBe('edge_back');
  });

  it('switches to next or previous tab for decisive horizontal swipes in content area', () => {
    expect(
      evaluateHorizontalGesture({
        startX: 280,
        startY: 400,
        endX: 170,
        endY: 410,
        durationMs: 220,
        viewportWidth: 400,
        allowTabSwipe: true,
      }),
    ).toBe('swipe_next_tab');

    expect(
      evaluateHorizontalGesture({
        startX: 110,
        startY: 400,
        endX: 225,
        endY: 392,
        durationMs: 220,
        viewportWidth: 400,
        allowTabSwipe: true,
      }),
    ).toBe('swipe_prev_tab');
  });

  it('ignores vertical scrolling, slow drags, right-edge touches, and scrollable targets', () => {
    // Diagonal/vertical scroll
    expect(
      evaluateHorizontalGesture({
        startX: 150,
        startY: 200,
        endX: 230,
        endY: 265,
        durationMs: 200,
        viewportWidth: 400,
        allowTabSwipe: true,
      }),
    ).toBeNull();

    // Right-edge touch reserved for Android gesture navigation
    expect(
      evaluateHorizontalGesture({
        startX: 386,
        startY: 300,
        endX: 260,
        endY: 305,
        durationMs: 200,
        viewportWidth: 400,
        allowTabSwipe: true,
      }),
    ).toBeNull();

    // Slow drag
    expect(
      evaluateHorizontalGesture({
        startX: 280,
        startY: 300,
        endX: 140,
        endY: 302,
        durationMs: 700,
        viewportWidth: 400,
        allowTabSwipe: true,
      }),
    ).toBeNull();

    // Scrollable horizontal chip strip
    expect(
      evaluateHorizontalGesture({
        startX: 280,
        startY: 300,
        endX: 140,
        endY: 302,
        durationMs: 200,
        viewportWidth: 400,
        allowTabSwipe: true,
        ignoredByTarget: true,
      }),
    ).toBeNull();
  });
});
