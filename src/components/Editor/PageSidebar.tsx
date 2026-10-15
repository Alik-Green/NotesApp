/**
 * Pages sidebar: thumbnails with drag-to-reorder, add/duplicate/delete/rotate, plus a page
 * overview grid, bookmarks and the PDF outline. Thumbnails render from the document through the
 * shared painters, so they always match the canvas.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bookmark, ID, Page, TemplateKind } from '@/core/model';
import { drawPage } from '@/render/strokeRenderer';
import { pageSizeAtZoom } from '@/render/viewport';
import { IconButton } from '@/components/ui/primitives';
import { MovePageCommand } from '@/core/commands';
import { useEditor } from '@/state/editorStore';

const THUMB_WIDTH = 132;

export type SidebarTab = 'pages' | 'overview' | 'bookmarks';

export interface PageSidebarProps {
  tab: SidebarTab;
  onTabChange(tab: SidebarTab): void;
  onClose(): void;
  bookmarks: Bookmark[];
  onAddBookmark(): void;
  onRemoveBookmark(id: ID): void;
}

export function PageSidebar({
  tab,
  onTabChange,
  onClose,
  bookmarks,
  onAddBookmark,
  onRemoveBookmark,
}: PageSidebarProps) {
  const doc = useEditor((state) => state.doc);
  const version = useEditor((state) => state.version);
  const currentPageIndex = useEditor((state) => state.currentPageIndex);
  const pages = useMemo(() => {
    // The document is mutable; `version` is the cache key that invalidates this derivation.
    void version;
    return doc?.pages.map((page) => page.data) ?? [];
  }, [doc, version]);

  return (
    <aside
      className="flex h-full w-full flex-col border-r border-ink-200 bg-white dark:border-ink-800 dark:bg-ink-900"
      aria-label="Pages"
    >
      <div className="flex items-center gap-1 border-b border-ink-200 px-2 py-1 dark:border-ink-800">
        {(['pages', 'overview', 'bookmarks'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={tab === entry}
            onClick={() => onTabChange(entry)}
            className={`h-10 flex-1 rounded-lg text-xs font-medium capitalize ${
              tab === entry ? 'bg-accent/15 text-accent' : 'hover:bg-ink-100 dark:hover:bg-ink-800'
            }`}
          >
            {entry}
          </button>
        ))}
        <IconButton label="Close sidebar" className="h-10 w-10" onClick={onClose}>
          ✕
        </IconButton>
      </div>

      {tab === 'pages' ? (
        <PageList
          pages={pages}
          currentPageIndex={currentPageIndex}
          bookmarks={bookmarks}
          onAddBookmark={onAddBookmark}
        />
      ) : null}
      {tab === 'overview' ? (
        <PageOverview pages={pages} currentPageIndex={currentPageIndex} />
      ) : null}
      {tab === 'bookmarks' ? (
        <div className="flex-1 overflow-y-auto p-3">
          <button
            type="button"
            onClick={onAddBookmark}
            className="mb-3 h-11 w-full rounded-lg border border-ink-200 text-sm hover:bg-ink-100 dark:border-ink-700 dark:hover:bg-ink-800"
          >
            Bookmark current page
          </button>
          {bookmarks.length === 0 ? (
            <p className="text-xs text-ink-500">No bookmarks yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {bookmarks.map((bookmark) => (
                <li key={bookmark.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    className="h-11 flex-1 rounded-lg px-2 text-left text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
                    onClick={() => {
                      const index = pages.findIndex((page) => page.id === bookmark.pageId);
                      if (index >= 0) useEditor.getState().requestScrollToPage(index);
                    }}
                  >
                    <span className="mr-2 text-xs text-ink-500">
                      {bookmark.source === 'pdf' ? 'PDF' : '★'}
                    </span>
                    {bookmark.label}
                  </button>
                  <IconButton
                    label={`Remove bookmark ${bookmark.label}`}
                    className="h-10 w-10"
                    onClick={() => onRemoveBookmark(bookmark.id)}
                  >
                    ✕
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </aside>
  );
}

interface PageListProps {
  pages: Page[];
  currentPageIndex: number;
  bookmarks: Bookmark[];
  onAddBookmark(): void;
}

function PageList({ pages, currentPageIndex, bookmarks, onAddBookmark }: PageListProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-page-index="${currentPageIndex}"]`,
    );
    element?.scrollIntoView({ block: 'nearest' });
  }, [currentPageIndex]);

  return (
    <>
      <ul ref={listRef} className="flex-1 overflow-y-auto p-2" data-testid="page-list">
        {pages.map((page, index) => {
          const size = pageSizeAtZoom(page, 1);
          const width = THUMB_WIDTH;
          const height = Math.round((size.height / size.width) * THUMB_WIDTH);
          const bookmarked = bookmarks.some((bookmark) => bookmark.pageId === page.id);
          return (
            <li
              key={page.id}
              data-page-index={index}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => {
                event.preventDefault();
                setDropIndex(index);
              }}
              onDrop={() => {
                const from = dragIndex;
                const dragged = from !== null ? pages[from] : undefined;
                if (dragged && from !== null && from !== index) {
                  // Dragging down past an item lands after it once removed from the list.
                  const to = from < index ? index : index;
                  useEditor
                    .getState()
                    .commit(new MovePageCommand(dragged.id, from, to, 'Reorder page'), {
                      structural: true,
                    });
                }
                setDragIndex(null);
                setDropIndex(null);
              }}
              className={`mb-2 rounded-lg p-1 transition-colors ${
                dropIndex === index && dragIndex !== null ? 'bg-accent/10 ring-1 ring-accent' : ''
              }`}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => useEditor.getState().requestScrollToPage(index)}
                  aria-label={`Go to page ${index + 1}`}
                  aria-current={index === currentPageIndex}
                  className={`relative shrink-0 rounded-md ring-2 transition-shadow ${
                    index === currentPageIndex
                      ? 'ring-accent'
                      : 'ring-transparent hover:ring-ink-300'
                  }`}
                >
                  <PageThumbnail page={page} width={width} height={height} />
                  <span className="absolute bottom-1 left-1 rounded bg-ink-900/70 px-1 text-[10px] text-white">
                    {index + 1}
                  </span>
                  {bookmarked ? <span className="absolute right-1 top-1 text-xs">★</span> : null}
                </button>
                <div className="flex flex-col">
                  <IconButton
                    label={`Duplicate page ${index + 1}`}
                    className="h-10 w-10"
                    onClick={() => useEditor.getState().duplicatePage(page.id)}
                  >
                    ⧉
                  </IconButton>
                  <IconButton
                    label={`Rotate page ${index + 1}`}
                    className="h-10 w-10"
                    onClick={() => useEditor.getState().rotatePage(page.id, 'cw')}
                  >
                    ⟳
                  </IconButton>
                  <IconButton
                    label={`Delete page ${index + 1}`}
                    className="h-10 w-10"
                    disabled={pages.length === 1}
                    onClick={() => useEditor.getState().deletePage(page.id)}
                  >
                    ✕
                  </IconButton>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-1 border-t border-ink-200 p-2 dark:border-ink-800">
        <button
          type="button"
          className="h-11 flex-1 rounded-lg bg-accent/10 text-sm text-accent"
          onClick={() => useEditor.getState().addPage()}
          data-testid="add-page"
        >
          ＋ Add page
        </button>
        <button
          type="button"
          className="h-11 rounded-lg px-3 text-sm hover:bg-ink-100 dark:hover:bg-ink-800"
          onClick={onAddBookmark}
        >
          ★
        </button>
      </div>
    </>
  );
}

function PageOverview({ pages, currentPageIndex }: { pages: Page[]; currentPageIndex: number }) {
  const templates: TemplateKind[] = ['blank', 'lined', 'grid', 'dotted', 'cornell'];
  return (
    <div className="flex-1 overflow-y-auto p-2" data-testid="page-overview">
      <div className="mb-2 grid grid-cols-2 gap-2">
        {pages.map((page, index) => (
          <button
            key={page.id}
            type="button"
            onClick={() => useEditor.getState().requestScrollToPage(index)}
            aria-label={`Page ${index + 1}`}
            className={`rounded-md ring-2 ${index === currentPageIndex ? 'ring-accent' : 'ring-transparent hover:ring-ink-300'}`}
          >
            <PageThumbnail
              page={page}
              width={96}
              height={Math.round((page.height / page.width) * 96)}
            />
            <span className="mt-0.5 block text-[10px] text-ink-500">Page {index + 1}</span>
          </button>
        ))}
      </div>
      <div className="mt-2 border-t border-ink-200 pt-2 dark:border-ink-800">
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
          Template for this page
        </p>
        <div className="grid grid-cols-2 gap-1">
          {templates.map((template) => (
            <button
              key={template}
              type="button"
              className="h-10 rounded-lg text-xs capitalize hover:bg-ink-100 dark:hover:bg-ink-800"
              onClick={() => {
                const pageId = pages[currentPageIndex]?.id;
                if (pageId) useEditor.getState().setPageTemplate(pageId, template);
              }}
            >
              {template}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PageThumbnail({
  page,
  width,
  height,
}: {
  page: Page;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const rotated = page.rotation === 90 || page.rotation === 270;
    const pageWidth = rotated ? page.height : page.width;
    const pageHeight = rotated ? page.width : page.height;
    const scale = Math.min(width / pageWidth, height / pageHeight);
    ctx.save();
    ctx.fillStyle = page.paperColor;
    ctx.fillRect(0, 0, width, height);
    ctx.translate((width - pageWidth * scale) / 2, (height - pageHeight * scale) / 2);
    ctx.scale(scale, scale);
    drawPage(ctx, page, { scale, includePaper: true });
    ctx.restore();
  }, [page, width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height }}
      className="rounded-md bg-white shadow-sm dark:bg-ink-800"
      aria-hidden="true"
    />
  );
}
