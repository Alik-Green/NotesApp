/**
 * Stroke construction and outline generation. Pure: no DOM, no React.
 *
 * Ink is stored as quantized typed arrays (`xs`/`ys` in 1/QUANT units, `ps` 0–255) which
 * keeps documents small and makes serialization a straight base64 encode. Rendering,
 * hit-testing and PDF/SVG export all rebuild outlines from those arrays through
 * `strokeOutline`, which is memoised per stroke instance.
 */

import { getStroke } from 'perfect-freehand';
import { hashString, seededRandom } from './ids';
import { QUANT, type Stroke, type StrokeTool } from './model';
import { rect, rectFromPoints, simplifyFlat, type Rect, type Vec2 } from './geometry';

export interface InputPoint {
  x: number;
  y: number;
  /** 0–1; 0.5 for mouse/finger. */
  pressure: number;
  time?: number;
}

export interface StrokeStyle {
  tool: StrokeTool;
  color: string;
  /** Nominal width in document units. */
  size: number;
  opacity: number;
}

export interface BuildStrokeOptions extends StrokeStyle {
  id: string;
  /** Drop points closer than this (document units) to keep arrays compact. */
  minDistance?: number;
  /** RDP tolerance applied before quantization. */
  simplifyTolerance?: number;
  seed?: number;
}

/** Styles copied into the document model, used by the UI palette. */
export const TOOL_DEFAULTS: Record<StrokeTool, StrokeStyle> = {
  pen: { tool: 'pen', color: '#111827', size: 2.4, opacity: 1 },
  highlighter: { tool: 'highlighter', color: '#fde047', size: 18, opacity: 0.4 },
  pencil: { tool: 'pencil', color: '#374151', size: 2, opacity: 0.85 },
};

export const HIGHLIGHTER_CAP: 'flat' | 'round' = 'flat';

function clampPressure(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0.5;
  return p > 1 ? 1 : p;
}

/**
 * Convert raw input points into the compact stored form.
 * Points are simplified (RDP) then quantized into Int16 arrays.
 */
export function buildStroke(inputPoints: readonly InputPoint[], options: BuildStrokeOptions): Stroke {
  const minDistance = options.minDistance ?? 0.6;
  const tolerance = options.simplifyTolerance ?? defaultTolerance(options.size);

  // 1. distance filter — keeps long strokes from ballooning
  const filtered: number[] = [];
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  for (const p of inputPoints) {
    if (Number.isNaN(lastX) || Math.hypot(p.x - lastX, p.y - lastY) >= minDistance) {
      filtered.push(p.x, p.y, clampPressure(p.pressure));
      lastX = p.x;
      lastY = p.y;
    }
  }
  if (filtered.length === 0 && inputPoints.length > 0) {
    const p = inputPoints[inputPoints.length - 1]!;
    filtered.push(p.x, p.y, clampPressure(p.pressure));
  }

  // 2. RDP on x/y only, carrying pressure through
  const xs: number[] = [];
  const ys: number[] = [];
  const ps: number[] = [];
  if (filtered.length > 0) {
    const flatXY: number[] = [];
    for (let i = 0; i < filtered.length; i += 3) flatXY.push(filtered[i]!, filtered[i + 1]!);
    const kept = simplifyFlat(flatXY, tolerance);
    for (let i = 0; i < kept.length; i += 2) {
      const x = kept[i]!;
      const y = kept[i + 1]!;
      // find the matching original pressure (nearest index)
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let j = 0; j < filtered.length; j += 3) {
        const d = (filtered[j]! - x) ** 2 + (filtered[j + 1]! - y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestIdx = j;
        }
      }
      xs.push(x);
      ys.push(y);
      ps.push(filtered[bestIdx + 2]!);
    }
  }

  // 3. quantize
  const n = xs.length;
  const qx = new Int16Array(n);
  const qy = new Int16Array(n);
  const qp = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    qx[i] = Math.round(xs[i]! * QUANT);
    qy[i] = Math.round(ys[i]! * QUANT);
    qp[i] = Math.round(ps[i]! * 255);
  }

  const seed = options.seed ?? hashString(`${options.id}:${n}:${qx[0] ?? 0},${qy[0] ?? 0}`);

  const stroke: Stroke = {
    type: 'stroke',
    id: options.id,
    tool: options.tool,
    color: options.color,
    size: options.size,
    opacity: options.opacity,
    xs: qx,
    ys: qy,
    ps: qp,
    seed,
    bbox: rect(0, 0, 0, 0),
  };
  stroke.bbox = strokeBounds(stroke);
  return stroke;
}

