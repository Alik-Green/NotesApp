/**
 * Viewport-sized overlay layer: live (in-progress) ink, laser trails, eraser cursor, lasso
 * path and selection handles. One instance per open viewport; it repaints through
 * requestAnimationFrame so pointer handlers never force a synchronous repaint.
 */

import type { Stroke } from '@/core/model';
import { QUANT } from '@/core/model';
import { strokeOutline } from '@/core/stroke';
import { pointAt, pressureAt } from '@/core/stroke';
import { getStroke } from 'perfect-freehand';
import type { Rect, Vec2 } from '@/core/geometry';
import type { AnyCanvas2DContext } from './strokeRenderer';

export interface LiveStrokeStyle {
  color: string;
  size: number;
  opacity: number;
  tool: string;
}

export interface LaserSegment {
  a: Vec2;
  b: Vec2;
  born: number;
}

export interface OverlayDeps {
  getZoom(): number;
  getDevicePixelRatio?(): number;
  /** Content-space origin of the viewport (scroll offsets). */
  getViewportOffset(): { left: number; top: number };
  /** Content-space layout offset of the page the current stroke belongs to. */
  getActivePageOrigin(): { x: number; y: number };
  isDark?(): boolean;
}

export class OverlayPainter {
  private canvas: HTMLCanvasElement;
  private deps: OverlayDeps;
  private livePoints: Vec2[] = [];
  private livePressures: number[] = [];
  private liveStyle: LiveStrokeStyle | null = null;
  private laser: LaserSegment[] = [];
  private cursor: Vec2 | null = null;
  private cursorRadius = 8;
  private cursorMode: 'none' | 'eraser' | 'pen' = 'none';
  private lasso: Vec2[] = [];
  private selectionBoxes: Rect[] = [];
  private frame: number | null = null;
  private laserActive = false;
  private laserFadeMs = 900;

  constructor(canvas: HTMLCanvasElement, deps: OverlayDeps) {
    this.canvas = canvas;
    this.deps = deps;
  }

  setDeps(deps: OverlayDeps): void {
    this.deps = deps;
  }

  get surface(): HTMLCanvasElement {
    return this.canvas;
  }

  setLaserFade(ms: number): void {
    this.laserFadeMs = ms;
  }

  /* ---------------- live ink ---------------- */

  setLiveStroke(points: readonly { x: number; y: number; pressure: number }[], style: LiveStrokeStyle): void {
    this.livePoints = points.map((p) => ({ x: p.x, y: p.y }));
    this.livePressures = points.map((p) => p.pressure);
    this.liveStyle = style;
    this.requestDraw();
  }

  addLivePoints(points: readonly { x: number; y: number; pressure: number }[], style: LiveStrokeStyle): void {
    for (const point of points) {
      this.livePoints.push({ x: point.x, y: point.y });
      this.livePressures.push(point.pressure);
    }
    this.liveStyle = style;
    this.requestDraw();
  }

  clearLive(): void {
    this.livePoints = [];
    this.livePressures = [];
    this.liveStyle = null;
    this.requestDraw();
  }

  /* ---------------- laser ---------------- */

