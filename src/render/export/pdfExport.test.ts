/**
 * PDF export tests: page count, metadata, and — most importantly — that ink is written as
 * vector paths (perfect-freehand outlines become PDF bezier operators) rather than a raster
 * screenshot, and that PDF-backed pages keep their original text and vectors.
 *
 * The exported bytes are re-opened with pdf-lib and its own stream decoder, so every assertion
 * is about the operators that really ended up inside the PDF.
 */

import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
  rgb,
  type PDFPage,
} from 'pdf-lib';
import { exportDocumentToPdf, exportNotebookPdf, inkBoundsOf, parseHex } from './pdfExport';
import { strokeOutline } from '@/core/stroke';
import { makeDoc, makeLine } from '@/core/testUtils';
import type { TextBox } from '@/core/model';

/** Most tests do not exercise embedded assets. */
const noAssets = async () => null;

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/** Decoded content stream(s) of one exported page, in PDF operator syntax. */
function contentsOf(parsed: PDFDocument, page: PDFPage): string {
  const entry = parsed.context.lookup(page.node.get(PDFName.of('Contents')));
  const refs = entry instanceof PDFArray ? entry.asArray() : [entry];
  return refs
    .map((ref) => {
      const stream = parsed.context.lookup(ref);
      if (stream instanceof PDFRawStream) return latin1(decodePDFRawStream(stream).decode());
      return '';
    })
    .join('\n');
}

/** Every indirect object plus every decoded stream, as text (for resource-level assertions). */
function objectDump(parsed: PDFDocument): string {
  let text = '';
  for (const [, object] of parsed.context.enumerateIndirectObjects()) {
    text += `${String(object)}\n`;
    if (object instanceof PDFRawStream) {
      try {
        text += `${latin1(decodePDFRawStream(object).decode())}\n`;
      } catch {
        // Streams that are not Flate/ASCII (e.g. embedded fonts) are irrelevant here.
      }
    }
  }
  return text;
}

/**
 * Text as a reader would see it: pdf-lib writes `Tj` operands as hex strings, which are UTF-16BE
 * (with a BOM) when the font cannot encode the characters as Latin-1.
 */
function visibleText(content: string): string {
  const fromHex = content.replace(/<([0-9A-Fa-f\s]+)>/g, (_all, hex: string) => {
    const clean = hex.replace(/\s+/g, '');
    if (clean.length === 0 || clean.length % 2 !== 0) return '';
    const bytes = Buffer.from(clean, 'hex');
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
    }
    return bytes.toString('latin1');
  });
  return fromHex.replace(/\((?:\\\\.|[^\\()])*\)/g, (match) =>
    match.slice(1, -1).replace(/\\(.)/g, '$1'),
  );
}

