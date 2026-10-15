/**
 * View transform maths: page layout inside the scroll container, screen ↔ page coordinate
 * conversion, virtualization helpers and zoom fitting. Pure functions (no DOM reads — callers
 * pass the measurements in), so they can be unit tested.
 */

import type { Page } from '@/core/model';
import type { Vec2 } from '@/core/geometry';

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 5;
/** Vertical gap between pages at zoom 1, in page units. */
export const PAGE_GAP = 24;
/** Extra pages kept mounted above/below the viewport. */
export const VIRTUAL_BUFFER_PAGES = 1;

export interface ViewTransform {
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  /** Client-rect origin of the scroll container. */
  originX: number;
  originY: number;
  pages: PageLayout[];
}

export interface PageLayout {
  pageId: string;
  index: number;
  /** Content-space position and size (px at the current zoom). */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: Page['rotation'];
}

export interface LayoutOptions {
  zoom: number;
  viewMode: 'vertical' | 'single';
  /** Width of the scroll container (px) — used to centre pages. */
  viewportWidth: number;
  /** Height of the scroll container (px) — single-page mode centres vertically. */
  viewportHeight?: number;
  gap?: number;
  /** Single-page mode: only lay out this page index. */
  singleIndex?: number;
  /** Vertical offset of the first page (leaves room for the toolbar, px). */
  paddingTop?: number;
}

/** Rendered size of a page (rotation-aware) at a zoom level, in px. */
export function pageSizeAtZoom(page: Pick<Page, 'width' | 'height' | 'rotation'>, zoom: number): { width: number; height: number } {
  const rotated = page.rotation === 90 || page.rotation === 270;
  return {
    width: Math.round((rotated ? page.height : page.width) * zoom),
    height: Math.round((rotated ? page.width : page.height) * zoom),
  };
}

export function computePageLayouts(pages: readonly Page[], options: LayoutOptions): PageLayout[] {
  const gap = (options.gap ?? PAGE_GAP) * options.zoom;
  const paddingTop = options.paddingTop ?? 24;
  const layouts: PageLayout[] = [];
  if (options.viewMode === 'single' && options.singleIndex !== undefined) {
    const page = pages[options.singleIndex];
    if (!page) return [];
    const size = pageSizeAtZoom(page, options.zoom);
    const x = Math.max(0, Math.round((options.viewportWidth - size.width) / 2));
    const availableHeight = options.viewportHeight ?? size.height;
    const y = Math.max(paddingTop, Math.round((availableHeight - size.height) / 2));
    layouts.push({ pageId: page.id, index: options.singleIndex, x, y, width: size.width, height: size.height, rotation: page.rotation });
    return layouts;
  }

  let y = paddingTop;
  pages.forEach((page, index) => {
    const size = pageSizeAtZoom(page, options.zoom);
    const x = Math.max(0, Math.round((options.viewportWidth - size.width) / 2));
    layouts.push({ pageId: page.id, index, x, y, width: size.width, height: size.height, rotation: page.rotation });
    y += size.height + gap;
  });
  return layouts;
}

export function contentSize(layouts: readonly PageLayout[]): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const layout of layouts) {
    width = Math.max(width, layout.x + layout.width);
    height = Math.max(height, layout.y + layout.height);
  }
  return { width, height };
}

/** Which pages to mount for the current scroll position (viewport ± buffer pages). */
export function visiblePageLayouts(
  layouts: readonly PageLayout[],
  scrollTop: number,
  viewportHeight: number,
  buffer = VIRTUAL_BUFFER_PAGES,
): PageLayout[] {
  if (layouts.length === 0) return [];
  const top = scrollTop;
  const bottom = scrollTop + viewportHeight;
  const visible = layouts.filter((layout) => layout.y + layout.height >= top && layout.y <= bottom);
  if (visible.length === 0) {
    // Between pages or scrolled past the end: keep the nearest page mounted.
    const nearest = layouts.reduce((best, layout) =>
      Math.abs(layout.y - scrollTop) < Math.abs(best.y - scrollTop) ? layout : best,
    );
    return [nearest];
  }
  const firstIndex = Math.max(0, visible[0]!.index - buffer);
  const lastIndex = Math.min(layouts.length - 1, visible[visible.length - 1]!.index + buffer);
  return layouts.slice(firstIndex, lastIndex + 1);
}

