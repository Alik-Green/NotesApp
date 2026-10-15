import { describe, expect, it } from 'vitest';
import {
  INKPAD_FORMAT,
  decodeBackup,
  decodeNotebookBundle,
  deserializeObject,
  deserializeSnapshot,
  encodeBackup,
  encodeNotebookBundle,
  serializeObject,
  serializePage,
  serializeSnapshot,
} from './serialization';
import { createPage } from './document';
import { buildStroke } from './stroke';
import { makeLine, makeSnapshot } from './testUtils';
import type { ImageObject, Stroke, TextBox } from './model';
import { DEFAULT_TEMPLATE_SPACING, templateGeometry } from './templates';

function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

describe('serialization', () => {
  it('round-trips strokes without losing quantized precision', () => {
    const stroke = makeLine(0, 120, 40, 3.5);
    const data = serializeObject(stroke);
    const restored = deserializeObject(data) as Stroke;
    expect(Array.from(restored.xs)).toEqual(Array.from(stroke.xs));
    expect(Array.from(restored.ys)).toEqual(Array.from(stroke.ys));
    expect(Array.from(restored.ps)).toEqual(Array.from(stroke.ps));
    expect(restored.tool).toBe(stroke.tool);
    expect(restored.color).toBe(stroke.color);
    expect(restored.size).toBe(stroke.size);
    expect(restored.bbox.x).toBeCloseTo(stroke.bbox.x, 3);
  });

  it('keeps text, images and shapes intact', () => {
    const text: TextBox = {
      type: 'text',
      id: 't1',
      x: 1,
      y: 2,
      w: 100,
      h: 40,
      rotation: 0.2,
      text: 'hello\nworld',
      fontFamily: 'Inter',
      fontSize: 16,
      color: '#000',
      align: 'left',
      link: { kind: 'page', pageId: 'p9' },
    };
    expect(deserializeObject(serializeObject(text))).toEqual(text);

    const image: ImageObject = {
      type: 'image',
      id: 'i1',
      assetId: 'a1',
      x: 0,
      y: 0,
      w: 10,
      h: 10,
      rotation: 0,
      crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      opacity: 0.9,
    };
    expect(deserializeObject(serializeObject(image))).toEqual(image);
  });

  it('round-trips a full snapshot', () => {
    const snapshot = makeSnapshot({ pages: 3 });
    snapshot.pages[1]!.objects.push(makeLine(0, 50, 20));
    snapshot.pages[2]!.background = { kind: 'pdf', assetId: 'asset-1', pdfPage: 4 };
    const page = serializePage(snapshot.pages[1]!);
    expect(typeof page.objects[0]).toBe('object');
    const restored = deserializeSnapshot(serializeSnapshot(snapshot));
    expect(restored.pages).toHaveLength(3);
    expect(restored.pages[2]!.background).toEqual({ kind: 'pdf', assetId: 'asset-1', pdfPage: 4 });
    const stroke = restored.pages[1]!.objects[0] as Stroke;
    expect(stroke.type).toBe('stroke');
    expect(stroke.xs.length).toBeGreaterThan(1);
  });

  it('encodes and decodes a .inkpad bundle', () => {
    const snapshot = makeSnapshot({ pages: 2 });
    snapshot.notebook.title = 'Algebra';
    snapshot.assets.push({ id: 'asset-1', kind: 'pdf', name: 'book.pdf', mime: 'application/pdf', pageCount: 12, createdAt: 5 });
    const bytes = encodeNotebookBundle({
      json: serializeSnapshot(snapshot),
      assetFiles: [{ id: 'asset-1', data: new Uint8Array([1, 2, 3, 4, 5]) }],
    });
    expect(bytes.byteLength).toBeGreaterThan(100);

    const bundle = decodeNotebookBundle(bytes);
    expect(bundle.json.format).toBe(INKPAD_FORMAT);
    expect(bundle.json.notebook.title).toBe('Algebra');
    expect(bundle.json.pages).toHaveLength(2);
    expect(bundle.assetFiles).toHaveLength(1);
    expect(Array.from(bundle.assetFiles[0]!.data)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects files that are not inkpad notebooks', () => {
    const bytes = encodeBackup({ folders: [], notebooks: [] });
    // A backup is a valid zip but has no notebook.json, so the notebook importer rejects it.
    expect(() => decodeNotebookBundle(bytes)).toThrow(/notebook\.json/);
    expect(() => decodeNotebookBundle(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('round-trips a full backup with folders and notebooks', () => {
    const folders = [
      { id: 'f1', name: 'University', parentId: null, createdAt: 1, updatedAt: 1 },
    ];
    const snapshot = makeSnapshot({ pages: 1 });
    const bytes = encodeBackup({
      folders,
      notebooks: [{ json: serializeSnapshot(snapshot), assetFiles: [] }],
    });
    const decoded = decodeBackup(bytes);
    expect(decoded.folders).toEqual(folders);
    expect(decoded.notebooks).toHaveLength(1);
    expect(deserializeSnapshot(decoded.notebooks[0]!.json).notebook.title).toBe('Test notebook');
  });

  it('stores stroke points compactly (~2 bytes per axis, ~1 byte of pressure)', () => {
    const points = Array.from({ length: 400 }, (_, i) => ({
      x: i * 1.7,
      y: Math.sin(i / 6) * 25,
      pressure: (i % 100) / 100,
    }));
    const stroke = buildStroke(points, { id: 'compact', tool: 'pen', color: '#000', size: 3, opacity: 1 });
    const data = serializeObject(stroke) as { xs: string; ys: string; ps: string };
    const points2 = stroke.xs.length;
    const rawBytes =
      base64ByteLength(data.xs) + base64ByteLength(data.ys) + base64ByteLength(data.ps);
    // 2 (int16 x) + 2 (int16 y) + 1 (uint8 pressure) = 5 raw bytes per point.
    expect(rawBytes / points2).toBeGreaterThanOrEqual(5);
    expect(rawBytes / points2).toBeLessThan(5.2);
    // JSON keeps the base64 text, so the on-disk cost is ~6.7 chars per point.
    const jsonChars = (data.xs.length + data.ys.length + data.ps.length) / points2;
    expect(jsonChars).toBeLessThan(7);
    expect(jsonChars).toBeGreaterThan(6.5);
  });

  it('produces the same geometry for template backgrounds after a round trip', () => {
    const page = createPage('nb', 0, { width: 600, height: 800 });
    page.background = { kind: 'template', template: 'grid' };
    const restored = deserializeSnapshot(
      serializeSnapshot({
        notebook: makeSnapshot().notebook,
        pages: [page],
        assets: [],
        bookmarks: [],
        outline: [],
      }),
    ).pages[0]!;
    const before = templateGeometry('grid', { width: page.width, height: page.height, spacing: DEFAULT_TEMPLATE_SPACING });
    const after = templateGeometry('grid', {
      width: restored.width,
      height: restored.height,
      spacing: DEFAULT_TEMPLATE_SPACING,
    });
    expect(after.lines).toEqual(before.lines);
    expect(after.dots).toEqual(before.dots);
  });
});
