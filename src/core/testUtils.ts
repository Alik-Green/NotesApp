/** Shared helpers for core unit tests (not shipped in the app bundle). */

import { NotebookDocument, createPage, type DocumentSnapshot } from './document';
import { newId } from './ids';
import { buildStroke } from './stroke';
import type { Page, Stroke, StrokeTool } from './model';

export function makeSnapshot(options: { pages?: number; title?: string } = {}): DocumentSnapshot {
  const notebookId = newId('nb');
  const pages: Page[] = [];
  for (let i = 0; i < (options.pages ?? 1); i++) {
    pages.push(createPage(notebookId, i, { width: 600, height: 800 }));
  }
  return {
    notebook: {
      id: notebookId,
      title: options.title ?? 'Test notebook',
      folderId: null,
      createdAt: 1,
      updatedAt: 1,
      pageCount: pages.length,
      defaultTemplate: 'blank',
      paperColor: '#ffffff',
      searchText: 'test notebook',
    },
    pages,
    assets: [],
    bookmarks: [],
    outline: [],
  };
}

export function makeDoc(pages = 1): NotebookDocument {
  return new NotebookDocument(makeSnapshot({ pages }));
}

export function makeStroke(overrides: Partial<Stroke> & { tool?: StrokeTool } = {}): Stroke {
  const points = Array.from({ length: 12 }, (_, i) => ({
    x: 10 + i * 5,
    y: 20 + Math.sin(i) * 3,
    pressure: 0.5,
  }));
  const stroke = buildStroke(points, {
    id: overrides.id ?? newId('st'),
    tool: overrides.tool ?? 'pen',
    color: overrides.color ?? '#111827',
    size: overrides.size ?? 3,
    opacity: overrides.opacity ?? 1,
  });
  return { ...stroke, ...overrides, xs: overrides.xs ?? stroke.xs, ys: overrides.ys ?? stroke.ys, ps: overrides.ps ?? stroke.ps };
}

/** A straight horizontal stroke from x0 to x1 at y. */
export function makeLine(x0: number, x1: number, y: number, size = 3, tool: StrokeTool = 'pen'): Stroke {
  const points = Array.from({ length: 8 }, (_, i) => ({
    x: x0 + ((x1 - x0) * i) / 7,
    y,
    pressure: 0.5,
  }));
  return buildStroke(points, { id: newId('st'), tool, color: '#111827', size, opacity: 1 });
}