function defaultTolerance(size: number): number {
  return Math.max(0.12, Math.min(0.6, size * 0.12));
}

/** Number of stored points. */
export function strokePointCount(stroke: Stroke): number {
  return stroke.xs.length;
}

export function pointAt(stroke: Stroke, i: number): Vec2 {
  return { x: stroke.xs[i]! / QUANT, y: stroke.ys[i]! / QUANT };
}

export function pressureAt(stroke: Stroke, i: number): number {
  return stroke.ps[i]! / 255;
}

export function strokeBounds(stroke: Stroke): Rect {
  const n = stroke.xs.length;
  if (n === 0) return rect(0, 0, 0, 0);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = stroke.xs[i]!;
    const y = stroke.ys[i]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = stroke.size / 2 + 1;
  return rect(minX / QUANT - pad, minY / QUANT - pad, (maxX - minX) / QUANT + pad * 2, (maxY - minY) / QUANT + pad * 2);
}

export interface FreehandOptions {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
  easing?: (t: number) => number;
  startCap: boolean;
  endCap: boolean;
  simulatePressure: boolean;
  last: boolean;
}

export function freehandOptionsFor(stroke: Pick<Stroke, 'tool' | 'size'>, last: boolean): FreehandOptions {
  switch (stroke.tool) {
    case 'highlighter':
      return {
        size: stroke.size,
        thinning: 0,
        smoothing: 0.55,
        streamline: 0.65,
        startCap: HIGHLIGHTER_CAP === 'round',
        endCap: HIGHLIGHTER_CAP === 'round',
        simulatePressure: false,
        last,
      };
    case 'pencil':
      return {
        size: stroke.size,
        thinning: 0.82,
        smoothing: 0.62,
        streamline: 0.45,
        startCap: true,
        endCap: true,
        simulatePressure: false,
        last,
      };
    case 'pen':
    default:
      return {
        size: stroke.size,
        thinning: 0.6,
        smoothing: 0.5,
        streamline: 0.38,
        startCap: true,
        endCap: true,
        simulatePressure: false,
        last,
      };
  }
}

const outlineCache = new WeakMap<Stroke, number[][][]>();

/**
 * Outline polygon(s) in document units. Returns `[outer]` — perfect-freehand can return a
 * single polygon for a stroke; we always return an array so callers can iterate paths.
 */
export function strokeOutline(stroke: Stroke, last = true): number[][] {
  const n = stroke.xs.length;
  if (n === 0) return [];
  let perLast: number[][][] | undefined = outlineCache.get(stroke);
  if (!perLast) {
    perLast = [[], []];
    outlineCache.set(stroke, perLast);
  }
  const slot = last ? 0 : 1;
  const cached = perLast[slot]!;
  if (cached.length > 0) return cached;

  const opts = freehandOptionsFor(stroke, last);
  const pts: number[][] = new Array(n);
  if (n === 1) {
    // Single tap → dot. perfect-freehand needs a duplicate point to build a shape.
    pts[0] = [stroke.xs[0]! / QUANT, stroke.ys[0]! / QUANT, pressureAt(stroke, 0)];
    pts.push([stroke.xs[0]! / QUANT + 0.01, stroke.ys[0]! / QUANT + 0.01, pressureAt(stroke, 0)]);
  } else {
    for (let i = 0; i < n; i++) {
      pts[i] = [stroke.xs[i]! / QUANT, stroke.ys[i]! / QUANT, pressureAt(stroke, i)];
    }
  }

  const outline = getStroke(pts, {
    size: opts.size,
    thinning: opts.thinning,
    smoothing: opts.smoothing,
    streamline: opts.streamline,
    simulatePressure: opts.simulatePressure,
    start: { cap: opts.startCap, taper: 0 },
    end: { cap: opts.endCap, taper: 0 },
    last,
  });

  const poly = outline as unknown as number[][];
  cached.push(...poly);
  return cached;
}

