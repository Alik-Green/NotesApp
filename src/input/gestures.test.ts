import { describe, expect, it } from 'vitest';
import { MultiTapTracker, emptyPinch, pinchFrom, pinchScaleFactor } from './gestures';

describe('pinch maths', () => {
  it('returns an inactive pinch for fewer than two pointers', () => {
    expect(pinchFrom([])).toEqual(emptyPinch());
    expect(pinchFrom([{ x: 10, y: 10 }])).toEqual(emptyPinch());
  });

  it('measures the distance and midpoint of the first two pointers', () => {
    const pinch = pinchFrom([
      { x: 100, y: 100 },
      { x: 160, y: 180 },
    ]);
    expect(pinch.active).toBe(true);
    expect(pinch.distance).toBe(100);
    expect(pinch.centerX).toBe(130);
    expect(pinch.centerY).toBe(140);
  });

  it('never reports a zero distance (protects against divide-by-zero)', () => {
    const pinch = pinchFrom([
      { x: 50, y: 50 },
      { x: 50, y: 50 },
    ]);
    expect(pinch.distance).toBe(1);
  });

  it('scales by the distance ratio and ignores inactive states', () => {
    const previous = pinchFrom([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const next = pinchFrom([
      { x: 0, y: 0 },
      { x: 150, y: 0 },
    ]);
    expect(pinchScaleFactor(previous, next)).toBe(1.5);
    expect(pinchScaleFactor(previous, emptyPinch())).toBe(1);
    expect(pinchScaleFactor(emptyPinch(), next)).toBe(1);
  });
});

describe('MultiTapTracker', () => {
  it('recognises a two-finger tap as undo', () => {
    const tracker = new MultiTapTracker();
    expect(tracker.handle('down', 1, 100, 100, 0, 'touch')).toBe('none');
    expect(tracker.handle('down', 2, 220, 100, 12, 'touch')).toBe('none');
    expect(tracker.handle('up', 1, 101, 100, 90, 'touch')).toBe('none');
    expect(tracker.handle('up', 2, 220, 101, 104, 'touch')).toBe('undo');
  });

  it('recognises a three-finger tap as redo', () => {
    const tracker = new MultiTapTracker();
    expect(tracker.handle('down', 1, 100, 100, 0, 'touch')).toBe('none');
    expect(tracker.handle('down', 2, 200, 100, 8, 'touch')).toBe('none');
    expect(tracker.handle('down', 3, 300, 100, 16, 'touch')).toBe('none');
    expect(tracker.handle('up', 1, 100, 100, 80, 'touch')).toBe('none');
    expect(tracker.handle('up', 2, 200, 100, 88, 'touch')).toBe('none');
    expect(tracker.handle('up', 3, 300, 100, 96, 'touch')).toBe('redo');
  });

  it('ignores single-finger taps and mouse/pen input', () => {
    const tracker = new MultiTapTracker();
    expect(tracker.handle('down', 1, 100, 100, 0, 'touch')).toBe('none');
    expect(tracker.handle('up', 1, 100, 100, 50, 'touch')).toBe('none');

    expect(tracker.handle('down', 2, 100, 100, 100, 'mouse')).toBe('none');
    expect(tracker.handle('up', 2, 100, 100, 120, 'mouse')).toBe('none');
    expect(tracker.handle('down', 3, 100, 100, 200, 'pen')).toBe('none');
    expect(tracker.handle('up', 3, 100, 100, 210, 'pen')).toBe('none');
  });

  it('does not treat a pinch (moved fingers) as a tap', () => {
    const tracker = new MultiTapTracker();
    tracker.handle('down', 1, 100, 100, 0, 'touch');
    tracker.handle('down', 2, 200, 100, 10, 'touch');
    tracker.handle('move', 1, 40, 100, 60, 'touch');
    tracker.handle('move', 2, 260, 100, 60, 'touch');
    tracker.handle('up', 1, 40, 100, 90, 'touch');
    expect(tracker.handle('up', 2, 260, 100, 100, 'touch')).toBe('none');
  });

  it('ignores a two-finger tap held longer than durationMs', () => {
    const tracker = new MultiTapTracker({ durationMs: 300 });
    tracker.handle('down', 1, 100, 100, 0, 'touch');
    tracker.handle('down', 2, 200, 100, 10, 'touch');
    tracker.handle('up', 1, 100, 100, 900, 'touch');
    expect(tracker.handle('up', 2, 200, 100, 910, 'touch')).toBe('none');
  });

  it('requires the fingers to lift within windowMs of each other', () => {
    const tracker = new MultiTapTracker({ durationMs: 10_000, windowMs: 200 });
    tracker.handle('down', 1, 100, 100, 0, 'touch');
    tracker.handle('down', 2, 200, 100, 10, 'touch');
    tracker.handle('up', 1, 100, 100, 100, 'touch');
    expect(tracker.handle('up', 2, 200, 100, 900, 'touch')).toBe('none');
  });

  it('resets on pointercancel and after every completed gesture', () => {
    const tracker = new MultiTapTracker();
    tracker.handle('down', 1, 100, 100, 0, 'touch');
    tracker.handle('down', 2, 200, 100, 10, 'touch');
    expect(tracker.handle('cancel', 1, 100, 100, 40, 'touch')).toBe('none');
    expect(tracker.handle('up', 2, 200, 100, 50, 'touch')).toBe('none');

    // A fresh two-finger tap still works because the state was cleared.
    tracker.handle('down', 3, 100, 100, 1_000, 'touch');
    tracker.handle('down', 4, 200, 100, 1_010, 'touch');
    tracker.handle('up', 3, 100, 100, 1_050, 'touch');
    expect(tracker.handle('up', 4, 200, 100, 1_060, 'touch')).toBe('undo');
  });

  it('reports the duration of the gesture that just finished', () => {
    const tracker = new MultiTapTracker();
    expect(tracker.lastGestureDuration()).toBe(0);
    tracker.handle('down', 1, 100, 100, 1_000, 'touch');
    tracker.handle('up', 1, 100, 100, 1_120, 'touch');
    expect(tracker.lastGestureDuration()).toBe(120);
  });

  it('ignores extra movement that stays inside the slop radius', () => {
    const tracker = new MultiTapTracker({ slop: 20 });
    tracker.handle('down', 1, 100, 100, 0, 'touch');
    tracker.handle('down', 2, 200, 100, 5, 'touch');
    tracker.handle('move', 1, 110, 105, 20, 'touch');
    tracker.handle('up', 1, 110, 105, 40, 'touch');
    expect(tracker.handle('up', 2, 200, 100, 50, 'touch')).toBe('undo');
  });
});