function numbersIn(content: string): number[] {
  return (content.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

function colorTriples(content: string): Array<[number, number, number]> {
  const found: Array<[number, number, number]> = [];
  const pattern = /(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (?:rg|RG)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    found.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  return found;
}

/** True when the stream contains `op` as a standalone operator line. */
function hasOperator(content: string, op: string): boolean {
  // Operators are one per line (pdf-lib separates them with \n); trim() drops any \r.
  return content.split('\n').some((line) => line.trim() === op);
}

/** Ink path segments (move/line) on a page — one per outline point. */
function inkSegments(content: string): number {
  return (content.match(/ (?:m|l|c)[\r\n]/g) ?? []).length;
}

async function exportAndParse(
  doc: Parameters<typeof exportDocumentToPdf>[0],
  options: Parameters<typeof exportDocumentToPdf>[1] = {},
  provider: Parameters<typeof exportDocumentToPdf>[2] = noAssets,
) {
  const bytes = await exportDocumentToPdf(doc, options, provider);
  const parsed = await PDFDocument.load(bytes);
  return {
    bytes,
    parsed,
    pages: parsed.getPages().map((page) => contentsOf(parsed, page)),
  };
}

describe('PDF export', () => {
  it('writes one PDF page per notebook page, sized in document units', async () => {
    const doc = makeDoc(3);
    const { parsed } = await exportAndParse(doc);
    expect(parsed.getPageCount()).toBe(3);
    expect(parsed.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
    expect(parsed.getPage(2).getSize()).toEqual({ width: 600, height: 800 });
    // pdf-lib controls the Producer string; the creator and title are ours.
    expect(parsed.getCreator()).toBe('InkPad — handwritten notes');
    expect(parsed.getTitle()).toBe('Test notebook');
  });

  it('honours a page filter and reports progress', async () => {
    const doc = makeDoc(4);
    const progress: Array<[number, number]> = [];
    const { parsed } = await exportAndParse(doc, {
      pages: [1, 3],
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(parsed.getPageCount()).toBe(2);
  });

  it('exports ink as vector paths, never as a raster image', async () => {
    const doc = makeDoc(1);
    doc.pages[0]!.data.objects.push(makeLine(40, 260, 120, 4));
    const { pages, parsed } = await exportAndParse(doc);
    const content = pages[0]!;
    // perfect-freehand outlines are filled move/line paths, exactly like a brush stroke.
    expect(inkSegments(content)).toBeGreaterThan(10);
    expect(hasOperator(content, 'h')).toBe(true);
    expect(hasOperator(content, 'f')).toBe(true);
    expect(objectDump(parsed)).not.toContain('/Subtype /Image');
  });

  it('keeps the stroke colour and geometry of the ink', async () => {
    const doc = makeDoc(1);
    const page = doc.pages[0]!.data;
    const stroke = makeLine(40, 260, 120, 4);
    page.objects.push(stroke);
    const { pages } = await exportAndParse(doc);
    const content = pages[0]!;

    const expected = parseHex(stroke.color);
    expect(expected).not.toBeNull();
    const colorMatch = colorTriples(content).some(
      ([r, g, b]) =>
        Math.abs(r - expected!.red) < 0.005 &&
        Math.abs(g - expected!.green) < 0.005 &&
        Math.abs(b - expected!.blue) < 0.005,
    );
    expect(colorMatch).toBe(true);

    // Geometry: ink is drawn from the page's bottom-left origin (PDF y-up), so the outline's
    // document-space bounds appear in the stream mirrored around the page height.
    const outline = strokeOutline(stroke, true);
    const xs = outline.map((point) => point[0]!);
    const ys = outline.map((point) => point[1]!);
    const numbers = numbersIn(content);
    const hasNear = (target: number) => numbers.some((value) => Math.abs(value - target) < 2);
    expect(hasNear(Math.min(...xs))).toBe(true);
    expect(hasNear(Math.max(...xs))).toBe(true);
    // Path coordinates are document-space (y down); the page flip lives in the stream's CTM.
    expect(hasNear(Math.max(...ys))).toBe(true);
    expect(hasNear(Math.min(...ys))).toBe(true);

    // …and that really is where the stroke sits on the page (document units, y down).
    const bounds = inkBoundsOf(page);
    expect(bounds).not.toBeNull();
    expect(bounds!.minX).toBeGreaterThan(30);
    expect(bounds!.maxX).toBeLessThan(275);
  });

  it('marks highlighter strokes with a multiply blend mode', async () => {
    const doc = makeDoc(1);
    doc.pages[0]!.data.objects.push(makeLine(40, 260, 120, 14, 'highlighter'));
    const { parsed, pages } = await exportAndParse(doc);
    expect(objectDump(parsed)).toContain('Multiply');
    expect(inkSegments(pages[0]!)).toBeGreaterThan(5);
  });

  it('only writes ink operators on the pages that have ink', async () => {
    const doc = makeDoc(3);
    doc.pages[1]!.data.objects.push(makeLine(40, 260, 120, 4));
    const { pages } = await exportAndParse(doc);
    expect(pages).toHaveLength(3);
    // A blank page contains only the paper rectangle: four path segments and nothing else.
    const blank = inkSegments(pages[0]!);
    expect(blank).toBeLessThanOrEqual(5);
    expect(inkSegments(pages[2]!)).toBe(blank);
    expect(inkSegments(pages[1]!)).toBeGreaterThan(blank + 20);
  });

  it('exports text boxes as selectable text', async () => {
    const doc = makeDoc(1);
    const text: TextBox = {
      type: 'text',
      id: 't1',
      x: 40,
      y: 60,
      w: 320,
      h: 80,
      rotation: 0,
      text: 'Hello ink',
      fontFamily: 'Helvetica',
      fontSize: 18,
      color: '#111827',
      align: 'left',
    };
    doc.pages[0]!.data.objects.push(text);
    const { pages } = await exportAndParse(doc);
    expect(visibleText(pages[0]!)).toContain('Hello ink');
  });

  it('copies PDF-backed pages from the source document, keeping their vectors', async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([612, 792]);
    sourcePage.drawText('SOURCE PAGE', {
      x: 50,
      y: 700,
      size: 20,
      font: await source.embedFont(StandardFonts.Helvetica),
    });
    sourcePage.drawRectangle({ x: 40, y: 40, width: 200, height: 120, color: rgb(0.2, 0.4, 0.8) });
    const sourceBytes = await source.save();

    const doc = makeDoc(1);
    const page = doc.pages[0]!.data;
    page.background = { kind: 'pdf', assetId: 'asset-1', pdfPage: 0 };
    page.width = 612;
    page.height = 792;
    // Ink on top of the imported page must land on the same page.
    page.objects.push(makeLine(40, 260, 120, 4));

    const { parsed, pages } = await exportAndParse(doc, {}, async (assetId) =>
      assetId === 'asset-1' ? sourceBytes : null,
    );
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    // The source page's own text and vectors are still there, plus the ink drawn on top of it.
    expect(visibleText(pages[0]!)).toContain('SOURCE PAGE');
    expect(objectDump(parsed)).toContain('/Helvetica');
    expect(inkSegments(pages[0]!)).toBeGreaterThan(10);
  });

  it('falls back to a blank page when a PDF asset is missing', async () => {
    const doc = makeDoc(1);
    doc.pages[0]!.data.background = { kind: 'pdf', assetId: 'gone', pdfPage: 0 };
    const bytes = await exportNotebookPdf(doc);
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBe(1);
    expect(parsed.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
  });

  it('never produces an unreadable file for an empty notebook', async () => {
    const doc = makeDoc(0);
    const { parsed } = await exportAndParse(doc);
    expect(parsed.getPageCount()).toBe(1);
  });
});
