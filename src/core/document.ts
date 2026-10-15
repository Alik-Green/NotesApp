/**
 * Mutable in-memory document. Commands mutate a `NotebookDocument`; the persistence layer
 * snapshots it. Pure TypeScript — no DOM/React, so the whole document model is testable
 * in Node.
 */

import { newId } from './ids';
import { SpatialIndex } from './spatial';
import { objectBounds } from './model';
import type {
  AssetMeta,
  Bookmark,
  ID,
  Notebook,
  OutlineItem,
  Page,
  PageBackground,
  PageRotation,
  SceneObject,
  TemplateKind,
} from './model';
import { computeSearchText } from './search';
import type { Rect } from './geometry';

export interface PageSpec {
  width: number;
  height: number;
  background?: PageBackground;
  paperColor?: string;
  rotation?: PageRotation;
}

export interface DocumentSnapshot {
  notebook: Notebook;
  pages: Page[];
  assets: AssetMeta[];
  bookmarks: Bookmark[];
  outline: OutlineItem[];
}

export function createPage(notebookId: ID, index: number, spec: PageSpec): Page {
  return {
    id: newId('pg'),
    notebookId,
    index,
    width: spec.width,
    height: spec.height,
    rotation: spec.rotation ?? 0,
    background: spec.background ?? { kind: 'template', template: 'blank' },
    paperColor: spec.paperColor ?? '#ffffff',
    objects: [],
    updatedAt: Date.now(),
  };
}

/**
 * A page plus its derived state: an id→object map and an rbush spatial index.
 * The `objects` array is the z-order (index 0 = bottom).
 */
export class PageModel {
  data: Page;
  private map = new Map<ID, SceneObject>();
  private index = new SpatialIndex();
  private indexDirty = false;

  constructor(page: Page) {
    this.data = page;
    this.map.clear();
    for (const o of page.objects) this.map.set(o.id, o);
    this.index.rebuild(page.objects);
  }

  get id(): ID {
    return this.data.id;
  }

  get objects(): readonly SceneObject[] {
    return this.data.objects;
  }

  get objectMap(): ReadonlyMap<ID, SceneObject> {
    return this.map;
  }

  get spatial(): SpatialIndex {
    return this.index;
  }

  get(id: ID): SceneObject | undefined {
    return this.map.get(id);
  }

  indexOf(id: ID): number {
    return this.data.objects.findIndex((o) => o.id === id);
  }

  insertObject(o: SceneObject, at?: number): number {
    const list = this.data.objects;
    const idx = at === undefined || at < 0 || at > list.length ? list.length : at;
    list.splice(idx, 0, o);
    this.map.set(o.id, o);
    this.index.insert(o);
    this.data.updatedAt = Date.now();
    return idx;
  }

  insertMany(objects: readonly SceneObject[], at?: number): number {
    const list = this.data.objects;
    let idx = at === undefined || at < 0 || at > list.length ? list.length : at;
    for (const o of objects) {
      list.splice(idx, 0, o);
      this.map.set(o.id, o);
      idx++;
    }
    this.reindex();
    this.data.updatedAt = Date.now();
    return idx;
  }

  removeObject(id: ID): { object: SceneObject; index: number } | null {
    const idx = this.indexOf(id);
    if (idx < 0) return null;
    const [object] = this.data.objects.splice(idx, 1);
    if (!object) return null;
    this.map.delete(id);
    this.index.remove(id);
    this.data.updatedAt = Date.now();
    return { object, index: idx };
  }

  replaceObject(id: ID, next: SceneObject): SceneObject | null {
    const idx = this.indexOf(id);
    if (idx < 0) return null;
    const prev = this.data.objects[idx]!;
    this.data.objects[idx] = next;
    this.map.set(id, next);
    this.index.update(next);
    this.data.updatedAt = Date.now();
    return prev;
  }

