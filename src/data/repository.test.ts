import { beforeEach, describe, expect, it } from 'vitest';
import { db, resetDatabase } from './db';
import {
  createFolder,
  createNotebookWithPage,
  deleteFolder,
  deleteNotebook,
  duplicateNotebook,
  exportBackupBytes,
  exportNotebookBytes,
  importBackupBytes,
  importNotebookBytes,
  listFolders,
  listNotebooks,
  loadSnapshot,
  purgeOrphanAssets,
  putAsset,
  saveBookmarks,
  savePages,
  saveSnapshot,
  storageInfo,
} from './repository';
import { buildStroke } from '@/core/stroke';
import { serializeSnapshot } from '@/core/serialization';
import type { AssetMeta, Bookmark } from '@/core/model';

beforeEach(async () => {
  await resetDatabase();
});

describe('repository', () => {
  it('creates a notebook with a first page', async () => {
    const { notebook, page } = await createNotebookWithPage({ title: 'Physics', template: 'lined' });
    expect(notebook.pageCount).toBe(1);
    expect(notebook.cover?.pageId).toBe(page.id);
    expect(page.background).toEqual({ kind: 'template', template: 'lined' });
    const stored = await listNotebooks();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title).toBe('Physics');
  });

  it('duplicates a notebook with fresh page and object ids', async () => {
    const { notebook, page } = await createNotebookWithPage({ title: 'Original' });
    page.objects.push(
      buildStroke(
        [
          { x: 0, y: 0, pressure: 0.5 },
          { x: 10, y: 10, pressure: 0.5 },
          { x: 20, y: 0, pressure: 0.5 },
        ],
        { id: 'stroke-1', tool: 'pen', color: '#000', size: 2, opacity: 1 },
      ),
    );
    await savePages([page]);

    const copy = await duplicateNotebook(notebook.id);
    expect(copy).not.toBeNull();
    const copyPages = await db.pages.where('notebookId').equals(copy!.id).toArray();
    expect(copyPages).toHaveLength(1);
    expect(copyPages[0]!.id).not.toBe(page.id);
    expect(copyPages[0]!.objects[0]!.id).not.toBe('stroke-1');
  });

  it('round-trips a notebook through .inkpad export/import', async () => {
    const { notebook, page } = await createNotebookWithPage({ title: 'Biology', template: 'grid' });
    page.objects.push(
      buildStroke(
        Array.from({ length: 40 }, (_, i) => ({ x: i * 3, y: Math.sin(i) * 5, pressure: i / 40 })),
        { id: 'stroke-2', tool: 'pen', color: '#ef4444', size: 3, opacity: 1 },
      ),
    );
    await savePages([page]);

    const bytes = await exportNotebookBytes(notebook.id);
    expect(bytes).not.toBeNull();
    const imported = await importNotebookBytes(bytes!);
    expect(imported.pageCount).toBe(1);

    const snapshot = await loadSnapshot(imported.notebookId);
    expect(snapshot!.notebook.title).toBe('Biology');
    expect(snapshot!.pages[0]!.background).toEqual({ kind: 'template', template: 'grid' });
    const stroke = snapshot!.pages[0]!.objects[0]!;
    expect(stroke.type).toBe('stroke');
    if (stroke.type === 'stroke') {
      expect(stroke.color).toBe('#ef4444');
      expect(stroke.xs.length).toBeGreaterThan(10);
    }
  });

  it('keeps PDF assets out of the page rows and prunes orphans', async () => {
    const { notebook, page } = await createNotebookWithPage({ title: 'With PDF' });
    const meta: AssetMeta = {
      id: 'asset-pdf',
      kind: 'pdf',
      name: 'paper.pdf',
      mime: 'application/pdf',
      pageCount: 3,
      createdAt: Date.now(),
    };
    await putAsset(meta, new Blob([new Uint8Array([37, 80, 68, 70])], { type: 'application/pdf' }));
    page.background = { kind: 'pdf', assetId: 'asset-pdf', pdfPage: 0 };
    await savePages([page]);

    expect(await purgeOrphanAssets()).toBe(0);
    const snapshot = await loadSnapshot(notebook.id);
    expect(snapshot!.assets.map((a) => a.id)).toEqual(['asset-pdf']);

    // Deleting the notebook removes its pages; the orphan sweep then drops the PDF blob.
    await deleteNotebook(notebook.id);
    expect(await db.assets.count()).toBe(0);
  });

  it('persists bookmarks and outline per notebook', async () => {
    const { notebook, page } = await createNotebookWithPage({ title: 'Marked' });
    const bookmark: Bookmark = {
      id: 'bm1',
      notebookId: notebook.id,
      pageId: page.id,
      label: 'Chapter 1',
      source: 'user',
      createdAt: Date.now(),
    };
    await saveBookmarks(notebook.id, [bookmark]);
    const snapshot = await loadSnapshot(notebook.id);
    expect(snapshot!.bookmarks).toEqual([bookmark]);
  });

  it('moves notebooks out of deleted folders', async () => {
    const folder = await createFolder('University');
    const { notebook } = await createNotebookWithPage({ title: 'Lecture 1', folderId: folder.id });
    expect((await listNotebooks())[0]!.folderId).toBe(folder.id);
    await deleteFolder(folder.id);
    expect((await listNotebooks())[0]!.folderId).toBe(null);
    expect(await listFolders()).toHaveLength(0);
    expect(notebook.id).toBeTruthy();
  });

  it('exports and restores a full backup', async () => {
    await createFolder('Archive');
    const { notebook, page } = await createNotebookWithPage({ title: 'Notebook A' });
    void notebook;
    await saveSnapshot({
      notebook: { ...(await db.notebooks.get(notebook.id))!, title: 'Notebook A' },
      pages: [page],
      assets: [],
      bookmarks: [],
      outline: [],
    });

    const backup = await exportBackupBytes();
    await resetDatabase();
    const result = await importBackupBytes(backup);
    expect(result.notebooks).toBe(1);
    expect(result.folders).toBe(1);
    expect((await listNotebooks())[0]!.title).toBe('Notebook A');
  });

  it('reports storage info', async () => {
    await createNotebookWithPage({ title: 'One' });
    await createNotebookWithPage({ title: 'Two' });
    const info = await storageInfo();
    expect(info.notebooks).toBe(2);
    expect(info.pages).toBe(2);
  });

  it('serializes snapshots without cover bitmaps', () => {
    const json = serializeSnapshot({
      notebook: {
        id: 'nb1',
        title: 'T',
        folderId: null,
        createdAt: 1,
        updatedAt: 1,
        pageCount: 0,
        defaultTemplate: 'blank',
        paperColor: '#fff',
        searchText: 't',
        cover: { pageId: 'p1', thumb: new Blob(['x']) },
      },
      pages: [],
      assets: [],
      bookmarks: [],
      outline: [],
    });
    expect(json.notebook.cover).toEqual({ pageId: 'p1' });
  });
});
