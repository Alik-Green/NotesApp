/**
 * Hit-testing, lasso selection and eraser queries. Pure functions over the document model;
 * they consult the page's rbush index through `PageModel` but never touch the DOM.
 */

import type { ID, SceneObject, ShapeObject, Stroke } from './model';
import { objectBounds } from './model';
import type { PageModel } from './document';
import { QUANT } from './model';
import {
  pointInPolygon,
  pointPolylineDistanceSq,
  pointStrokeDistanceSq,
  polygonContainsPolygon,
  polygonContainsRect,
  rectContainsPoint,
  rectExpand,
  segmentIntersectsRect,
  type Rect,
  type Vec2,
} from './geometry';
import { newId } from './ids';
import { sliceStroke } from './stroke';

export interface HitOptions {
  /** Extra tolerance in document units (e.g. finger-sized slop). */
  tolerance?: number;
  /** When false, only the topmost object is returned. */
  includeAll?: boolean;
}

export function shapeHasFill(shape: ShapeObject): boolean {
  return shape.fill !== null && shape.shape !== 'line' && shape.shape !== 'arrow';
}

export function hitTestObject(object: SceneObject, point: Vec2, tolerance = 2): boolean {
  switch (object.type) {
    case 'stroke': {
      const reach = object.size / 2 + tolerance;
      return pointStrokeDistanceSq(point, object.xs, object.ys, 1 / QUANT) <= reach * reach;
    }
    case 'highlight': {
      const r: Rect = { x: object.x, y: object.y, w: object.w, h: object.h };
      return rectContainsPoint(rectExpand(r, tolerance), point);
    }
    default: {
      const local = toLocalPoint(object, point);
      const r: Rect = { x: 0, y: 0, w: object.w, h: object.h };
      if (object.type === 'shape' && object.shape === 'ellipse') {
        if (!rectContainsPoint(rectExpand(r, tolerance), local)) return false;
        const rx = object.w / 2 || 1;
        const ry = object.h / 2 || 1;
        const nx = (local.x - rx) / (rx + tolerance);
        const ny = (local.y - ry) / (ry + tolerance);
        return nx * nx + ny * ny <= 1;
      }
      if (object.type === 'shape' && object.shape === 'line') {
        const a = { x: 0, y: 0 };
        const b = { x: object.w, y: object.h };
        const reach = object.size / 2 + tolerance;
        return pointPolylineDistanceSq(local, [a.x, a.y, b.x, b.y]) <= reach * reach;
      }
      if (object.type === 'shape' && object.shape === 'triangle') {
        if (object.fill === null) {
          const { x, y, w, h } = r;
          const edges: [Vec2, Vec2][] = [
            [{ x, y: y + h }, { x: x + w / 2, y }],
            [{ x: x + w / 2, y }, { x: x + w, y: y + h }],
            [{ x: x + w, y: y + h }, { x, y: y + h }],
          ];
          const reach = object.size / 2 + tolerance;
          return edges.some(
            ([p1, p2]) =>
              pointPolylineDistanceSq(local, [p1.x, p1.y, p2.x, p2.y]) <= reach * reach,
          );
        }
        return pointInPolygon(local, [
          { x: r.x, y: r.y + r.h },
          { x: r.x + r.w / 2, y: r.y },
          { x: r.x + r.w, y: r.y + r.h },
        ]);
      }
      return rectContainsPoint(rectExpand(r, tolerance), local);
    }
  }
}

/** Convert a page-space point into an object's unrotated local space. */
export function toLocalPoint(
  object: { x: number; y: number; w: number; h: number; rotation: number },
  point: Vec2,
): Vec2 {
  const cx = object.x + object.w / 2;
  const cy = object.y + object.h / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const cos = Math.cos(-object.rotation);
  const sin = Math.sin(-object.rotation);
  return {
    x: dx * cos - dy * sin + object.w / 2,
    y: dx * sin + dy * cos + object.h / 2,
  };
}

/** Topmost object under `point` (or all of them, ordered top→bottom). */
export function hitTestPage(
  page: PageModel,
  point: Vec2,
  options: HitOptions = {},
): SceneObject[] {
  const tolerance = options.tolerance ?? 2;
  const searchRadius = tolerance + 24;
  const candidates = page.searchIds({
    x: point.x - searchRadius,
    y: point.y - searchRadius,
    w: searchRadius * 2,
    h: searchRadius * 2,
  });
  const found: SceneObject[] = [];
  for (const id of candidates) {
    const object = page.get(id);
    if (object && hitTestObject(object, point, tolerance)) found.push(object);
  }
  // Sort by z-order (array index), topmost first.
  const order = new Map<ID, number>();
  page.objects.forEach((o, i) => order.set(o.id, i));
  found.sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  return options.includeAll ? found : found.slice(0, 1);
}

/** Objects whose bounds intersect the rect (marquee selection). */
export function objectsInRect(page: PageModel, area: Rect): SceneObject[] {
  return page
    .searchObjects(area)
    .filter((o) => objectFullyInRect(o, area) || objectTouchesRect(o, area));
}

function objectFullyInRect(o: SceneObject, area: Rect): boolean {
  const b = objectBounds(o);
  return b.x >= area.x && b.y >= area.y && b.x + b.w <= area.x + area.w && b.y + b.h <= area.y + area.h;
}

