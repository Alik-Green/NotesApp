/**
 * The scrolling canvas surface.
 *
 * Layers:
 *   content (scrollable) → per-page background + committed ink canvases (virtualized)
 *   overlay (viewport-sized, fixed) → live stroke, laser, lasso, selection, cursors
 *
 * Pointer input goes through `PointerRouter`; this component turns router callbacks into
 * document commands and keeps the view transform in sync with the scroll container.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { ID, Stroke, TemplateKind } from '@/core/model';
import { buildStroke, TOOL_DEFAULTS, type InputPoint } from '@/core/stroke';
import {
  insertObjectCommand,
  removeObjectsCommand,
  SplitStrokesCommand,
  type ObjectEntry,
} from '@/core/commands';
import { objectsInLasso, splitStrokeByEraser, strokesAt } from '@/core/hitTest';
import { objectBounds } from '@/core/model';
import type { Rect, Vec2 } from '@/core/geometry';
import { OverlayPainter } from '@/render/overlayPainter';
import {
  clampZoom,
  computePageLayouts,
  contentSize,
  fitZoom,
  scrollForZoomAnchor,
  visiblePageLayouts,
  type ViewTransform,
} from '@/render/viewport';
import { PointerRouter, type PointerKind } from '@/input/pointerRouter';
import { useEditor } from '@/state/editorStore';
import { useSettings } from '@/state/settings';
import { newId } from '@/core/ids';
import { useAssetImages } from '@/render/useAssetImages';
import { PageCanvas } from './PageCanvas';
import { usePdfBackground } from './usePdfBackground';

export interface PageViewportProps {
  /** Called with the page-space point when the pointer taps empty canvas. */
  onTapPoint?(point: Vec2, pageId: ID): void;
  /** Exposes a "scroll to page" implementation for the page nav. */
  onReady?(api: ViewportApi): void;
}

export interface ViewportApi {
  scrollToPage(index: number): void;
  fitWidth(): void;
  zoomToFit(): void;
  getViewportSize(): { width: number; height: number };
}

const WHEEL_ZOOM_STEP = 1.0015;

