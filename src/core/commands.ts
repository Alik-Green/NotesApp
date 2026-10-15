/**
 * Reversible commands. Every mutation of a `NotebookDocument` goes through one of these so
 * undo/redo, batching (one eraser drag = one command) and persisted history all fall out of
 * the same mechanism.
 *
 * Each command has a plain-data `CommandData` form so a history can be stored in IndexedDB
 * and replayed after a reload.
 */

import type {
  AssetMeta,
  Bookmark,
  ID,
  Page,
  SceneObject,
  TemplateKind,
} from './model';
import type { NotebookDocument, PageModel } from './document';
import { clonePage, createPage, type PageSpec } from './document';
import { newId } from './ids';

export interface Command {
  readonly kind: string;
  readonly label: string;
  apply(doc: NotebookDocument): void;
  revert(doc: NotebookDocument): void;
  /** Plain-data serialisation for persisted history. */
  toData(): CommandData;
}

export interface ObjectEntry {
  object: SceneObject;
  index: number;
}

/* ------------------------------------------------------------------ */
/* Object commands                                                     */
/* ------------------------------------------------------------------ */

/** Insert objects (ink, text, images, shapes, highlights). */
export class InsertObjectsCommand implements Command {
  readonly kind = 'insert-objects';
  constructor(
    readonly pageId: ID,
    readonly entries: ObjectEntry[],
    readonly label = 'Add object',
  ) {}

  apply(doc: NotebookDocument): void {
    const page = doc.getPage(this.pageId);
    if (!page) return;
    // Insert from the lowest index upwards so recorded indices stay valid.
    const sorted = [...this.entries].sort((a, b) => a.index - b.index);
    for (const e of sorted) page.insertObject(e.object, e.index);
    page.reindex();
  }

  revert(doc: NotebookDocument): void {
    const page = doc.getPage(this.pageId);
    if (!page) return;
    for (const e of this.entries) page.removeObject(e.object.id);
    page.reindex();
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, pageId: this.pageId, entries: this.entries };
  }
}

/** Remove objects (delete, cut, erase-strokes). */
export class RemoveObjectsCommand implements Command {
  readonly kind = 'remove-objects';
  constructor(
    readonly pageId: ID,
    readonly entries: ObjectEntry[],
    readonly label = 'Erase',
  ) {}

  apply(doc: NotebookDocument): void {
    const page = doc.getPage(this.pageId);
    if (!page) return;
    for (const e of this.entries) page.removeObject(e.object.id);
    page.reindex();
  }

  revert(doc: NotebookDocument): void {
    const page = doc.getPage(this.pageId);
    if (!page) return;
    const sorted = [...this.entries].sort((a, b) => a.index - b.index);
    for (const e of sorted) page.insertObject(e.object, e.index);
    page.reindex();
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, pageId: this.pageId, entries: this.entries };
  }
}

/** Replace objects in place — move, resize, rotate, recolour, text edit, z-order change. */
export class ReplaceObjectsCommand implements Command {
  readonly kind = 'replace-objects';
  constructor(
    readonly pageId: ID,
    readonly before: ObjectEntry[],
    readonly after: ObjectEntry[],
    readonly label = 'Edit object',
  ) {}

  private write(doc: NotebookDocument, entries: ObjectEntry[]): void {
    const page = doc.getPage(this.pageId);
    if (!page) return;
    const ids = new Set(entries.map((e) => e.object.id));
    // Detach edited objects, then re-insert at their recorded z positions.
    for (const id of ids) page.removeObject(id);
    const sorted = [...entries].sort((a, b) => a.index - b.index);
    for (const e of sorted) page.insertObject(e.object, e.index);
    page.reindex();
  }

  apply(doc: NotebookDocument): void {
    this.write(doc, this.after);
  }

  revert(doc: NotebookDocument): void {
    this.write(doc, this.before);
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, pageId: this.pageId, before: this.before, after: this.after };
  }
}

/** Split strokes into fragments (pixel/partial eraser) — one undo step for a whole drag. */
export class SplitStrokesCommand implements Command {
  readonly kind = 'split-strokes';
  constructor(
    readonly pageId: ID,
    readonly before: ObjectEntry[],
    readonly after: ObjectEntry[],
    readonly label = 'Erase pixels',
  ) {}

  private write(doc: NotebookDocument, remove: ObjectEntry[], insert: ObjectEntry[]): void {
    const page = doc.getPage(this.pageId);
    if (!page) return;
    for (const e of remove) page.removeObject(e.object.id);
    for (const e of [...insert].sort((a, b) => a.index - b.index)) page.insertObject(e.object, e.index);
    page.reindex();
  }

