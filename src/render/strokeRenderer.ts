/**
 * Canvas 2D rendering of page contents. Shared by the editor canvases, thumbnails, cover
 * previews and PNG export, so what you see is what gets exported.
 *
 * Pure-ish: takes a 2D context, never touches React or IndexedDB. Image objects receive their
 * bitmaps through `images` so this module never loads assets itself.
 */

import type { ImageObject, Page, SceneObject, ShapeObject, Stroke, TextBox } from '@/core/model';
import { QUANT, objectBounds } from '@/core/model';
import { strokeOutline } from '@/core/stroke';
import { templateGeometry } from '@/core/templates';

export type AnyCanvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type ImageSource = CanvasImageSource;

export interface RenderOptions {
  /** Document units → canvas pixels. */
  scale: number;
  /** Offset in canvas pixels applied before scaling (for viewport rendering). */
  offsetX?: number;
  offsetY?: number;
  /** Device pixel ratio multiplier for crispness. */
  dpr?: number;
  /** Bitmaps for image objects, keyed by asset id. */
  images?: ReadonlyMap<string, ImageSource>;
  /** Multiplies every object's opacity (used for ghost/preview rendering). */
  alpha?: number;
  /** Renders only these object ids (partial redraw). */
  only?: ReadonlySet<string>;
  /** Skips these object ids (e.g. objects drawn by the live layer). */
  exclude?: ReadonlySet<string>;
  /** Draws the template / PDF placeholder background. */
  includeBackground?: boolean;
  /** Draws the page paper colour. */
  includePaper?: boolean;
  /** Highlights selected objects with a tint. */
  selectionTint?: ReadonlySet<string>;
  laserAlphaMap?: ReadonlyMap<string, number>;
}

export interface PageRenderTarget {
  width: number;
  height: number;
  /** Extra element id to hang data attributes on for tests. */
  id?: string;
}

/** Total pixel size of a page at a given zoom, honouring rotation. */
export function pagePixelSize(page: Page, zoom: number): { width: number; height: number } {
  const rotated = page.rotation === 90 || page.rotation === 270;
  const w = rotated ? page.height : page.width;
  const h = rotated ? page.width : page.height;
  return { width: Math.round(w * zoom), height: Math.round(h * zoom) };
}

