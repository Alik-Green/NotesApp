/**
 * InkPad document model — pure data types plus small pure helpers.
 *
 * Hierarchy: Notebook → Page → Layers.
 * A page owns an ordered list of scene objects (`objects`), where array order *is* the
 * z-order. The renderer draws four passes per page: background (template or PDF page),
 * committed ink, live stroke, selection/UI overlay — see `render/strokeRenderer.ts`.
 */

import type { Rect } from './geometry';

export type ID = string;

/** Points are stored quantized to 1/QUANT document units in Int16 channels. */
export const QUANT = 8;

export type StrokeTool = 'pen' | 'highlighter' | 'pencil';
export type ToolKind =
  | StrokeTool
  | 'eraser'
  | 'eraser-pixel'
  | 'lasso'
  | 'pan'
  | 'laser'
  | 'text'
  | 'shape'
  | 'image';

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'triangle';
export type TemplateKind = 'blank' | 'lined' | 'grid' | 'dotted' | 'cornell';

export const STROKE_TOOLS: readonly StrokeTool[] = ['pen', 'highlighter', 'pencil'];

export function isStrokeTool(tool: ToolKind): tool is StrokeTool {
  return tool === 'pen' || tool === 'highlighter' || tool === 'pencil';
}

export interface Stroke {
  readonly type: 'stroke';
  id: ID;
  tool: StrokeTool;
  color: string;
  /** Nominal width in document units (already scaled for the tool). */
  size: number;
  opacity: number;
  /** Quantized x coordinates (document units × QUANT). */
  xs: Int16Array;
  /** Quantized y coordinates (document units × QUANT). */
  ys: Int16Array;
  /** Pressure per point, 0–255. Constant 127 for mouse/finger input. */
  ps: Uint8Array;
  seed: number;
  /** Cached bounds in document units; recomputed from the point arrays. */
  bbox: Rect;
}

export type LinkTarget = { kind: 'url'; href: string } | { kind: 'page'; pageId: ID };

export interface TextBox {
  readonly type: 'text';
  id: ID;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  bold?: boolean;
  italic?: boolean;
  link?: LinkTarget;
  /** Sticky-note styling: filled background instead of transparent. */
  sticky?: { color: string };
}

export interface ImageObject {
  readonly type: 'image';
  id: ID;
  assetId: ID;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  /** Normalised (0–1) source crop window. */
  crop: Rect;
  opacity: number;
  link?: LinkTarget;
}

export interface ShapeObject {
  readonly type: 'shape';
  id: ID;
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  color: string;
  fill: string | null;
  size: number;
  opacity: number;
}

export interface HighlightObject {
  readonly type: 'highlight';
  id: ID;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  opacity: number;
}

export type SceneObject = Stroke | TextBox | ImageObject | ShapeObject | HighlightObject;

export type ObjectType = SceneObject['type'];

export function isStroke(o: SceneObject): o is Stroke {
  return o.type === 'stroke';
}

/** Objects that carry an axis-aligned box + rotation transform. */
export type BoxObject = TextBox | ImageObject | ShapeObject;
export type BoxObjectType = BoxObject['type'];

export function isBoxObject(o: SceneObject): o is BoxObject {
  return o.type === 'text' || o.type === 'image' || o.type === 'shape';
}

export type PageBackground =
  | { kind: 'template'; template: TemplateKind }
  | { kind: 'pdf'; assetId: ID; pdfPage: number };

export type PageRotation = 0 | 90 | 180 | 270;

export interface Page {
  id: ID;
  notebookId: ID;
  /** Position inside the notebook; kept in sync by the document. */
  index: number;
  /** Unrotated page size in document units. */
  width: number;
  height: number;
  rotation: PageRotation;
  background: PageBackground;
  paperColor: string;
  objects: SceneObject[];
  updatedAt: number;
}

export interface NotebookCover {
  pageId: ID;
  /** Small PNG of the first page, refreshed by autosave. */
  thumb?: Blob;
}

export interface Notebook {
  id: ID;
  title: string;
  folderId: ID | null;
  createdAt: number;
  updatedAt: number;
  /** Number of pages; cached so the library grid needs no page query. */
  pageCount: number;
  cover?: NotebookCover;
  defaultTemplate: TemplateKind;
  paperColor: string;
  /** Denormalised lowercase text used by library search. */
  searchText: string;
}

export interface Folder {
  id: ID;
  name: string;
  parentId: ID | null;
  createdAt: number;
  updatedAt: number;
}

export type AssetKind = 'pdf' | 'image';

export interface Asset {
  id: ID;
  kind: AssetKind;
  name: string;
  mime: string;
  bytes: Blob;
  /** PDFs only. */
  pageCount?: number;
  /** Images only. */
  width?: number;
  height?: number;
  createdAt: number;
}

/** Asset without the blob payload — blobs live in IndexedDB and are loaded on demand. */
export type AssetMeta = Omit<Asset, 'bytes'>;

export interface Bookmark {
  id: ID;
  notebookId: ID;
  pageId: ID;
  label: string;
  /** `pdf` bookmarks come from the imported document outline, `user` are hand made. */
  source: 'user' | 'pdf';
  createdAt: number;
}

export interface OutlineItem {
  id: ID;
  notebookId: ID;
  pageId: ID | null;
  label: string;
  depth: number;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export const PAGE_SIZES = {
  a4: { width: 595, height: 842 },
  letter: { width: 612, height: 792 },
  square: { width: 768, height: 768 },
  /** 4:3 slides-ish */
  wide: { width: 960, height: 720 },
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

export function objectBBox(o: SceneObject): Rect {
  switch (o.type) {
    case 'stroke':
      return o.bbox;
    default:
      return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
}

/** Object bounds accounting for rotation (axis-aligned hull of the rotated box). */
export function objectBounds(o: SceneObject): Rect {
  const b = objectBBox(o);
  if (o.type === 'stroke' || o.type === 'highlight' || !o.rotation) return b;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const cos = Math.cos(o.rotation);
  const sin = Math.sin(o.rotation);
  const hw = b.w / 2;
  const hh = b.h / 2;
  const xs = [
    cx + hw * cos - hh * sin,
    cx + hw * cos + hh * sin,
    cx - hw * cos - hh * sin,
    cx - hw * cos + hh * sin,
  ];
  const ys = [
    cy + hw * sin + hh * cos,
    cy + hw * sin - hh * cos,
    cy - hw * sin + hh * cos,
    cy - hw * sin - hh * cos,
  ];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function defaultPaperColor(isDark: boolean): string {
  return isDark ? '#1f2430' : '#ffffff';
}
