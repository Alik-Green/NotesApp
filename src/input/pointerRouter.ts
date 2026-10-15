/**
 * Pointer routing for the drawing surface.
 *
 * Responsibilities:
 *  - decides, per pointer event, whether the gesture is inking, erasing, lassoing, panning or
 *    pinching, based on tool, pointer type and the palm-rejection policy;
 *  - coalesces pointer events into a smooth point stream for the live layer;
 *  - recognises two- and three-finger taps (undo/redo) and two-finger pan/pinch;
 *  - never touches the document directly — it reports through callbacks, so the store stays the
 *    only thing that mutates state.
 *
 * Not a React hook: the editor wires it to a canvas element and the view transform.
 */

import type { InputPoint } from '@/core/stroke';
import type { Vec2 } from '@/core/geometry';
import { pageAtClient, type ViewTransform } from '@/render/viewport';
import { MultiTapTracker, pinchFrom, pinchScaleFactor, type PinchState, type TapKind } from './gestures';

export type PointerKind = 'pen' | 'touch' | 'mouse' | 'unknown';

export type GestureMode = 'idle' | 'ink' | 'erase' | 'lasso' | 'pan' | 'pinch' | 'laser';

export interface RouterCallbacks {
  /** Live ink preview (null clears the live layer). */
  onLiveStroke(points: readonly InputPoint[], tool: string): void;
  onClearLive(): void;
  /** Pointer released: the caller turns the points into a document object. */
  onInkComplete(points: readonly InputPoint[], tool: string): void;
  /** Eraser moved from `a` to `b` (page units). `phase` start/end marks the drag. */
  onErase(a: Vec2, b: Vec2, phase: 'start' | 'move' | 'end'): void;
  /** Lasso loop while dragging; `phase: 'end'` means "commit the selection". */
  onLasso(polygon: Vec2[], phase: 'start' | 'move' | 'end'): void;
  /** Laser pointer trail segments. */
  onLaser(points: readonly InputPoint[], phase: 'start' | 'move' | 'end'): void;
  /** Single tap (used by the text/shape/image tools to place objects). */
  onTap(point: Vec2, kind: PointerKind): void;
  /** Panning by a screen-space delta (px). */
  onPan(dx: number, dy: number, phase: 'start' | 'move' | 'end'): void;
  /** Two-finger zoom about a screen anchor. */
  onZoom(factor: number, anchorClientX: number, anchorClientY: number): void;
  onUndoTap(): void;
  onRedoTap(): void;
  /** Reports the pointer kind of the first event so the UI can show palm-rejection state. */
  onPointerKind?(kind: PointerKind, pointerType: string): void;
  /** Page the current gesture is acting on (resolved from the point under the pointer). */
  onTargetPage?(pageId: string): void;
  /** Optional hook so the caller can draw an eraser cursor / lasso preview. */
  onCursorMove?(point: Vec2 | null): void;
}

export interface RouterOptions {
  callbacks: RouterCallbacks;
  getTransform(): ViewTransform;
  getTool(): string;
  getEraserRadius(): number;
  /** Palm-rejection policy for this session (see DECISIONS.md D6). */
  shouldDrawWithTouch(): boolean;
  /** Pointer Types that may draw when the tool is an ink tool. */
  allowMouseDraw?: boolean;
  enableMultiTap?: boolean;
  /** Movement (px) before a pointer counts as a drag rather than a tap. */
  tapSlop?: number;
  /** Two-finger panning while a drawing tool is active. */
  twoFingerPan?: boolean;
}

export const INK_TOOLS = new Set(['pen', 'highlighter', 'pencil']);

const LASER_TOOL = 'laser';

interface ActivePointer {
  id: number;
  kind: PointerKind;
  type: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  clientX: number;
  clientY: number;
  moved: boolean;
  points: InputPoint[];
  time: number;
}

export function pointerKind(pointerType: string): PointerKind {
  if (pointerType === 'pen') return 'pen';
  if (pointerType === 'touch') return 'touch';
  if (pointerType === 'mouse') return 'mouse';
  return 'unknown';
}

export class PointerRouter {
  private pointers = new Map<number, ActivePointer>();
  private mode: GestureMode = 'idle';
  private drawingId: number | null = null;
  private pinch: PinchState = pinchFrom([]);
  private lastPan = { x: 0, y: 0 };
  private tapTracker = new MultiTapTracker();
  private activePageId: string | null = null;
  private readonly callbacks: RouterCallbacks;
  private readonly options: RouterOptions;
  private lastErasePoint: Vec2 | null = null;
  private lassoPoints: Vec2[] = [];
  private downOnEmptyCanvas = false;
  /** Unused when multi-tap gestures are disabled. */
  constructor(options: RouterOptions) {
    this.options = options;
    this.callbacks = options.callbacks;
  }

  get currentMode(): GestureMode {
    return this.mode;
  }

  get activePointers(): number {
    return this.pointers.size;
  }

  /** True while ink (or a laser trail) is being produced — used to suppress re-renders. */
  get isDrawing(): boolean {
    return this.mode === 'ink' || this.mode === 'laser';
  }

