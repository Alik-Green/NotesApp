import { describe, expect, it, vi } from 'vitest';
import { CommandStack } from './commandStack';
import {
  AddPageCommand,
  InsertObjectsCommand,
  MovePageCommand,
  RemoveObjectsCommand,
  ReplaceObjectsCommand,
  UpdateNotebookCommand,
  commandFromData,
} from './commands';
import { createPage } from './document';
import { makeDoc, makeLine } from './testUtils';

describe('CommandStack', () => {
  it('applies commands and undoes them', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = doc.pages[0]!;
    const stroke = makeLine(0, 50, 10);

    stack.execute(new InsertObjectsCommand(page.id, [{ object: stroke, index: 0 }], 'Add stroke'));
    expect(page.objects).toHaveLength(1);
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);

    stack.undo();
    expect(page.objects).toHaveLength(0);
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);

    stack.redo();
    expect(page.objects).toHaveLength(1);
    expect(stack.undoLabel).toBe('Add stroke');
  });

  it('restores objects at their original z-order on undo', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = doc.pages[0]!;
    const a = makeLine(0, 10, 0);
    const b = makeLine(0, 10, 20);
    const c = makeLine(0, 10, 40);
    stack.execute(new InsertObjectsCommand(page.id, [{ object: a, index: 0 }, { object: b, index: 1 }, { object: c, index: 2 }]));

    stack.execute(new RemoveObjectsCommand(page.id, [{ object: b, index: 1 }]));
    expect(page.objects.map((o) => o.id)).toEqual([a.id, c.id]);

    stack.undo();
    expect(page.objects.map((o) => o.id)).toEqual([a.id, b.id, c.id]);
  });

  it('collapses a batch into a single undo step', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = doc.pages[0]!;
    const strokes = Array.from({ length: 6 }, (_, i) => makeLine(0, 10, i * 4));
    for (const [index, stroke] of strokes.entries()) {
      stack.execute(new InsertObjectsCommand(page.id, [{ object: stroke, index }], 'Add stroke'));
    }
    stack.clear();

    // Simulate one eraser drag erasing six strokes.
    stack.runBatch('Erase 6 strokes', () => {
      strokes.forEach((stroke) => {
        const index = page.indexOf(stroke.id);
        stack.execute(new RemoveObjectsCommand(page.id, [{ object: stroke, index }]));
      });
    });

    expect(page.objects).toHaveLength(0);
    expect(stack.undoCount).toBe(1);
    expect(stack.undoLabel).toBe('Erase 6 strokes');

    stack.undo();
    expect(page.objects).toHaveLength(6);
    stack.redo();
    expect(page.objects).toHaveLength(0);
  });

  it('treats a single-command batch as that command', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = doc.pages[0]!;
    stack.runBatch('Add', () => {
      stack.execute(new InsertObjectsCommand(page.id, [{ object: makeLine(0, 10, 0), index: 0 }]));
    });
    expect(stack.undoCount).toBe(1);
    expect(stack.undoLabel).toBe('Add object');
  });

  it('clears the redo stack after a new command', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = doc.pages[0]!;
    stack.execute(new InsertObjectsCommand(page.id, [{ object: makeLine(0, 10, 0), index: 0 }]));
    stack.undo();
    expect(stack.canRedo).toBe(true);
    stack.execute(new InsertObjectsCommand(page.id, [{ object: makeLine(0, 10, 5), index: 0 }]));
    expect(stack.canRedo).toBe(false);
    expect(page.objects).toHaveLength(1);
  });

  it('caps the history at the configured limit, dropping the oldest entries', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc, { cap: 5 });
    const page = doc.pages[0]!;
    for (let i = 0; i < 12; i++) {
      stack.execute(new InsertObjectsCommand(page.id, [{ object: makeLine(0, 10, i), index: i }], `Add ${i}`));
    }
    expect(stack.undoCount).toBe(5);
    expect(stack.undoLabel).toBe('Add 11');
    for (let i = 0; i < 5; i++) stack.undo();
    expect(stack.canUndo).toBe(false);
    // Five commands remain applied because the first seven fell out of the window.
    expect(page.objects).toHaveLength(7);
  });

  it('supports page-level and notebook-level commands', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = createPage(doc.id, 1, { width: 600, height: 800 });
    stack.execute(new AddPageCommand(page, 1));
    expect(doc.pageCount).toBe(2);
    stack.execute(new MovePageCommand(page.id, 1, 0));
    expect(doc.pages[0]!.id).toBe(page.id);
    stack.execute(new UpdateNotebookCommand({ title: 'Test notebook' }, { title: 'Renamed' }));
    expect(doc.notebook.title).toBe('Renamed');
    stack.undo();
    expect(doc.notebook.title).toBe('Test notebook');
    stack.undo();
    expect(doc.pages[0]!.id).not.toBe(page.id);
    stack.undo();
    expect(doc.pageCount).toBe(1);
  });

  it('round-trips commands through plain data', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = doc.pages[0]!;
    const stroke = makeLine(0, 40, 10);
    stack.execute(new InsertObjectsCommand(page.id, [{ object: stroke, index: 0 }], 'Add stroke'));

    const data = stack.toData();
    const json = JSON.parse(JSON.stringify(data)) as typeof data;

    const restored = CommandStack.restore(new CommandStack(doc).doc, json);
    expect(restored.undoCount).toBe(1);
    expect(restored.undoLabel).toBe('Add stroke');
    restored.undo();
    expect(page.objects).toHaveLength(0);
    restored.redo();
    expect(page.objects).toHaveLength(1);
  });

  it('restores a persisted history and replays it', () => {
    const doc = makeDoc();
    const stack = new CommandStack(doc);
    const page = doc.pages[0]!;
    const stroke = makeLine(0, 40, 10);
    stack.execute(new InsertObjectsCommand(page.id, [{ object: stroke, index: 0 }]));
    const history = JSON.parse(JSON.stringify(stack.toData())) as ReturnType<CommandStack['toData']>;

    // Simulate a reload: same serialized document, restored history.
    const reloaded = makeDoc();
    const stack2 = CommandStack.restore(reloaded, history);
    expect(stack2.undoCount).toBe(1);
    stack2.undo();
    expect(reloaded.pages[0]!.objects).toHaveLength(0);
  });

  it('calls the settle callback for undo, redo and execute', () => {
    const doc = makeDoc();
    const onSettled = vi.fn();
    const stack = new CommandStack(doc, { onSettled });
    const page = doc.pages[0]!;
    stack.execute(new InsertObjectsCommand(page.id, [{ object: makeLine(0, 10, 0), index: 0 }]));
    stack.undo();
    stack.redo();
    expect(onSettled).toHaveBeenCalledTimes(3);
  });

  it('reports the touched pages for save-on-exit bookkeeping', () => {
    const doc = makeDoc(2);
    const stack = new CommandStack(doc);
    const page = doc.pages[1]!;
    stack.execute(new InsertObjectsCommand(page.id, [{ object: makeLine(0, 10, 0), index: 0 }]));
    expect(stack.touchedPageIds()).toContain(page.id);
  });

  it('rehydrates every command kind from data', () => {
    const doc = makeDoc(2);
    const page = doc.pages[0]!;
    const other = doc.pages[1]!;
    const stroke = makeLine(0, 20, 5);
    const commands = [
      new InsertObjectsCommand(page.id, [{ object: stroke, index: 0 }]).toData(),
      new RemoveObjectsCommand(page.id, [{ object: stroke, index: 0 }]).toData(),
      new ReplaceObjectsCommand(page.id, [{ object: stroke, index: 0 }], [{ object: stroke, index: 0 }]).toData(),
      new AddPageCommand(createPage(doc.id, 2, { width: 1, height: 1 }), 2).toData(),
      new MovePageCommand(other.id, 1, 0).toData(),
      new UpdateNotebookCommand({}, { title: 'x' }).toData(),
    ];
    for (const data of commands) {
      const command = commandFromData(data);
      expect(typeof command.apply).toBe('function');
      expect(typeof command.revert).toBe('function');
    }
  });
});
