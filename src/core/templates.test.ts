import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATE_SPACING, TEMPLATE_LABELS, templateGeometry } from './templates';
import type { TemplateKind } from './model';

const SIZE = { width: 600, height: 800 };
const KINDS: TemplateKind[] = ['blank', 'lined', 'grid', 'dotted', 'cornell'];

describe('templates', () => {
  it('labels every template kind', () => {
    for (const kind of KINDS) {
      expect(TEMPLATE_LABELS[kind]).toBeTruthy();
    }
  });

  it('draws nothing on blank paper', () => {
    const geometry = templateGeometry('blank', SIZE);
    expect(geometry.lines).toEqual([]);
    expect(geometry.dots).toEqual([]);
    expect(geometry.boxes).toEqual([]);
    expect(geometry.kind).toBe('blank');
  });

  it('gives every kind a usable colour and line width', () => {
    for (const kind of KINDS) {
      const geometry = templateGeometry(kind, SIZE);
      expect(geometry.spacing).toBe(DEFAULT_TEMPLATE_SPACING);
      expect(geometry.lineWidth).toBeGreaterThan(0);
      expect(geometry.color).toMatch(/^rgba?\(/);
    }
  });

  it('keeps lines inside the page and evenly spaced', () => {
    const geometry = templateGeometry('lined', SIZE);
    expect(geometry.lines.length).toBeGreaterThan(10);
    for (const [x1, y1, x2, y2] of geometry.lines) {
      expect(y1).toBe(y2);
      expect(x1).toBeGreaterThan(0);
      expect(x2).toBeLessThanOrEqual(SIZE.width);
      expect(y1).toBeGreaterThan(0);
      expect(y1).toBeLessThan(SIZE.height);
    }
    for (let i = 1; i < geometry.lines.length; i++) {
      expect(geometry.lines[i]![1] - geometry.lines[i - 1]![1]).toBeCloseTo(DEFAULT_TEMPLATE_SPACING, 6);
    }
  });

  it('draws both axes for the grid', () => {
    const geometry = templateGeometry('grid', SIZE);
    const horizontal = geometry.lines.filter(([, y1, , y2]) => y1 === y2);
    const vertical = geometry.lines.filter(([x1, , x2]) => x1 === x2);
    expect(horizontal.length).toBeGreaterThan(10);
    expect(vertical.length).toBeGreaterThan(10);
  });

  it('places dotted paper on a lattice', () => {
    const geometry = templateGeometry('dotted', SIZE);
    expect(geometry.lines).toEqual([]);
    expect(geometry.dots.length).toBeGreaterThan(100);
    const [firstX, firstY] = geometry.dots[0]!;
    const row = geometry.dots.filter(([, y]) => y === firstY);
    expect(row[1]![0] - firstX).toBeCloseTo(DEFAULT_TEMPLATE_SPACING, 6);
  });

  it('gives Cornell paper a margin and a summary block', () => {
    const geometry = templateGeometry('cornell', SIZE);
    expect(geometry.boxes.length).toBeGreaterThanOrEqual(2);
    for (const box of geometry.boxes) {
      expect(box.w).toBeGreaterThan(0);
      expect(box.h).toBeGreaterThan(0);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(SIZE.width);
      expect(box.y + box.h).toBeLessThanOrEqual(SIZE.height);
    }
  });

  it('honours a custom spacing', () => {
    const geometry = templateGeometry('lined', { ...SIZE, spacing: 40 });
    expect(geometry.spacing).toBe(40);
    expect(geometry.lines[1]![1] - geometry.lines[0]![1]).toBeCloseTo(40, 6);
  });

  it('degrades gracefully for a zero-sized page', () => {
    for (const kind of KINDS) {
      const geometry = templateGeometry(kind, { width: 0, height: 0 });
      expect(geometry.lines).toEqual([]);
      expect(geometry.dots).toEqual([]);
      expect(geometry.boxes).toEqual([]);
    }
  });
});
