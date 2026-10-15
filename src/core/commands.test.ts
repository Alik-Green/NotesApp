/**
 * Command coverage: every mutation of the document must be reversible through the stack, and
 * the page indices/notebook counters must be left consistent by both apply and revert.
 */

import { describe, expect, it } from 'vitest';
import {
  AddPageCommand,
  ImportAssetCommand,
  InsertObjectsCommand,
  MovePageCommand,
  RemovePageCommand,
  ReplaceObjectsCommand,
  SetBookmarksCommand,
  SplitStrokesCommand,
  UpdateNotebookCommand,
  UpdatePageCommand,
  insertObjectsCommand,
  newAssetId,
  pagesAffectedBy,
  removeObjectsCommand,
  setZOrderCommand,
} from './commands';
import { CommandStack } from './commandStack';
import { createPage } from './document';
import { newId } from './ids';
import { buildStroke } from './stroke';
import { makeDoc, makeLine } from './testUtils';
import type { AssetMeta, Bookmark, Page, SceneObject } from './model';

/** Applies commands through the stack, so undo/redo behave exactly as they do in the app. */
function stackWith(doc: ReturnType<typeof makeDoc>): CommandStack {
  return new CommandStack(doc, { onSettled: () => undefined });
}

function pageIds(doc: ReturnType<typeof makeDoc>): string[] {
  return doc.pages.map((page) => page.id);
}

function objectIds(doc: ReturnType<typeof makeDoc>, index = 0): string[] {
  return doc.pages[index]!.data.objects.map((object) => object.id);
}

describe('object commands', () => {
  it('inserts objects at their recorded z positions and undoes them', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const bottom = makeLine(10, 60, 10);
    const top = makeLine(10, 60, 90);
    page.insertMany([bottom, top]);

    const middle = makeLine(10, 60, 50);
    stack.execute(new InsertObjectsCommand(page.id, [{ object: middle, index: 1 }], 'Add'));

    expect(objectIds(doc)).toEqual([bottom.id, middle.id, top.id]);
    expect(stack.canUndo).toBe(true);
    stack.undo();
    expect(objectIds(doc)).toEqual([bottom.id, top.id]);
    stack.redo();
    expect(objectIds(doc)).toEqual([bottom.id, middle.id, top.id]);
  });

  it('removes objects and restores them at the same indices', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const a = makeLine(10, 60, 10);
    const b = makeLine(10, 60, 50);
    const c = makeLine(10, 60, 90);
    page.insertMany([a, b, c]);

    const command = removeObjectsCommand(page, [a.id, c.id], 'Delete');
    expect(command).not.toBeNull();
    stack.execute(command!);
    expect(objectIds(doc)).toEqual([b.id]);

    stack.undo();
    expect(objectIds(doc)).toEqual([a.id, b.id, c.id]);
  });

  it('replaces objects in place (recolour, transforms) and undoes exactly', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const stroke = makeLine(10, 60, 50);
    page.insertMany([stroke]);

    const recoloured: SceneObject = { ...stroke, color: '#2563eb' };
    stack.execute(
      new ReplaceObjectsCommand(
        page.id,
        [{ object: stroke, index: 0 }],
        [{ object: recoloured, index: 0 }],
        'Colour',
      ),
    );
    expect((page.data.objects[0] as typeof stroke).color).toBe('#2563eb');
    expect(page.data.objects).toHaveLength(1);

    stack.undo();
    expect((page.data.objects[0] as typeof stroke).color).toBe(stroke.color);
  });

  it('splits a stroke into eraser fragments as one undo step', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const original = makeLine(10, 200, 50, 4);
    page.insertMany([original]);

    const left = makeLine(10, 90, 50, 4);
    const right = makeLine(120, 200, 50, 4);
    stack.execute(
      new SplitStrokesCommand(
        page.id,
        [{ object: original, index: 0 }],
        [
          { object: left, index: 0 },
          { object: right, index: 1 },
        ],
        'Erase pixels',
      ),
    );
    expect(objectIds(doc)).toEqual([left.id, right.id]);

    stack.undo();
    expect(objectIds(doc)).toEqual([original.id]);
    stack.redo();
    expect(objectIds(doc)).toEqual([left.id, right.id]);
  });

  it('reorders objects between the z-order operations', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const a = makeLine(10, 60, 10);
    const b = makeLine(10, 60, 50);
    const c = makeLine(10, 60, 90);
    page.insertMany([a, b, c]);

    stack.execute(setZOrderCommand(page, [a.id], 'front')!);
    expect(objectIds(doc)).toEqual([b.id, c.id, a.id]);

    // One step backwards swaps with the object directly beneath it.
    stack.execute(setZOrderCommand(page, [a.id], 'backward')!);
    expect(objectIds(doc)).toEqual([b.id, a.id, c.id]);

    stack.undo();
    expect(objectIds(doc)).toEqual([b.id, c.id, a.id]);

    // 'back' pushes the selection behind everything else.
    stack.execute(setZOrderCommand(page, [a.id], 'back')!);
    expect(objectIds(doc)).toEqual([a.id, b.id, c.id]);
    stack.undo();
    expect(objectIds(doc)).toEqual([b.id, c.id, a.id]);
  });

  it('reports which pages a command touches', () => {
    const doc = makeDoc(1);
    const page = doc.pages[0]!;
    const command = insertObjectsCommand(page, [makeLine(10, 60, 50)], 'Add');
    expect(pagesAffectedBy(command.toData())).toEqual([page.id]);
  });
});

