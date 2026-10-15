/**
 * Document model tests: page management (indices, counters), the per-page object list with its
 * spatial index, notebook metadata (search text, page count) and snapshot round-trips.
 */

import { describe, expect, it } from 'vitest';
import {
  NotebookDocument,
  clonePage,
  createNotebook,
  createPage,
  emptySnapshot,
  type DocumentSnapshot,
} from './document';
import { makeDoc, makeLine, makeSnapshot } from './testUtils';
import type { AssetMeta } from './model';

describe('PageModel', () => {
  it('keeps the object list and its lookup map in sync', () => {
    const doc = makeDoc(1);
    const page = doc.pages[0]!;
    const a = makeLine(10, 60, 10);
    const b = makeLine(10, 60, 50);

    page.insertObject(b, 0);
    page.insertObject(a, 0);
    expect(page.objects.map((object) => object.id)).toEqual([a.id, b.id]);
    expect(page.get(b.id)).toBe(b);
    expect(page.indexOf(b.id)).toBe(1);

    page.removeObject(a.id);
    expect(page.get(a.id)).toBeUndefined();
    expect(page.indexOf(a.id)).toBe(-1);
    expect(page.objects.map((object) => object.id)).toEqual([b.id]);
  });

  it('moves objects between z indices', () => {
    const doc = makeDoc(1);
    const page = doc.pages[0]!;
    const a = makeLine(10, 60, 10);
    const b = makeLine(10, 60, 50);
    const c = makeLine(10, 60, 90);
    page.insertMany([a, b, c]);

    expect(page.moveToIndex(a.id, 2)).toBe(2);
    expect(page.objects.map((object) => object.id)).toEqual([b.id, c.id, a.id]);
    // Out-of-range targets clamp to the end.
    expect(page.moveToIndex(b.id, 99)).toBe(2);
    expect(page.objects.map((object) => object.id)).toEqual([c.id, a.id, b.id]);
    expect(page.moveToIndex('missing', 0)).toBe(-1);
  });

  it('replaces objects in place and keeps the spatial index usable', () => {
    const doc = makeDoc(1);
    const page = doc.pages[0]!;
    const stroke = makeLine(10, 60, 50);
    page.insertObject(stroke);

    expect(page.searchIds({ x: 0, y: 0, w: 600, h: 800 })).toEqual([stroke.id]);
    page.replaceObject(stroke.id, { ...stroke, color: '#2563eb' });
    expect(page.get(stroke.id)).toMatchObject({ color: '#2563eb' });
    expect(page.searchIds({ x: 0, y: 0, w: 600, h: 800 })).toEqual([stroke.id]);

    // Removing an object also removes it from the index.
    page.removeObject(stroke.id);
    expect(page.searchIds({ x: 0, y: 0, w: 600, h: 800 })).toEqual([]);
  });

  it('computes page bounds from the objects', () => {
    const doc = makeDoc(1);
    const page = doc.pages[0]!;
    expect(page.bounds()).toBeNull();
    page.insertMany([makeLine(10, 60, 20), makeLine(10, 60, 120)]);
    const bounds = page.bounds()!;
    expect(bounds.x).toBeGreaterThan(0);
    expect(bounds.w).toBeGreaterThan(40);
    expect(bounds.h).toBeGreaterThan(80);
  });

  it('clones deeply enough that edits do not leak back', () => {
    const doc = makeDoc(1);
    const page = doc.pages[0]!;
    page.insertObject(makeLine(10, 60, 20));
    const copy = page.clone();
    copy.insertObject(makeLine(10, 60, 100));
    expect(copy.objects).toHaveLength(2);
    expect(page.objects).toHaveLength(1);

    const pageCopy = clonePage(page.data);
    pageCopy.objects.push(makeLine(10, 60, 200));
    expect(page.data.objects).toHaveLength(1);
  });
});

