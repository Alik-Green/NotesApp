/**
 * Persistence layer: everything the UI needs to load/save documents, assets and history.
 * Only this folder (plus `render/`) touches IndexedDB.
 */

import { db, type AssetRow, type HistoryRow } from './db';
import { createNotebook, createPage, type DocumentSnapshot } from '@/core/document';
import {
  PAGE_SIZES,
  type AssetMeta,
  type Bookmark,
  type Folder,
  type OutlineItem,
  type ID,
  type Notebook,
  type Page,
  type TemplateKind,
} from '@/core/model';
import {
  blobToBytes,
  bytesToBlob,
  decodeBackup,
  decodeNotebookBundle,
  deserializeSnapshot,
  encodeBackup,
  encodeNotebookBundle,
  serializePage,
  serializeSnapshot,
  type AssetFile,
  type BackupBundle,
  type NotebookBundle,
  type SerializedPage,
} from '@/core/serialization';
import type { HistoryData } from '@/core/commandStack';

export interface CreateNotebookOptions {
  title: string;
  folderId?: ID | null;
  template?: TemplateKind;
  pageSize?: { width: number; height: number };
  paperColor?: string;
}

export async function listNotebooks(): Promise<Notebook[]> {
  return db.notebooks.orderBy('updatedAt').reverse().toArray();
}

export async function getNotebook(id: ID): Promise<Notebook | null> {
  return (await db.notebooks.get(id)) ?? null;
}

export async function listFolders(): Promise<Folder[]> {
  return db.folders.orderBy('name').toArray();
}