  moveToIndex(id: ID, targetIndex: number): number {
    const list = this.data.objects;
    const from = this.indexOf(id);
    if (from < 0) return -1;
    const [obj] = list.splice(from, 1);
    if (!obj) return -1;
    const to = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(to, 0, obj);
    this.data.updatedAt = Date.now();
    return to;
  }

  setObjects(objects: SceneObject[]): void {
    this.data.objects = objects;
    this.map.clear();
    for (const o of objects) this.map.set(o.id, o);
    this.reindex();
    this.data.updatedAt = Date.now();
  }

  reindex(): void {
    this.index.rebuild(this.data.objects);
    this.indexDirty = false;
  }

  markIndexDirty(): void {
    this.indexDirty = true;
  }

  /** Ensures the spatial index reflects the current object list. */
  ensureIndex(): SpatialIndex {
    if (this.indexDirty) this.reindex();
    return this.index;
  }

  /** Broad-phase candidate ids for a rect. */
  searchIds(area: Rect): ID[] {
    return this.ensureIndex().search(area);
  }

  searchObjects(area: Rect): SceneObject[] {
    return this.ensureIndex().searchObjects(area, this.objectMap);
  }

  bounds(): Rect | null {
    let out: Rect | null = null;
    for (const o of this.data.objects) {
      const b = objectBounds(o);
      if (!out) out = { ...b };
      else {
        const minX = Math.min(out.x, b.x);
        const minY = Math.min(out.y, b.y);
        const maxX = Math.max(out.x + out.w, b.x + b.w);
        const maxY = Math.max(out.y + out.h, b.y + b.h);
        out = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      }
    }
    return out;
  }

  clone(): PageModel {
    return new PageModel(clonePage(this.data));
  }
}

export function clonePage(page: Page): Page {
  return {
    ...page,
    objects: page.objects.slice(),
  };
}

export interface NotebookInit {
  title: string;
  id?: ID;
  folderId?: ID | null;
  defaultTemplate?: TemplateKind;
  paperColor?: string;
  createdAt?: number;
}

export function createNotebook(init: NotebookInit): Notebook {
  const now = Date.now();
  return {
    id: init.id ?? newId('nb'),
    title: init.title,
    folderId: init.folderId ?? null,
    createdAt: init.createdAt ?? now,
    updatedAt: now,
    pageCount: 0,
    defaultTemplate: init.defaultTemplate ?? 'blank',
    paperColor: init.paperColor ?? '#ffffff',
    searchText: computeSearchText(init.title, []),
  };
}

export class NotebookDocument {
  notebook: Notebook;
  pages: PageModel[];
  assets: Map<ID, AssetMeta>;
  bookmarks: Bookmark[];
  outline: OutlineItem[];

  constructor(snapshot: DocumentSnapshot) {
    this.notebook = { ...snapshot.notebook };
    this.pages = snapshot.pages.map((p) => new PageModel(p));
    this.assets = new Map(snapshot.assets.map((a) => [a.id, { ...a }]));
    this.bookmarks = snapshot.bookmarks.map((b) => ({ ...b }));
    this.outline = snapshot.outline.map((o) => ({ ...o }));
    this.recomputeIndices();
  }

