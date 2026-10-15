/**
 * PDF export.
 *
 * - PDF-backed notebook pages keep their *original* content: the source page is copied into the
 *   output document with pdf-lib, so the underlying text/vector data survives and file sizes
 *   stay small.
 * - Ink is written as **vector paths** (filled perfect-freehand outlines), never as a raster
 *   screenshot. Shapes, text, highlights and images are written as native PDF operators too.
 * - Template backgrounds (lined/grid/dotted/Cornell) are re-drawn as vector rules.
 */

import {
  BlendMode,
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import { QUANT, objectBounds, type Page, type SceneObject } from '@/core/model';
import { strokeOutline } from '@/core/stroke';
import { templateGeometry } from '@/core/templates';
import { rectCenter } from '@/core/geometry';
import type { NotebookDocument } from '@/core/document';
import { getAssetBytes } from '@/data/repository';

export interface PdfExportOptions {
  /** Fill paper colour + template rules on non-PDF pages (default true). */
  includeBackgrounds?: boolean;
  /** Page indices to export (default: every page). */
  pages?: number[];
  onProgress?(done: number, total: number): void;
}

export interface ExportAssetProvider {
  (assetId: string): Promise<Uint8Array | null>;
}

const defaultAssetProvider: ExportAssetProvider = async (assetId) => {
  const blob = await getAssetBytes(assetId);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
};

export async function exportDocumentToPdf(
  doc: NotebookDocument,
  options: PdfExportOptions = {},
  assetProvider: ExportAssetProvider = defaultAssetProvider,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  // pdf-lib stamps its own Producer string when saving, so InkPad identifies itself as the
  // creator (the title is written too).
  out.setCreator('InkPad — handwritten notes');
  out.setTitle(doc.notebook.title);

  const helvetica = await out.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await out.embedFont(StandardFonts.HelveticaBold);
  const indices = options.pages ?? doc.pages.map((_, index) => index);
  const sourceCache = new Map<string, PDFDocument>();
  const imageCache = new Map<string, PDFImage | null>();

  let done = 0;
  for (const index of indices) {
    const model = doc.pages[index];
    if (!model) continue;
    const page = model.data;
    let target: PDFPage;
    let scale = 1;

    if (page.background.kind === 'pdf') {
      const { assetId, pdfPage } = page.background;
      let source = sourceCache.get(assetId);
      if (!source) {
        const bytes = await assetProvider(assetId);
        if (bytes) {
          try {
            source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
            sourceCache.set(assetId, source);
          } catch (error) {
            console.warn('InkPad: could not read the source PDF for export', error);
          }
        }
      }
      if (source && pdfPage < source.getPageCount()) {
        const [copied] = await out.copyPages(source, [pdfPage]);
        if (copied) {
          target = out.addPage(copied);
          const { width } = target.getSize();
          const ourWidth = page.rotation === 90 || page.rotation === 270 ? page.height : page.width;
          scale = ourWidth > 0 ? width / ourWidth : 1;
          // The page may have been rotated in InkPad; the copied content is not, so ink is
          // drawn in unrotated space when a rotation is set.
          if (page.rotation) {
            target.setRotation(degrees((target.getRotation().angle + page.rotation) % 360));
          }
        } else {
          target = out.addPage([page.width, page.height]);
        }
      } else {
        target = out.addPage([page.width, page.height]);
      }
    } else {
      target = out.addPage([page.width, page.height]);
    }

    if (page.background.kind !== 'pdf' && options.includeBackgrounds !== false) {
      drawPaper(target, page);
      drawTemplateBackground(target, page);
    }

    for (const object of page.objects) {
      await drawObject(target, object, { doc, out, helvetica, helveticaBold, assetProvider, imageCache, scale });
    }

    done++;
    options.onProgress?.(done, indices.length);
  }

  // pdf-lib refuses to save a document without pages; an (unlikely) empty notebook still gets
  // a readable single blank page rather than a corrupt file.
  if (out.getPageCount() === 0) out.addPage([595.28, 841.89]);

  return out.save();
}

/** Convenience wrapper used by the editor (exports every page of an open notebook). */
export async function exportNotebookPdf(doc: NotebookDocument, options: PdfExportOptions = {}): Promise<Uint8Array> {
  return exportDocumentToPdf(doc, options);
}

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

interface PaintContext {
  doc: NotebookDocument;
  out: PDFDocument;
  helvetica: PDFFont;
  helveticaBold: PDFFont;
  assetProvider: ExportAssetProvider;
  imageCache: Map<string, PDFImage | null>;
  scale: number;
}

function drawPaper(page: PDFPage, model: Page): void {
  const color = parseHex(model.paperColor);
  if (color) page.drawRectangle({ x: 0, y: 0, width: model.width, height: model.height, color });
}

function drawTemplateBackground(target: PDFPage, model: Page): void {
  if (model.background.kind !== 'template') return;
  const geometry = templateGeometry(model.background.template, {
    width: model.width,
    height: model.height,
    color: 'rgba(100,116,139,0.35)',
  });
  const color = rgb(0.45, 0.5, 0.58);
  const height = model.height;
  for (const [x1, y1, x2, y2] of geometry.lines) {
    target.drawLine({
      start: { x: x1, y: height - y1 },
      end: { x: x2, y: height - y2 },
      thickness: geometry.lineWidth,
      color,
      opacity: 0.5,
    });
  }
  for (const box of geometry.boxes) {
    target.drawRectangle({
      x: box.x,
      y: height - box.y - box.h,
      width: box.w,
      height: box.h,
      borderColor: color,
      borderWidth: geometry.lineWidth,
      opacity: 0.6,
    });
  }
  if (geometry.dots.length) {
    for (const [x, y] of geometry.dots) {
      target.drawCircle({ x, y: height - y, size: 1.1, color, opacity: 0.5 });
    }
  }
}

async function drawObject(target: PDFPage, object: SceneObject, context: PaintContext): Promise<void> {
  const pageHeight = target.getSize().height;
  switch (object.type) {
    case 'stroke': {
      const outline = strokeOutline(object, true);
      if (outline.length === 0) break;
      const color = parseHex(object.color) ?? rgb(0, 0, 0);
      const path = outlineToSvg(outline);
      // y is flipped for SVG paths, so the outline (document units, y down) is drawn from the
      // bottom-left origin of the page.
      target.drawSvgPath(path, {
        x: 0,
        y: pageHeight,
        color,
        opacity: object.opacity,
        blendMode: object.tool === 'highlighter' ? BlendMode.Multiply : BlendMode.Normal,
      });
      break;
    }
    case 'highlight': {
      const color = parseHex(object.color) ?? rgb(1, 0.86, 0.1);
      target.drawRectangle({
        x: object.x,
        y: pageHeight - object.y - object.h,
        width: object.w,
        height: object.h,
        color,
        opacity: object.opacity,
        blendMode: BlendMode.Multiply,
      });
      break;
    }
    case 'shape': {
      const color = parseHex(object.color) ?? rgb(0, 0, 0);
      const fill = object.fill ? (parseHex(object.fill) ?? undefined) : undefined;
      const cx = object.x + object.w / 2;
      if (object.shape === 'line' || object.shape === 'arrow') {
        target.drawLine({
          start: { x: object.x, y: pageHeight - object.y },
          end: { x: object.x + object.w, y: pageHeight - (object.y + object.h) },
          thickness: object.size,
          color,
          opacity: object.opacity,
        });
        if (object.shape === 'arrow') {
          const angle = Math.atan2(object.h, object.w);
          const head = Math.max(6, object.size * 3.4);
          for (const delta of [-0.4, 0.4]) {
            target.drawLine({
              start: { x: object.x + object.w, y: pageHeight - (object.y + object.h) },
              end: {
                x: object.x + object.w - head * Math.cos(angle + delta),
                y: pageHeight - (object.y + object.h) + head * Math.sin(angle + delta),
              },
              thickness: object.size,
              color,
              opacity: object.opacity,
            });
          }
        }
        break;
      }
      const options = {
        x: object.x,
        y: pageHeight - object.y - object.h,
        width: object.w,
        height: object.h,
        borderColor: color,
        borderWidth: object.size,
        opacity: object.opacity,
      };
      if (object.shape === 'ellipse') {
        target.drawEllipse({
          x: cx,
          y: pageHeight - (object.y + object.h / 2),
          xScale: object.w / 2,
          yScale: object.h / 2,
          borderColor: color,
          borderWidth: object.size,
          color: fill,
          opacity: object.opacity,
        });
      } else if (object.shape === 'triangle') {
        const points = [
          { x: object.x, y: pageHeight - (object.y + object.h) },
          { x: object.x + object.w / 2, y: pageHeight - object.y },
          { x: object.x + object.w, y: pageHeight - (object.y + object.h) },
        ];
        target.drawSvgPath(
          `M ${points[0]!.x} ${-points[0]!.y + pageHeight} L ${points[1]!.x} ${-points[1]!.y + pageHeight} L ${points[2]!.x} ${-points[2]!.y + pageHeight} Z`,
          {
            x: 0,
            y: 0,
            color: fill,
            borderColor: color,
            borderWidth: object.size,
            opacity: object.opacity,
          },
        );
      } else {
        target.drawRectangle({
          ...options,
          color: fill,
        });
      }
      break;
    }
    case 'text': {
      const color = parseHex(object.color) ?? rgb(0, 0, 0);
      if (object.sticky) {
        const sticky = parseHex(object.sticky.color);
        if (sticky) {
          target.drawRectangle({
            x: object.x,
            y: pageHeight - object.y - object.h,
            width: object.w,
            height: object.h,
            color: sticky,
          });
        }
      }
      const font = object.bold ? context.helveticaBold : context.helvetica;
      const size = object.fontSize;
      const lineHeight = size * 1.32;
      const lines = wrapText(object.text, object.w - 2, font, size);
      lines.forEach((line, index) => {
        const width = font.widthOfTextAtSize(line, size);
        const align = object.align ?? 'left';
        const x =
          align === 'center'
            ? object.x + (object.w - width) / 2
            : align === 'right'
              ? object.x + object.w - width
              : object.x;
        target.drawText(line, {
          x,
          y: pageHeight - object.y - size - index * lineHeight,
          size,
          font,
          color,
        });
      });
      break;
    }
    case 'image': {
      const image = await embedImage(object.assetId, context);
      if (!image) {
        // Missing bitmap: draw a light placeholder instead of failing the whole export.
        target.drawRectangle({
          x: object.x,
          y: pageHeight - object.y - object.h,
          width: object.w,
          height: object.h,
          color: rgb(0.85, 0.87, 0.9),
        });
        break;
      }
      const cx = rectCenter({ x: object.x, y: object.y, w: object.w, h: object.h });
      target.drawImage(image, {
        x: cx.x - object.w / 2,
        y: pageHeight - (cx.y + object.h / 2),
        width: object.w,
        height: object.h,
        opacity: object.opacity,
        rotate: degrees(object.rotation ? (object.rotation * 180) / Math.PI : 0),
      });
      break;
    }
  }
}

async function embedImage(assetId: string, context: PaintContext): Promise<PDFImage | null> {
  if (context.imageCache.has(assetId)) return context.imageCache.get(assetId) ?? null;
  let image: PDFImage | null = null;
  try {
    const bytes = await context.assetProvider(assetId);
    if (bytes) {
      const lower = assetId.toLowerCase();
      if (lower.endsWith('jpg') || lower.endsWith('jpeg')) {
        image = await context.out.embedJpg(bytes);
      } else {
        try {
          image = await context.out.embedPng(bytes);
        } catch {
          // Fall back to JPEG decoding for formats pdf-lib cannot read directly (webp/gif).
          try {
            image = await context.out.embedJpg(bytes);
          } catch {
            image = null;
          }
        }
      }
    }
  } catch (error) {
    console.warn('InkPad: could not embed image', assetId, error);
    image = null;
  }
  context.imageCache.set(assetId, image);
  return image;
}

/** Serialises one outline polygon (or many) as SVG path data for pdf-lib. */
export function outlineToSvg(points: readonly number[][]): string {
  return polygonToSvg(points);
}

function polygonToSvg(points: readonly number[][]): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  let d = `M ${round(first[0] ?? 0)} ${round(first[1] ?? 0)}`;
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    d += ` L ${round(point[0] ?? 0)} ${round(point[1] ?? 0)}`;
  }
  return `${d} Z`;
}