/** Applies page rotation so downstream drawing can work in unrotated page space. */
export function applyPageRotation(
  ctx: AnyCanvas2DContext,
  page: Page,
  scale: number,
  offsetX = 0,
  offsetY = 0,
): void {
  const rotated = page.rotation === 90 || page.rotation === 270;
  const outW = (rotated ? page.height : page.width) * scale;
  const outH = (rotated ? page.width : page.height) * scale;
  ctx.translate(offsetX, offsetY);
  if (page.rotation === 90) {
    ctx.translate(outW, 0);
    ctx.rotate(Math.PI / 2);
  } else if (page.rotation === 180) {
    ctx.translate(outW, outH);
    ctx.rotate(Math.PI);
  } else if (page.rotation === 270) {
    ctx.translate(0, outH);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.scale(scale, scale);
}

export function tracePolygon(ctx: AnyCanvas2DContext, points: readonly number[][]): void {
  let started = false;
  for (const p of points) {
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
}

/* ------------------------------------------------------------------ */
/* Background: template or paper                                       */
/* ------------------------------------------------------------------ */

export function drawPaperAndTemplate(
  ctx: AnyCanvas2DContext,
  page: Page,
  options: { paperColor?: string; template?: Page['background'] } = {},
): void {
  const background = options.template ?? page.background;
  if (background.kind !== 'template') return;
  const geometry = templateGeometry(background.template, {
    width: page.width,
    height: page.height,
    color: paperColorToRuleColor(options.paperColor ?? page.paperColor),
  });
  if (geometry.lines.length === 0 && geometry.dots.length === 0 && geometry.boxes.length === 0) return;
  ctx.save();
  ctx.strokeStyle = geometry.color;
  ctx.fillStyle = geometry.color;
  ctx.lineWidth = geometry.lineWidth;
  ctx.beginPath();
  for (const [x1, y1, x2, y2] of geometry.lines) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }
  for (const box of geometry.boxes) ctx.rect(box.x, box.y, box.w, box.h);
  ctx.stroke();
  if (geometry.dots.length) {
    for (const [x, y] of geometry.dots) {
      ctx.moveTo(x + 1.1, y);
      ctx.arc(x, y, 1.1, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

/** Rule colour that stays legible on light and dark paper. */
export function paperColorToRuleColor(paperColor: string): string {
  const rgb = parseHexColor(paperColor);
  if (!rgb) return 'rgba(100,116,139,0.38)';
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance < 0.5 ? 'rgba(203,213,225,0.30)' : 'rgba(71,85,105,0.34)';
}

export function parseHexColor(color: string): { r: number; g: number; b: number; a: number } | null {
  const hex = color.trim();
  const short = /^#?([\da-f])([\da-f])([\da-f])$/i.exec(hex);
  if (short) {
    return {
      r: parseInt(short[1]! + short[1]!, 16),
      g: parseInt(short[2]! + short[2]!, 16),
      b: parseInt(short[3]! + short[3]!, 16),
      a: 1,
    };
  }
  const long = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (long) {
    return {
      r: parseInt(long[1]!, 16),
      g: parseInt(long[2]!, 16),
      b: parseInt(long[3]!, 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(hex);
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Objects                                                             */
/* ------------------------------------------------------------------ */

export function drawObjects(
  ctx: AnyCanvas2DContext,
  page: Page,
  options: RenderOptions,
): void {
  for (const object of page.objects) {
    if (options.only && !options.only.has(object.id)) continue;
    if (options.exclude?.has(object.id)) continue;
    drawObject(ctx, object, options);
  }
}

export function drawObject(ctx: AnyCanvas2DContext, object: SceneObject, options: RenderOptions): void {
  const alpha = options.alpha ?? 1;
  switch (object.type) {
    case 'stroke':
      drawStroke(ctx, object, alpha);
      break;
    case 'highlight':
      drawHighlight(ctx, object, alpha);
      break;
    case 'shape':
      drawShape(ctx, object, alpha);
      break;
    case 'text':
      drawText(ctx, object, alpha);
      break;
    case 'image':
      drawImage(ctx, object, options);
      break;
  }
  if (options.selectionTint?.has(object.id)) {
    const box = objectBounds(object);
    ctx.save();
    ctx.globalAlpha = 0.18 * alpha;
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.restore();
  }
}

export function drawStroke(ctx: AnyCanvas2DContext, stroke: Stroke, alpha = 1): void {
  const outline = strokeOutline(stroke, true);
  if (outline.length === 0) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity * alpha;
  if (stroke.tool === 'highlighter') {
    ctx.globalCompositeOperation = 'multiply';
  }
  ctx.fillStyle = stroke.color;
  ctx.beginPath();
  tracePolygon(ctx, outline);
  ctx.fill();
  if (stroke.tool === 'pencil') {
    // Grainy second pass so pencil reads differently from pen at the same width.
    ctx.globalAlpha = stroke.opacity * alpha * 0.5;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(0.5, stroke.size * 0.22);
    ctx.beginPath();
    for (let i = 1; i < stroke.xs.length; i++) {
      const x0 = stroke.xs[i - 1]! / QUANT;
      const y0 = stroke.ys[i - 1]! / QUANT;
      const x1 = stroke.xs[i]! / QUANT;
      const y1 = stroke.ys[i]! / QUANT;
      ctx.moveTo(x0 + 0.35, y0 - 0.3);
      ctx.lineTo(x1 + 0.35, y1 - 0.3);
    }
    ctx.stroke();
  }
  ctx.restore();
}

export function drawHighlight(
  ctx: AnyCanvas2DContext,
  highlight: { x: number; y: number; w: number; h: number; color: string; opacity: number },
  alpha = 1,
): void {
  ctx.save();
  ctx.globalAlpha = highlight.opacity * alpha;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = highlight.color;
  ctx.fillRect(highlight.x, highlight.y, highlight.w, highlight.h);
  ctx.restore();
}

export function drawShape(ctx: AnyCanvas2DContext, shape: ShapeObject, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = shape.opacity * alpha;
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  ctx.translate(cx, cy);
  if (shape.rotation) ctx.rotate(shape.rotation);
  ctx.translate(-shape.w / 2, -shape.h / 2);
  ctx.lineWidth = Math.max(0.4, shape.size);
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.fill ?? 'transparent';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (shape.shape) {
    case 'rect':
      ctx.rect(0, 0, shape.w, shape.h);
      break;
    case 'ellipse':
      ctx.ellipse(shape.w / 2, shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(0, shape.h);
      ctx.lineTo(shape.w / 2, 0);
      ctx.lineTo(shape.w, shape.h);
      ctx.closePath();
      break;
    case 'line':
      ctx.moveTo(0, 0);
      ctx.lineTo(shape.w, shape.h);
      break;
    case 'arrow': {
      ctx.moveTo(0, 0);
      ctx.lineTo(shape.w, shape.h);
      const angle = Math.atan2(shape.h, shape.w);
      const head = Math.max(6, shape.size * 3.4);
      ctx.moveTo(shape.w, shape.h);
      ctx.lineTo(shape.w - head * Math.cos(angle - 0.4), shape.h - head * Math.sin(angle - 0.4));
      ctx.moveTo(shape.w, shape.h);
      ctx.lineTo(shape.w - head * Math.cos(angle + 0.4), shape.h - head * Math.sin(angle + 0.4));
      break;
    }
  }
  if (shape.fill && shape.shape !== 'line' && shape.shape !== 'arrow') ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function fontString(object: Pick<TextBox, 'fontSize' | 'fontFamily' | 'bold' | 'italic'>): string {
  const style = object.italic ? 'italic ' : '';
  const weight = object.bold ? '700 ' : '400 ';
  return `${style}${weight}${object.fontSize}px ${object.fontFamily}`;
}

export function drawText(ctx: AnyCanvas2DContext, object: TextBox, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;
  ctx.translate(cx, cy);
  if (object.rotation) ctx.rotate(object.rotation);
  ctx.translate(-object.w / 2, -object.h / 2);
  if (object.sticky) {
    ctx.fillStyle = object.sticky.color;
    ctx.shadowColor = 'rgba(15,23,42,0.18)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    ctx.fillRect(0, 0, object.w, object.h);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  }
  ctx.font = fontString(object);
  ctx.fillStyle = object.color;
  ctx.textBaseline = 'top';
  ctx.textAlign = object.align === 'center' ? 'center' : object.align === 'right' ? 'right' : 'left';
  const lineHeight = object.fontSize * 1.32;
  const maxWidth = object.w - 2;
  const anchorX = object.align === 'center' ? object.w / 2 : object.align === 'right' ? object.w - 1 : 0;
  let y = 0;
  for (const rawLine of object.text.split('\n')) {
    for (const line of wrapLine(ctx, rawLine, maxWidth)) {
      ctx.fillText(line, anchorX, y + 1);
      y += lineHeight;
    }
  }
  ctx.restore();
}

export function wrapLine(ctx: AnyCanvas2DContext, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

export function drawImage(ctx: AnyCanvas2DContext, object: ImageObject, options: RenderOptions): void {
  const image = options.images?.get(object.assetId);
  ctx.save();
  ctx.globalAlpha = object.opacity * (options.alpha ?? 1);
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;
  ctx.translate(cx, cy);
  if (object.rotation) ctx.rotate(object.rotation);
  ctx.translate(-object.w / 2, -object.h / 2);
  if (image) {
    const natural = naturalSize(image);
    const crop = object.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const sx = natural.width * crop.x;
    const sy = natural.height * crop.y;
    const sw = Math.max(1, natural.width * crop.w);
    const sh = Math.max(1, natural.height * crop.h);
    try {
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, object.w, object.h);
    } catch {
      // Invalid/undecoded image state — draw a placeholder instead of throwing every frame.
      drawImagePlaceholder(ctx, object);
    }
  } else {
    drawImagePlaceholder(ctx, object);
  }
  ctx.restore();
}

function drawImagePlaceholder(ctx: AnyCanvas2DContext, object: ImageObject): void {
  ctx.fillStyle = 'rgba(148,163,184,0.25)';
  ctx.fillRect(0, 0, object.w, object.h);
  ctx.strokeStyle = 'rgba(100,116,139,0.6)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, object.w - 1, object.h - 1);
}

export function naturalSize(source: ImageSource): { width: number; height: number } {
  const candidate = source as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number };
  const width = candidate.naturalWidth ?? candidate.width ?? 0;
  const height = candidate.naturalHeight ?? candidate.height ?? 0;
  return { width, height };
}

/** Draws a complete page (paper + template + objects) into a context. */
export function drawPage(ctx: AnyCanvas2DContext, page: Page, options: RenderOptions): void {
  ctx.save();
  if (options.includePaper !== false) {
    ctx.fillStyle = page.paperColor;
    ctx.fillRect(0, 0, page.width, page.height);
  }
  if (options.includeBackground !== false) {
    drawPaperAndTemplate(ctx, page, { paperColor: page.paperColor });
  }
  drawObjects(ctx, page, options);
  ctx.restore();
}