  /** Page the current gesture targets (null before the first gesture). */
  get targetPageId(): string | null {
    return this.activePageId;
  }

  private transform(): ViewTransform {
    return this.options.getTransform();
  }

  /** Resolves a client point to { pageId, page-local point }. */
  private resolve(event: { clientX: number; clientY: number }): { pageId: string | null; point: Vec2 } {
    const hit = pageAtClient(this.transform(), event.clientX, event.clientY);
    if (!hit) return { pageId: null, point: { x: 0, y: 0 } };
    if (hit.layout.pageId !== this.activePageId) {
      this.activePageId = hit.layout.pageId;
      this.callbacks.onTargetPage?.(hit.layout.pageId);
    }
    return { pageId: hit.layout.pageId, point: hit.point };
  }

  private shouldInk(kind: PointerKind): boolean {
    const tool = this.options.getTool();
    if (!INK_TOOLS.has(tool) && tool !== LASER_TOOL) return false;
    if (kind === 'pen') return true;
    if (kind === 'mouse') return this.options.allowMouseDraw !== false;
    if (kind === 'touch') return this.options.shouldDrawWithTouch();
    return false;
  }

  handlePointerDown(event: PointerEvent): void {
    const kind = pointerKind(event.pointerType);
    this.callbacks.onPointerKind?.(kind, event.pointerType);

    const tap = this.options.enableMultiTap !== false ? this.tapTracker.handle('down', event.pointerId, event.clientX, event.clientY, event.timeStamp, event.pointerType) : 'none';
    if (tap !== 'none') return;

    const tool = this.options.getTool();
    const pointer: ActivePointer = {
      id: event.pointerId,
      kind,
      type: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      moved: false,
      points: [],
      time: event.timeStamp,
    };
    this.pointers.set(event.pointerId, pointer);

    // Two touch pointers always mean pan/pinch, whatever the tool is.
    if (this.pointers.size === 2 && kind === 'touch' && this.options.twoFingerPan !== false) {
      this.cancelActiveStroke();
      this.beginPinch();
      return;
    }
    if (this.pointers.size > 1) return;

    this.downOnEmptyCanvas = true;

    if (tool === 'pan' || (!this.shouldInk(kind) && kind !== 'mouse' && tool !== 'lasso')) {
      // Touch/mouse on a drawing tool pans; the dedicated pan tool always pans.
      if (tool === 'pan' || kind === 'touch') {
        this.mode = 'pan';
        this.lastPan = { x: event.clientX, y: event.clientY };
        this.callbacks.onPan(0, 0, 'start');
        return;
      }
    }

    this.beginAction(pointer, event);
  }

  private beginAction(pointer: ActivePointer, event: PointerEvent): void {
    const tool = this.options.getTool();
    const { point } = this.resolve(event);

    if (tool === 'eraser' || tool === 'eraser-pixel') {
      this.mode = 'erase';
      this.drawingId = pointer.id;
      this.lastErasePoint = point;
      this.callbacks.onErase(point, point, 'start');
      return;
    }
    if (tool === 'lasso') {
      this.mode = 'lasso';
      this.drawingId = pointer.id;
      this.lassoPoints = [point];
      this.callbacks.onLasso(this.lassoPoints, 'start');
      return;
    }
    if (tool === 'text' || tool === 'shape' || tool === 'image') {
      // These tools act on tap; the drag is used by callers to create shapes (handled in view).
      this.mode = 'idle';
      this.drawingId = pointer.id;
      pointer.points = [{ x: point.x, y: point.y, pressure: 0.5 }];
      return;
    }
    if (this.shouldInk(pointer.kind)) {
      this.mode = tool === LASER_TOOL ? 'laser' : 'ink';
      this.drawingId = pointer.id;
      pointer.points = this.collectPoints(event);
      if (this.mode === 'laser') this.callbacks.onLaser(pointer.points, 'start');
      else this.callbacks.onLiveStroke(pointer.points, tool);
      return;
    }

    // Nothing to do: keep the pointer tracked so a pan can start later.
    this.mode = 'idle';
  }

  handlePointerMove(event: PointerEvent): void {
    const kind = pointerKind(event.pointerType);
    if (this.options.enableMultiTap !== false) {
      this.tapTracker.handle('move', event.pointerId, event.clientX, event.clientY, event.timeStamp, event.pointerType);
    }
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) {
      if (kind !== 'touch' || !this.mode.startsWith('pan')) {
        this.callbacks.onCursorMove?.(this.resolve(event).point);
      }
      return;
    }
    pointer.clientX = event.clientX;
    pointer.clientY = event.clientY;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (
      !pointer.moved &&
      Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > (this.options.tapSlop ?? 6)
    ) {
      pointer.moved = true;
    }