  setLaser(points: readonly { x: number; y: number }[]): void {
    const now = performance.now();
    if (points.length >= 2) {
      const a = points[points.length - 2]!;
      const b = points[points.length - 1]!;
      this.laser.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, born: now });
    }
    this.startLaserLoop();
  }

  clearLaser(): void {
    this.laser = [];
    this.requestDraw();
  }

  private startLaserLoop(): void {
    if (this.laserActive) return;
    this.laserActive = true;
    const tick = () => {
      const now = performance.now();
      this.laser = this.laser.filter((segment) => now - segment.born < this.laserFadeMs);
      this.requestDraw();
      if (this.laser.length > 0) {
        this.frame = requestAnimationFrame(tick);
      } else {
        this.laserActive = false;
        this.frame = null;
      }
    };
    this.frame = requestAnimationFrame(tick);
  }

  /* ---------------- cursor, lasso, selection ---------------- */

  setCursor(point: Vec2 | null, mode: 'none' | 'eraser' | 'pen' = 'none', radius = 8): void {
    this.cursor = point;
    this.cursorMode = mode;
    this.cursorRadius = radius;
    this.requestDraw();
  }

  setLasso(points: readonly Vec2[]): void {
    this.lasso = points.map((p) => ({ x: p.x, y: p.y }));
    this.requestDraw();
  }

  clearLasso(): void {
    this.lasso = [];
    this.requestDraw();
  }

  setSelection(boxes: readonly Rect[]): void {
    this.selectionBoxes = boxes.map((b) => ({ ...b }));
    this.requestDraw();
  }

  resize(width: number, height: number): void {
    const dpr = this.deps.getDevicePixelRatio?.() ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.requestDraw();
  }

  requestDraw(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.draw();
    });
  }

  /** Screen position of a page-space point (page origin + zoom − scroll). */
  private toViewport(point: Vec2): Vec2 {
    const zoom = this.deps.getZoom();
    const origin = this.deps.getActivePageOrigin();
    const offset = this.deps.getViewportOffset();
    return {
      x: origin.x + point.x * zoom - offset.left,
      y: origin.y + point.y * zoom - offset.top,
    };
  }

  draw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.deps.getDevicePixelRatio?.() ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width / dpr, this.canvas.height / dpr);
    if (this.liveStyle) this.drawLiveStroke(ctx);
    if (this.laser.length) this.drawLaser(ctx);
    if (this.lasso.length > 1) this.drawLasso(ctx);
    if (this.selectionBoxes.length) this.drawSelection(ctx);
    if (this.cursor && this.cursorMode !== 'none') this.drawCursor(ctx);
  }

  private drawLiveStroke(ctx: AnyCanvas2DContext): void {
    const style = this.liveStyle;
    if (!style || this.livePoints.length === 0) return;
    const zoom = this.deps.getZoom();
    const points = this.livePoints.map((point, index) => [point.x, point.y, this.livePressures[index] ?? 0.5]);
    const outline = getStroke(points, {
      size: style.size,
      thinning: style.tool === 'highlighter' ? 0 : style.tool === 'pencil' ? 0.82 : 0.6,
      smoothing: 0.5,
      streamline: style.tool === 'pen' ? 0.35 : 0.55,
      simulatePressure: false,
      start: { cap: style.tool !== 'highlighter', taper: 0 },
      end: { cap: style.tool !== 'highlighter', taper: 0 },
      last: true,
    });
    if (!outline.length) return;
    const origin = this.deps.getActivePageOrigin();
    const offset = this.deps.getViewportOffset();
    ctx.save();
    ctx.translate(origin.x - offset.left, origin.y - offset.top);
    ctx.scale(zoom, zoom);
    ctx.globalAlpha = style.opacity;
    if (style.tool === 'highlighter') ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = style.color;
    ctx.beginPath();
    let started = false;
    for (const p of outline) {
      const x = p[0] ?? 0;
      const y = p[1] ?? 0;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  private drawLaser(ctx: AnyCanvas2DContext): void {
    const now = performance.now();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    for (const segment of this.laser) {
      const age = (now - segment.born) / this.laserFadeMs;
      const alpha = Math.max(0, 1 - age);
      if (alpha <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = '#ef4444';
      const a = this.toViewport(segment.a);
      const b = this.toViewport(segment.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawLasso(ctx: AnyCanvas2DContext): void {
    const zoom = this.deps.getZoom();
    const offset = this.deps.getViewportOffset();
    ctx.save();
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    this.lasso.forEach((point, index) => {
      const x = point.x * zoom - offset.left;
      const y = point.y * zoom - offset.top;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  private drawSelection(ctx: AnyCanvas2DContext): void {
    const zoom = this.deps.getZoom();
    const origin = this.deps.getActivePageOrigin();
    const offset = this.deps.getViewportOffset();
    ctx.save();
    ctx.strokeStyle = '#0ea5e9';
    ctx.lineWidth = 1.5;
    for (const box of this.selectionBoxes) {
      const x = origin.x + box.x * zoom - offset.left;
      const y = origin.y + box.y * zoom - offset.top;
      ctx.strokeRect(x, y, box.w * zoom, box.h * zoom);
      ctx.fillStyle = 'rgba(14,165,233,0.12)';
      ctx.fillRect(x, y, box.w * zoom, box.h * zoom);
    }
    ctx.restore();
  }

  private drawCursor(ctx: AnyCanvas2DContext): void {
    if (!this.cursor) return;
    const zoom = this.deps.getZoom();
    const offset = this.deps.getViewportOffset();
    const x = this.cursor.x * zoom - offset.left;
    const y = this.cursor.y * zoom - offset.top;
    ctx.save();
    if (this.cursorMode === 'eraser') {
      ctx.strokeStyle = 'rgba(15,23,42,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, this.cursorRadius * zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath();
      ctx.arc(x, y, Math.max(1, this.cursorRadius * zoom - 1), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(15,23,42,0.5)';
      ctx.beginPath();
      ctx.arc(x, y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/** Builds an outline for the live preview without allocating a Stroke document object. */
export function liveOutlinePoints(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  ps: ArrayLike<number>,
): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < xs.length; i++) out.push({ x: xs[i]! / QUANT, y: ys[i]! / QUANT });
  void ps;
  return out;
}

export function strokePreviewPoints(stroke: Stroke): Vec2[] {
  return stroke.xs.length ? [pointAt(stroke, 0), pointAt(stroke, stroke.xs.length - 1)] : [];
}

export { strokeOutline, pressureAt };
