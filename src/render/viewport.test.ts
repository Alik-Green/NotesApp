import { describe, expect, it } from 'vitest';
import type { Page, PageRotation } from '@/core/model';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  clientToContent,
  clientToPage,
  computePageLayouts,
  contentSize,
  contentToClient,
  contentToPage,
  fitZoom,
  layoutsAreOrdered,
  pageAtClient,
  pageSizeAtZoom,
  scrollForZoomAnchor,
  visiblePageLayouts,
  type PageLayout,
  type ViewTransform,
} from './viewport';

function makePage(id: string, width = 600, height = 800, rotation: PageRotation = 0): Page {
  return {
    id,
    notebookId: 'nb-1',
    index: 0,
    width,
    height,
    rotation,
    background: { kind: 'template', template: 'lined' },
    paperColor: '#ffffff',
    objects: [],
    updatedAt: 0,
  };
}

const pages = [makePage('p1'), makePage('p2'), makePage('p3'), makePage('p4')];

function layout(id: string, x: number, y: number, width = 600, height = 800): PageLayout {
  return { pageId: id, index: 0, x, y, width, height, rotation: 0 };
}

function transform(overrides: Partial<ViewTransform> = {}): ViewTransform {
  return { zoom: 1, scrollLeft: 0, scrollTop: 0, originX: 0, originY: 0, pages: [], ...overrides };
}

describe('pageSizeAtZoom', () => {
  it('scales the page and rounds to whole pixels', () => {
    expect(pageSizeAtZoom(makePage('p1'), 1)).toEqual({ width: 600, height: 800 });
    expect(pageSizeAtZoom(makePage('p1'), 0.5)).toEqual({ width: 300, height: 400 });
  });

  it('swaps width and height for quarter-turn rotations', () => {
    expect(pageSizeAtZoom(makePage('p1', 600, 800, 90), 1)).toEqual({ width: 800, height: 600 });
    expect(pageSizeAtZoom(makePage('p1', 600, 800, 270), 1)).toEqual({ width: 800, height: 600 });
    // 180° is not a swap.
    expect(pageSizeAtZoom(makePage('p1', 600, 800, 180), 1)).toEqual({ width: 600, height: 800 });
  });
});

describe('computePageLayouts', () => {
  it('stacks pages vertically, centred on the viewport width', () => {
    const layouts = computePageLayouts(pages.slice(0, 2), {
      zoom: 1,
      viewMode: 'vertical',
      viewportWidth: 1000,
    });
    expect(layouts).toHaveLength(2);
    expect(layouts[0]).toMatchObject({ pageId: 'p1', index: 0, x: 200, y: 24, width: 600, height: 800 });
    expect(layouts[1]).toMatchObject({ pageId: 'p2', index: 1, x: 200, y: 848 });
    expect(layoutsAreOrdered(layouts)).toBe(true);
    expect(contentSize(layouts)).toEqual({ width: 800, height: 1648 });
  });

  it('scales the gap with zoom and clamps x when the page is wider than the viewport', () => {
    const layouts = computePageLayouts(pages.slice(0, 2), {
      zoom: 2,
      viewMode: 'vertical',
      viewportWidth: 1000,
    });
    // 600x800 at zoom 2 → 1200x1600 (wider than the 1000px viewport) and a 48px gap.
    expect(layouts[0]).toMatchObject({ x: 0, y: 24, width: 1200, height: 1600 });
    expect(layouts[1]!.y).toBe(24 + 1600 + 48);
  });

  it('honours an explicit gap and top padding', () => {
    const layouts = computePageLayouts(pages.slice(0, 2), {
      zoom: 1,
      viewMode: 'vertical',
      viewportWidth: 1000,
      gap: 10,
      paddingTop: 5,
    });
    expect(layouts[0]!.y).toBe(5);
    expect(layouts[1]!.y).toBe(5 + 800 + 10);
  });

  it('lays out a single centred page in single-page mode', () => {
    const layouts = computePageLayouts(pages, {
      zoom: 1,
      viewMode: 'single',
      viewportWidth: 1000,
      viewportHeight: 1000,
      singleIndex: 1,
    });
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ pageId: 'p2', index: 1, x: 200, y: 100 });
  });

  it('never pushes a tall page above the top padding in single-page mode', () => {
    const layouts = computePageLayouts(pages, {
      zoom: 1,
      viewMode: 'single',
      viewportWidth: 1000,
      viewportHeight: 700,
      singleIndex: 0,
    });
    // (700 - 800) / 2 = -50 → clamped to the default paddingTop.
    expect(layouts[0]!.y).toBe(24);
  });

  it('returns nothing for an out-of-range single index and falls back to vertical mode without one', () => {
    expect(
      computePageLayouts(pages, { zoom: 1, viewMode: 'single', viewportWidth: 1000, singleIndex: 99 }),
    ).toEqual([]);
    expect(computePageLayouts(pages.slice(0, 3), { zoom: 1, viewMode: 'single', viewportWidth: 1000 })).toHaveLength(3);
  });
});