function round(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export function wrapText(text: string, maxWidth: number, font: PDFFont, size: number, limit = 4000): string[] {
  const out: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (maxWidth <= 0) {
      out.push(rawLine);
      continue;
    }
    let current = '';
    for (const word of rawLine.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        out.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    out.push(current);
    if (out.length > limit) return out.slice(0, limit);
  }
  return out;
}

export function parseHex(color: string): ReturnType<typeof rgb> | null {
  const short = /^#?([\da-f])([\da-f])([\da-f])$/i.exec(color.trim());
  if (short) {
    return rgb(
      parseInt(short[1]! + short[1]!, 16) / 255,
      parseInt(short[2]! + short[2]!, 16) / 255,
      parseInt(short[3]! + short[3]!, 16) / 255,
    );
  }
  const long = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color.trim());
  if (long) {
    return rgb(
      parseInt(long[1]!, 16) / 255,
      parseInt(long[2]!, 16) / 255,
      parseInt(long[3]!, 16) / 255,
    );
  }
  const rgba = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color.trim());
  if (rgba) return rgb(Number(rgba[1]) / 255, Number(rgba[2]) / 255, Number(rgba[3]) / 255);
  return null;
}

/** Total stored ink points across the document — used by the export progress UI and tests. */
export function countInkPoints(doc: NotebookDocument): number {
  let total = 0;
  for (const page of doc.pages) {
    for (const object of page.objects) {
      if (object.type === 'stroke') total += object.xs.length;
    }
  }
  return total;
}

export function inkBoundsOf(page: Page): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let bounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const object of page.objects) {
    if (object.type !== 'stroke') continue;
    for (let i = 0; i < object.xs.length; i++) {
      const x = object.xs[i]! / QUANT;
      const y = object.ys[i]! / QUANT;
      if (!bounds) bounds = { minX: x, minY: y, maxX: x, maxY: y };
      else {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
    void objectBounds(object);
  }
  return bounds;
}