describe('page commands', () => {
  it('adds and removes pages, keeping indices and pageCount consistent', () => {
    const doc = makeDoc(2);
    const stack = stackWith(doc);
    const inserted = createPage(doc.id, 1, { width: 600, height: 800 });
    stack.execute(new AddPageCommand(inserted, 1, 'Add page'));

    expect(doc.pageCount).toBe(3);
    expect(doc.notebook.pageCount).toBe(3);
    expect(doc.pages.map((page) => page.data.index)).toEqual([0, 1, 2]);
    expect(doc.pages[1]!.id).toBe(inserted.id);

    stack.undo();
    expect(doc.pageCount).toBe(2);
    expect(doc.notebook.pageCount).toBe(2);
    expect(pageIds(doc)).not.toContain(inserted.id);
  });

  it('deletes a page and restores it at its original position', () => {
    const doc = makeDoc(3);
    const stack = stackWith(doc);
    const before = pageIds(doc);
    const middle = doc.pages[1]!.data;

    stack.execute(new RemovePageCommand(middle, 1, 'Delete page'));
    expect(pageIds(doc)).toEqual([before[0], before[2]]);

    stack.undo();
    expect(pageIds(doc)).toEqual(before);
    expect(doc.pages.map((page) => page.data.index)).toEqual([0, 1, 2]);
  });

  it('moves a page forwards and backwards', () => {
    const doc = makeDoc(3);
    const stack = stackWith(doc);
    const before = pageIds(doc);
    const moved = doc.pages[0]!.id;

    stack.execute(new MovePageCommand(moved, 0, 2, 'Reorder page'));
    expect(pageIds(doc)).toEqual([before[1], before[2], before[0]]);

    stack.undo();
    expect(pageIds(doc)).toEqual(before);
    expect(doc.pages.map((page) => page.data.index)).toEqual([0, 1, 2]);
  });

  it('updates page settings (rotation, template) reversibly', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;

    stack.execute(
      new UpdatePageCommand(
        page.id,
        { rotation: 0, background: { kind: 'template', template: 'blank' } },
        { rotation: 90, background: { kind: 'template', template: 'grid' } },
        'Page settings',
      ),
    );
    expect(page.data.rotation).toBe(90);
    expect(page.data.background).toEqual({ kind: 'template', template: 'grid' });

    stack.undo();
    expect(page.data.rotation).toBe(0);
    expect(page.data.background).toEqual({ kind: 'template', template: 'blank' });
  });
});