    if (this.mode === 'pinch' && this.pointers.size >= 2) {
      const positions = [...this.pointers.values()].map((p) => ({ x: p.clientX, y: p.clientY }));
      const next = pinchFrom(positions);
      const factor = pinchScaleFactor(this.pinch, next);
      if (Math.abs(factor - 1) > 0.001) {
        this.callbacks.onZoom(factor, next.centerX, next.centerY);
        const dx = next.centerX - this.pinch.centerX;
        const dy = next.centerY - this.pinch.centerY;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) this.callbacks.onPan(dx, dy, 'move');
      }
      this.pinch = next;
      return;
    }

    if (this.mode === 'pan' && this.drawingId === null) {
      const dx = event.clientX - this.lastPan.x;
      const dy = event.clientY - this.lastPan.y;
      if (dx !== 0 || dy !== 0) {
        this.lastPan = { x: event.clientX, y: event.clientY };
        this.callbacks.onPan(dx, dy, 'move');
      }
      return;
    }

    if (this.drawingId !== event.pointerId) {
      this.callbacks.onCursorMove?.(this.resolve(event).point);
      return;
    }

    const tool = this.options.getTool();
    switch (this.mode) {
      case 'ink':
      case 'laser': {
        const added = this.collectPoints(event);
        pointer.points.push(...added);
        if (this.mode === 'laser') this.callbacks.onLaser(pointer.points, 'move');
        else this.callbacks.onLiveStroke(pointer.points, tool);
        break;
      }
      case 'erase': {
        const { point } = this.resolve(event);
        if (this.lastErasePoint) this.callbacks.onErase(this.lastErasePoint, point, 'move');
        else this.callbacks.onErase(point, point, 'move');
        this.lastErasePoint = point;
        break;
      }
      case 'lasso': {
        const { point } = this.resolve(event);
        const last = this.lassoPoints[this.lassoPoints.length - 1];
        if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 1.5) {
          this.lassoPoints.push(point);
          this.callbacks.onLasso(this.lassoPoints, 'move');
        }
        break;
      }
      default:
        this.callbacks.onCursorMove?.(this.resolve(event).point);
        break;
    }
  }

  handlePointerUp(event: PointerEvent): void {
    const tap: TapKind =
      this.options.enableMultiTap !== false
        ? this.tapTracker.handle('up', event.pointerId, event.clientX, event.clientY, event.timeStamp, event.pointerType)
        : 'none';

    const pointer = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);

    if (this.pointers.size === 0 && this.mode === 'pinch') {
      this.mode = 'idle';
      this.pinch = pinchFrom([]);
    }

    if (pointer && this.drawingId === pointer.id) {
      const tool = this.options.getTool();
      if (this.mode === 'ink') {
        const points = pointer.points;
        this.callbacks.onClearLive();
        // A tap (no movement) still produces a dot, mirroring real ink.
        this.callbacks.onInkComplete(points.length ? points : [{ x: 0, y: 0, pressure: 0.5 }], tool);
      } else if (this.mode === 'laser') {
        this.callbacks.onLaser(pointer.points, 'end');
      } else if (this.mode === 'erase') {
        const point = this.lastErasePoint ?? this.resolve(event).point;
        this.callbacks.onErase(point, point, 'end');
      } else if (this.mode === 'lasso') {
        this.callbacks.onLasso(this.lassoPoints, 'end');
      } else if (!pointer.moved && this.downOnEmptyCanvas) {
        this.callbacks.onTap(this.resolve(event).point, pointer.kind);
      }
      this.drawingId = null;
      this.lastErasePoint = null;
      this.lassoPoints = [];
      this.mode = 'idle';
      this.callbacks.onCursorMove?.(this.resolve(event).point);
    }

    if (tap === 'undo') this.callbacks.onUndoTap();
    if (tap === 'redo') this.callbacks.onRedoTap();
  }

  handlePointerCancel(event: PointerEvent): void {
    const pointer = this.pointers.get(event.pointerId);
    this.pointers.delete(event.pointerId);
    this.tapTracker.handle('cancel', event.pointerId, event.clientX, event.clientY, event.timeStamp, event.pointerType);
    if (pointer && this.drawingId === pointer.id) this.cancelActiveStroke();
  }

  handlePointerLeave(): void {
    if (this.mode === 'idle') this.callbacks.onCursorMove?.(null);
  }

  private cancelActiveStroke(): void {
    this.callbacks.onClearLive();
    this.drawingId = null;
    this.lastErasePoint = null;
    this.lassoPoints = [];
    this.mode = 'idle';
  }

  private beginPinch(): void {
    this.mode = 'pinch';
    this.pinch = pinchFrom([...this.pointers.values()].map((p) => ({ x: p.clientX, y: p.clientY })));
    this.callbacks.onPan(0, 0, 'start');
  }

  /** Collects coalesced events so high-frequency stylus samples are not dropped. */
  private collectPoints(event: PointerEvent): InputPoint[] {
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    const list = events.length > 0 ? events : [event];
    const out: InputPoint[] = [];
    for (const sample of list) {
      const { point } = this.resolve(sample);
      // Mouse and finger report 0.5 (or 0); real pressure only comes from a stylus.
      const pressure = sample.pressure > 0 && sample.pressure !== 0.5 ? sample.pressure : 0.5;
      out.push({ x: point.x, y: point.y, pressure, time: sample.timeStamp });
    }
    return out;
  }
}

/** Convenience factory used by the React layer. */
export function createPointerRouter(options: RouterOptions): PointerRouter {
  return new PointerRouter(options);
}
