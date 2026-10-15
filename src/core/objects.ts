/** Factories for non-ink scene objects (text, sticky, shapes, images, highlights). Pure. */

import { newId } from './ids';
import type { HighlightObject, ImageObject, ID, ShapeKind, ShapeObject, TextBox } from './model';
import type { Rect, Vec2 } from './geometry';

export const DEFAULT_FONT = 'Inter, ui-sans-serif, system-ui, sans-serif';

export function defaultTextBox(
  point: Vec2,
  text = '',
  options: { fontSize?: number; color?: string; width?: number; fontFamily?: string } = {},
): TextBox {
  const fontSize = options.fontSize ?? 18;
  const lines = Math.max(1, text.split('\n').length);
  return {
    type: 'text',
    id: newId('tx'),
    x: point.x,
    y: point.y,
    w: options.width ?? 260,
    h: Math.max(fontSize * 1.6, lines * fontSize * 1.35),
    rotation: 0,
    text,
    fontFamily: options.fontFamily ?? DEFAULT_FONT,
    fontSize,
    color: options.color ?? '#111827',
    align: 'left',
  };
}

export function defaultSticky(point: Vec2, text = '', color = '#fde68a'): TextBox {
  const size = 180;
  return {
    type: 'text',
    id: newId('st'),
    x: point.x - size / 2,
    y: point.y - size / 2,
    w: size,
    h: size,
    rotation: 0,
    text,
    fontFamily: DEFAULT_FONT,
    fontSize: 16,
    color: '#111827',
    align: 'left',
    sticky: { color },
  };
}

export function shapeFromDrag(
  from: Vec2,
  to: Vec2,
  shape: ShapeKind,
  options: { color?: string; size?: number; fill?: string | null } = {},
): ShapeObject {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const w = Math.abs(to.x - from.x);
  const h = Math.abs(to.y - from.y);
  if (shape === 'line' || shape === 'arrow') {
    return {
      type: 'shape',
      id: newId('sh'),
      shape,
      x: from.x,
      y: from.y,
      w: to.x - from.x,
      h: to.y - from.y,
      rotation: 0,
      color: options.color ?? '#0ea5e9',
      fill: null,
      size: options.size ?? 2.5,
      opacity: 1,
    };
  }
  return {
    type: 'shape',
    id: newId('sh'),
    shape,
    x,
    y,
    w: Math.max(1, w),
    h: Math.max(1, h),
    rotation: 0,
    color: options.color ?? '#0ea5e9',
    fill: options.fill ?? null,
    size: options.size ?? 2.5,
    opacity: 1,
  };
}

export function imageObject(
  assetId: ID,
  natural: { width: number; height: number },
  point: Vec2,
  options: { maxWidth?: number; maxHeight?: number } = {},
): ImageObject {
  const maxWidth = options.maxWidth ?? 420;
  const maxHeight = options.maxHeight ?? 420;
  const scale = Math.min(maxWidth / (natural.width || maxWidth), maxHeight / (natural.height || maxHeight), 1);
  const w = Math.max(24, Math.round((natural.width || maxWidth) * scale));
  const h = Math.max(24, Math.round((natural.height || maxHeight) * scale));
  return {
    type: 'image',
    id: newId('im'),
    assetId,
    x: Math.round(point.x - w / 2),
    y: Math.round(point.y - h / 2),
    w,
    h,
    rotation: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 },
    opacity: 1,
  };
}

export function highlightFromRect(rect: Rect, color = '#fde047'): HighlightObject {
  return {
    type: 'highlight',
    id: newId('hl'),
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    color,
    opacity: 0.45,
  };
}

export type { Rect };
