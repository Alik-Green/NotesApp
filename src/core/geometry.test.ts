import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  composeTransforms,
  identityTransform,
  pointInPolygon,
  pointPolylineDistanceSq,
  polygonContainsRect,
  rectFromPoints,
  rectUnion,
  segmentsIntersect,
  simplifyFlat,
  smoothFlat,
  snapAngleToIncrements,
} from './geometry';

describe('geometry', () => {
  it('builds bounds from points', () => {
    expect(rectFromPoints([{ x: 1, y: 2 }, { x: -3, y: 5 }])).toEqual({ x: -3, y: 2, w: 4, h: 3 });
  });

  it('unions rects', () => {
    expect(rectUnion({ x: 0, y: 0, w: 2, h: 2 }, { x: 5, y: 1, w: 1, h: 1 })).toEqual({
      x: 0,
      y: 0,
      w: 6,
      h: 2,
    });
  });

  it('measures distance from a point to a polyline', () => {
    const flat = [0, 0, 10, 0];
    expect(pointPolylineDistanceSq({ x: 5, y: 3 }, flat)).toBeCloseTo(9, 6);
    expect(pointPolylineDistanceSq({ x: -2, y: 0 }, flat)).toBeCloseTo(4, 6);
  });

  it('detects segment intersections and polygon containment', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 })).toBe(false);
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(polygonContainsRect(square, { x: 1, y: 1, w: 2, h: 2 })).toBe(true);
    expect(polygonContainsRect(square, { x: 9, y: 9, w: 4, h: 4 })).toBe(false);
  });

  it('applies scale, rotation and translation transforms', () => {
    const scaled = applyTransform({ x: 2, y: 0 }, { ...identityTransform(), scaleX: 2, scaleY: 2, pivot: { x: 0, y: 0 } });
    expect(scaled).toEqual({ x: 4, y: 0 });
    const rotated = applyTransform({ x: 1, y: 0 }, { ...identityTransform(), rotation: Math.PI / 2 });
    expect(rotated.x).toBeCloseTo(0, 6);
    expect(rotated.y).toBeCloseTo(1, 6);
    const moved = applyTransform({ x: 1, y: 1 }, { ...identityTransform(), tx: 5, ty: -2 });
    expect(moved).toEqual({ x: 6, y: -1 });
  });

  it('composes transforms as apply a then b', () => {
    const a = { ...identityTransform(), tx: 10 };
    const b = { ...identityTransform(), scaleX: 2, scaleY: 2 };
    const composed = composeTransforms(a, b);
    const direct = applyTransform(applyTransform({ x: 1, y: 0 }, a), b);
    expect(applyTransform({ x: 1, y: 0 }, composed)).toEqual(direct);
  });

  it('simplifies polylines within tolerance', () => {
    const flat = [0, 0, 1, 0.05, 2, 0, 3, 0.05, 4, 0];
    expect(simplifyFlat(flat, 0.5)).toEqual([0, 0, 4, 0]);
    expect(simplifyFlat(flat, 0.01)).toHaveLength(10);
  });

  it('smooths interior points but keeps endpoints', () => {
    const flat = [0, 0, 10, 10, 20, 0];
    const smoothed = smoothFlat(flat, 1);
    expect(smoothed[0]).toBe(0);
    expect(smoothed[1]).toBe(0);
    expect(smoothed[4]).toBe(20);
    expect(smoothed[5]).toBe(0);
    // The spike in the middle is pulled towards its neighbours' average (5).
    expect(smoothed[3]).toBeLessThan(10);
    expect(smoothed[3]).toBeGreaterThan(0);
  });

  it('snaps angles to increments', () => {
    expect(snapAngleToIncrements(0.1, 4)).toBeCloseTo(0, 6);
    expect(snapAngleToIncrements(Math.PI / 2 - 0.05, 4)).toBeCloseTo(Math.PI / 2, 6);
  });
});
