/**
 * Pure 2D geometry helpers. No DOM, no React — safe to unit test in Node.
 *
 * Conventions: page space is measured in document units ("points", 1 unit = 1/72 inch
 * for PDF-backed pages). Rect is axis-aligned `{x, y, w, h}`. Angles are radians.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EPSILON = 1e-6;

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export function rectFromPoints(points: readonly Vec2[], pad = 0): Rect {
  if (points.length === 0) return rect(0, 0, 0, 0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return rect(minX - pad, minY - pad, maxX - minX + 2 * pad, maxY - minY + 2 * pad);
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rectRight(r: Rect): number {
  return r.x + r.w;
}

export function rectBottom(r: Rect): number {
  return r.y + r.h;
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(rectRight(a), rectRight(b));
  const bottom = Math.max(rectBottom(a), rectBottom(b));
  return rect(x, y, right - x, bottom - y);
}

export function rectUnionAll(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return rect(0, 0, 0, 0);
  let out = rects[0]!;
  for (let i = 1; i < rects.length; i++) out = rectUnion(out, rects[i]!);
  return out;
}

export function rectExpand(r: Rect, by: number): Rect {
  return rect(r.x - by, r.y - by, r.w + 2 * by, r.h + 2 * by);
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return !(rectRight(a) < b.x || rectRight(b) < a.x || rectBottom(a) < b.y || rectBottom(b) < a.y);
}

export function rectContainsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    rectRight(inner) <= rectRight(outer) + EPSILON &&
    rectBottom(inner) <= rectBottom(outer) + EPSILON
  );
}

export function rectContainsPoint(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x <= rectRight(r) && p.y >= r.y && p.y <= rectBottom(r);
}

export function rectsEqual(a: Rect, b: Rect, tolerance = 0.5): boolean {
  return (
    Math.abs(a.x - b.x) <= tolerance &&
    Math.abs(a.y - b.y) <= tolerance &&
    Math.abs(a.w - b.w) <= tolerance &&
    Math.abs(a.h - b.h) <= tolerance
  );
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Squared distance from point `p` to segment `a`-`b`. */
export function pointSegmentDistanceSq(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < EPSILON) return apx * apx + apy * apy;
  let t = (apx * abx + apy * aby) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return dx * dx + dy * dy;
}

/**
 * Squared distance from a point to a stroke's centre line, given its separate quantized
 * x/y channels (see `Stroke`). `scale` converts stored values into document units.
 */
export function pointStrokeDistanceSq(
  p: Vec2,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  scale = 1,
): number {
  const count = xs.length;
  if (count === 0) return Infinity;
  if (count === 1) {
    const dx = p.x - xs[0]! * scale;
    const dy = p.y - ys[0]! * scale;
    return dx * dx + dy * dy;
  }
  let best = Infinity;
  let prevX = xs[0]! * scale;
  let prevY = ys[0]! * scale;
  for (let i = 1; i < count; i++) {
    const x = xs[i]! * scale;
    const y = ys[i]! * scale;
    const d = pointSegmentDistanceSq(p, { x: prevX, y: prevY }, { x, y });
    if (d < best) best = d;
    prevX = x;
    prevY = y;
  }
  return best;
}

/** Shortest distance from a point to a polyline given as a flat [x,y,x,y,…] array. */
export function pointPolylineDistanceSq(p: Vec2, flat: ArrayLike<number>, scale = 1): number {
  const count = Math.floor(flat.length / 2);
  if (count === 0) return Infinity;
  if (count === 1) {
    const dx = p.x - flat[0]! * scale;
    const dy = p.y - flat[1]! * scale;
    return dx * dx + dy * dy;
  }
  let best = Infinity;
  let prevX = flat[0]! * scale;
  let prevY = flat[1]! * scale;
  for (let i = 1; i < count; i++) {
    const x = flat[i * 2]! * scale;
    const y = flat[i * 2 + 1]! * scale;
    const d = pointSegmentDistanceSq(p, { x: prevX, y: prevY }, { x, y });
    if (d < best) best = d;
    prevX = x;
    prevY = y;
  }
  return best;
}

export function segmentIntersectsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  if (rectContainsPoint(r, a) || rectContainsPoint(r, b)) return true;
  const corners: Vec2[] = [
    { x: r.x, y: r.y },
    { x: rectRight(r), y: r.y },
    { x: rectRight(r), y: rectBottom(r) },
    { x: r.x, y: rectBottom(r) },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(a, b, corners[i]!, corners[(i + 1) % 4]!)) return true;
  }
  return false;
}

/** True when the polyline touches the rect (used by the split/pixel eraser). */
export function polylineIntersectsRect(flat: ArrayLike<number>, r: Rect, scale = 1): boolean {
  const count = Math.floor(flat.length / 2);
  if (count === 0) return false;
  if (count === 1) {
    return rectContainsPoint(r, { x: flat[0]! * scale, y: flat[1]! * scale });
  }
  for (let i = 1; i < count; i++) {
    const a = { x: flat[(i - 1) * 2]! * scale, y: flat[(i - 1) * 2 + 1]! * scale };
    const b = { x: flat[i * 2]! * scale, y: flat[i * 2 + 1]! * scale };
    if (segmentIntersectsRect(a, b, r)) return true;
  }
  return false;
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
}

