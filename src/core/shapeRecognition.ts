/**
 * Shape recognition for the "hold to snap" gesture: after the user pauses for ~450 ms at the
 * end of a stroke, the ink is replaced by a clean geometric shape.
 *
 * Heuristics (all pure, unit tested):
 *  - straight open path            → line
 *  - closed path, 4 dominant edges → rectangle (axis-aligned bbox of the ink)
 *  - closed path, 3 dominant edges → triangle
 *  - closed path, elliptic area    → ellipse/circle
 */

import { pointSegmentDistanceSq, rectFromPoints, type Rect, type Vec2 } from './geometry';

export type RecognizedKind = 'line' | 'rect' | 'ellipse' | 'triangle';

export interface RecognizedShape {
  kind: RecognizedKind;
  /** Axis-aligned bounds in document units. */
  bounds: Rect;
  /** Start/end points for a line. */
  from?: Vec2;
  to?: Vec2;
  /** How confident the matcher is (0–1); the editor requires ≥ 0.6 to snap. */
  confidence: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;

export function recognizeShape(
  points: readonly Vec2[],
  minConfidence = DEFAULT_MIN_CONFIDENCE,
): RecognizedShape | null {
  if (points.length < 3) return null;
  const pts = dedupe(points);
  if (pts.length < 3) return null;

  const bounds = rectFromPoints(pts);
  const diag = Math.hypot(bounds.w, bounds.h);
  if (diag < 6) return null; // too small to be intentional

  const start = pts[0]!;
  const end = pts[pts.length - 1]!;
  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const closed = gap < Math.max(12, diag * 0.22);

  if (!closed) {
    // Straight line: all points close to the chord.
    const tol = Math.max(1.5, diag * 0.06);
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, Math.sqrt(pointSegmentDistanceSq(p, start, end)));
    if (maxDev <= tol) {
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const confidence = clamp01(1 - maxDev / tol) * 0.5 + clamp01(length / diag) * 0.5;
      if (confidence >= minConfidence) {
        return { kind: 'line', bounds, from: start, to: end, confidence };
      }
    }
    // Open shapes that are nearly closed but not quite: relax and continue.
    if (gap > Math.max(24, diag * 0.4)) return null;
  }

  const closedPath = closed ? [...pts, start] : [...pts, start];
  const pathLength = polylineLength(closedPath);
  const tolerance = Math.max(2, pathLength * 0.035);
  const corners = simplify(closedPath, tolerance);
  // simplify keeps first and last equal for closed loops → drop duplicate
  if (corners.length > 1) {
    const first = corners[0]!;
    const last = corners[corners.length - 1]!;
    if (Math.hypot(first.x - last.x, first.y - last.y) < 1e-6) corners.pop();
  }
  const vertexCount = corners.length;

  const area = Math.abs(polygonArea(closedPath));
  const bboxArea = Math.max(1e-6, bounds.w * bounds.h);
  const fillRatio = area / bboxArea;

  if (vertexCount === 3 && fillRatio < 0.68) {
    return { kind: 'triangle', bounds, confidence: scoreVertices(vertexCount, 3, fillRatio, 0.5) };
  }

  if (vertexCount === 4) {
    const rightAngles = corners.every((c, i) => {
      const prev = corners[(i - 1 + corners.length) % corners.length]!;
      const next = corners[(i + 1) % corners.length]!;
      const angle = angleAt(c, prev, next);
      return Math.abs(angle - Math.PI / 2) < 0.45;
    });
    const rectangular = rightAngles && fillRatio > 0.6;
    const confidence = rectangular ? clamp01(fillRatio) * 0.85 + 0.15 : fillRatio * 0.5;
    if (confidence >= minConfidence) return { kind: 'rect', bounds, confidence };
  }

  // Ellipse: polygon area approaches π/4 ≈ 0.785 of the bounding box.
  const ellipseScore = 1 - Math.abs(fillRatio - Math.PI / 4) / (Math.PI / 4);
  const roundness = smoothness(closedPath, bounds);
  const confidence = clamp01(ellipseScore * 0.7 + roundness * 0.3);
  if (confidence >= minConfidence) return { kind: 'ellipse', bounds, confidence };

  return null;
}

function scoreVertices(actual: number, expected: number, fillRatio: number, targetFill: number): number {
  const vertexScore = actual === expected ? 1 : 0.4;
  const fillScore = clamp01(1 - Math.abs(fillRatio - targetFill) / targetFill);
  return clamp01(vertexScore * 0.7 + fillScore * 0.3);
}

/** How evenly the point spacing matches the ideal ellipse radius (1 = perfect). */
function smoothness(points: readonly Vec2[], bounds: Rect): number {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const rx = bounds.w / 2 || 1;
  const ry = bounds.h / 2 || 1;
  let error = 0;
  for (const p of points) {
    const nx = (p.x - cx) / rx;
    const ny = (p.y - cy) / ry;
    error += Math.abs(Math.hypot(nx, ny) - 1);
  }
  error /= Math.max(1, points.length);
  return clamp01(1 - error * 1.4);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function dedupe(points: readonly Vec2[], tolerance = 0.35): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tolerance) out.push(p);
  }
  if (out.length === 0 && points.length > 0) out.push(points[0]!);
  return out;
}

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return total;
}

export function polygonArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j]!.x + points[i]!.x) * (points[j]!.y - points[i]!.y);
  }
  return area / 2;
}

function angleAt(vertex: Vec2, a: Vec2, b: Vec2): number {
  const v1 = { x: a.x - vertex.x, y: a.y - vertex.y };
  const v2 = { x: b.x - vertex.x, y: b.y - vertex.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const m1 = Math.hypot(v1.x, v1.y) || 1;
  const m2 = Math.hypot(v2.x, v2.y) || 1;
  return Math.acos(Math.max(-1, Math.min(1, dot / (m1 * m2))));
}

/** RDP simplification returning the kept vertices (used to count corners). */
export function simplify(points: readonly Vec2[], tolerance: number): Vec2[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const tolSq = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = pointSegmentDistanceSq(points[i]!, points[first]!, points[last]!);
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
  const out: Vec2[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]!);
  return out;
}
