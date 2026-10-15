/** PNG export for single pages or whole notebooks (canvas → Blob, no raster of the UI). */

import type { Page } from '@/core/model';
import { drawPage, type ImageSource } from '@/render/strokeRenderer';
import { applyPageRotation } from '@/render/strokeRenderer';

export interface PngExportOptions {
  /** Pixels per document unit. 2 ≈ 144 DPI for a 72-dpi page. */
  scale?: number;
  /** Extra margin in pixels. */
  margin?: number;
  background?: 'paper' | 'transparent';
  images?: ReadonlyMap<string, ImageSource>;
  getBackgroundBitmap?(page: Page): CanvasImageSource | null;
}

export interface PngResult {
  blob: Blob;
  width: number;
  height: number;
}

export async function renderPageToPng(page: Page, options: PngExportOptions = {}): Promise<PngResult | null> {
  const scale = options.scale ?? 2;
  const margin = options.margin ?? 0;
  const rotated = page.rotation === 90 || page.rotation === 270;
  const width = Math.round((rotated ? page.height : page.width) * scale + margin * 2);
  const height = Math.round((rotated ? page.width : page.height) * scale + margin * 2);
  const canvas = createCanvas(width, height);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  applyPageRotation(ctx, page, scale, margin, margin);
  if (options.background !== 'transparent') {
    ctx.fillStyle = page.paperColor;
    ctx.fillRect(0, 0, page.width, page.height);
  }
  const bitmap = options.getBackgroundBitmap?.(page) ?? null;
  if (page.background.kind === 'pdf' && bitmap) {
    const natural = bitmap as { width?: number; height?: number };
    ctx.drawImage(bitmap, 0, 0, natural.width ?? page.width, natural.height ?? page.height);
  }
  drawPage(ctx, page, {
    scale,
    images: options.images,
    includePaper: options.background !== 'transparent',
    includeBackground: options.background !== 'transparent',
  });
  ctx.restore();

  const blob = await canvasToBlob(canvas);
  return blob ? { blob, width, height } : null;
}

/** Renders a small thumbnail of a page (used for covers and the sidebar). */
export async function renderPageThumbnail(page: Page, maxSize = 240): Promise<Blob | null> {
  const rotated = page.rotation === 90 || page.rotation === 270;
  const pageWidth = rotated ? page.height : page.width;
  const pageHeight = rotated ? page.width : page.height;
  const scale = Math.min(maxSize / pageWidth, maxSize / pageHeight);
  const result = await renderPageToPng(page, { scale, margin: 0 });
  return result?.blob ?? null;
}

type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

function createCanvas(width: number, height: number): CanvasLike | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
}

async function canvasToBlob(canvas: CanvasLike): Promise<Blob | null> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve) => {
    (canvas as HTMLCanvasElement).toBlob((blob) => resolve(blob), 'image/png');
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