  apply(doc: NotebookDocument): void {
    this.write(doc, this.before, this.after);
  }

  revert(doc: NotebookDocument): void {
    this.write(doc, this.after, this.before);
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, pageId: this.pageId, before: this.before, after: this.after };
  }
}

/* ------------------------------------------------------------------ */
/* Page commands                                                       */
/* ------------------------------------------------------------------ */

export class AddPageCommand implements Command {
  readonly kind = 'add-page';
  constructor(
    readonly page: Page,
    readonly index: number,
    readonly label = 'Add page',
  ) {}

  apply(doc: NotebookDocument): void {
    doc.addPage(clonePage(this.page), this.index);
  }

  revert(doc: NotebookDocument): void {
    doc.removePage(this.page.id);
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, page: this.page, index: this.index };
  }
}

export class RemovePageCommand implements Command {
  readonly kind = 'remove-page';
  constructor(
    readonly page: Page,
    readonly index: number,
    readonly label = 'Delete page',
  ) {}

  apply(doc: NotebookDocument): void {
    doc.removePage(this.page.id);
  }

  revert(doc: NotebookDocument): void {
    doc.addPage(clonePage(this.page), this.index);
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, page: this.page, index: this.index };
  }
}

export class MovePageCommand implements Command {
  readonly kind = 'move-page';
  constructor(
    readonly pageId: ID,
    readonly from: number,
    readonly to: number,
    readonly label = 'Reorder page',
  ) {}

  apply(doc: NotebookDocument): void {
    doc.movePage(doc.pageIndex(this.pageId), this.to);
  }

  revert(doc: NotebookDocument): void {
    doc.movePage(doc.pageIndex(this.pageId), this.from);
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, pageId: this.pageId, from: this.from, to: this.to };
  }
}

export type PagePatch = Partial<Pick<Page, 'rotation' | 'background' | 'paperColor' | 'width' | 'height'>>;

export class UpdatePageCommand implements Command {
  readonly kind = 'update-page';
  constructor(
    readonly pageId: ID,
    readonly before: PagePatch,
    readonly after: PagePatch,
    readonly label = 'Page settings',
  ) {}

  private write(doc: NotebookDocument, patch: PagePatch): void {
    const page = doc.getPage(this.pageId);
    if (!page) return;
    Object.assign(page.data, patch);
    page.data.updatedAt = Date.now();
    page.reindex();
  }

  apply(doc: NotebookDocument): void {
    this.write(doc, this.after);
  }

  revert(doc: NotebookDocument): void {
    this.write(doc, this.before);
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, pageId: this.pageId, before: this.before, after: this.after };
  }
}

/** Copies an existing page (used by duplicate-page and insert-from-PDF). */
export class DuplicatePageCommand implements Command {
  readonly kind = 'duplicate-page';
  constructor(
    readonly sourcePageId: ID,
    readonly newPage: Page,
    readonly index: number,
    readonly label = 'Duplicate page',
  ) {}

  apply(doc: NotebookDocument): void {
    doc.addPage(clonePage(this.newPage), this.index);
  }

  revert(doc: NotebookDocument): void {
    doc.removePage(this.newPage.id);
  }