/** Content-space point → page-local document units. */
export function contentToPage(layout: PageLayout, contentX: number, contentY: number, zoom: number): Vec2 {
  return { x: (contentX - layout.x) / zoom, y: (contentY - layout.y) / zoom };
}

export function contentToClient(transform: ViewTransform, contentX: number, contentY: number): Vec2 {
  return {
    x: contentX - transform.scrollLeft + transform.originX,
    y: contentY - transform.scrollTop + transform.originY,
  };
}

export function clientToContent(transform: ViewTransform, clientX: number, clientY: number): Vec2 {
  return {
    x: clientX - transform.originX + transform.scrollLeft,
    y: clientY - transform.originY + transform.scrollTop,
  };
}

/** Page whose layout contains the client point, or the nearest one (vertical mode). */
export function pageAtClient(transform: ViewTransform, clientX: number, clientY: number): { layout: PageLayout; point: Vec2 } | null {
  if (transform.pages.length === 0) return null;
  const content = clientToContent(transform, clientX, clientY);
  const inside = transform.pages.find(
    (layout) =>
      content.x >= layout.x &&
      content.x <= layout.x + layout.width &&
      content.y >= layout.y &&
      content.y <= layout.y + layout.height,
  );
  const layout = inside ?? nearestLayout(transform.pages, content);
  return { layout, point: contentToPage(layout, content.x, content.y, transform.zoom) };
}

export function clientToPage(transform: ViewTransform, clientX: number, clientY: number): Vec2 {
  const hit = pageAtClient(transform, clientX, clientY);
  return hit ? hit.point : { x: 0, y: 0 };
}

function nearestLayout(layouts: readonly PageLayout[], content: Vec2): PageLayout {
  let best = layouts[0]!;
  let bestDistance = Infinity;
  for (const layout of layouts) {
    const dx = Math.max(layout.x - content.x, 0, content.x - (layout.x + layout.width));
    const dy = Math.max(layout.y - content.y, 0, content.y - (layout.y + layout.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = layout;
    }
  }
  return best;
}

/** Zoom that makes a page fill `viewportWidth` with margins. */
export function fitZoom(page: Pick<Page, 'width' | 'height' | 'rotation'>, viewportWidth: number, viewportHeight: number, margin = 48, maxZoom = 2): number {
  const size = pageSizeAtZoom(page, 1);
  const zoom = Math.min(
    (viewportWidth - margin * 2) / size.width,
    (viewportHeight - margin * 2) / size.height,
  );
  return Math.max(MIN_ZOOM, Math.min(maxZoom, zoom));
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Scroll offsets that keep `anchor` (client px) over the same content point after zooming. */
export function scrollForZoomAnchor(
  previous: { zoom: number; scrollLeft: number; scrollTop: number },
  nextZoom: number,
  anchorClientX: number,
  anchorClientY: number,
  originX: number,
  originY: number,
  viewMode: 'vertical' | 'single' = 'vertical',
  anchorContentY = 0,
): { scrollLeft: number; scrollTop: number } {
  if (viewMode === 'single') {
    return { scrollLeft: previous.scrollLeft, scrollTop: previous.scrollTop };
  }
  const contentX = anchorClientX - originX + previous.scrollLeft;
  const contentY = anchorClientY - originY + previous.scrollTop;
  const ratio = nextZoom / previous.zoom;
  return {
    scrollLeft: Math.max(0, contentX * ratio - (anchorClientX - originX)),
    scrollTop: Math.max(0, contentY * ratio - (anchorClientY - originY - anchorContentY)),
  };
}

/** Sanity check used by tests: layouts must not overlap in vertical mode. */
export function layoutsAreOrdered(layouts: readonly PageLayout[]): boolean {
  for (let i = 1; i < layouts.length; i++) {
    if (layouts[i]!.y < layouts[i - 1]!.y) return false;
  }
  return true;
}