export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersects =
      pi.y > p.y !== pj.y > p.y && p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Rectangle fully inside the polygon? Used for "lasso selects what it fully surrounds". */
export function polygonContainsRect(polygon: readonly Vec2[], r: Rect): boolean {
  const corners: Vec2[] = [
    { x: r.x, y: r.y },
    { x: rectRight(r), y: r.y },
    { x: rectRight(r), y: rectBottom(r) },
    { x: r.x, y: rectBottom(r) },
  ];
  if (!corners.every((c) => pointInPolygon(c, polygon))) return false;
  // Guard against concave polygons that contain all corners but cut through an edge.
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    for (let j = 0, k = polygon.length - 1; j < polygon.length; k = j++) {
      if (segmentsIntersect(a, b, polygon[j]!, polygon[k]!)) return false;
    }
  }
  return true;
}

export function polygonContainsPolygon(polygon: readonly Vec2[], other: readonly Vec2[]): boolean {
  for (const p of other) if (!pointInPolygon(p, polygon)) return false;
  return true;
}

export function rotatePoint(p: Vec2, pivot: Vec2, angle: number): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos };
}

export interface Transform {
  /** Translation applied after scaling/rotation, in document units. */
  tx: number;
  ty: number;
  scaleX: number;
  scaleY: number;
  /** Rotation in radians around `pivot`. */
  rotation: number;
  pivot: Vec2;
}

export function identityTransform(): Transform {
  return { tx: 0, ty: 0, scaleX: 1, scaleY: 1, rotation: 0, pivot: { x: 0, y: 0 } };
}

export function applyTransform(p: Vec2, t: Transform): Vec2 {
  let x = p.x;
  let y = p.y;
  const px = t.pivot.x;
  const py = t.pivot.y;
  x = px + (x - px) * t.scaleX;
  y = py + (y - py) * t.scaleY;
  if (t.rotation !== 0) {
    const cos = Math.cos(t.rotation);
    const sin = Math.sin(t.rotation);
    const dx = x - px;
    const dy = y - py;
    x = px + dx * cos - dy * sin;
    y = py + dx * sin + dy * cos;
  }
  return { x: x + t.tx, y: y + t.ty };
}

export function transformIsIdentity(t: Transform): boolean {
  return (
    t.tx === 0 &&
    t.ty === 0 &&
    t.scaleX === 1 &&
    t.scaleY === 1 &&
    t.rotation === 0
  );
}

export function composeTransforms(a: Transform, b: Transform): Transform {
  // Apply `a` then `b`.
  const pivot = a.pivot;
  const scaledPivot = applyTransform(pivot, b);
  return {
    tx: a.tx * b.scaleX + b.tx,
    ty: a.ty * b.scaleY + b.ty,
    scaleX: a.scaleX * b.scaleX,
    scaleY: a.scaleY * b.scaleY,
    rotation: a.rotation + b.rotation,
    pivot: scaledPivot,
  };
}

/** Average scale factor of a transform — used to keep stroke widths sane while resizing. */
export function transformScale(t: Transform): number {
  return Math.sqrt(Math.abs(t.scaleX * t.scaleY)) || 1;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Ramer–Douglas–Peucker simplification of a flat point array. */
export function simplifyFlat(flat: readonly number[], tolerance: number): number[] {
  const n = Math.floor(flat.length / 2);
  if (n <= 2 || tolerance <= 0) return Array.from(flat);
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tolSq = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last - first < 2) continue;
    const a = { x: flat[first * 2]!, y: flat[first * 2 + 1]! };
    const b = { x: flat[last * 2]!, y: flat[last * 2 + 1]! };
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const p = { x: flat[i * 2]!, y: flat[i * 2 + 1]! };
      const d = pointSegmentDistanceSq(p, a, b);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (maxDist > tolSq && index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(flat[i * 2]!, flat[i * 2 + 1]!);
  }
  return out;
}

/** Catmull-Rom style smoothing for freehand input jitter (keeps endpoints). */
export function smoothFlat(flat: readonly number[], strength = 0.5): number[] {
  const n = Math.floor(flat.length / 2);
  if (n < 3) return Array.from(flat);
  const out = new Array<number>(flat.length);
  out[0] = flat[0]!;
  out[1] = flat[1]!;
  for (let i = 1; i < n - 1; i++) {
    const mx = (flat[(i - 1) * 2]! + 2 * flat[i * 2]! + flat[(i + 1) * 2]!) / 4;
    const my = (flat[(i - 1) * 2 + 1]! + 2 * flat[i * 2 + 1]! + flat[(i + 1) * 2 + 1]!) / 4;
    out[i * 2] = lerp(flat[i * 2]!, mx, strength);
    out[i * 2 + 1] = lerp(flat[i * 2 + 1]!, my, strength);
  }
  out[(n - 1) * 2] = flat[(n - 1) * 2]!;
  out[(n - 1) * 2 + 1] = flat[(n - 1) * 2 + 1]!;
  return out;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Normalise any angle to [0, 2π). */
export function normalizeAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

export function snapAngleToIncrements(angle: number, increments = 8): number {
  const step = (Math.PI * 2) / increments;
  return Math.round(angle / step) * step;
}