  toData(): CommandData {
    return {
      kind: this.kind,
      label: this.label,
      sourcePageId: this.sourcePageId,
      page: this.newPage,
      index: this.index,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Notebook-level commands                                             */
/* ------------------------------------------------------------------ */

export type NotebookPatch = {
  title?: string;
  paperColor?: string;
  defaultTemplate?: TemplateKind;
  folderId?: ID | null;
};

export class UpdateNotebookCommand implements Command {
  readonly kind = 'update-notebook';
  constructor(
    readonly before: NotebookPatch,
    readonly after: NotebookPatch,
    readonly label = 'Notebook settings',
  ) {}

  private write(doc: NotebookDocument, patch: NotebookPatch): void {
    Object.assign(doc.notebook, patch);
    doc.refreshNotebookMeta();
  }

  apply(doc: NotebookDocument): void {
    this.write(doc, this.after);
  }

  revert(doc: NotebookDocument): void {
    this.write(doc, this.before);
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, before: this.before, after: this.after };
  }
}

export class SetBookmarksCommand implements Command {
  readonly kind = 'set-bookmarks';
  constructor(
    readonly before: Bookmark[],
    readonly after: Bookmark[],
    readonly label = 'Bookmark',
  ) {}

  apply(doc: NotebookDocument): void {
    doc.bookmarks = this.after.map((b) => ({ ...b }));
  }

  revert(doc: NotebookDocument): void {
    doc.bookmarks = this.before.map((b) => ({ ...b }));
  }

  toData(): CommandData {
    return { kind: this.kind, label: this.label, before: this.before, after: this.after };
  }
}

/**
 * Adds a PDF/image asset and the pages that reference it in one undoable step.
 */
export class ImportAssetCommand implements Command {
  readonly kind = 'import-asset';
  constructor(
    readonly asset: AssetMeta,
    readonly pages: Page[],
    readonly startIndex: number,
    readonly label = 'Import PDF',
  ) {}

  apply(doc: NotebookDocument): void {
    doc.addAsset(this.asset);
    this.pages.forEach((p, i) => doc.addPage(clonePage(p), this.startIndex + i));
  }

  revert(doc: NotebookDocument): void {
    for (const p of this.pages) doc.removePage(p.id);
    doc.removeAsset(this.asset.id);
  }

  toData(): CommandData {
    return {
      kind: this.kind,
      label: this.label,
      asset: this.asset,
      pages: this.pages,
      startIndex: this.startIndex,
    };
  }
}

/** Groups commands so a compound action is a single undo step. */
export class BatchCommand implements Command {
  readonly kind = 'batch';
  constructor(
    readonly commands: Command[],
    readonly label: string,
  ) {}

  apply(doc: NotebookDocument): void {
    for (const c of this.commands) c.apply(doc);
  }

  revert(doc: NotebookDocument): void {
    for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i]!.revert(doc);
  }

  toData(): CommandData {
    return {
      kind: this.kind,
      label: this.label,
      commands: this.commands.map((c) => c.toData()),
    };
  }
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

export type CommandData =
  | { kind: 'insert-objects'; label: string; pageId: ID; entries: ObjectEntry[] }
  | { kind: 'remove-objects'; label: string; pageId: ID; entries: ObjectEntry[] }
  | { kind: 'replace-objects'; label: string; pageId: ID; before: ObjectEntry[]; after: ObjectEntry[] }
  | { kind: 'split-strokes'; label: string; pageId: ID; before: ObjectEntry[]; after: ObjectEntry[] }
  | { kind: 'add-page'; label: string; page: Page; index: number }
  | { kind: 'remove-page'; label: string; page: Page; index: number }
  | { kind: 'move-page'; label: string; pageId: ID; from: number; to: number }
  | { kind: 'update-page'; label: string; pageId: ID; before: PagePatch; after: PagePatch }
  | { kind: 'duplicate-page'; label: string; sourcePageId: ID; page: Page; index: number }
  | { kind: 'update-notebook'; label: string; before: NotebookPatch; after: NotebookPatch }
  | { kind: 'set-bookmarks'; label: string; before: Bookmark[]; after: Bookmark[] }
  | { kind: 'import-asset'; label: string; asset: AssetMeta; pages: Page[]; startIndex: number }
  | { kind: 'batch'; label: string; commands: CommandData[] };

/** Rehydrate a command from stored data. Used when restoring persisted history. */
export function commandFromData(data: CommandData): Command {
  switch (data.kind) {
    case 'insert-objects':
      return new InsertObjectsCommand(data.pageId, data.entries, data.label);
    case 'remove-objects':
      return new RemoveObjectsCommand(data.pageId, data.entries, data.label);
    case 'replace-objects':
      return new ReplaceObjectsCommand(data.pageId, data.before, data.after, data.label);
    case 'split-strokes':
      return new SplitStrokesCommand(data.pageId, data.before, data.after, data.label);
    case 'add-page':
      return new AddPageCommand(data.page, data.index, data.label);
    case 'remove-page':
      return new RemovePageCommand(data.page, data.index, data.label);
    case 'move-page':
      return new MovePageCommand(data.pageId, data.from, data.to, data.label);
    case 'update-page':
      return new UpdatePageCommand(data.pageId, data.before, data.after, data.label);
    case 'duplicate-page':
      return new DuplicatePageCommand(data.sourcePageId, data.page, data.index, data.label);
    case 'update-notebook':
      return new UpdateNotebookCommand(data.before, data.after, data.label);
    case 'set-bookmarks':
      return new SetBookmarksCommand(data.before, data.after, data.label);
    case 'import-asset':
      return new ImportAssetCommand(data.asset, data.pages, data.startIndex, data.label);
    case 'batch':
      return new BatchCommand(data.commands.map(commandFromData), data.label);
  }
}

/* ------------------------------------------------------------------ */
/* Convenience factories                                               */
/* ------------------------------------------------------------------ */

export function insertObjectCommand(page: PageModel, object: SceneObject, label = 'Add object'): Command {
  return new InsertObjectsCommand(page.id, [{ object, index: page.objects.length }], label);
}

export function insertObjectsCommand(page: PageModel, objects: SceneObject[], label = 'Add objects'): Command {
  let index = page.objects.length;
  const entries = objects.map((object) => ({ object, index: index++ }));
  return new InsertObjectsCommand(page.id, entries, label);
}

export function removeObjectCommand(page: PageModel, id: ID, label = 'Delete'): Command | null {
  const index = page.indexOf(id);
  const object = page.get(id);
  if (index < 0 || !object) return null;
  return new RemoveObjectsCommand(page.id, [{ object, index }], label);
}

export function removeObjectsCommand(page: PageModel, ids: readonly ID[], label = 'Delete'): Command | null {
  const entries: ObjectEntry[] = [];
  for (const id of ids) {
    const index = page.indexOf(id);
    const object = page.get(id);
    if (index >= 0 && object) entries.push({ object, index });
  }
  if (entries.length === 0) return null;
  return new RemoveObjectsCommand(page.id, entries, label);
}

export function replaceObjectCommand(
  page: PageModel,
  id: ID,
  next: SceneObject,
  label = 'Edit object',
): Command | null {
  const index = page.indexOf(id);
  const object = page.get(id);
  if (index < 0 || !object) return null;
  return new ReplaceObjectsCommand(
    page.id,
    [{ object, index }],
    [{ object: next, index }],
    label,
  );
}

/** Replace many objects at once (lasso transform, batch recolour, …). */
export function replaceObjectsCommand(
  page: PageModel,
  updates: ReadonlyMap<ID, SceneObject>,
  label = 'Transform',
): Command | null {
  const before: ObjectEntry[] = [];
  const after: ObjectEntry[] = [];
  for (const [id, next] of updates) {
    const index = page.indexOf(id);
    const object = page.get(id);
    if (index < 0 || !object) continue;
    before.push({ object, index });
    after.push({ object: next, index });
  }
  if (before.length === 0) return null;
  return new ReplaceObjectsCommand(page.id, before, after, label);
}

/** Move objects one z-step or to an extreme (bring to front / send to back). */
export function setZOrderCommand(
  page: PageModel,
  ids: readonly ID[],
  where: 'front' | 'back' | 'forward' | 'backward',
): Command | null {
  const selected = new Set(ids);
  const list = page.objects.slice();
  const moving = list.filter((o) => selected.has(o.id));
  if (moving.length === 0) return null;
  const rest = list.filter((o) => !selected.has(o.id));
  let next: SceneObject[];
  switch (where) {
    case 'front':
      next = [...rest, ...moving];
      break;
    case 'back':
      next = [...moving, ...rest];
      break;
    case 'forward':
    case 'backward': {
      next = list.slice();
      const dir = where === 'forward' ? 1 : -1;
      const order = where === 'forward' ? [...list.keys()].reverse() : [...list.keys()];
      for (const i of order) {
        const obj = list[i]!;
        if (!selected.has(obj.id)) continue;
        const j = i + dir;
        if (j < 0 || j >= next.length) continue;
        if (selected.has(next[j]!.id)) continue;
        next[i] = next[j]!;
        next[j] = obj;
      }
      break;
    }
  }
  const before: ObjectEntry[] = list.map((object, index) => ({ object, index }));
  const after: ObjectEntry[] = next.map((object, index) => ({ object, index }));
  return new ReplaceObjectsCommand(page.id, before, after, 'Reorder');
}

/** Build a fresh page for a notebook (used by commands + import). */
export function pageFromSpec(notebookId: ID, index: number, spec: PageSpec): Page {
  return createPage(notebookId, index, spec);
}

export function newAssetId(): ID {
  return newId('as');
}

/** Page ids a command touches — used for dirty tracking and partial saving. */
export function pagesAffectedBy(data: CommandData): ID[] {
  const out = new Set<ID>();
  collectPageIds(data, out);
  return [...out];
}

function collectPageIds(data: CommandData, out: Set<ID>): void {
  switch (data.kind) {
    case 'insert-objects':
    case 'remove-objects':
    case 'replace-objects':
    case 'split-strokes':
    case 'update-page':
      out.add(data.pageId);
      break;
    case 'add-page':
    case 'duplicate-page':
      out.add(data.page.id);
      break;
    case 'remove-page':
      break;
    case 'import-asset':
      for (const page of data.pages) out.add(page.id);
      break;
    case 'batch':
      for (const command of data.commands) collectPageIds(command, out);
      break;
    default:
      break;
  }
}
