import { describe, expect, it } from 'vitest';
import { QUANT } from './model';
import {
  buildStroke,
  freehandOptionsFor,
  pointAt,
  sliceStroke,
  strokeBounds,
  strokeOutline,
  strokePathData,
  transformStroke,
} from './stroke';

function line(from = 0, to = 100, count = 20, pressure = 0.5) {
  return Array.from({ length: count }, (_, i) => ({
    x: from + ((to - from) * i) / (count - 1),
    y: 0,
    pressure,
  }));
}

/** Wavy input: keeps every point through simplification, unlike a straight line. */
function wave(count = 24, amplitude = 12, pressure = 0.5) {
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    return { x: t * 200, y: Math.sin(t * Math.PI * 4) * amplitude, pressure };
  });
}

describe('stroke building', () => {
  it('quantizes points into typed arrays', () => {
    const stroke = buildStroke(line(), { id: 's1', tool: 'pen', color: '#000', size: 3, opacity: 1 });
    expect(stroke.xs).toBeInstanceOf(Int16Array);
    expect(stroke.ys).toBeInstanceOf(Int16Array);
    expect(stroke.ps).toBeInstanceOf(Uint8Array);
    expect(stroke.xs.length).toBeGreaterThan(1);
    expect(pointAt(stroke, 0).x).toBeCloseTo(0, 1);
    expect(pointAt(stroke, stroke.xs.length - 1).x).toBeCloseTo(100, 1);
  });

  it('quantization error stays under half a storage step', () => {
    const stroke = buildStroke(line(0, 10, 11), { id: 's2', tool: 'pen', color: '#000', size: 1, opacity: 1 });
    stroke.xs.forEach((value, i) => {
      expect(Math.abs(value / QUANT - 10 * (i / (stroke.xs.length - 1)))).toBeLessThan(1 / QUANT);
    });
  });

  it('drops duplicate points (minDistance)', () => {
    const points = Array.from({ length: 50 }, () => ({ x: 5, y: 5, pressure: 0.5 }));
    const stroke = buildStroke(points, { id: 's3', tool: 'pen', color: '#000', size: 2, opacity: 1 });
    expect(stroke.xs.length).toBeLessThan(5);
  });

  it('computes bounds including stroke width', () => {
    const stroke = buildStroke(line(0, 10), { id: 's4', tool: 'pen', color: '#000', size: 4, opacity: 1 });
    const bounds = strokeBounds(stroke);
    // Bounds are padded by half the stroke width (+1 unit of slack).
    expect(bounds.x).toBeLessThanOrEqual(-2);
    expect(bounds.y).toBeLessThanOrEqual(-2);
    expect(bounds.y).toBeGreaterThan(-4);
    expect(bounds.w).toBeGreaterThan(10);
  });

  it('builds a closed outline for rendering and export', () => {
    const stroke = buildStroke(line(0, 50, 12), { id: 's5', tool: 'pen', color: '#000', size: 4, opacity: 1 });
    const outline = strokeOutline(stroke);
    expect(outline.length).toBeGreaterThan(3);
    const path = strokePathData(stroke);
    expect(path.startsWith('M ')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
  });

  it('highlighter uses a flat tip and no pressure thinning', () => {
    const options = freehandOptionsFor({ tool: 'highlighter', size: 18 }, true);
    expect(options.thinning).toBe(0);
    expect(options.startCap).toBe(false);
    expect(options.endCap).toBe(false);
  });

  it('transforms strokes including rescaling', () => {
    const stroke = buildStroke(line(0, 10, 6), { id: 's6', tool: 'pen', color: '#000', size: 2, opacity: 1 });
    const scaled = transformStroke(stroke, (p) => ({ x: p.x * 2, y: p.y + 5 }));
    expect(pointAt(scaled, 0).y).toBeCloseTo(5, 1);
    expect(scaled.bbox.w).toBeGreaterThan(stroke.bbox.w);
    expect(stroke.xs).not.toBe(scaled.xs);
  });

  it('slices strokes for the pixel eraser', () => {
    const stroke = buildStroke(wave(24), { id: 's7', tool: 'pen', color: '#000', size: 2, opacity: 1 });
    expect(stroke.xs.length).toBeGreaterThan(10);
    const left = sliceStroke(stroke, 0, 4);
    expect(left?.xs.length).toBe(4);
    expect(left?.ps.length).toBe(4);
    expect(sliceStroke(stroke, 3, 3)).toBeNull();
  });

  it('handles a single tap as a dot', () => {
    const stroke = buildStroke([{ x: 3, y: 4, pressure: 0.9 }], {
      id: 's8',
      tool: 'pen',
      color: '#000',
      size: 4,
      opacity: 1,
    });
    expect(stroke.xs.length).toBe(1);
    expect(strokeOutline(stroke).length).toBeGreaterThan(2);
  });
});
