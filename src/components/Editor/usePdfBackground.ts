/**
 * Supplies rasterized PDF page bitmaps to the page canvases.
 *
 * Pages are rasterized lazily: a canvas only asks for the page it is about to paint, at the
 * resolution the current zoom needs, and the result is cached (LRU) so panning back and forth
 * does not re-render. pdf.js is imported dynamically, which keeps the ~1 MB library out of the
 * initial bundle until someone actually opens a PDF-backed notebook.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PageLayout } from '@/render/viewport';
import { assetBytesProvider } from '@/render/pdfTextCache';
import { useEditor } from '@/state/editorStore';

export interface PdfBackgroundState {
  getBackgroundBitmap(assetId: string | null, pdfPage: number): CanvasImageSource | null;
  requestBackground(layoutIndex: number, scale: number): void;
}

export interface PdfBackgroundOptions {
  layouts: PageLayout[];
  zoom: number;
  version: number;
}

/** Cached page bitmaps (each can be several MB, so the set is small and evicted LRU-style). */
const MAX_BITMAPS = 12;
/** Largest single page render (~16 MP ≈ 64 MB of RGBA) — protects memory on huge zooms. */
const MAX_PIXELS = 16_000_000;
/** A cached bitmap is reused while it is at least this fraction of the requested scale. */
const SCALE_TOLERANCE = 0.75;

interface BitmapEntry {
  bitmap: CanvasImageSource;
  scale: number;
  lastUsed: number;
}

interface PendingEntry {
  scale: number;
  promise: Promise<void>;
  cancel(): void;
}

const bitmaps = new Map<string, BitmapEntry>();
const pending = new Map<string, PendingEntry>();

function keyOf(assetId: string, pdfPage: number): string {
  return `${assetId}:${pdfPage}`;
}

export function cachedPdfBackground(assetId: string, pdfPage: number): CanvasImageSource | null {
  const entry = bitmaps.get(keyOf(assetId, pdfPage));
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return entry.bitmap;
}

function clampScale(scale: number, width: number, height: number): number {
  const wanted = Math.max(0.5, Math.min(4, scale));
  const area = Math.max(1, width * height);
  return Math.min(wanted, Math.sqrt(MAX_PIXELS / area));
}

function evictBitmaps(): void {
  if (bitmaps.size <= MAX_BITMAPS) return;
  const entries = [...bitmaps.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key] of entries.slice(0, bitmaps.size - MAX_BITMAPS)) bitmaps.delete(key);
}

/**
 * Renders (or reuses) a PDF page bitmap. `onReady` fires once a new bitmap is available so the
 * caller can repaint.
 */
export function requestPdfBackground(
  assetId: string,
  pdfPage: number,
  pageWidth: number,
  pageHeight: number,
  scale: number,
  onReady: () => void,
): Promise<void> {
  const key = keyOf(assetId, pdfPage);
  const wanted = clampScale(scale, pageWidth, pageHeight);

  const existing = bitmaps.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    if (existing.scale >= wanted * SCALE_TOLERANCE) return Promise.resolve();
  }

  const inFlight = pending.get(key);
  // Reuse an in-flight render unless it is clearly too coarse for the new zoom.
  if (inFlight && inFlight.scale >= wanted * SCALE_TOLERANCE) return inFlight.promise;
  if (inFlight) inFlight.cancel();

  let cancelRender: (() => void) | null = null;
  let cancelled = false;

  const promise = (async () => {
    const engine = await import('@/render/pdfEngine');
    const entry = await engine.acquirePdf(assetId, () => assetBytesProvider(assetId));
    if (cancelled || !entry) return;
    const handle = engine.renderPdfPage(entry.document, pdfPage + 1, { scale: wanted });
    cancelRender = () => handle.cancel();
    try {
      const { bitmap } = await handle.promise;
      if (cancelled) return;
      bitmaps.set(key, { bitmap, scale: wanted, lastUsed: Date.now() });
      evictBitmaps();
      onReady();
    } catch (error) {
      if (!(error instanceof engine.PdfRenderCancelled)) {
        // A broken page must not break the notebook: the placeholder stays visible.
        console.warn('InkPad: could not render PDF page', pdfPage + 1, error);
      }
    }
  })();

  const tracked: PendingEntry = {
    scale: wanted,
    promise,
    cancel() {
      cancelled = true;
      cancelRender?.();
    },
  };
  pending.set(key, tracked);
  return promise.finally(() => {
    if (pending.get(key) === tracked) pending.delete(key);
  });
}

/** Cancels in-flight renders and drops every cached bitmap (used when the editor closes). */
export function clearPdfBackgrounds(): void {
  for (const entry of pending.values()) entry.cancel();
  pending.clear();
  bitmaps.clear();
}

export function usePdfBackground({ layouts }: PdfBackgroundOptions): PdfBackgroundState {
  const layoutsRef = useRef(layouts);
  useEffect(() => {
    layoutsRef.current = layouts;
  }, [layouts]);

  // Free page bitmaps when the editor unmounts; pdf.js documents are cached separately.
  useEffect(() => clearPdfBackgrounds, []);

  const getBackgroundBitmap = useCallback((assetId: string | null, pdfPage: number) => {
    if (!assetId) return null;
    return cachedPdfBackground(assetId, pdfPage);
  }, []);

  const requestBackground = useCallback((layoutIndex: number, scale: number) => {
    const layout = layoutsRef.current.find((entry) => entry.index === layoutIndex);
    if (!layout) return;
    const store = useEditor.getState();
    const page = store.doc?.pages[layoutIndex]?.data;
    if (!page || page.background.kind !== 'pdf') return;
    const { assetId, pdfPage } = page.background;
    // Repaint through the document generation counter once the bitmap exists.
    void requestPdfBackground(assetId, pdfPage, page.width, page.height, scale, () => {
      const current = useEditor.getState();
      useEditor.setState({ version: current.version + 1 });
    });
  }, []);

  return { getBackgroundBitmap, requestBackground };
}
