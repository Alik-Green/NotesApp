/**
 * Editor state: the open document, its command stack, the view transform, the active tool and
 * autosave bookkeeping.
 *
 * The document itself (`NotebookDocument`) is mutable and lives outside React's render cycle;
 * `version` is bumped on every committed change so views can re-render imperatively.
 */

import { create } from 'zustand';
import { CommandStack, type HistoryData } from '@/core/commandStack';
import { NotebookDocument, createPage } from '@/core/document';
import type { ID, Page, PageRotation, SceneObject, StrokeTool, TemplateKind, ToolKind } from '@/core/model';
import { newId } from '@/core/ids';
import {
  AddPageCommand,
  DuplicatePageCommand,
  ImportAssetCommand,
  RemovePageCommand,
  UpdateNotebookCommand,
  UpdatePageCommand,
  pagesAffectedBy,
  type Command,
} from '@/core/commands';
import * as repo from '@/data/repository';

export type EditorStatus = 'idle' | 'loading' | 'ready' | 'missing' | 'error';
export type ViewMode = 'vertical' | 'single';

export interface ToolSettings {
  tool: ToolKind;
  strokeTool: StrokeTool;
  eraserSize: number;
  shapeKind: 'rect' | 'ellipse' | 'line' | 'arrow' | 'triangle';
  highlightColor: string;
}

export interface EditorState {
  status: EditorStatus;
  error: string | null;
  notebookId: ID | null;
  doc: NotebookDocument | null;
  stack: CommandStack | null;
  version: number;

  currentPageIndex: number;
  zoom: number;
  viewMode: ViewMode;
  /** Set when the editor should scroll to a specific page (e.g. jump-to-page). */
  scrollToPage: { index: number; nonce: number } | null;

  tool: ToolKind;
  shapeKind: 'rect' | 'ellipse' | 'line' | 'arrow' | 'triangle';
  selection: ID[];
  /** Live counters mirrored from the stack so buttons can disable correctly. */
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;

  dirtyPageIds: Set<ID>;
  structuralDirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  saveError: string | null;

  /* actions */
  open(notebookId: ID): Promise<void>;
  close(): Promise<void>;
  setTool(tool: ToolKind): void;
  setShapeKind(kind: EditorState['shapeKind']): void;
  setSelection(ids: ID[]): void;
  clearSelection(): void;
  commit(command: Command, options?: { structural?: boolean; label?: string }): void;
  batch(label: string, fn: () => void, options?: { structural?: boolean }): void;
  /** Multi-event batching (e.g. one eraser drag spanning many pointer events). */
  beginBatch(label: string): void;
  endBatch(options?: { structural?: boolean }): void;
  undo(): void;
  redo(): void;
  setZoom(zoom: number): void;
  zoomBy(factor: number): void;
  setViewMode(mode: ViewMode): void;
  setCurrentPage(index: number): void;
  requestScrollToPage(index: number): void;
  addPage(options?: { afterIndex?: number; template?: TemplateKind }): void;
  deletePage(pageId: ID): void;
  duplicatePage(pageId: ID): void;
  rotatePage(pageId: ID, rotation: PageRotation | 'cw' | 'ccw'): void;
  setPageTemplate(pageId: ID, template: TemplateKind): void;
  setPaperColor(color: string, pageId?: ID): void;
  insertPdfPages(assetId: ID, pageNumbers: number[], afterIndex: number): void;
  save(): Promise<void>;
  flush(): Promise<void>;
}

const HISTORY_SAVE_INTERVAL_MS = 5000;

let lastHistorySave = 0;

