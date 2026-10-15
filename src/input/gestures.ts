/**
 * Gesture helpers for the canvas: pinch-zoom maths and multi-finger tap detection
 * (two-finger tap = undo, three-finger tap = redo). Pure logic, unit-testable.
 */

export interface PointerSample {
  id: number;
  x: number;
  y: number;
  type: string;
}

export interface PinchState {
  active: boolean;
  distance: number;
  centerX: number;
  centerY: number;
}

export function emptyPinch(): PinchState {
  return { active: false, distance: 0, centerX: 0, centerY: 0 };
}

export function pinchFrom(positions: ArrayLike<{ x: number; y: number }>): PinchState {
  if (positions.length < 2) return emptyPinch();
  const [a, b] = [positions[0]!, positions[1]!];
  return {
    active: true,
    distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
    centerX: (a.x + b.x) / 2,
    centerY: (a.y + b.y) / 2,
  };
}

/** Zoom factor between two pinch states. */
export function pinchScaleFactor(previous: PinchState, next: PinchState): number {
  if (!previous.active || !next.active || previous.distance <= 0) return 1;
  return next.distance / previous.distance;
}

export type TapKind = 'none' | 'undo' | 'redo';

export interface TapTrackerOptions {
  /** Max movement (px) allowed for a touch to count as a tap. */
  slop?: number;
  /** Max duration (ms) of a tap. */
  durationMs?: number;
  /** Max gap (ms) between the taps of a multi-finger tap. */
  windowMs?: number;
}

interface TouchPoint {
  x: number;
  y: number;
  /** Where this finger first touched down — movement is measured against it. */
  startX: number;
  startY: number;
  moved: boolean;
}

interface TouchSpan {
  startedAt: number;
  maxPointers: number;
  moved: boolean;
  endedAt: number;
}

/**
 * Tracks touch pointers to recognise two- and three-finger taps.
 * Pointer events do not expose "fingers", so the tracker counts starts/ends itself.
 */
export class MultiTapTracker {
  private active = new Map<number, TouchPoint>();
  private maxPointers = 0;
  private startedAt = 0;
  private lastSpan: TouchSpan | null = null;
  private readonly slop: number;
  private readonly durationMs: number;
  private readonly windowMs: number;

  constructor(options: TapTrackerOptions = {}) {
    this.slop = options.slop ?? 14;
    this.durationMs = options.durationMs ?? 500;
    this.windowMs = options.windowMs ?? 400;
  }

  /** Feed a pointer event; returns the recognised tap kind (if any) when fingers lift. */
  handle(kind: 'down' | 'move' | 'up' | 'cancel', id: number, x: number, y: number, time: number, pointerType: string): TapKind {
    if (pointerType !== 'touch') return 'none';
    if (kind === 'down') {
      if (this.active.size === 0) {
        this.startedAt = time;
        this.maxPointers = 0;
      }
      this.active.set(id, { x, y, startX: x, startY: y, moved: false });
      this.maxPointers = Math.max(this.maxPointers, this.active.size);
      return 'none';
    }
    if (kind === 'move') {
      const entry = this.active.get(id);
      if (entry) {
        entry.x = x;
        entry.y = y;
        // Each finger's travel is measured from its own touch-down point, so fingers that
        // simply land far apart (a two-finger tap) are not mistaken for a pinch.
        if (Math.hypot(entry.startX - x, entry.startY - y) > this.slop) entry.moved = true;
      }
      // Movement during a multi-touch gesture cancels the tap but keeps tracking.
      return 'none';
    }

    // up / cancel
    const entry = this.active.get(id);
    const travelled = entry ? Math.hypot(entry.startX - x, entry.startY - y) : 0;
    const moved = entry ? entry.moved || travelled > this.slop : false;
    this.active.delete(id);
    if (kind === 'cancel') {
      this.reset();
      return 'none';
    }
    const span: TouchSpan = {
      startedAt: this.startedAt,
      maxPointers: this.maxPointers,
      moved,
      endedAt: time,
    };
    if (this.active.size > 0) {
      // Not every finger has lifted yet: remember this lift so the final one can be matched
      // against it (two- and three-finger taps always lift a few milliseconds apart).
      this.lastSpan = span;
      return 'none';
    }

    const result = this.classify(span);
    this.lastSpan = span;
    this.maxPointers = 0;
    return result;
  }

  /** Duration of the gesture that just finished (ms); used by tests and diagnostics. */
  lastGestureDuration(): number {
    return this.lastSpan ? this.lastSpan.endedAt - this.lastSpan.startedAt : 0;
  }

  private classify(span: TouchSpan): TapKind {
    if (span.moved) return 'none';
    if (span.maxPointers < 2) return 'none';
    if (span.endedAt - span.startedAt > this.durationMs) return 'none';
    const previous = this.lastSpan;
    if (!previous) return 'none';
    if (span.maxPointers !== previous.maxPointers) return 'none';
    // The last finger must follow the previous one within the window (a pinch-then-lift does
    // not qualify because it moved).
    const gap = span.endedAt - previous.endedAt;
    if (gap < 0 || gap >= this.windowMs) return 'none';
    return span.maxPointers >= 3 ? 'redo' : 'undo';
  }

  reset(): void {
    this.active.clear();
    this.maxPointers = 0;
    this.lastSpan = null;
  }
}
