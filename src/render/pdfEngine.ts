/**
 * pdf.js facade. Keeps pdf.js imports in one place so the rest of the app never has to think
 * about worker setup, caching, cancellation or the version-specific API surface.
 *
 * Documents are cached per asset id (a 300-page PDF is parsed once); renders are cancellable
 * and rasterize into OffscreenCanvas-backed ImageBitmaps when the browser supports it.
 */

import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let workerConfigured = false;

export function configurePdfWorker(): void {
  if (workerConfigured) return;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  workerConfigured = true;
}

export interface PdfRenderOptions {
  scale: number;
  /** Optional existing canvas to draw into (OffscreenCanvas or HTMLCanvasElement). */
  canvas?: OffscreenCanvas | HTMLCanvasElement;
  rotation?: number;
  /** Renders only this region of the page (page units) — used by tiled rendering. */
  viewportBox?: { x: number; y: number; width: number; height: number };
}

export interface PdfRenderResult {
  /** OffscreenCanvas or HTMLCanvasElement containing the rendered page. */
  canvas: OffscreenCanvas | HTMLCanvasElement;
  width: number;
  height: number;
  /** Page size in pdf.js user units at scale 1. */
  pageWidth: number;
  pageHeight: number;
  scale: number;
}

export class PdfRenderCancelled extends Error {
  constructor() {
    super('PDF render cancelled');
    this.name = 'PdfRenderCancelled';
  }
}

export function supportsOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/* ------------------------------------------------------------------ */
/* Document handling                                                   */
/* ------------------------------------------------------------------ */

const loadingTasks = new WeakMap<PDFDocumentProxy, PDFDocumentLoadingTask>();

export async function pdfFromBytes(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  configurePdfWorker();
  // pdf.js detaches the buffer it is given, so hand it a private copy.
  const data = bytes.slice();
  const task = pdfjs.getDocument({ data });
  const document = await task.promise;
  loadingTasks.set(document, task);
  return document;
}

/** Destroys the worker/document pair backing `document` (v6 only exposes destroy on the task). */
export async function destroyPdf(document: PDFDocumentProxy): Promise<void> {
  const task = loadingTasks.get(document);
  loadingTasks.delete(document);
  await task?.destroy().catch(() => undefined);
}

export interface CachedPdf {
  assetId: string;
  document: PDFDocumentProxy;
  pageCount: number;
  lastUsed: number;
}

const documentCache = new Map<string, CachedPdf>();
const inFlight = new Map<string, Promise<CachedPdf>>();
const MAX_CACHED_DOCUMENTS = 4;

export function cachedPdf(assetId: string): CachedPdf | undefined {
  const entry = documentCache.get(assetId);
  if (entry) entry.lastUsed = Date.now();
  return entry;
}

/**
 * Loads (or reuses) a PDF for an asset. `loader` supplies the bytes; callers pass the
 * repository lookup so this module stays free of storage concerns.
 */
export async function acquirePdf(assetId: string, loader: () => Promise<Uint8Array | null>): Promise<CachedPdf | null> {
  const cached = documentCache.get(assetId);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached;
  }
  const pending = inFlight.get(assetId);
  if (pending) return pending;

  const task = (async () => {
    const bytes = await loader();
    if (!bytes) throw new Error(`PDF asset ${assetId} is missing`);
    const document = await pdfFromBytes(bytes);
    const entry: CachedPdf = { assetId, document, pageCount: document.numPages, lastUsed: Date.now() };
    documentCache.set(assetId, entry);
    await evictDocuments();
    return entry;
  })();
  inFlight.set(assetId, task);
  try {
    return await task;
  } finally {
    inFlight.delete(assetId);
  }
}