  get id(): ID {
    return this.notebook.id;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  pageIndex(id: ID): number {
    return this.pages.findIndex((p) => p.id === id);
  }

  getPage(id: ID): PageModel | undefined {
    return this.pages.find((p) => p.id === id);
  }

  pageAt(index: number): PageModel | undefined {
    return this.pages[index];
  }

  pageById(id: ID): PageModel | undefined {
    return this.pages.find((p) => p.id === id);
  }

  addPage(page: Page, at?: number): number {
    const idx = at === undefined || at < 0 || at > this.pages.length ? this.pages.length : at;
    page.notebookId = this.id;
    this.pages.splice(idx, 0, new PageModel(page));
    this.recomputeIndices();
    return idx;
  }

  removePage(id: ID): { page: Page; index: number } | null {
    const idx = this.pageIndex(id);
    if (idx < 0) return null;
    const [model] = this.pages.splice(idx, 1);
    this.recomputeIndices();
    return model ? { page: model.data, index: idx } : null;
  }

  movePage(from: number, to: number): number {
    if (from < 0 || from >= this.pages.length) return from;
    const [model] = this.pages.splice(from, 1);
    if (!model) return from;
    const target = Math.max(0, Math.min(this.pages.length, to));
    this.pages.splice(target, 0, model);
    this.recomputeIndices();
    return target;
  }

  duplicatePage(id: ID, at?: number): ID | null {
    const idx = this.pageIndex(id);
    if (idx < 0) return null;
    const src = this.pages[idx]!;
    const copy: Page = {
      ...clonePage(src.data),
      id: newId('pg'),
      notebookId: this.id,
      objects: src.data.objects.map((o) => ({ ...o, id: newId('ob') }) as SceneObject),
      updatedAt: Date.now(),
    };
    const target = at ?? idx + 1;
    this.pages.splice(target, 0, new PageModel(copy));
    this.recomputeIndices();
    return copy.id;
  }

  /** Deep-clones a page (fresh ids) without inserting it — used by import & commands. */
  clonePageWithNewIds(id: ID): Page | null {
    const model = this.getPage(id);
    if (!model) return null;
    return {
      ...clonePage(model.data),
      id: newId('pg'),
      notebookId: this.id,
      objects: model.data.objects.map((o) => ({ ...o, id: newId('ob') }) as SceneObject),
    };
  }

  setNotebookTitle(title: string): void {
    this.notebook.title = title;
    this.refreshNotebookMeta();
  }

  refreshNotebookMeta(): void {
    this.notebook.pageCount = this.pages.length;
    this.notebook.updatedAt = Date.now();
    const first = this.pages[0];
    if (first) {
      if (!this.notebook.cover || this.notebook.cover.pageId !== first.id) {
        this.notebook.cover = { pageId: first.id, thumb: this.notebook.cover?.thumb };
      }
    } else {
      this.notebook.cover = undefined;
    }
    this.notebook.searchText = computeSearchText(
      this.notebook.title,
      this.pages.flatMap((p) => p.data.objects.flatMap(objectTexts)),
    );
  }

  addAsset(meta: AssetMeta): void {
    this.assets.set(meta.id, meta);
  }

  removeAsset(id: ID): void {
    this.assets.delete(id);
  }

  assetIdsInUse(): Set<ID> {
    const used = new Set<ID>();
    for (const p of this.pages) {
      if (p.data.background.kind === 'pdf') used.add(p.data.background.assetId);
      for (const o of p.data.objects) if (o.type === 'image') used.add(o.assetId);
    }
    return used;
  }

  recomputeIndices(): void {
    this.pages.forEach((p, i) => {
      p.data.index = i;
      p.data.notebookId = this.id;
    });
    this.refreshNotebookMeta();
  }

  toSnapshot(): DocumentSnapshot {
    this.recomputeIndices();
    return {
      notebook: { ...this.notebook, cover: this.notebook.cover ? { ...this.notebook.cover } : undefined },
      pages: this.pages.map((p) => clonePage(p.data)),
      assets: Array.from(this.assets.values()).map((a) => ({ ...a })),
      bookmarks: this.bookmarks.map((b) => ({ ...b })),
      outline: this.outline.map((o) => ({ ...o })),
    };
  }
}

function objectTexts(o: SceneObject): string[] {
  if (o.type === 'text') return [o.text];
  return [];
}

export function emptySnapshot(title: string, pages: Page[], notebookId?: ID): DocumentSnapshot {
  return {
    notebook: { ...createNotebook({ title, id: notebookId }), pageCount: pages.length },
    pages,
    assets: [],
    bookmarks: [],
    outline: [],
  };
}