export const useEditor = create<EditorState>((set, get) => ({
  status: 'idle',
  error: null,
  notebookId: null,
  doc: null,
  stack: null,
  version: 0,
  currentPageIndex: 0,
  zoom: 1,
  viewMode: 'vertical',
  scrollToPage: null,
  tool: 'pen',
  shapeKind: 'rect',
  selection: [],
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  dirtyPageIds: new Set<ID>(),
  structuralDirty: false,
  saving: false,
  lastSavedAt: null,
  saveError: null,

  async open(notebookId) {
    set({ status: 'loading', error: null });
    try {
      const snapshot = await repo.loadSnapshot(notebookId);
      if (!snapshot) {
        set({ status: 'missing', doc: null, stack: null, notebookId: null });
        return;
      }
      const doc = new NotebookDocument(snapshot);
      if (doc.pages.length === 0) {
        const page = createPage(doc.id, 0, { width: 595, height: 842 });
        doc.addPage(page);
        await repo.savePages([page]);
      }
      const history = await repo.loadHistory(notebookId);
      const stack = new CommandStack(doc, { cap: 500 });
      if (history) {
        const restored = CommandStack.restore(doc, history as HistoryData, { cap: 500 });
        set({
          stack: restored,
          notebookId,
          doc,
          status: 'ready',
          version: get().version + 1,
          currentPageIndex: 0,
          selection: [],
          dirtyPageIds: new Set<ID>(),
          ...mirrorStack(restored),
        });
        return;
      }
      set({
        stack,
        notebookId,
        doc,
        status: 'ready',
        version: get().version + 1,
        currentPageIndex: 0,
        selection: [],
        dirtyPageIds: new Set<ID>(),
        ...mirrorStack(stack),
      });
    } catch (error) {
      set({ status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  },

  async close() {
    await get().flush();
    set({
      status: 'idle',
      doc: null,
      stack: null,
      notebookId: null,
      selection: [],
      dirtyPageIds: new Set<ID>(),
      structuralDirty: false,
    });
  },

  setTool(tool) {
    // Drawing and erasing tools drop any selection; the object tools keep it.
    const clearsSelection = tool !== 'lasso';
    set(clearsSelection ? { tool, selection: [] } : { tool });
  },

  setShapeKind(kind) {
    set({ shapeKind: kind, tool: 'shape' });
  },

  setSelection(ids) {
    set({ selection: [...ids] });
  },

  clearSelection() {
    set({ selection: [] });
  },

  commit(command, options = {}) {
    const { stack } = get();
    if (!stack) return;
    stack.execute(command);
    applyCommit(set, get, command, options);
  },

  batch(label, fn, options = {}) {
    const { stack } = get();
    if (!stack) return;
    stack.beginBatch(label);
    try {
      fn();
    } finally {
      stack.endBatch();
    }
    const dirty = new Set(get().dirtyPageIds);
    for (const pageId of stack.touchedPageIds()) dirty.add(pageId);
    set({
      version: get().version + 1,
      dirtyPageIds: dirty,
      structuralDirty: get().structuralDirty || Boolean(options.structural),
      ...mirrorStack(stack),
    });
  },

  beginBatch(label) {
    get().stack?.beginBatch(label);
  },

  endBatch(options = {}) {
    const { stack } = get();
    if (!stack) return;
    stack.endBatch();
    const dirty = new Set(get().dirtyPageIds);
    for (const pageId of stack.touchedPageIds()) dirty.add(pageId);
    set({
      version: get().version + 1,
      dirtyPageIds: dirty,
      structuralDirty: get().structuralDirty || Boolean(options.structural),
      ...mirrorStack(stack),
    });
  },

  undo() {
    const { stack } = get();
    if (!stack) return;
    const command = stack.undo();
    if (!command) return;
    const dirty = new Set(get().dirtyPageIds);
    for (const pageId of pagesAffectedBy(command.toData())) dirty.add(pageId);
    set({
      version: get().version + 1,
      dirtyPageIds: dirty,
      structuralDirty: true,
      selection: [],
      ...mirrorStack(stack),
    });
  },

  redo() {
    const { stack } = get();
    if (!stack) return;
    const command = stack.redo();
    if (!command) return;
    const dirty = new Set(get().dirtyPageIds);
    for (const pageId of pagesAffectedBy(command.toData())) dirty.add(pageId);
    set({
      version: get().version + 1,
      dirtyPageIds: dirty,
      structuralDirty: true,
      selection: [],
      ...mirrorStack(stack),
    });
  },

  setZoom(zoom) {
    set({ zoom: Math.min(5, Math.max(0.25, zoom)) });
  },

  zoomBy(factor) {
    get().setZoom(get().zoom * factor);
  },

  setViewMode(mode) {
    set({ viewMode: mode });
  },

  setCurrentPage(index) {
    const doc = get().doc;
    if (!doc) return;
    const clamped = Math.max(0, Math.min(doc.pages.length - 1, index));
    set({ currentPageIndex: clamped });
  },

  requestScrollToPage(index) {
    set({ scrollToPage: { index, nonce: Date.now() }, currentPageIndex: index });
  },

  addPage(options = {}) {
    const { doc } = get();
    if (!doc) return;
    const index = options.afterIndex ?? get().currentPageIndex;
    const template = options.template ?? doc.notebook.defaultTemplate;
    const reference = doc.pages[Math.max(0, Math.min(index, doc.pages.length - 1))]?.data;
    const page: Page = createPage(doc.id, index + 1, {
      width: reference?.width ?? 595,
      height: reference?.height ?? 842,
      background: { kind: 'template', template },
      paperColor: reference?.paperColor ?? doc.notebook.paperColor,
    });
    get().commit(new AddPageCommand(page, index + 1, 'Add page'), { structural: true });
    get().requestScrollToPage(index + 1);
  },

  deletePage(pageId) {
    const { doc } = get();
    if (!doc) return;
    const index = doc.pageIndex(pageId);
    const page = doc.getPage(pageId);
    if (index < 0 || !page) return;
    if (doc.pages.length === 1) return;
    get().commit(new RemovePageCommand(page.data, index, 'Delete page'), { structural: true });
    set({ currentPageIndex: Math.max(0, Math.min(index, doc.pages.length - 1)) });
  },

  duplicatePage(pageId) {
    const { doc } = get();
    if (!doc) return;
    const index = doc.pageIndex(pageId);
    const source = doc.getPage(pageId);
    if (index < 0 || !source) return;
    const copy: Page = {
      ...source.data,
      id: newId('pg'),
      objects: source.data.objects.map((object) => ({ ...object, id: newId('ob') }) as SceneObject),
    };
    get().commit(new DuplicatePageCommand(pageId, copy, index + 1, 'Duplicate page'), { structural: true });
    get().requestScrollToPage(index + 1);
  },

  rotatePage(pageId, rotation) {
    const { doc } = get();
    if (!doc) return;
    const page = doc.getPage(pageId);
    if (!page) return;
    const current = page.data.rotation;
    const next: PageRotation =
      rotation === 'cw'
        ? (((current + 90) % 360) as PageRotation)
        : rotation === 'ccw'
          ? (((current + 270) % 360) as PageRotation)
          : rotation;
    get().commit(new UpdatePageCommand(pageId, { rotation: current }, { rotation: next }, 'Rotate page'), {
      structural: true,
    });
  },

  setPageTemplate(pageId, template) {
    const { doc } = get();
    const page = doc?.getPage(pageId);
    if (!page) return;
    const before = page.data.background;
    get().commit(
      new UpdatePageCommand(
        pageId,
        { background: before },
        { background: { kind: 'template', template } },
        'Page template',
      ),
      { structural: true },
    );
  },

  setPaperColor(color, pageId) {
    const { doc } = get();
    if (!doc) return;
    const target = pageId ? doc.getPage(pageId) : undefined;
    if (target) {
      get().commit(
        new UpdatePageCommand(target.id, { paperColor: target.data.paperColor }, { paperColor: color }, 'Paper colour'),
        { structural: true },
      );
      return;
    }
    const before = { paperColor: doc.notebook.paperColor };
    for (const page of doc.pages) page.data.paperColor = color;
    get().commit(new UpdateNotebookCommand(before, { paperColor: color }, 'Paper colour'), { structural: true });
  },

  insertPdfPages(assetId, pageNumbers, afterIndex) {
    const { doc } = get();
    if (!doc) return;
    const reference = doc.pages[Math.max(0, Math.min(afterIndex, doc.pages.length - 1))]?.data;
    const pages: Page[] = pageNumbers.map((pdfPage, i) =>
      createPage(doc.id, afterIndex + 1 + i, {
        width: reference?.width ?? 595,
        height: reference?.height ?? 842,
        background: { kind: 'pdf', assetId, pdfPage },
        paperColor: '#ffffff',
      }),
    );
    const meta = doc.assets.get(assetId);
    if (!meta) return;
    // Re-adding an already-known asset must not upset the undo step.
    get().commit(new ImportAssetCommand(meta, pages, afterIndex + 1, 'Insert PDF pages'), { structural: true });
    get().requestScrollToPage(afterIndex + 1);
  },

  async save() {
    const { doc, dirtyPageIds, structuralDirty, saving } = get();
    if (!doc || saving) return;
    if (dirtyPageIds.size === 0 && !structuralDirty) return;
    set({ saving: true, saveError: null });
    try {
      if (structuralDirty) {
        await repo.saveSnapshot(doc.toSnapshot());
      } else {
        const pages = [...dirtyPageIds].map((id) => doc.getPage(id)?.data).filter((p): p is Page => Boolean(p));
        await repo.savePages(pages);
        await repo.saveNotebookMeta(doc.notebook);
      }
      const stack = get().stack;
      const now = Date.now();
      if (stack && now - lastHistorySave > HISTORY_SAVE_INTERVAL_MS) {
        lastHistorySave = now;
        await repo.saveHistory(doc.id, stack.toData());
      }
      set({
        dirtyPageIds: new Set<ID>(),
        structuralDirty: false,
        saving: false,
        lastSavedAt: now,
      });
    } catch (error) {
      set({ saving: false, saveError: error instanceof Error ? error.message : String(error) });
    }
  },

  async flush() {
    const { doc, stack } = get();
    await get().save();
    if (doc && stack) await repo.saveHistory(doc.id, stack.toData());
  },
}));

function mirrorStack(stack: CommandStack): Pick<
  EditorState,
  'canUndo' | 'canRedo' | 'undoLabel' | 'redoLabel'
> {
  return {
    canUndo: stack.canUndo,
    canRedo: stack.canRedo,
    undoLabel: stack.undoLabel,
    redoLabel: stack.redoLabel,
  };
}

function applyCommit(
  set: (partial: Partial<EditorState>) => void,
  get: () => EditorState,
  command: Command,
  options: { structural?: boolean },
): void {
  const dirty = new Set(get().dirtyPageIds);
  for (const pageId of pagesAffectedBy(command.toData())) dirty.add(pageId);
  const stack = get().stack;
  set({
    version: get().version + 1,
    dirtyPageIds: dirty,
    structuralDirty: get().structuralDirty || Boolean(options.structural),
    ...(stack ? mirrorStack(stack) : {}),
  });
}

/** Convenience selector: the currently visible page model. */
export function currentPage(state: EditorState) {
  return state.doc?.pages[state.currentPageIndex] ?? null;
}
