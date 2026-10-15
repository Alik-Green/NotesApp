/**
 * Spatial index over a page's objects. Pure wrapper around rbush so hit-testing,
 * lasso selection and eraser queries stay O(log n) on stroke-heavy pages.
 */

import RBush from 'rbush';
import type { ID, SceneObject } from './model';
import { objectBounds } from './model';
import { rectIntersects, type Rect } from './geometry';

export interface IndexedObject {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  id: ID;
}

function toEntry(o: SceneObject): IndexedObject {
  const b = objectBounds(o);
  return { minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h, id: o.id };
}

export class SpatialIndex {
  private tree = new RBush<IndexedObject>();
  private byId = new Map<ID, IndexedObject>();

  constructor(objects: readonly SceneObject[] = []) {
    this.rebuild(objects);
  }

  rebuild(objects: readonly SceneObject[]): void {
    this.tree.clear();
    this.byId.clear();
    const entries: IndexedObject[] = [];
    for (const o of objects) {
      const e = toEntry(o);
      entries.push(e);
      this.byId.set(o.id, e);
    }
    if (entries.length) this.tree.load(entries);
  }

  insert(o: SceneObject): void {
    const e = toEntry(o);
    this.byId.set(o.id, e);
    this.tree.insert(e);
  }

  remove(id: ID): void {
    const e = this.byId.get(id);
    if (!e) return;
    this.tree.remove(e, (a, b) => a.id === b.id);
    this.byId.delete(id);
  }

  update(o: SceneObject): void {
    this.remove(o.id);
    this.insert(o);
  }

  clear(): void {
    this.tree.clear();
    this.byId.clear();
  }

  get size(): number {
    return this.byId.size;
  }

  has(id: ID): boolean {
    return this.byId.has(id);
  }

  /** Ids of objects whose bounds intersect `area` (broad phase). */
  search(area: Rect): ID[] {
    const found = this.tree.search({
      minX: area.x,
      minY: area.y,
      maxX: area.x + area.w,
      maxY: area.y + area.h,
    });
    return found.map((e) => e.id);
  }

  /** Objects intersecting `area`, resolved against the object map (broad phase). */
  searchObjects(area: Rect, objects: ReadonlyMap<ID, SceneObject>): SceneObject[] {
    const out: SceneObject[] = [];
    for (const id of this.search(area)) {
      const o = objects.get(id);
      if (o) out.push(o);
    }
    return out;
  }

  /** Nearest object centre to `p`, within `radius` — used by the pixel eraser. */
  nearest(p: { x: number; y: number }, objects: ReadonlyMap<ID, SceneObject>, radius: number): SceneObject | null {
    const ids = this.search({ x: p.x - radius, y: p.y - radius, w: radius * 2, h: radius * 2 });
    let best: SceneObject | null = null;
    let bestDist = Infinity;
    for (const id of ids) {
      const o = objects.get(id);
      if (!o) continue;
      const b = objectBounds(o);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      const d = (cx - p.x) ** 2 + (cy - p.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = o;
      }
    }
    return best;
  }
}

/** Convenience: which objects' bounds overlap a rect. */
export function idsInRect(index: SpatialIndex, area: Rect): ID[] {
  return index.search(area);
}

export { rectIntersects };