describe('NotebookDocument', () => {
  it('keeps page indices contiguous after add/remove/move', () => {
    const doc = makeDoc(3);
    const inserted = createPage(doc.id, 99, { width: 600, height: 800 });
    doc.addPage(inserted, 1);
    expect(doc.pages.map((page) => page.data.index)).toEqual([0, 1, 2, 3]);
    expect(doc.pageIndex(inserted.id)).toBe(1);

    doc.removePage(inserted.id);
    expect(doc.pages.map((page) => page.data.index)).toEqual([0, 1, 2]);

    const moved = doc.movePage(2, 0);
    expect(moved).toBe(0);
    expect(doc.pages.map((page) => page.data.index)).toEqual([0, 1, 2]);
  });

  it('duplicates a page with fresh ids, positioned after the source', () => {
    const doc = makeDoc(2);
    doc.pages[0]!.insertObject(makeLine(10, 60, 20));
    const copyId = doc.duplicatePage(doc.pages[0]!.id);
    expect(copyId).not.toBeNull();
    expect(doc.pageCount).toBe(3);
    expect(doc.pages[1]!.id).toBe(copyId);
    expect(doc.pages[1]!.data.objects[0]!.id).not.toBe(doc.pages[0]!.data.objects[0]!.id);
  });

  it('falls back to appending when a move target is out of range', () => {
    const doc = makeDoc(2);
    const first = doc.pages[0]!.id;
    expect(doc.movePage(0, 99)).toBe(1);
    expect(doc.pages[1]!.id).toBe(first);
    expect(doc.movePage(5, 0)).toBe(5); // no-op for an invalid source index
  });

  it('keeps the library metadata (pageCount + searchText) current', () => {
    const doc = makeDoc(2);
    doc.setNotebookTitle('Astrophysics');
    doc.refreshNotebookMeta();
    expect(doc.notebook.pageCount).toBe(2);
    expect(doc.notebook.searchText).toContain('astrophysics');

    // Text written on a page becomes searchable from the library.
    doc.pages[0]!.insertObject({
      type: 'text',
      id: 'text-1',
      x: 0,
      y: 0,
      w: 100,
      h: 40,
      rotation: 0,
      text: 'Kepler orbit',
      fontFamily: 'Helvetica',
      fontSize: 16,
      color: '#111827',
      align: 'left',
    });
    doc.refreshNotebookMeta();
    expect(doc.notebook.searchText).toContain('kepler orbit');
  });

  it('tracks which assets are still referenced by pages', () => {
    const doc = makeDoc(1);
    const asset: AssetMeta = {
      id: 'asset-pdf',
      kind: 'pdf',
      name: 'paper.pdf',
      mime: 'application/pdf',
      pageCount: 1,
      createdAt: 1,
    };
    doc.addAsset(asset);
    expect(doc.assetIdsInUse().has(asset.id)).toBe(false);

    doc.pages[0]!.data.background = { kind: 'pdf', assetId: asset.id, pdfPage: 0 };
    expect(doc.assetIdsInUse().has(asset.id)).toBe(true);

    doc.removeAsset(asset.id);
    expect(doc.assets.size).toBe(0);
  });

  it('round-trips through a snapshot', () => {
    const doc = makeDoc(2);
    doc.pages[0]!.insertObject(makeLine(10, 60, 20));
    doc.setNotebookTitle('Snapshot test');
    const snapshot = doc.toSnapshot();
    const restored = new NotebookDocument(snapshot);
    expect(restored.notebook.title).toBe('Snapshot test');
    expect(restored.pageCount).toBe(2);
    expect(restored.pages[0]!.objects).toHaveLength(1);

    // The snapshot is a copy: mutating the document afterwards must not touch it.
    doc.pages[0]!.insertObject(makeLine(10, 60, 200));
    expect(snapshot.pages[0]!.objects).toHaveLength(1);
  });

  it('builds an empty snapshot with one page', () => {
    const snapshot: DocumentSnapshot = emptySnapshot('New notebook', [createPage('nb', 0, { width: 600, height: 800 })]);
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.notebook.title).toBe('New notebook');
    expect(snapshot.bookmarks).toEqual([]);
    expect(snapshot.outline).toEqual([]);
  });

  it('creates notebook metadata with sensible defaults', () => {
    const notebook = createNotebook({ title: 'Fresh' });
    expect(notebook.pageCount).toBe(0);
    expect(notebook.defaultTemplate).toBe('blank');
    expect(notebook.paperColor).toBe('#ffffff');
    expect(notebook.searchText).toContain('fresh');
  });

  it('keeps notebookId consistent across pages', () => {
    const snapshot = makeSnapshot({ pages: 3 });
    const doc = new NotebookDocument(snapshot);
    for (const page of doc.pages) {
      expect(page.data.notebookId).toBe(doc.id);
    }
  });
});