export function PageViewport({ onTapPoint, onReady }: PageViewportProps) {
  const doc = useEditor((state) => state.doc);
  const version = useEditor((state) => state.version);
  const zoom = useEditor((state) => state.zoom);
  const viewMode = useEditor((state) => state.viewMode);
  const tool = useEditor((state) => state.tool);
  const currentPageIndex = useEditor((state) => state.currentPageIndex);
  const scrollToPage = useEditor((state) => state.scrollToPage);
  const setZoom = useEditor((state) => state.setZoom);
  const setCurrentPage = useEditor((state) => state.setCurrentPage);
  const setSelection = useEditor((state) => state.setSelection);
  const selection = useEditor((state) => state.selection);

  const toolStyles = useSettings((state) => state.toolStyles);
  const eraserSize = useSettings((state) => state.eraserSize);
  const penOnly = useSettings((state) => state.penOnly);
  const twoFingerUndo = useSettings((state) => state.twoFingerUndo);
  const laserFadeMs = useSettings((state) => state.laserFadeMs);

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const painterRef = useRef<OverlayPainter | null>(null);
  const routerRef = useRef<PointerRouter | null>(null);
  const liveRef = useRef<{ pageId: ID | null; points: InputPoint[] } | null>(null);
  const eraserDragRef = useRef<{
    pageId: ID;
    erased: Set<ID>;
    fragments: Map<ID, Stroke[]>;
  } | null>(null);
  const stylusSeenRef = useRef(false);
  const [stylusSeen, setStylusSeen] = useState(false);
  const lassoRef = useRef<Vec2[]>([]);
  const dragPanRef = useRef<{ x: number; y: number } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [pointerKind, setPointerKind] = useState<PointerKind>('unknown');

  const pages = useMemo(() => {
    // The document is mutable; `version` is the cache key that invalidates this derivation.
    void version;
    return doc?.pages.map((page) => page.data) ?? [];
  }, [doc, version]);

  /* ---------------- layout ---------------- */

  const layouts = useMemo(
    () =>
      computePageLayouts(pages, {
        zoom,
        viewMode,
        viewportWidth: viewportSize.width || 800,
        viewportHeight: viewportSize.height || 600,
        singleIndex: currentPageIndex,
      }),
    // `version` keeps layout in sync with page add/remove/rotate/尺寸 changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pages, zoom, viewMode, viewportSize.width, viewportSize.height, currentPageIndex, version],
  );
  const content = useMemo(() => contentSize(layouts), [layouts]);
  const visibleLayouts = useMemo(
    () =>
      viewMode === 'single'
        ? layouts
        : visiblePageLayouts(layouts, scroll.top, viewportSize.height || 600),
    [layouts, scroll.top, viewportSize.height, viewMode],
  );

  const transformRef = useRef<ViewTransform>({
    zoom,
    scrollLeft: 0,
    scrollTop: 0,
    originX: 0,
    originY: 0,
    pages: layouts,
  });
  // Synced in an effect (never during render) so pointer handlers always see the live transform.
  useEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    transformRef.current = {
      zoom,
      scrollLeft: scroll.left,
      scrollTop: scroll.top,
      originX: rect?.left ?? 0,
      originY: rect?.top ?? 0,
      pages: layouts,
    };
  }, [zoom, scroll.left, scroll.top, layouts]);

  const activePageRef = useRef<{
    pageId: ID | null;
    origin: { x: number; y: number };
  }>({
    pageId: null,
    origin: { x: 0, y: 0 },
  });

  /* ---------------- overlay painter ---------------- */

  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) return;
    const painter = new OverlayPainter(canvas, {
      getZoom: () => transformRef.current.zoom,
      getViewportOffset: () => ({
        left: transformRef.current.scrollLeft,
        top: transformRef.current.scrollTop,
      }),
      getActivePageOrigin: () => activePageRef.current.origin,
      getDevicePixelRatio: () => window.devicePixelRatio || 1,
    });
    painter.setLaserFade(laserFadeMs);
    painterRef.current = painter;
    return () => {
      painterRef.current = null;
    };
  }, [laserFadeMs]);

  useEffect(() => {
    painterRef.current?.resize(viewportSize.width, viewportSize.height);
  }, [viewportSize.width, viewportSize.height]);

  // Selection boxes for the overlay.
  useEffect(() => {
    const painter = painterRef.current;
    const page = doc?.pages[currentPageIndex];
    if (!painter || !page) return;
    const boxes: Rect[] = selection
      .map((id) => page.get(id))
      .filter((object): object is NonNullable<typeof object> => Boolean(object))
      .map((object) => objectBounds(object));
    painter.setSelection(boxes);
    const layout = layouts.find((entry) => entry.pageId === page.id);
    activePageRef.current = {
      pageId: page.id,
      origin: { x: layout?.x ?? 0, y: layout?.y ?? 0 },
    };
  }, [selection, doc, currentPageIndex, layouts]);

  function layoutFor(pageId: ID) {
    return layouts.find((layout) => layout.pageId === pageId);
  }

  /* ---------------- PDF background (no-op unless the page has a PDF) ---------------- */

  const { getBackgroundBitmap, requestBackground } = usePdfBackground({
    layouts,
    zoom,
    version,
  });

  /* ---------------- image objects ---------------- */

  const visiblePageIds = useMemo(
    () => visibleLayouts.map((layout) => layout.pageId),
    [visibleLayouts],
  );
  const images = useAssetImages(pages, visiblePageIds);

  /* ---------------- viewport measurement + scrolling ---------------- */

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', measure);
    };
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onScroll = () => setScroll({ left: element.scrollLeft, top: element.scrollTop });
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToPageIndex = useCallback(
    (index: number) => {
      const element = containerRef.current;
      const layout = layouts.find((entry) => entry.index === index);
      if (!element || !layout) return;
      element.scrollTo({ top: Math.max(0, layout.y - 16), behavior: 'smooth' });
    },
    [layouts],
  );

  useEffect(() => {
    if (!scrollToPage) return;
    if (viewMode === 'single') {
      setCurrentPage(scrollToPage.index);
      return;
    }
    scrollToPageIndex(scrollToPage.index);
  }, [scrollToPage, viewMode, scrollToPageIndex, setCurrentPage]);

  const api = useMemo<ViewportApi>(
    () => ({
      scrollToPage: scrollToPageIndex,
      fitWidth: () => {
        const page = pages[currentPageIndex];
        if (!page) return;
        const size = viewportSize.width || 800;
        setZoom(fitZoom({ ...page, height: 1 }, size, viewportSize.height || 600, 32, 5));
      },
      zoomToFit: () => {
        const page = pages[currentPageIndex];
        if (!page) return;
        setZoom(fitZoom(page, viewportSize.width || 800, viewportSize.height || 600, 48, 3));
      },
      getViewportSize: () => viewportSize,
    }),
    [scrollToPageIndex, pages, currentPageIndex, viewportSize, setZoom],
  );

  useEffect(() => {
    onReady?.(api);
  }, [api, onReady]);

  /* ---------------- pointer routing ---------------- */

  const commitStroke = useCallback(
    (pageId: ID, points: readonly InputPoint[], strokeTool: string) => {
      const doc0 = useEditor.getState().doc;
      const page = doc0?.getPage(pageId);
      if (!page) return;
      const style = toolStyles[strokeTool as keyof typeof toolStyles] ?? TOOL_DEFAULTS.pen;
      const stroke = buildStroke(points, {
        id: newId('st'),
        tool: style.tool,
        color: style.color,
        size: style.size,
        opacity: style.opacity,
      });
      useEditor.getState().commit(insertObjectCommand(page, stroke, 'Draw'));
    },
    [toolStyles],
  );

  useEffect(() => {
    if (!overlayRef.current) return;
    const router = new PointerRouter({
      callbacks: {
        onLiveStroke(points, strokeTool) {
          const pageId = router.targetPageId ?? activePageRef.current.pageId;
          if (!pageId) return;
          liveRef.current = { pageId, points: [...points] };
          const style = toolStyles[strokeTool as keyof typeof toolStyles] ?? TOOL_DEFAULTS.pen;
          painterRef.current?.setLiveStroke(points, {
            color: style.color,
            size: style.size,
            opacity: style.opacity,
            tool: style.tool,
          });
        },
        onClearLive() {
          liveRef.current = null;
          painterRef.current?.clearLive();
        },
        onInkComplete(points, strokeTool) {
          const pageId = liveRef.current?.pageId ?? router.targetPageId;
          liveRef.current = null;
          if (!pageId) return;
          commitStroke(pageId, points, strokeTool);
        },
        onErase(a, b, phase) {
          const store = useEditor.getState();
          const pageId = router.targetPageId;
          const page = pageId ? store.doc?.getPage(pageId) : undefined;
          if (!page || !pageId) return;

          if (phase === 'start') {
            // One eraser drag = one undo step, however many strokes it removes.
            eraserDragRef.current = {
              pageId,
              erased: new Set<ID>(),
              fragments: new Map<ID, Stroke[]>(),
            };
            store.beginBatch('Erase');
            return;
          }

          const radius = eraserSize / 2;
          const drag = eraserDragRef.current;
          if (useEditor.getState().tool === 'eraser') {
            const hits = strokesAt(page, b, radius + 2);
            if (!drag) return;
            const ids = hits.map((stroke) => stroke.id).filter((id) => !drag.erased.has(id));
            if (ids.length === 0) return;
            for (const id of ids) drag.erased.add(id);
            const command = removeObjectsCommand(page, ids, 'Erase strokes');
            if (command) useEditor.getState().commit(command);
          } else {
            if (!drag) return;
            // Pixel eraser: split every stroke the segment crosses, keeping the fragments.
            for (const stroke of strokesAt(page, b, radius + 8)) {
              const current = drag.fragments.get(stroke.id) ?? [stroke];
              let changed = false;
              const next: Stroke[] = [];
              for (const fragment of current) {
                const parts = splitStrokeByEraser(fragment, a, b, radius);
                if (parts.length === 1 && parts[0]!.xs.length === fragment.xs.length) {
                  next.push(fragment);
                } else {
                  changed = true;
                  next.push(...parts);
                }
              }
              if (!changed) continue;
              const index = page.indexOf(stroke.id);
              if (index < 0) continue;
              const before: ObjectEntry[] = [{ object: stroke, index }];
              const after: ObjectEntry[] = next.map((part, offset) => ({
                object: part,
                index: index + offset,
              }));
              drag.fragments.set(stroke.id, next);
              useEditor
                .getState()
                .commit(new SplitStrokesCommand(pageId, before, after, 'Erase pixels'));
            }
          }

          if (phase === 'end') {
            eraserDragRef.current = null;
            useEditor.getState().endBatch();
          }
        },
        onLasso(polygon, phase) {
          const pageId = router.targetPageId;
          const doc0 = useEditor.getState().doc;
          const page = pageId ? doc0?.getPage(pageId) : undefined;
          if (!page) return;
          if (phase === 'end') {
            const ids = objectsInLasso(page, polygon, { mode: 'contain' }).map(
              (object) => object.id,
            );
            setSelection(ids);
            lassoRef.current = [];
            painterRef.current?.clearLasso();
            return;
          }
          lassoRef.current = polygon;
          painterRef.current?.setLasso(polygon);
        },
        onLaser(points, phase) {
          if (phase === 'end') {
            painterRef.current?.clearLaser();
            return;
          }
          painterRef.current?.setLaser(points);
        },
        onTap(point, kind) {
          if (useEditor.getState().tool !== 'text' && useEditor.getState().tool !== 'shape') {
            const pageId = router.targetPageId;
            if (pageId && useEditor.getState().tool === 'lasso') {
              // Lasso taps clear the selection.
              setSelection([]);
              return;
            }
          }
          const pageId = router.targetPageId;
          if (!pageId) return;
          setPointerKind(kind);
          onTapPoint?.(point, pageId);
        },
        onPan(dx, dy) {
          const element = containerRef.current;
          if (!element) return;
          element.scrollLeft -= dx;
          element.scrollTop -= dy;
        },
        onZoom(factor, anchorClientX, anchorClientY) {
          const element = containerRef.current;
          const current = useEditor.getState().zoom;
          const next = clampZoom(current * factor);
          if (next === current) return;
          const rect = element?.getBoundingClientRect();
          const previous = {
            zoom: current,
            scrollLeft: element?.scrollLeft ?? 0,
            scrollTop: element?.scrollTop ?? 0,
          };
          useEditor.getState().setZoom(next);
          if (element && rect) {
            const next2 = scrollForZoomAnchor(
              previous,
              next,
              anchorClientX,
              anchorClientY,
              rect.left,
              rect.top,
              viewMode,
            );
            element.scrollLeft = next2.scrollLeft;
            element.scrollTop = next2.scrollTop;
          }
        },
        onUndoTap() {
          if (twoFingerUndo) useEditor.getState().undo();
        },
        onRedoTap() {
          if (twoFingerUndo) useEditor.getState().redo();
        },
        onPointerKind(kind) {
          setPointerKind(kind);
          if (kind === 'pen' && !stylusSeenRef.current) {
            stylusSeenRef.current = true;
            setStylusSeen(true);
          }
        },
        onTargetPage(pageId) {
          const layout = layoutFor(pageId);
          activePageRef.current = {
            pageId,
            origin: { x: layout?.x ?? 0, y: layout?.y ?? 0 },
          };
        },
        onCursorMove(point) {
          const painter = painterRef.current;
          if (!painter) return;
          const activeTool = useEditor.getState().tool;
          if (point && (activeTool === 'eraser' || activeTool === 'eraser-pixel')) {
            painter.setCursor(point, 'eraser', eraserSize / 2);
          } else if (point && activeTool === 'pen') {
            painter.setCursor(point, 'pen');
          } else {
            painter.setCursor(null);
          }
        },
      },
      getTransform: () => transformRef.current,
      getTool: () => useEditor.getState().tool,
      getEraserRadius: () => eraserSize / 2,
      shouldDrawWithTouch: () => {
        if (penOnly === 'always') return false;
        if (penOnly === 'off') return true;
        // 'auto': fingers draw until a stylus appears in this session, then touch pans.
        return !stylusSeenRef.current;
      },
      enableMultiTap: twoFingerUndo,
    });
    routerRef.current = router;
    return () => {
      routerRef.current = null;
    };
    // Handlers read live state through the store, so re-creating on each dep is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    eraserSize,
    penOnly,
    twoFingerUndo,
    toolStyles,
    commitStroke,
    layouts,
    viewMode,
    setSelection,
    onTapPoint,
  ]);

  /* ---------------- canvas event wiring ---------------- */

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const router = routerRef.current;
    if (!router) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.pointerType === 'mouse' && event.button === 1) {
      dragPanRef.current = { x: event.clientX, y: event.clientY };
      return;
    }
    router.handlePointerDown(event.nativeEvent);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const router = routerRef.current;
    if (!router) return;
    if (dragPanRef.current) {
      const element = containerRef.current;
      if (element) {
        element.scrollLeft -= event.clientX - dragPanRef.current.x;
        element.scrollTop -= event.clientY - dragPanRef.current.y;
      }
      dragPanRef.current = { x: event.clientX, y: event.clientY };
      return;
    }
    router.handlePointerMove(event.nativeEvent);
  }, []);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    dragPanRef.current = null;
    routerRef.current?.handlePointerUp(event.nativeEvent);
  }, []);

  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    routerRef.current?.handlePointerCancel(event.nativeEvent);
  }, []);

  /* ---------------- wheel zoom / scroll ---------------- */

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const zoomIntent = event.ctrlKey || event.metaKey;
      if (!zoomIntent || viewMode === 'single') return;
      event.preventDefault();
      const current = useEditor.getState().zoom;
      const next = clampZoom(current * Math.exp(-event.deltaY * WHEEL_ZOOM_STEP * 0.01));
      if (next === current) return;
      const previous = {
        zoom: current,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
      };
      const rect = element.getBoundingClientRect();
      useEditor.getState().setZoom(next);
      const offsets = scrollForZoomAnchor(
        previous,
        next,
        event.clientX,
        event.clientY,
        rect.left,
        rect.top,
        viewMode,
      );
      element.scrollLeft = offsets.scrollLeft;
      element.scrollTop = offsets.scrollTop;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [viewMode]);

  /* ---------------- which page is on screen (single mode) ---------------- */

  useEffect(() => {
    if (viewMode !== 'vertical') return;
    const element = containerRef.current;
    if (!element || layouts.length === 0) return;
    const center = element.scrollTop + (viewportSize.height || 600) / 2;
    const nearest = layouts.reduce((best, layout) =>
      Math.abs(layout.y + layout.height / 2 - center) < Math.abs(best.y + best.height / 2 - center)
        ? layout
        : best,
    );
    if (nearest.index !== currentPageIndex) setCurrentPage(nearest.index);
  }, [scroll.top, layouts, viewMode, viewportSize.height, currentPageIndex, setCurrentPage]);

  const inkGeneration = version;

  return (
    <div
      className="relative min-h-0 flex-1 overflow-hidden bg-ink-200 dark:bg-ink-950"
      data-testid="page-viewport"
    >
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-auto overscroll-contain"
        style={{ touchAction: 'none' }}
        data-testid="page-scroll"
      >
        <div
          ref={contentRef}
          className="relative"
          style={{
            width: content.width,
            height: content.height,
            minWidth: '100%',
          }}
        >
          {visibleLayouts.map((layout) => {
            const page = pages[layout.index];
            if (!page) return null;
            return (
              <PageCanvas
                key={page.id}
                page={page}
                layout={layout}
                zoom={zoom}
                generation={inkGeneration}
                images={images}
                getBackgroundBitmap={() =>
                  getBackgroundBitmap(
                    page.background.kind === 'pdf' ? page.background.assetId : null,
                    page.background.kind === 'pdf' ? page.background.pdfPage : 0,
                  )
                }
                onBackgroundNeeded={(scale) => requestBackground(layout.index, scale)}
              />
            );
          })}
        </div>
      </div>

      <canvas
        ref={overlayRef}
        className="pointer-events-auto absolute left-0 top-0 z-10"
        style={{
          width: viewportSize.width,
          height: viewportSize.height,
          touchAction: 'none',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => routerRef.current?.handlePointerLeave()}
        data-testid="overlay-canvas"
        aria-label="Drawing surface"
        role="application"
      />

      <ViewportStatus
        pointerKind={pointerKind}
        stylusSeen={stylusSeen}
        pageCount={pages.length}
        currentPageIndex={currentPageIndex}
        tool={tool}
        templateOfCurrentPage={
          pages[currentPageIndex]?.background.kind === 'template'
            ? (
                pages[currentPageIndex]!.background as {
                  template: TemplateKind;
                }
              ).template
            : undefined
        }
      />
    </div>
  );
}

