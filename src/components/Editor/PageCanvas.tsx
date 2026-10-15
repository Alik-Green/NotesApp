/**
 * One page's static layers (background + committed ink) inside the scrollable content.
 * Positioned in content space; the live/overlay layer is a single viewport-sized canvas
 * owned by the viewport, so this component only repaints when its page changes.
 */

import { useEffect, useRef } from 'react';
import type { Page } from '@/core/model';
import type { PageLayout } from '@/render/viewport';
import { PagePainter } from '@/render/pagePainter';
import type { ImageSource } from '@/render/strokeRenderer';

export interface PageCanvasProps {
  page: Page;
  layout: PageLayout;
  zoom: number;
  generation: number;
  images?: ReadonlyMap<string, ImageSource>;
  getBackgroundBitmap?: () => CanvasImageSource | null;
  onBackgroundNeeded?: (scale: number) => void;
}

export function PageCanvas({
  page,
  layout,
  zoom,
  generation,
  images,
  getBackgroundBitmap,
  onBackgroundNeeded,
}: PageCanvasProps) {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<PagePainter | null>(null);
  const callbacksRef = useRef({ getBackgroundBitmap, onBackgroundNeeded });
  // Kept in a ref so the painter always calls the latest callback without being re-created.
  useEffect(() => {
    callbacksRef.current = { getBackgroundBitmap, onBackgroundNeeded };
  });

  // Create the painter lazily once both canvases exist.
  useEffect(() => {
    if (!bgRef.current || !inkRef.current) return;
    const painter = new PagePainter(page, {
      backgroundCanvas: bgRef.current,
      inkCanvas: inkRef.current,
      getZoom: () => zoom,
      getImages: () => images,
      getBackgroundBitmap: () => callbacksRef.current.getBackgroundBitmap?.() ?? null,
      onBackgroundNeeded: (scale) => callbacksRef.current.onBackgroundNeeded?.(scale),
    });
    painterRef.current = painter;
    painter.resize(layout.width, layout.height, zoom);
    painter.drawAll(generation);
    return () => {
      painterRef.current = null;
    };
    // The painter is recreated when the page identity changes; other props are read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, page]);

  useEffect(() => {
    const painter = painterRef.current;
    if (!painter) return;
    painter.setPage(page);
    painter.resize(layout.width, layout.height, zoom);
    painter.drawAll(generation);
  }, [page, layout.width, layout.height, zoom, generation]);

  return (
    <div
      className="absolute origin-top-left overflow-hidden rounded-[2px] shadow-[0_1px_3px_rgba(15,23,42,0.18),0_12px_32px_rgba(15,23,42,0.12)]"
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        // Position in content space; the parent is the scrolling content element.
        willChange: 'transform',
      }}
      data-testid="page-canvas"
      data-page-id={page.id}
      data-page-index={layout.index}
    >
      <canvas ref={bgRef} className="absolute left-0 top-0" aria-hidden="true" />
      <canvas ref={inkRef} className="absolute left-0 top-0" aria-hidden="true" />
    </div>
  );
}