async function evictDocuments(): Promise<void> {
  if (documentCache.size <= MAX_CACHED_DOCUMENTS) return;
  const entries = [...documentCache.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  for (const entry of entries.slice(0, documentCache.size - MAX_CACHED_DOCUMENTS)) {
    documentCache.delete(entry.assetId);
    // Destroys the loading task, freeing the worker's memory for this document.
    await destroyPdf(entry.document);
  }
}

export function releasePdf(assetId: string): void {
  const entry = documentCache.get(assetId);
  if (!entry) return;
  documentCache.delete(assetId);
  void destroyPdf(entry.document);
}

export function releaseAllPdfs(): void {
  for (const entry of documentCache.values()) void destroyPdf(entry.document);
  documentCache.clear();
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

export async function getPdfPage(document: PDFDocumentProxy, pageNumber: number): Promise<PDFPageProxy> {
  return document.getPage(pageNumber);
}

export async function getPdfPageSize(
  document: PDFDocumentProxy,
  pageNumber: number,
): Promise<{ width: number; height: number }> {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}

export interface PdfPageBitmap {
  bitmap: ImageBitmap | OffscreenCanvas | HTMLCanvasElement;
  width: number;
  height: number;
}

export interface PdfRenderHandle {
  promise: Promise<PdfPageBitmap>;
  cancel(): void;
}

/**
 * Starts rendering a page. The returned handle can be cancelled (page scrolled away, zoom
 * changed) — cancellation rejects with `PdfRenderCancelled` and frees the partial surface.
 */
export function renderPdfPage(
  document: PDFDocumentProxy,
  pageNumber: number,
  options: PdfRenderOptions,
): PdfRenderHandle {
  let task: RenderTask | null = null;
  let cancelled = false;

  const promise = (async (): Promise<PdfPageBitmap> => {
    const page = await document.getPage(pageNumber);
    if (cancelled) throw new PdfRenderCancelled();
    const viewport = page.getViewport({ scale: options.scale, rotation: options.rotation });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas =
      options.canvas ??
      (supportsOffscreenCanvas()
        ? new OffscreenCanvas(width, height)
        : (() => {
            const element = document_().createElement('canvas');
            element.width = width;
            element.height = height;
            return element;
          })());

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('No 2D context available for PDF rendering');

    // pdf.js v6 types only accept a DOM 2D context; OffscreenCanvas contexts are compatible at
    // runtime, so the cast is safe (and the canvas branch above guarantees one exists).
    task = page.render({
      canvas: canvas as HTMLCanvasElement,
      canvasContext: context as CanvasRenderingContext2D,
      viewport,
      intent: 'display',
    });
    try {
      await task.promise;
    } catch (error) {
      if (cancelled) throw new PdfRenderCancelled();
      throw error;
    }
    if (cancelled) throw new PdfRenderCancelled();

    if (typeof createImageBitmap === 'function' && !options.canvas) {
      try {
        const bitmap = await createImageBitmap(canvas as unknown as ImageBitmapSource);
        return { bitmap, width, height };
      } catch {
        // Fall back to the canvas itself when createImageBitmap is unavailable/large.
      }
    }
    return { bitmap: canvas, width, height };
  })();

  return {
    promise,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}

function document_(): Document {
  if (typeof document === 'undefined') throw new Error('No DOM available for canvas creation');
  return document;
}

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
}

export interface PdfTextContent {
  items: PdfTextItem[];
  text: string;
}

/** Extracts positioned text (used for search and the selection layer). */
export async function getPdfTextContent(document: PDFDocumentProxy, pageNumber: number): Promise<PdfTextContent> {
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  let text = '';
  for (const raw of content.items) {
    const item = raw as { str?: string; transform?: number[]; width?: number; height?: number; fontName?: string };
    if (typeof item.str !== 'string') continue;
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0];
    const x = transform[4] ?? 0;
    const y = transform[5] ?? 0;
    items.push({ str: item.str, x, y, width: item.width ?? 0, height: item.height ?? 10, fontName: item.fontName });
    text += item.str;
    if (item.str.endsWith(' ') || text.length > 0) text += ' ';
  }
  return { items, text: text.trim() };
}

export interface PdfOutlineEntry {
  title: string;
  pageNumber: number | null;
  depth: number;
}

/** Flattens the PDF outline into (title, pageNumber) pairs. */
export async function getPdfOutline(document: PDFDocumentProxy): Promise<PdfOutlineEntry[]> {
  const entries: PdfOutlineEntry[] = [];
  let raw;
  try {
    raw = await document.getOutline();
  } catch {
    return entries;
  }
  if (!raw) return entries;

  const walk = async (items: typeof raw, depth: number): Promise<void> => {
    for (const item of items ?? []) {
      let pageNumber: number | null = null;
      try {
        const destination = typeof item.dest === 'string' ? await document.getDestination(item.dest) : item.dest;
        if (Array.isArray(destination) && destination[0]) {
          const index = await document.getPageIndex(destination[0] as never);
          pageNumber = index + 1;
        }
      } catch {
        pageNumber = null;
      }
      entries.push({ title: item.title || 'Untitled', pageNumber, depth });
      if (item.items?.length) await walk(item.items, depth + 1);
    }
  };
  await walk(raw, 0);
  return entries;
}

export type { PDFDocumentProxy, PDFPageProxy };