function objectTouchesRect(o: SceneObject, area: Rect): boolean {
  const b = objectBounds(o);
  return !(b.x + b.w < area.x || b.x > area.x + area.w || b.y + b.h < area.y || b.y > area.y + area.h);
}

export interface LassoOptions {
  /** `contain` selects only objects fully inside the loop; `intersect` also catches partial hits. */
  mode?: 'contain' | 'intersect';
  tolerance?: number;
}

/** Objects selected by a lasso loop, in z-order (bottom → top). */
export function objectsInLasso(
  page: PageModel,
  polygon: readonly Vec2[],
  options: LassoOptions = {},
): SceneObject[] {
  const mode = options.mode ?? 'contain';
  const tolerance = options.tolerance ?? 1;
  if (polygon.length < 3) return [];
  let bounds: Rect | null = null;
  for (const p of polygon) {
    bounds = bounds
      ? {
          x: Math.min(bounds.x, p.x),
          y: Math.min(bounds.y, p.y),
          w: Math.max(bounds.x + bounds.w, p.x) - Math.min(bounds.x, p.x),
          h: Math.max(bounds.y + bounds.h, p.y) - Math.min(bounds.y, p.y),
        }
      : { x: p.x, y: p.y, w: 0, h: 0 };
  }
  if (!bounds) return [];
  const candidates = page.searchObjects(bounds);
  const selected: SceneObject[] = [];
  for (const object of candidates) {
    if (mode === 'contain') {
      if (object.type === 'stroke') {
        const points: Vec2[] = [];
        for (let i = 0; i < object.xs.length; i++) {
          points.push({ x: object.xs[i]! / QUANT, y: object.ys[i]! / QUANT });
        }
        if (polygonContainsPolygon(polygon, points)) selected.push(object);
      } else {
        const b = objectBounds(object);
        // Rotation-aware: test the four rotated corners plus the axis-aligned hull.
        if (polygonContainsRect(polygon, rectExpand(b, tolerance))) selected.push(object);
      }
    } else if (lassoIntersectsObject(object, polygon, tolerance)) {
      selected.push(object);
    }
  }
  return selected;
}

function lassoIntersectsObject(object: SceneObject, polygon: readonly Vec2[], tolerance: number): boolean {
  if (object.type === 'stroke') {
    for (let i = 0; i < object.xs.length; i++) {
      const p = { x: object.xs[i]! / QUANT, y: object.ys[i]! / QUANT };
      if (pointInPolygon(p, polygon)) return true;
    }
    return false;
  }
  const b = objectBounds(object);
  if (pointInPolygon({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, polygon)) return true;
  // Edge crossing test in both directions.
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    if (segmentIntersectsRect(a, next, b)) return true;
  }
  const corners: Vec2[] = [
    { x: b.x - tolerance, y: b.y - tolerance },
    { x: b.x + b.w + tolerance, y: b.y - tolerance },
    { x: b.x + b.w + tolerance, y: b.y + b.h + tolerance },
    { x: b.x - tolerance, y: b.y + b.h + tolerance },
  ];
  return corners.some((c) => pointInPolygon(c, polygon));
}

/** Stroke eraser: every stroke the eraser circle touches. */
export function strokesAt(page: PageModel, point: Vec2, radius: number): Stroke[] {
  const area: Rect = { x: point.x - radius, y: point.y - radius, w: radius * 2, h: radius * 2 };
  const out: Stroke[] = [];
  for (const object of page.searchObjects(area)) {
    if (object.type !== 'stroke') continue;
    const reach = radius + object.size / 2;
    if (pointStrokeDistanceSq(point, object.xs, object.ys, 1 / QUANT) <= reach * reach) out.push(object);
  }
  return out;
}

/**
 * Pixel (partial) eraser: split a stroke wherever it passes under the eraser segment
 * `a`→`b`. Returns the surviving fragments (may be empty when the whole stroke is erased).
 */
export function splitStrokeByEraser(
  stroke: Stroke,
  a: Vec2,
  b: Vec2,
  radius: number,
): Stroke[] {
  const n = stroke.xs.length;
  if (n === 0) return [];
  const reach = radius + stroke.size / 2;
  const reachSq = reach * reach;
  const covered = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = { x: stroke.xs[i]! / QUANT, y: stroke.ys[i]! / QUANT };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let d: number;
    if (lenSq < 1e-6) {
      d = (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
    } else {
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d = (p.x - (a.x + dx * t)) ** 2 + (p.y - (a.y + dy * t)) ** 2;
    }
    if (d <= reachSq) covered[i] = 1;
  }

  const fragments: Stroke[] = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (!covered[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const fragment = sliceStroke(stroke, start, i);
      if (fragment) fragments.push({ ...fragment, id: newId('ob') });
      start = -1;
    }
  }
  if (start >= 0) {
    const fragment = sliceStroke(stroke, start, n);
    if (fragment) fragments.push({ ...fragment, id: newId('ob') });
  }
  return fragments;
}

export function objectIds(objects: readonly SceneObject[]): ID[] {
  return objects.map((o) => o.id);
}