describe('notebook commands', () => {
  it('renames a notebook and keeps the library search text in sync', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const before = { title: doc.notebook.title, searchText: doc.notebook.searchText };

    stack.execute(new UpdateNotebookCommand(before, { title: 'Lecture 4' }, 'Rename'));
    expect(doc.notebook.title).toBe('Lecture 4');
    expect(doc.notebook.searchText).toContain('lecture 4');

    stack.undo();
    expect(doc.notebook.title).toBe(before.title);
    expect(doc.notebook.searchText).toBe(before.searchText);
  });

  it('adds and removes bookmarks reversibly', () => {
    const doc = makeDoc(2);
    const stack = stackWith(doc);
    const page = doc.pages[1]!;
    const bookmark: Bookmark = {
      id: newId('bm'),
      notebookId: doc.id,
      pageId: page.id,
      label: 'Chapter 2',
      source: 'user',
      createdAt: Date.now(),
    };

    stack.execute(new SetBookmarksCommand([], [bookmark], 'Add bookmark'));
    expect(doc.bookmarks).toHaveLength(1);

    stack.execute(new SetBookmarksCommand([bookmark], [], 'Remove bookmark'));
    expect(doc.bookmarks).toHaveLength(0);

    stack.undo();
    expect(doc.bookmarks.map((entry) => entry.id)).toEqual([bookmark.id]);
  });

  it('imports a PDF as pages plus an asset, and undoes both', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const asset: AssetMeta = {
      id: newAssetId(),
      kind: 'pdf',
      name: 'slides.pdf',
      mime: 'application/pdf',
      pageCount: 2,
      createdAt: Date.now(),
    };
    const pages: Page[] = [0, 1].map((index) =>
      createPage(doc.id, index, {
        width: 842,
        height: 595,
        background: { kind: 'pdf', assetId: asset.id, pdfPage: index },
      }),
    );

    stack.execute(new ImportAssetCommand(asset, pages, 1, 'Import PDF'));
    expect(doc.pageCount).toBe(3);
    expect(doc.assets.get(asset.id)?.name).toBe('slides.pdf');
    expect(doc.pages[1]!.data.background).toEqual({ kind: 'pdf', assetId: asset.id, pdfPage: 0 });
    expect(doc.pages.map((page) => page.data.index)).toEqual([0, 1, 2]);

    stack.undo();
    expect(doc.pageCount).toBe(1);
    expect(doc.assets.has(asset.id)).toBe(false);

    stack.redo();
    expect(doc.pageCount).toBe(3);
    expect(doc.assets.has(asset.id)).toBe(true);
  });
});

describe('history bookkeeping', () => {
  it('batches an eraser drag into a single undo step', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const strokes = [makeLine(10, 60, 10), makeLine(10, 60, 30), makeLine(10, 60, 50)];
    page.insertMany(strokes);

    stack.beginBatch('Erase stroke');
    for (const stroke of strokes) {
      const command = removeObjectsCommand(page, [stroke.id], 'Erase stroke');
      if (command) stack.execute(command);
    }
    stack.endBatch();

    expect(objectIds(doc)).toEqual([]);
    expect(stack.undoLabel).toBe('Erase stroke');
    stack.undo();
    expect(objectIds(doc)).toEqual(strokes.map((stroke) => stroke.id));
    expect(stack.canUndo).toBe(false);
  });

  it('clears the redo branch when a new command is committed after undo', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const first = makeLine(10, 60, 10);
    const second = makeLine(10, 60, 50);

    stack.execute(insertObjectsCommand(page, [first], 'Add'));
    stack.undo();
    expect(stack.canRedo).toBe(true);

    stack.execute(insertObjectsCommand(page, [second], 'Add'));
    expect(stack.canRedo).toBe(false);
    expect(objectIds(doc)).toEqual([second.id]);
  });

  it('keeps stroke geometry intact through a command round-trip', () => {
    const doc = makeDoc(1);
    const stack = stackWith(doc);
    const page = doc.pages[0]!;
    const stroke = buildStroke(
      [
        { x: 12, y: 30, pressure: 0.4 },
        { x: 40, y: 44, pressure: 0.8 },
        { x: 80, y: 20, pressure: 1 },
      ],
      { tool: 'pen', color: '#111827', size: 3, opacity: 1, id: newId('st') },
    );
    stack.execute(new InsertObjectsCommand(page.id, [{ object: stroke, index: 0 }], 'Add'));
    stack.undo();
    stack.redo();

    const restored = page.data.objects[0]!;
    expect(restored).toEqual(stroke);
  });
});