interface ViewportStatusProps {
  pointerKind: PointerKind;
  stylusSeen: boolean;
  pageCount: number;
  currentPageIndex: number;
  tool: string;
  templateOfCurrentPage?: TemplateKind;
}

/** Small, unobtrusive status line (page number, input kind, palm-rejection state). */
function ViewportStatus({
  pointerKind,
  stylusSeen,
  pageCount,
  currentPageIndex,
  tool,
  templateOfCurrentPage,
}: ViewportStatusProps) {
  return (
    <div
      className="pointer-events-none absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full bg-ink-900/80 px-3 py-1 text-xs text-white backdrop-blur dark:bg-ink-100/80 dark:text-ink-900"
      data-testid="viewport-status"
    >
      <span>
        Page {currentPageIndex + 1} / {pageCount}
      </span>
      <span className="mx-2 opacity-50">•</span>
      <span>{tool}</span>
      {templateOfCurrentPage ? (
        <>
          <span className="mx-2 opacity-50">•</span>
          <span>{templateOfCurrentPage}</span>
        </>
      ) : null}
      {stylusSeen || pointerKind === 'touch' ? (
        <>
          <span className="mx-2 opacity-50">•</span>
          <span data-testid="pointer-kind">
            {stylusSeen ? 'stylus detected — touch pans' : 'touch'}
          </span>
        </>
      ) : null}
    </div>
  );
}