/** SVG path data (`M…Z` per sub-path) for a stroke outline — used by PDF and SVG export. */
export function strokePathData(stroke: Stroke, outline?: number[][]): string {
  const points = outline ?? strokeOutline(stroke, true);
  return outlineToPathData(points);
}

export function outlineToPathData(points: readonly number[][]): string {
  if (points.length === 0) return '';
  let d = '';
  let subPath = '';
  for (const p of points) {
    const x = p[0] ?? 0;
    const y = p[1] ?? 0;
    if (subPath === '') subPath = `M ${round2(x)} ${round2(y)}`;
    else subPath += ` L ${round2(x)} ${round2(y)}`;
  }
  if (subPath !== '') d = `${subPath} Z`;
  return d;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Deterministic pencil texture samples. Each sample is a short segment drawn with
 * low alpha, offset from the centre line, producing a graphite-ish grain.
 */
export interface TextureSample {
  x: number;
  y: number;
  r: number;
  alpha: number;
}

export function pencilTexture(stroke: Stroke, samplesPerSegment = 2): TextureSample[] {
  const n = stroke.xs.length;
  const out: TextureSample[] = [];
  if (n === 0) return out;
  const rand = seededRandom(stroke.seed);
  const count = n === 1 ? 6 : Math.min(600, n * samplesPerSegment);
  const radius = stroke.size / 2;
  for (let i = 0; i < count; i++) {
    const t = i / Math.max(1, count - 1);
    const idx = Math.min(n - 1, Math.floor(t * (n - 1)));
    const x = stroke.xs[idx]! / QUANT;
    const y = stroke.ys[idx]! / QUANT;
    const angle = rand() * Math.PI * 2;
    const dist = rand() * radius * 0.9;
    out.push({
      x: x + Math.cos(angle) * dist,
      y: y + Math.sin(angle) * dist,
      r: Math.max(0.4, radius * (0.35 + rand() * 0.5)),
      alpha: 0.16 + rand() * 0.24,
    });
  }
  return out;
}

/** Apply a per-point affine transform (used by move/resize/rotate commands). */
export function transformStroke(
  stroke: Stroke,
  fn: (p: Vec2, i: number, pressure: number) => Vec2,
): Stroke {
  const n = stroke.xs.length;
  const xs = new Int16Array(n);
  const ys = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const p = fn({ x: stroke.xs[i]! / QUANT, y: stroke.ys[i]! / QUANT }, i, pressureAt(stroke, i));
    xs[i] = clampInt16(Math.round(p.x * QUANT));
    ys[i] = clampInt16(Math.round(p.y * QUANT));
  }
  const next: Stroke = { ...stroke, xs, ys, ps: stroke.ps.slice() };
  next.bbox = strokeBounds(next);
  return next;
}

function clampInt16(v: number): number {
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

/** Split a stroke at the given index ranges (pixel eraser). Keeps pressure + style. */
export function sliceStroke(stroke: Stroke, from: number, to: number): Stroke | null {
  const n = stroke.xs.length;
  const start = Math.max(0, from);
  const end = Math.min(n, to);
  if (end - start < (start === 0 || end === n ? 1 : 2)) return null;
  const next: Stroke = {
    ...stroke,
    xs: stroke.xs.slice(start, end),
    ys: stroke.ys.slice(start, end),
    ps: stroke.ps.slice(start, end),
  };
  next.bbox = strokeBounds(next);
  return next;
}

export function boundsOfStrokes(strokes: readonly Stroke[]): Rect {
  return rectFromPoints(
    strokes.flatMap((s) => [
      { x: s.bbox.x, y: s.bbox.y },
      { x: s.bbox.x + s.bbox.w, y: s.bbox.y + s.bbox.h },
    ]),
  );
}
