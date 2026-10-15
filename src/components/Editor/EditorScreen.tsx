/**
 * Editor shell: toolbar, page sidebar, canvas viewport, dialogs and global wiring
 * (open/close, autosave, keyboard shortcuts, import/export).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog } from '@/components/ui/primitives';
import type { Bookmark, ID, SceneObject } from '@/core/model';
import { newId } from '@/core/ids';
import {
  InsertObjectsCommand,
  RemoveObjectsCommand,
  ReplaceObjectsCommand,
  SetBookmarksCommand,
  UpdateNotebookCommand,
  setZOrderCommand,
} from '@/core/commands';
import { transformStroke } from '@/core/stroke';
import { defaultTextBox } from '@/core/objects';
import { useEditor } from '@/state/editorStore';
import { useSettings } from '@/state/settings';
import { exportNotebookBytes, saveBookmarks } from '@/data/repository';
import { downloadBlob, renderPageToPng } from '@/render/export/png';
import { Toolbar } from './Toolbar';
import { SHORTCUTS } from './shortcuts';
import { PageViewport, type ViewportApi } from './PageViewport';
import { PageSidebar, type SidebarTab } from './PageSidebar';
import { useAutosave } from './useAutosave';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { usePdfImport } from './usePdfImport';
import { SearchPanel } from './SearchPanel';
import { useImageInsert } from './useImageInsert';
import { SelectionActions } from './SelectionActions';
import { TextBoxDialog } from './TextBoxDialog';

export interface EditorScreenProps {
  notebookId: ID;
  onClose(): void;
}

export function EditorScreen({ notebookId, onClose }: EditorScreenProps) {
  const status = useEditor((state) => state.status);
  const error = useEditor((state) => state.error);
  const title = useEditor((state) => state.doc?.notebook.title ?? '');
  const viewMode = useEditor((state) => state.viewMode);
  const autoSaveMs = useSettings((state) => state.autoSaveMs);
  const open = useEditor((state) => state.open);
  const close = useEditor((state) => state.close);
  const version = useEditor((state) => state.version);
  const currentPageIndex = useEditor((state) => state.currentPageIndex);

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('pages');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [viewportApi, setViewportApi] = useState<ViewportApi | null>(null);
  const [clipboard, setClipboard] = useState<SceneObject[]>([]);
  const [textPoint, setTextPoint] = useState<{
    pageId: ID;
    x: number;
    y: number;
  } | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  /* ---------------- open / close ---------------- */

  useEffect(() => {
    void open(notebookId);
    return () => {
      void useEditor.getState().flush();
    };
  }, [notebookId, open]);

  useAutosave({ intervalMs: autoSaveMs });

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Bookmarks live on the document, which is mutable: `version` marks every change.
  const bookmarks = useMemo<Bookmark[]>(() => {
    // The document is mutable; `version` is the cache key that invalidates this derivation.
    void version;
    return useEditor.getState().doc?.bookmarks ?? [];
  }, [version]);

  const getCurrentPage = useCallback(() => {
    const store = useEditor.getState();
    return store.doc?.pages[store.currentPageIndex] ?? null;
  }, []);

  /* ---------------- selection actions ---------------- */

  const deleteSelection = useCallback(() => {
    const store = useEditor.getState();
    const page = getCurrentPage();
    if (!page) return;
    const entries = store.selection
      .filter((id) => page.indexOf(id) >= 0)
      .flatMap((id) => {
        const object = page.get(id);
        return object ? [{ object, index: page.indexOf(id) }] : [];
      });
    if (entries.length === 0) return;
    store.commit(new RemoveObjectsCommand(page.id, entries, 'Delete'));
    store.clearSelection();
  }, [getCurrentPage]);

  const copySelection = useCallback(() => {
    const store = useEditor.getState();
    const page = getCurrentPage();
    if (!page) return;
    const objects = store.selection.flatMap((id) => {
      const object = page.get(id);
      return object ? [object] : [];
    });
    setClipboard(objects.map((object) => ({ ...object, id: newId('ob') }) as SceneObject));
    if (objects.length)
      setToast(`Copied ${objects.length} object${objects.length === 1 ? '' : 's'}`);
  }, [getCurrentPage]);

  const pasteClipboard = useCallback(() => {
    const store = useEditor.getState();
    const page = getCurrentPage();
    if (!page || clipboard.length === 0) return;
    const objects = clipboard.map((object) => {
      if (object.type === 'stroke') {
        const next = transformStroke(object, (point) => ({
          x: point.x + 14,
          y: point.y + 14,
        }));
        return { ...next, id: newId('ob') };
      }
      return {
        ...object,
        x: object.x + 14,
        y: object.y + 14,
        id: newId('ob'),
      } as SceneObject;
    });
    const entries = objects.map((object, offset) => ({
      object,
      index: page.objects.length + offset,
    }));
    store.commit(new InsertObjectsCommand(page.id, entries, 'Paste'));
    store.setSelection(objects.map((object) => object.id));
    setToast('Pasted');
  }, [clipboard, getCurrentPage]);

  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      const store = useEditor.getState();
      const page = getCurrentPage();
      if (!page || store.selection.length === 0) return;
      const before: Array<{ object: SceneObject; index: number }> = [];
      const after: Array<{ object: SceneObject; index: number }> = [];
      for (const id of store.selection) {
        const index = page.indexOf(id);
        const object = page.get(id);
        if (!object || index < 0) continue;
        before.push({ object, index });
        if (object.type === 'stroke') {
          after.push({
            object: {
              ...transformStroke(object, (point) => ({
                x: point.x + dx,
                y: point.y + dy,
              })),
              id,
            },
            index,
          });
        } else {
          after.push({
            object: {
              ...object,
              x: object.x + dx,
              y: object.y + dy,
            } as SceneObject,
            index,
          });
        }
      }
      if (before.length) store.commit(new ReplaceObjectsCommand(page.id, before, after, 'Move'));
    },
    [getCurrentPage],
  );

  const selectAll = useCallback(() => {
    const store = useEditor.getState();
    const page = getCurrentPage();
    if (!page) return;
    store.setSelection(page.objects.map((object) => object.id));
  }, [getCurrentPage]);

  const changeZOrder = useCallback(
    (where: 'front' | 'back' | 'forward' | 'backward') => {
      const store = useEditor.getState();
      const page = getCurrentPage();
      if (!page || store.selection.length === 0) return;
      const command = setZOrderCommand(page, store.selection, where);
      if (command) store.commit(command);
    },
    [getCurrentPage],
  );

  /* ---------------- import / export ---------------- */

  const handleExportPdf = useCallback(async () => {
    const store = useEditor.getState();
    const doc = store.doc;
    if (!doc) return;
    setToast('Exporting PDF…');
    try {
      // pdf-lib is only needed here, so it is loaded on demand (keeps the first paint light).
      const { exportNotebookPdf } = await import('@/render/export/pdfExport');
      const bytes = await exportNotebookPdf(doc);
      const copy = bytes.slice();
      downloadBlob(
        new Blob([copy.buffer as ArrayBuffer], { type: 'application/pdf' }),
        `${doc.notebook.title}.pdf`,
      );
      setToast(`Exported ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'} to PDF`);
    } catch (exportError) {
      console.error(exportError);
      setToast('PDF export failed');
    }
  }, []);

  const handleExportPng = useCallback(async () => {
    const store = useEditor.getState();
    const page = getCurrentPage()?.data;
    if (!page) return;
    const result = await renderPageToPng(page, { scale: 2 });
    if (!result) {
      setToast('PNG export is unavailable in this browser');
      return;
    }
    downloadBlob(
      result.blob,
      `${store.doc?.notebook.title ?? 'page'}-${store.currentPageIndex + 1}.png`,
    );
    setToast('PNG exported');
  }, [getCurrentPage]);

  const handleExportInkpad = useCallback(async () => {
    const store = useEditor.getState();
    if (!store.doc) return;
    await store.flush();
    const bytes = await exportNotebookBytes(store.doc.id);
    if (!bytes) return;
    const copy = bytes.slice();
    downloadBlob(
      new Blob([copy.buffer as ArrayBuffer], { type: 'application/zip' }),
      `${store.doc.notebook.title}.inkpad`,
    );
    setToast('Exported .inkpad');
  }, []);

  const { importPdf } = usePdfImport({ onMessage: setToast });
  const { insertImage } = useImageInsert({ onMessage: setToast });

  /* ---------------- bookmarks ---------------- */

  const addBookmark = useCallback(() => {
    const store = useEditor.getState();
    const page = getCurrentPage();
    if (!page || !store.doc) return;
    const before = store.doc.bookmarks;
    const bookmark: Bookmark = {
      id: newId('bm'),
      notebookId: store.doc.id,
      pageId: page.id,
      label: `Page ${store.currentPageIndex + 1}`,
      source: 'user',
      createdAt: Date.now(),
    };
    const after = [...before, bookmark];
    store.commit(new SetBookmarksCommand(before, after, 'Add bookmark'));
    void saveBookmarks(store.doc.id, after);
  }, [getCurrentPage]);

  const removeBookmark = useCallback((id: ID) => {
    const store = useEditor.getState();
    if (!store.doc) return;
    const before = store.doc.bookmarks;
    const after = before.filter((bookmark) => bookmark.id !== id);
    store.commit(new SetBookmarksCommand(before, after, 'Remove bookmark'));
    void saveBookmarks(store.doc.id, after);
  }, []);

  const renameNotebook = useCallback((next: string) => {
    const store = useEditor.getState();
    if (!store.doc) return;
    const current = store.doc.notebook.title;
    store.commit(new UpdateNotebookCommand({ title: current }, { title: next }, 'Rename notebook'));
    store.requestScrollToPage(store.currentPageIndex);
  }, []);

  /* ---------------- keyboard ---------------- */

  const shortcutHandlers = useMemo(
    () => ({
      onShowShortcuts: () => setShortcutsOpen(true),
      onShowSearch: () => setSearchOpen(true),
      onToggleOverview: () => {
        setSidebarOpen(true);
        setSidebarTab((tab) => (tab === 'overview' ? 'pages' : 'overview'));
      },
      onCopy: copySelection,
      onCut: () => {
        copySelection();
        deleteSelection();
      },
      onPaste: pasteClipboard,
      onDeleteSelection: deleteSelection,
      onNudge: nudgeSelection,
      onSelectAll: selectAll,
      onZOrder: changeZOrder,
    }),
    [copySelection, deleteSelection, pasteClipboard, nudgeSelection, selectAll, changeZOrder],
  );

  useKeyboardShortcuts(shortcutHandlers);
  useEffect(() => {
    const onPasteImage = (event: ClipboardEvent) => {
      const file = [...(event.clipboardData?.files ?? [])].find((entry) =>
        entry.type.startsWith('image/'),
      );
      if (file) void insertImage(file);
    };
    window.addEventListener('paste', onPasteImage);
    return () => window.removeEventListener('paste', onPasteImage);
  }, [insertImage]);

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-live="polite">
        <span className="text-sm text-ink-500">Opening notebook…</span>
      </div>
    );
  }

  if (status === 'missing' || status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-sm text-ink-500">{error ?? 'That notebook could not be found.'}</p>
        <Button variant="primary" onClick={onClose}>
          Back to library
        </Button>
      </div>
    );
  }

  const pageCount = useEditor.getState().doc?.pages.length ?? 1;

  return (
    <div className="flex h-full min-h-0 flex-col bg-ink-100 dark:bg-ink-950" data-testid="editor">
      <Toolbar
        title={title}
        onTitleChange={renameNotebook}
        onClose={() => {
          void close().then(onClose);
        }}
        onExportPdf={handleExportPdf}
        onExportPng={handleExportPng}
        onExportInkpad={handleExportInkpad}
        onImportPdf={() => pdfInputRef.current?.click()}
        onImportImage={() => fileInputRef.current?.click()}
        onShowShortcuts={() => setShortcutsOpen(true)}
        onShowSearch={() => setSearchOpen(true)}
        onShowOutline={() => {
          setSidebarOpen(true);
          setSidebarTab('bookmarks');
        }}
        viewportApi={viewportApi}
        toggleSidebar={() => setSidebarOpen((isOpen) => !isOpen)}
        sidebarOpen={sidebarOpen}
      />

      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? (
          <div className="w-52 shrink-0 lg:w-60">
            <PageSidebar
              tab={sidebarTab}
              onTabChange={setSidebarTab}
              onClose={() => setSidebarOpen(false)}
              bookmarks={bookmarks}
              onAddBookmark={addBookmark}
              onRemoveBookmark={removeBookmark}
            />
          </div>
        ) : null}

        <div className="relative flex min-w-0 flex-1 flex-col">
          <PageViewport
            onReady={setViewportApi}
            onTapPoint={(point, pageId) => {
              const store = useEditor.getState();
              if (store.tool === 'text') setTextPoint({ pageId, x: point.x, y: point.y });
            }}
          />

          <SelectionActions
            onCopy={copySelection}
            onCut={() => {
              copySelection();
              deleteSelection();
            }}
            onPaste={pasteClipboard}
            onDelete={deleteSelection}
            onZOrder={changeZOrder}
            hasClipboard={clipboard.length > 0}
          />

          {viewMode === 'single' ? (
            <div className="flex items-center justify-center gap-2 border-t border-ink-200 bg-white py-1 dark:border-ink-800 dark:bg-ink-900">
              <Button
                size="sm"
                onClick={() =>
                  useEditor.getState().requestScrollToPage(Math.max(0, currentPageIndex - 1))
                }
              >
                ← Previous
              </Button>
              <span className="text-sm text-ink-500" data-testid="page-counter">
                {currentPageIndex + 1} / {pageCount}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  useEditor
                    .getState()
                    .requestScrollToPage(Math.min(pageCount - 1, currentPageIndex + 1))
                }
              >
                Next →
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        data-testid="image-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          setImageFile(file ?? null);
          if (file) void insertImage(file);
          event.target.value = '';
        }}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        data-testid="pdf-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importPdf(file);
          event.target.value = '';
        }}
      />
      {imageFile ? <span className="sr-only">Selected {imageFile.name}</span> : null}

      <Dialog
        open={shortcutsOpen}
        title="Keyboard shortcuts"
        onClose={() => setShortcutsOpen(false)}
        footer={<Button onClick={() => setShortcutsOpen(false)}>Close</Button>}
      >
        <dl
          className="grid max-h-[60vh] grid-cols-1 gap-1 overflow-y-auto text-sm sm:grid-cols-2"
          data-testid="shortcuts-list"
        >
          {SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.keys}
              className="flex items-center justify-between gap-3 rounded px-2 py-1 odd:bg-ink-100/60 dark:odd:bg-ink-800/60"
            >
              <dt className="font-mono text-xs">{shortcut.keys}</dt>
              <dd className="text-xs text-ink-600 dark:text-ink-300">{shortcut.action}</dd>
            </div>
          ))}
        </dl>
      </Dialog>

      <SearchPanel
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onJump={(index) => useEditor.getState().requestScrollToPage(index)}
      />

      <TextBoxDialog
        key={
          textPoint
            ? `${textPoint.pageId}:${Math.round(textPoint.x)}:${Math.round(textPoint.y)}`
            : 'closed'
        }
        target={textPoint}
        onClose={() => setTextPoint(null)}
        onCommit={(pageId, point, text, fontSize, color) => {
          setTextPoint(null);
          void (async () => {
            const store = useEditor.getState();
            const page = store.doc?.getPage(pageId);
            if (!page) return;
            const box = defaultTextBox(point, text, { fontSize, color });
            store.commit(
              new InsertObjectsCommand(
                page.id,
                [{ object: box, index: page.objects.length }],
                'Add text',
              ),
            );
            store.setSelection([box.id]);
          })();
        }}
      />

      {toast ? (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink-900 px-4 py-2 text-sm text-white shadow-panel dark:bg-ink-100 dark:text-ink-900"
          data-testid="toast"
        >
          {toast}
        </div>
      ) : null}
    </div>
  );
}
