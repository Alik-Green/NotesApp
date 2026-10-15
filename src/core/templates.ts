/**
 * Page templates (backgrounds). Templates are *not* part of the ink: the renderer paints them
 * from these pure geometry descriptions, and PDF export re-draws them as vector lines.
 */

import type { TemplateKind } from './model';
import type { Rect } from './geometry';

export interface TemplateGeometry {
  kind: TemplateKind;
  /** Spacing in document units (points). */
  spacing: number;
  lines: Array<[number, number, number, number]>;
  dots: Array<[number, number]>;
  /** Cornell layout: margin + summary block rectangles. */
  boxes: Rect[];
  color: string;
  /** Line width in document units. */
  lineWidth: number;
}

export interface TemplateOptions {
  width: number;
  height: number;
  /** Base colour of the rule lines; adapts to the paper colour. */
  color?: string;
  spacing?: number;
}

export const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  blank: 'Blank',
  lined: 'Lined',
  grid: 'Grid',
  dotted: 'Dotted',
  cornell: 'Cornell',
};

export const DEFAULT_TEMPLATE_SPACING = 32;

export function templateGeometry(kind: TemplateKind, options: TemplateOptions): TemplateGeometry {
  const spacing = options.spacing ?? DEFAULT_TEMPLATE_SPACING;
  const color = options.color ?? 'rgba(100,116,139,0.38)';
  const geometry: TemplateGeometry = {
    kind,
    spacing,
    lines: [],
    dots: [],
    boxes: [],
    color,
    lineWidth: 1,
  };
  const { width, height } = options;
  if (kind === 'blank' || width <= 0 || height <= 0) return geometry;

  const margin = Math.round(spacing * 0.9);

  if (kind === 'lined') {
    for (let y = margin + spacing; y < height - margin * 0.4; y += spacing) {
      geometry.lines.push([margin, y, width - margin, y]);
    }
    return geometry;
  }

  if (kind === 'grid') {
    for (let y = margin; y < height - margin * 0.4; y += spacing) {
      geometry.lines.push([margin, y, width - margin, y]);
    }
    for (let x = margin; x < width - margin * 0.4; x += spacing) {
      geometry.lines.push([x, margin, x, height - margin * 0.4]);
    }
    return geometry;
  }

  if (kind === 'dotted') {
    const step = spacing;
    for (let y = margin; y < height - margin * 0.4; y += step) {
      for (let x = margin; x < width - margin * 0.4; x += step) {
        geometry.dots.push([x, y]);
      }
    }
    return geometry;
  }

  // Cornell: a title band, a cue column and a summary band.
  const titleHeight = spacing * 2.2;
  const cueWidth = Math.round(width * 0.28);
  const summaryHeight = Math.round(height * 0.2);
  geometry.boxes.push({ x: margin, y: margin, w: width - margin * 2, h: titleHeight });
  geometry.boxes.push({
    x: margin,
    y: margin + titleHeight,
    w: cueWidth,
    h: height - margin * 2 - titleHeight - summaryHeight,
  });
  geometry.boxes.push({
    x: margin,
    y: height - margin - summaryHeight,
    w: width - margin * 2,
    h: summaryHeight,
  });
  // ruled lines inside the note area
  const noteX = margin + cueWidth;
  for (let y = margin + titleHeight + spacing; y < height - margin - summaryHeight; y += spacing) {
    geometry.lines.push([noteX, y, width - margin, y]);
  }
  return geometry;
}

export function templateRowCount(kind: TemplateKind, options: TemplateOptions): number {
  const geometry = templateGeometry(kind, options);
  return geometry.lines.filter((l) => Math.abs(l[1] - l[3]) < 0.001).length;
}