describe('visiblePageLayouts', () => {
  const layouts = computePageLayouts(pages, { zoom: 1, viewMode: 'vertical', viewportWidth: 1000 });

  it('keeps one buffer page mounted above and below the viewport', () => {
    const visible = visiblePageLayouts(layouts, 0, 800);
    expect(visible.map((entry) => entry.pageId)).toEqual(['p1', 'p2']);
  });

  it('widens the window in the middle of the document', () => {
    const visible = visiblePageLayouts(layouts, 900, 800);
    expect(visible.map((entry) => entry.pageId)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('respects an explicit buffer of zero', () => {
    const visible = visiblePageLayouts(layouts, 0, 800, 0);
    expect(visible.map((entry) => entry.pageId)).toEqual(['p1']);
  });

  it('keeps the nearest page mounted when scrolled between pages', () => {
    const visible = visiblePageLayouts(layouts, 830, 10);
    expect(visible.map((entry) => entry.pageId)).toEqual(['p2']);
  });

  it('handles an empty document', () => {
    expect(visiblePageLayouts([], 0, 800)).toEqual([]);
  });
});

describe('coordinate conversion', () => {
  it('maps content space to page units through the layout offset and zoom', () => {
    const point = contentToPage(layout('p1', 200, 24), 350, 174, 1.5);
    expect(point).toEqual({ x: 100, y: 100 });
  });

  it('round-trips content and client space', () => {
    const view = transform({ scrollLeft: 100, scrollTop: 50, originX: 20, originY: 10 });
    expect(contentToClient(view, 200, 100)).toEqual({ x: 120, y: 60 });
    expect(clientToContent(view, 120, 60)).toEqual({ x: 200, y: 100 });
  });

  it('finds the page under the pointer and returns page-local units', () => {
    const view = transform({ pages: [layout('p1', 200, 24), layout('p2', 200, 848)] });
    const hit = pageAtClient(view, 300, 100);
    expect(hit?.layout.pageId).toBe('p1');
    expect(hit?.point).toEqual({ x: 100, y: 76 });
  });

  it('snaps to the nearest page when the pointer is outside every page', () => {
    const view = transform({ pages: [layout('p1', 200, 24), layout('p2', 200, 848)] });
    const hit = pageAtClient(view, 10, 900);
    expect(hit?.layout.pageId).toBe('p2');
    expect(hit?.point).toEqual({ x: -190, y: 52 });
  });

  it('accounts for zoom when converting pointer positions', () => {
    const view = transform({ zoom: 2, pages: [layout('p1', 200, 24, 1200, 1600)] });
    expect(pageAtClient(view, 300, 100)?.point).toEqual({ x: 50, y: 38 });
  });

  it('returns null / the origin when there are no pages', () => {
    const view = transform();
    expect(pageAtClient(view, 10, 10)).toBeNull();
    expect(clientToPage(view, 10, 10)).toEqual({ x: 0, y: 0 });
  });
});

describe('zoom helpers', () => {
  it('fits a page inside the viewport using the tighter axis', () => {
    // min((1000 - 96) / 600, (900 - 96) / 800)
    expect(fitZoom(makePage('p1'), 1000, 900)).toBeCloseTo((900 - 96) / 800, 6);
  });

  it('clamps the fit result to the zoom limits', () => {
    expect(fitZoom(makePage('p1'), 200, 200)).toBe(MIN_ZOOM);
    expect(fitZoom(makePage('p1'), 5000, 5000)).toBe(2);
    expect(fitZoom(makePage('p1'), 5000, 5000, 48, 3)).toBe(3);
  });

  it('clamps zoom to the allowed range', () => {
    expect(clampZoom(0.05)).toBe(MIN_ZOOM);
    expect(clampZoom(50)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it('keeps the content point under the pinch anchor fixed while zooming', () => {
    const next = scrollForZoomAnchor({ zoom: 1, scrollLeft: 0, scrollTop: 0 }, 2, 100, 100, 0, 0);
    expect(next).toEqual({ scrollLeft: 100, scrollTop: 100 });
    // The point under the anchor is unchanged: contentX * ratio - scrollLeft === clientX.
    expect(100 * 2 - next.scrollLeft).toBe(100);
  });

  it('never scrolls to a negative offset and ignores single-page mode', () => {
    expect(scrollForZoomAnchor({ zoom: 1, scrollLeft: 0, scrollTop: 0 }, 0.5, 100, 100, 0, 0)).toEqual({
      scrollLeft: 0,
      scrollTop: 0,
    });
    expect(
      scrollForZoomAnchor({ zoom: 1, scrollLeft: 42, scrollTop: 7 }, 2, 100, 100, 0, 0, 'single'),
    ).toEqual({ scrollLeft: 42, scrollTop: 7 });
  });

  it('keeps a page-relative anchor (e.g. the current page edge) stable', () => {
    const next = scrollForZoomAnchor({ zoom: 1, scrollLeft: 0, scrollTop: 500 }, 2, 0, 300, 0, 0, 'vertical', 200);
    // contentY (500 + 300) * 2 - (300 - 200) = 1500
    expect(next.scrollTop).toBe(1500);
  });
});

describe('layoutsAreOrdered', () => {
  it('detects out-of-order layouts', () => {
    expect(layoutsAreOrdered([layout('p1', 0, 24), layout('p2', 0, 848)])).toBe(true);
    expect(layoutsAreOrdered([layout('p2', 0, 848), layout('p1', 0, 24)])).toBe(false);
    expect(layoutsAreOrdered([])).toBe(true);
  });
});