export function makeFolderId(): ID {
  return `fd${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function createFolder(name: string, parentId: ID | null = null): Promise<Folder> {
  const now = Date.now();
  const folder: Folder = { id: makeFolderId(), name, parentId, createdAt: now, updatedAt: now };
  await db.folders.put(folder);
  return folder;
}

export async function renameFolder(id: ID, name: string): Promise<void> {
  await db.folders.update(id, { name, updatedAt: Date.now() });
}

export async function deleteFolder(id: ID): Promise<void> {
  // Notebooks inside move back to the root; child folders are re-parented.
  await db.notebooks.where('folderId').equals(id).modify({ folderId: null });
  await db.folders.where('parentId').equals(id).modify({ parentId: null });
  await db.folders.delete(id);
}

/** Create a notebook plus its first page. */
export async function createNotebookWithPage(
  options: CreateNotebookOptions,
): Promise<{ notebook: Notebook; page: Page }> {
  const size = options.pageSize ?? PAGE_SIZES.a4;
  const notebook = createNotebook({
    title: options.title,
    folderId: options.folderId ?? null,
    defaultTemplate: options.template ?? 'blank',
    paperColor: options.paperColor ?? '#ffffff',
  });
  const page: Page = createPage(notebook.id, 0, {
    width: size.width,
    height: size.height,
    background: { kind: 'template', template: options.template ?? 'blank' },
    paperColor: notebook.paperColor,
  });
  notebook.pageCount = 1;
  notebook.cover = { pageId: page.id };
  await db.transaction('rw', db.notebooks, db.pages, async () => {
    await db.notebooks.put(notebook);
    await db.pages.put(serializePage(page));
  });
  return { notebook, page };
}

export async function renameNotebook(id: ID, title: string): Promise<void> {
  const notebook = await db.notebooks.get(id);
  if (!notebook) return;
  const body = notebook.searchText.split('\n').slice(1);
  const searchText = [title, ...body].join('\n').toLowerCase();
  await db.notebooks.update(id, { title, searchText, updatedAt: Date.now() });
}

export async function setNotebookFolder(id: ID, folderId: ID | null): Promise<void> {
  await db.notebooks.update(id, { folderId, updatedAt: Date.now() });
}

/** Deep-copies a notebook's rows into a new notebook with fresh ids. */
export async function duplicateNotebook(id: ID, title?: string): Promise<Notebook | null> {
  const source = await db.notebooks.get(id);
  if (!source) return null;
  const copy = createNotebook({
    title: title ?? `${source.title} copy`,
    folderId: source.folderId,
    defaultTemplate: source.defaultTemplate,
    paperColor: source.paperColor,
  });
  copy.createdAt = source.createdAt;
  const pages = await db.pages.where('notebookId').equals(id).toArray();
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const nextPages: SerializedPage[] = sorted.map((page, index) => ({
    ...page,
    id: `${copy.id}_${index}`,
    notebookId: copy.id,
    index,
    objects: page.objects.map((object, i) => ({
      ...object,
      id: `${copy.id}_${index}_${i}_${object.id.slice(-6)}`,
    })),
  }));
  if (nextPages.length === 0) {
    const page = createPage(copy.id, 0, {
      width: PAGE_SIZES.a4.width,
      height: PAGE_SIZES.a4.height,
    });
    nextPages.push(serializePage(page));
  }
  copy.pageCount = nextPages.length;
  copy.cover = { pageId: nextPages[0]!.id };
  const { thumb: _thumb, ...coverRest } = copy.cover;
  copy.cover = coverRest;
  await db.transaction('rw', db.notebooks, db.pages, async () => {
    await db.notebooks.put(copy);
    await db.pages.bulkPut(nextPages);
  });
  return copy;
}

export async function deleteNotebook(id: ID): Promise<void> {
  await db.transaction('rw', db.notebooks, db.pages, db.history, db.bookmarks, db.outline, async () => {
    await db.pages.where('notebookId').equals(id).delete();
    await db.history.delete(id);
    await db.bookmarks.where('notebookId').equals(id).delete();
    await db.outline.where('notebookId').equals(id).delete();
    await db.notebooks.delete(id);
  });
  await purgeOrphanAssets();
}

export async function listAssetsForNotebook(notebookId: ID): Promise<AssetMeta[]> {
  const pages = await db.pages.where('notebookId').equals(notebookId).toArray();
  const ids = new Set<string>();
  for (const page of pages) {
    if (page.background.kind === 'pdf') ids.add(page.background.assetId);
    for (const object of page.objects) if (object.type === 'image') ids.add(object.assetId);
  }
  const assets: AssetMeta[] = [];
  for (const assetId of ids) {
    const row = await db.assets.get(assetId);
    if (row) assets.push(metaFromRow(row));
  }
  return assets;
}

export function metaFromRow(row: AssetRow): AssetMeta {
  const { bytes: _bytes, ...meta } = row;
  return meta;
}

export async function putAsset(meta: AssetMeta, bytes: Blob): Promise<void> {
  await db.assets.put({ ...meta, bytes });
}

export async function getAssetMeta(id: ID): Promise<AssetMeta | null> {
  const row = await db.assets.get(id);
  return row ? metaFromRow(row) : null;
}

export async function getAssetBytes(id: ID): Promise<Blob | null> {
  const row = await db.assets.get(id);
  return row?.bytes ?? null;
}

/** Object URLs are cached so PDFs/images are not re-created from blobs per frame. */
const urlCache = new Map<ID, string>();

export async function getAssetUrl(id: ID): Promise<string | null> {
  const cached = urlCache.get(id);
  if (cached) return cached;
  const blob = await getAssetBytes(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

export function releaseAssetUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

export async function deleteAsset(id: ID): Promise<void> {
  const url = urlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    urlCache.delete(id);
  }
  await db.assets.delete(id);
}

/** Removes assets no page references any more (after deletes/imports). */
export async function purgeOrphanAssets(): Promise<number> {
  const used = new Set<string>();
  await db.pages.each((page) => {
    if (page.background.kind === 'pdf') used.add(page.background.assetId);
    for (const object of page.objects) if (object.type === 'image') used.add(object.assetId);
  });
  const all = await db.assets.toCollection().primaryKeys();
  const orphans = all.filter((assetId) => !used.has(assetId));
  if (orphans.length) await db.assets.bulkDelete(orphans);
  return orphans.length;
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

/** Load a full document snapshot (pages deserialized, assets as metadata only). */
export async function loadSnapshot(notebookId: ID): Promise<DocumentSnapshot | null> {
  const notebook = await db.notebooks.get(notebookId);
  if (!notebook) return null;
  const pages = await db.pages.where('notebookId').equals(notebookId).toArray();
  const ordered = [...pages].sort((a, b) => a.index - b.index);
  return deserializeSnapshot({
    format: 'inkpad',
    version: 1,
    notebook,
    pages: ordered,
    assets: await listAssetsForNotebook(notebookId),
    bookmarks: await listBookmarks(notebookId),
    outline: await listOutline(notebookId),
  });
}

export async function listBookmarks(notebookId: ID): Promise<Bookmark[]> {
  return db.bookmarks.where('notebookId').equals(notebookId).toArray();
}

export async function listOutline(notebookId: ID): Promise<OutlineItem[]> {
  return db.outline.where('notebookId').equals(notebookId).toArray();
}

export async function saveBookmarks(notebookId: ID, bookmarks: readonly Bookmark[]): Promise<void> {
  await db.transaction('rw', db.bookmarks, async () => {
    await db.bookmarks.where('notebookId').equals(notebookId).delete();
    if (bookmarks.length) await db.bookmarks.bulkPut(bookmarks.map((b) => ({ ...b })));
  });
}

export async function saveOutline(notebookId: ID, outline: readonly OutlineItem[]): Promise<void> {
  await db.transaction('rw', db.outline, async () => {
    await db.outline.where('notebookId').equals(notebookId).delete();
    if (outline.length) await db.outline.bulkPut(outline.map((o) => ({ ...o })));
  });
}

export async function saveSnapshot(snapshot: DocumentSnapshot): Promise<void> {
  await db.transaction('rw', db.notebooks, db.pages, async () => {
    await db.notebooks.put(snapshot.notebook);
    await db.pages.where('notebookId').equals(snapshot.notebook.id).delete();
    await db.pages.bulkPut(snapshot.pages.map(serializePage));
  });
  await saveBookmarks(snapshot.notebook.id, snapshot.bookmarks);
  await saveOutline(snapshot.notebook.id, snapshot.outline);
}

/** Autosave fast path: write only the pages that changed. */
export async function savePages(pages: readonly Page[]): Promise<void> {
  if (pages.length === 0) return;
  await db.pages.bulkPut(pages.map(serializePage));
}

export async function savePageIndexes(
  entries: Array<{ id: ID; index: number; notebookId: ID }>,
): Promise<void> {
  await db.transaction('rw', db.pages, async () => {
    for (const entry of entries) {
      await db.pages.update(entry.id, { index: entry.index, notebookId: entry.notebookId });
    }
  });
}

export async function saveNotebookMeta(notebook: Notebook): Promise<void> {
  await db.notebooks.put(notebook);
}

export async function deletePages(ids: readonly ID[]): Promise<void> {
  await db.pages.bulkDelete([...ids]);
}

export async function loadHistory(notebookId: ID): Promise<HistoryData | null> {
  const row: HistoryRow | undefined = await db.history.get(notebookId);
  if (!row) return null;
  return { entries: row.entries, redo: row.redo };
}

export const MAX_HISTORY_ENTRIES = 500;

export async function saveHistory(notebookId: ID, history: HistoryData): Promise<void> {
  const entries = history.entries.slice(-MAX_HISTORY_ENTRIES);
  const redo = (history.redo ?? []).slice(0, MAX_HISTORY_ENTRIES);
  if (entries.length === 0 && redo.length === 0) {
    await db.history.delete(notebookId);
    return;
  }
  await db.history.put({ notebookId, entries, redo, updatedAt: Date.now() });
}

export async function clearHistory(notebookId: ID): Promise<void> {
  await db.history.delete(notebookId);
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row ? (row.value as T) : fallback;
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value });
}

export async function allSettings(): Promise<Record<string, unknown>> {
  const rows = await db.settings.toArray();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/* ------------------------------------------------------------------ */
/* Import / export                                                     */
/* ------------------------------------------------------------------ */

export async function exportNotebookBytes(notebookId: ID): Promise<Uint8Array | null> {
  const snapshot = await loadSnapshot(notebookId);
  if (!snapshot) return null;
  const assetFiles: AssetFile[] = [];
  for (const meta of snapshot.assets) {
    const blob = await getAssetBytes(meta.id);
    if (blob) assetFiles.push({ id: meta.id, data: await blobToBytes(blob) });
  }
  const json = serializeSnapshot(snapshot);
  return encodeNotebookBundle({ json, assetFiles });
}

export interface ImportedNotebook {
  notebookId: ID;
  title: string;
  pageCount: number;
}

/** Import a `.inkpad` notebook, optionally into a folder and with a new title. */
export async function importNotebookBytes(
  bytes: Uint8Array,
  options: ImportOptions = {},
): Promise<ImportedNotebook> {
  return importBundleData(decodeNotebookBundle(bytes), options);
}

export interface ImportOptions {
  folderId?: ID | null;
  title?: string;
  /** Keep original ids when possible (used by full backups); otherwise ids are remapped. */
  keepIds?: boolean;
}

export async function importBundleData(
  bundle: NotebookBundle,
  options: ImportOptions = {},
): Promise<ImportedNotebook> {
  const snapshot = deserializeSnapshot(bundle.json);
  const keepIds = options.keepIds ?? false;
  const clash = keepIds ? await db.notebooks.get(snapshot.notebook.id) : undefined;
  const suffix = clash ? `_${Math.random().toString(36).slice(2, 7)}` : '';
  const notebook: Notebook = {
    ...snapshot.notebook,
    id: `${snapshot.notebook.id}${suffix}`,
    title: options.title ?? (clash ? `${snapshot.notebook.title} (imported)` : snapshot.notebook.title),
    folderId: options.folderId !== undefined ? options.folderId : snapshot.notebook.folderId,
    updatedAt: Date.now(),
  };
  const pages: Page[] = snapshot.pages.map((page, index) => ({
    ...page,
    id: suffix ? `${page.id}${suffix}` : page.id,
    notebookId: notebook.id,
    index,
    objects: suffix
      ? page.objects.map((object, i) => ({ ...object, id: `${object.id}${suffix}${i}` }))
      : page.objects,
  }));
  notebook.pageCount = pages.length;
  notebook.cover = pages[0] ? { pageId: pages[0].id } : undefined;

  await db.transaction('rw', db.notebooks, db.pages, db.assets, async () => {
    await db.notebooks.put(notebook);
    await db.pages.bulkPut(pages.map(serializePage));
    for (const file of bundle.assetFiles) {
      const meta = snapshot.assets.find((a) => a.id === file.id);
      if (!meta) continue;
      if (await db.assets.get(meta.id)) continue;
      await db.assets.put({ ...meta, bytes: bytesToBlob(file.data, meta.mime) });
    }
  });

  return { notebookId: notebook.id, title: notebook.title, pageCount: pages.length };
}

/** Full backup of every notebook + folder into one file. */
export async function exportBackupBytes(): Promise<Uint8Array> {
  const folders = await listFolders();
  const notebooks = await listNotebooks();
  const bundles: NotebookBundle[] = [];
  for (const notebook of notebooks) {
    const snapshot = await loadSnapshot(notebook.id);
    if (!snapshot) continue;
    const assetFiles: AssetFile[] = [];
    for (const meta of snapshot.assets) {
      const blob = await getAssetBytes(meta.id);
      if (blob) assetFiles.push({ id: meta.id, data: await blobToBytes(blob) });
    }
    bundles.push({ json: serializeSnapshot(snapshot), assetFiles });
  }
  const backup: BackupBundle = { folders, notebooks: bundles };
  return encodeBackup(backup);
}

export async function importBackupBytes(
  bytes: Uint8Array,
): Promise<{ notebooks: number; folders: number }> {
  const backup = decodeBackup(bytes);
  let folderCount = 0;
  for (const folder of backup.folders) {
    if (!(await db.folders.get(folder.id))) {
      await db.folders.put(folder);
      folderCount++;
    }
  }
  let notebookCount = 0;
  for (const bundle of backup.notebooks) {
    const clash = await db.notebooks.get(bundle.json.notebook.id);
    await importBundleData(bundle, { keepIds: !clash });
    notebookCount++;
  }
  return { notebooks: notebookCount, folders: folderCount };
}

export interface StorageInfo {
  usage: number;
  quota: number;
  notebooks: number;
  pages: number;
  assets: number;
}

export async function storageInfo(): Promise<StorageInfo> {
  const [notebooks, pages, assets] = await Promise.all([
    db.notebooks.count(),
    db.pages.count(),
    db.assets.count(),
  ]);
  let usage = 0;
  let quota = 0;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    const estimate = await navigator.storage.estimate();
    usage = estimate.usage ?? 0;
    quota = estimate.quota ?? 0;
  }
  return { usage, quota, notebooks, pages, assets };
}

/** First page of a notebook (used for cover previews and "open" defaults). */
export async function loadFirstPage(notebookId: ID): Promise<Page | null> {
  const pages = await db.pages.where('notebookId').equals(notebookId).sortBy('index');
  const first = pages[0];
  return first ? deserializeSnapshot({
    format: 'inkpad',
    version: 1,
    notebook: (await db.notebooks.get(notebookId))!,
    pages: [first],
    assets: [],
    bookmarks: [],
    outline: [],
  }).pages[0]! : null;
}

export async function loadPage(pageId: ID): Promise<Page | null> {
  const row = await db.pages.get(pageId);
  if (!row) return null;
  return deserializeSnapshot({
    format: 'inkpad',
    version: 1,
    notebook: {
      id: row.notebookId,
      title: '',
      folderId: null,
      createdAt: 0,
      updatedAt: 0,
      pageCount: 1,
      defaultTemplate: 'blank',
      paperColor: '#ffffff',
      searchText: '',
    },
    pages: [row],
    assets: [],
    bookmarks: [],
    outline: [],
  }).pages[0]!;
}
