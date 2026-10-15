import { describe, expect, it } from 'vitest';
import type { NotebookDocument } from './document';
import { SpatialIndex } from './spatial';
import type { PageModel } from './document';
import {
  hitTestObject,
  hitTestPage,
  objectsInLasso,
  objectsInRect,
  splitStrokeByEraser,
  strokesAt,
  toLocalPoint,
} from './hitTest';
import { makeDoc, makeLine } from './testUtils';
import { objectBounds } from './model';
import type { ShapeObject, TextBox } from './model';

function docWithStrokes(): { doc: NotebookDocument; page: PageModel } {
  const doc = makeDoc();
  const page = doc.pages[0]!;
  page.insertObject(makeLine(0, 100, 50));
  page.insertObject(makeLine(0, 100, 150));
  return { doc, page };
}

describe('spatial index', () => {
  it('finds objects in a rect and updates on insert/remove', () => {
    const { page } = docWithStrokes();
    const index = page.ensureIndex();
    expect(index.size).toBe(2);
    const found = index.search({ x: -5, y: 40, w: 10, h: 20 });
    expect(found).toHaveLength(1);
    const first = page.objects[0]!;
    page.removeObject(first.id);
    expect(page.spatial.size).toBe(1);
  });

  it('finds the nearest object within a radius', () => {
    const { page } = docWithStrokes();
    const nearest = page.spatial.nearest({ x: 50, y: 152 }, page.objectMap, 40);
    expect(nearest).not.toBeNull();
    expect(objectBounds(nearest!).y).toBeGreaterThan(100);
  });

  it('rebuilds after edits', () => {
    const { page } = docWithStrokes();
    page.setObjects([makeLine(0, 10, 500)]);
    const index = new SpatialIndex(page.objects);
    expect(index.search({ x: 0, y: 495, w: 20, h: 20 })).toHaveLength(1);
    expect(index.search({ x: 0, y: 45, w: 20, h: 20 })).toHaveLength(0);
  });
});

describe('hit testing', () => {
  it('hits strokes near their path only', () => {
    const { page } = docWithStrokes();
    const hits = hitTestPage(page, { x: 50, y: 50 });
    expect(hits).toHaveLength(1);
    expect(hitTestPage(page, { x: 50, y: 100 })).toHaveLength(0);
  });

  it('honours tolerance for fat fingers', () => {
    const { page } = docWithStrokes();
    expect(hitTestPage(page, { x: 50, y: 60 }, { tolerance: 12 })).toHaveLength(1);
  });

  it('returns the topmost object first', () => {
    const { page } = docWithStrokes();
    const top = makeLine(0, 100, 50, 6);
    page.insertObject(top);
    const hits = hitTestPage(page, { x: 50, y: 50 }, { includeAll: true });
    expect(hits[0]!.id).toBe(top.id);
  });

  it('hit tests rotated text boxes', () => {
    const text: TextBox = {
      type: 'text',
      id: 't1',
      x: 100,
      y: 100,
      w: 100,
      h: 40,
      rotation: Math.PI / 2,
      text: 'hi',
      fontFamily: 'Inter',
      fontSize: 16,
      color: '#000',
      align: 'left',
    };
    // Rotated 90° around its centre (150, 120): the box becomes a vertical strip 40 wide.
    expect(hitTestObject(text, { x: 150, y: 120 })).toBe(true);
    expect(hitTestObject(text, { x: 150, y: 150 })).toBe(true);
    // Beyond the strip, and to the left of it, the box is no longer hit.
    expect(hitTestObject(text, { x: 150, y: 190 })).toBe(false);
    expect(hitTestObject(text, { x: 120, y: 110 })).toBe(false);
    const local = toLocalPoint(text, { x: 150, y: 150 });
    expect(local.x).toBeCloseTo(80, 4);
    expect(local.y).toBeCloseTo(20, 4);
  });

  it('hit tests shape interiors and edges', () => {
    const rect: ShapeObject = {
      type: 'shape',
      id: 's1',
      shape: 'rect',
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      rotation: 0,
      color: '#000',
      fill: null,
      size: 2,
      opacity: 1,
    };
    expect(hitTestObject(rect, { x: 50, y: 25 })).toBe(true);
    expect(hitTestObject(rect, { x: 50, y: 80 })).toBe(false);

    const ellipse: ShapeObject = { ...rect, shape: 'ellipse' };
    expect(hitTestObject(ellipse, { x: 50, y: 25 })).toBe(true);
    expect(hitTestObject(ellipse, { x: 2, y: 2 })).toBe(false);

    const dot: ShapeObject = { ...rect, shape: 'line', w: 100, h: 0, size: 4 };
    expect(hitTestObject(dot, { x: 50, y: 1 })).toBe(true);
    expect(hitTestObject(dot, { x: 50, y: 30 })).toBe(false);
  });
});

describe('selection', () => {
  it('selects objects whose bounds intersect a marquee', () => {
    const { page } = docWithStrokes();
    const selected = objectsInRect(page, { x: -10, y: 30, w: 130, h: 40 });
    expect(selected).toHaveLength(1);
    expect(objectsInRect(page, { x: -10, y: 30, w: 130, h: 200 })).toHaveLength(2);
  });

  it('selects only fully enclosed objects with a lasso loop', () => {
    const { page } = docWithStrokes();
    const loop = [
      { x: -20, y: 40 },
      { x: 120, y: 40 },
      { x: 120, y: 60 },
      { x: -20, y: 60 },
    ];
    const contained = objectsInLasso(page, loop);
    expect(contained).toHaveLength(1);

    const partialLoop = [
      { x: 40, y: 30 },
      { x: 120, y: 30 },
      { x: 120, y: 200 },
      { x: 40, y: 200 },
    ];
    expect(objectsInLasso(page, partialLoop)).toHaveLength(0);
    expect(objectsInLasso(page, partialLoop, { mode: 'intersect' })).toHaveLength(2);
  });

  it('ignores degenerate lassos', () => {
    const { page } = docWithStrokes();
    expect(objectsInLasso(page, [{ x: 0, y: 0 }, { x: 1, y: 1 }])).toHaveLength(0);
  });
});

describe('eraser queries', () => {
  it('stroke eraser finds strokes under the eraser circle', () => {
    const { page } = docWithStrokes();
    const hits = strokesAt(page, { x: 50, y: 50 }, 8);
    expect(hits).toHaveLength(1);
    expect(strokesAt(page, { x: 50, y: 400 }, 8)).toHaveLength(0);
  });

  it('pixel eraser splits a stroke and keeps the surviving fragments', () => {
    const stroke = makeLine(0, 100, 0, 3);
    const fragments = splitStrokeByEraser(stroke, { x: 50, y: -10 }, { x: 50, y: 10 }, 4);
    // The eraser only removes the middle, so both ends survive as separate strokes.
    expect(fragments.length).toBeGreaterThanOrEqual(1);
    const total = fragments.reduce((sum, fragment) => sum + fragment.xs.length, 0);
    expect(total).toBeLessThanOrEqual(stroke.xs.length);
    for (const fragment of fragments) {
      expect(fragment.id).not.toBe(stroke.id);
    }
  });

  it('pixel eraser can erase a whole stroke', () => {
    const stroke = makeLine(0, 100, 0, 3);
    const fragments = splitStrokeByEraser(stroke, { x: -50, y: 0 }, { x: 150, y: 0 }, 30);
    expect(fragments).toHaveLength(0);
  });
});
