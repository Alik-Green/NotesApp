/**
 * Owns the two static canvases of a page: the background (paper + template or PDF bitmap) and
 * the committed ink. Both are redrawn only when something actually changes, so drawing a new
 * stroke never repaints the page.
 *
 * Canvas resolution is capped (`MAX_PAGE_PIXELS`) to keep memory bounded when many pages are
 * mounted at high zoom; the CSS size always matches the layout size so the page still fills the
 * correct space (see DECISIONS.md D14).
 */

import type { Page } from '@/core/model';
import { applyPageRotation, drawObjects, drawPaperAndTemplate, type AnyCanvas2DContext } from './strokeRenderer';

export const MAX_PAGE_PIXELS = 6_000_000;
/** Upper bound on device pixels per page unit — keeps ink crisp without unbounded surfaces. */
export const MAX_RENDER_SCALE = 3;

export interface PagePainterOptions {
  backgroundCanvas: HTMLCanvasElement;
  inkCanvas: HTMLCanvasElement;
  getZoom(): number;
  getImages(): ReadonlyMap<string, CanvasImageSource> | undefined;
  /** PDF page bitmap for the current background, if already rasterized. */
  getBackgroundBitmap?(): CanvasImageSource | null;
  /** Called when a PDF-backed background needs a (re)render at the current scale. */
  onBackgroundNeeded?(scale: number): void;
  getDevicePixelRatio?(): number;
}

export interface PagePaintState {
  page: Page;
  /** Layout size in CSS px (already includes zoom). */
  width: number;
  height: number;
}

export function computeRenderScale(
  zoom: number,
  dpr: number,
  cssWidth: number,
  cssHeight: number,
  maxPixels = MAX_PAGE_PIXELS,
): number {
  let scale = Math.min(MAX_RENDER_SCALE, Math.max(0.5, zoom * dpr));
  const area = cssWidth * cssHeight * scale * scale;
  if (area > maxPixels) scale = Math.sqrt(maxPixels / (cssWidth * cssHeight));
  return scale;
}

export class PagePainter {
  private background: HTMLCanvasElement;
  private ink: HTMLCanvasElement;
  private page: Page;
  private zoom = 1;
  private renderScale = 1;
  private inkGeneration = -1;
  private backgroundKey = '';
  private readonly options: PagePainterOptions;

  constructor(page: Page, options: PagePainterOptions) {
    this.page = page;
    this.options = options;
    this.background = options.backgroundCanvas;
    this.ink = options.inkCanvas;
  }

  get current(): Page {
    return this.page;
  }

  setPage(page: Page): void {
    this.page = page;
    this.invalidateAll();
  }

  /** Resizes both surfaces for a new layout size / zoom. */
  resize(cssWidth: number, cssHeight: number, zoom: number): boolean {
    const changed = this.zoom !== zoom || this.background.style.width !== `${cssWidth}px`;
    this.zoom = zoom;
    const dpr = this.options.getDevicePixelRatio?.() ?? (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const scale = computeRenderScale(zoom, dpr, cssWidth, cssHeight);
    if (this.renderScale !== scale) {
      this.renderScale = scale;
      this.invalidateAll();
    }
    for (const canvas of [this.background, this.ink]) {
      if (canvas.width !== Math.round(cssWidth * scale) || canvas.height !== Math.round(cssHeight * scale)) {
        canvas.width = Math.max(1, Math.round(cssWidth * scale));
        canvas.height = Math.max(1, Math.round(cssHeight * scale));
        this.invalidateAll();
      }
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    if (changed) this.invalidateAll();
    return changed;
  }

  invalidateAll(): void {
    this.inkGeneration = -1;
    this.backgroundKey = '';
  }

  invalidateInk(): void {
    this.inkGeneration = -1;
  }

  get scale(): number {
    return this.renderScale;
  }

  private context(canvas: HTMLCanvasElement): AnyCanvas2DContext | null {
    return canvas.getContext('2d') as AnyCanvas2DContext | null;
  }

  /** Draws paper + template (or the PDF bitmap) for the current surface. */
  drawBackground(): void {
    const ctx = this.context(this.background);
    if (!ctx) return;
    const page = this.page;
    const key = `${page.rotation}|${page.paperColor}|${page.background.kind}|${page.background.kind === 'template' ? page.background.template : `${page.background.assetId}:${page.background.pdfPage}`}|${this.renderScale.toFixed(2)}|${this.background.width}x${this.background.height}`;
    if (this.backgroundKey === key) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.background.width, this.background.height);
    ctx.save();
    applyPageRotation(ctx, page, this.renderScale, 0, 0);
    ctx.fillStyle = page.paperColor;
    ctx.fillRect(0, 0, page.width, page.height);
    if (page.background.kind === 'template') {
      drawPaperAndTemplate(ctx, page, { paperColor: page.paperColor });
    } else {
      const bitmap = this.options.getBackgroundBitmap?.() ?? null;
      if (bitmap) {
        const natural = naturalSizeOf(bitmap);
        const scaleX = page.width / (natural.width || page.width);
        const scaleY = page.height / (natural.height || page.height);
        ctx.save();
        ctx.scale(scaleX, scaleY);
        ctx.drawImage(bitmap, 0, 0, natural.width || page.width, natural.height || page.height);
        ctx.restore();
      } else {
        // Placeholder while the PDF page rasterizes; a checker hints "loading" without flashing.
        ctx.fillStyle = 'rgba(148,163,184,0.10)';
        ctx.fillRect(0, 0, page.width, page.height);
        ctx.strokeStyle = 'rgba(148,163,184,0.35)';
        ctx.lineWidth = 1 / this.renderScale;
        ctx.strokeRect(0.5, 0.5, page.width - 1, page.height - 1);
        this.options.onBackgroundNeeded?.(this.renderScale);
      }
    }
    ctx.restore();
    this.backgroundKey = key;
  }

  /** Draws every committed object on the page. */
  drawInk(generation: number, options: { exclude?: ReadonlySet<string> } = {}): void {
    if (this.inkGeneration === generation && !options.exclude?.size) return;
    const ctx = this.context(this.ink);
    if (!ctx) return;
    const page = this.page;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    ctx.save();
    applyPageRotation(ctx, page, this.renderScale, 0, 0);
    drawObjects(ctx, page, {
      scale: this.renderScale,
      images: this.options.getImages(),
      exclude: options.exclude,
    });
    ctx.restore();
    this.inkGeneration = generation;
  }

  drawAll(generation: number): void {
    this.drawBackground();
    this.drawInk(generation);
  }
}

export function naturalSizeOf(source: CanvasImageSource): { width: number; height: number } {
  const candidate = source as { naturalWidth?: number; width?: number; naturalHeight?: number; height?: number };
  return {
    width: candidate.naturalWidth ?? candidate.width ?? 0,
    height: candidate.naturalHeight ?? candidate.height ?? 0,
  };
}
